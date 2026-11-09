// 技能策展 P3（对应 Hermes `agent/curator.py` + `tools/skill_usage.py`）。
// 覆盖：生命周期纯函数、使用账本的读写与还原、合并建议的机械校验，
// 以及 CurationService 的间隔闸门、闲置/归档落地口径（直接迁移 vs 出提案）、合并采纳与权限漂移。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CURATION,
  defaultSettings,
  sanitizeCuration,
  type CurationSettings,
  type Settings,
} from "../src/core/settings";
import type { UserRole } from "../src/core/types";
import type { MockHandler } from "../src/provider/mock";
import type { MemberUsageRecord } from "../src/agent/member-runtime";
import { SkillLibrary, type SkillActor, type SkillRecord } from "../src/skills/library";
import {
  DAY_MS,
  idleDaysOf,
  lastActivityAtOf,
  lifecycleStateOf,
  normalizeLifecycle,
  planLifecycle,
} from "../src/skills/curation/lifecycle";
import {
  CURATION_RULES,
  type ConsolidationCurationProposal,
  type CurationProposal,
  type LifecycleCurationProposal,
  type SkillUsageRecord,
} from "../src/skills/curation/types";
import {
  SkillUsageStore,
  emptyUsage,
  normalizeCurationProposal,
  normalizeUsage,
} from "../src/skills/curation/usage-store";
import { CurationService } from "../src/skills/curation/service";
import { extractMerges, renderCandidate, validateMerges } from "../src/skills/curation/prompt";

const nowMs = Date.now();
/** 天数口径与服务端一致：一律相对真实时间，测试里的闲置算式和 Date.now() 对得上。 */
function daysAgo(days: number): number {
  return nowMs - days * DAY_MS;
}

let dir: string;
// 账本写入是延迟落盘的，afterEach 必须先 flush 再删目录，否则补写会把目录重新建出来。
const openStores: SkillUsageStore[] = [];

function newStore(file: string, onError?: (message: string) => void): SkillUsageStore {
  const store = new SkillUsageStore(file, onError);
  openStores.push(store);
  return store;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-curation-"));
});

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.flush()));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

// ---------------------------------------------------------------- 夹具

function usageOf(skillId: string, overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return { ...emptyUsage(skillId), skillId, ...overrides };
}

function recordOf(id: string, name: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id,
    scope: "personal",
    ownerId: "u_owner",
    name,
    description: `用来验证策展的 ${name}`,
    instructions: "1. 打开文件。\n2. 按步骤执行。\n3. 回读确认结果。",
    createdAt: daysAgo(40),
    updatedAt: daysAgo(40),
    ...overrides,
  };
}

/** 直接写账本文件：SkillUsageStore 懒加载，写在任何一次读取之前就能按这份清单继续。 */
async function seedUsageFile(
  caseDir: string,
  usage: Record<string, Partial<SkillUsageRecord>>,
  extra: { proposals?: readonly unknown[]; lastPassAt?: Record<string, number> } = {},
): Promise<string> {
  const file = join(caseDir, "skill-usage.json");
  const normalized: Record<string, SkillUsageRecord> = {};
  for (const [skillId, overrides] of Object.entries(usage)) {
    normalized[skillId] = usageOf(skillId, overrides);
  }
  await writeFile(
    file,
    JSON.stringify({
      usage: normalized,
      proposals: extra.proposals ?? [],
      log: [],
      lastPassAt: extra.lastPassAt ?? {},
    }),
    "utf8",
  );
  return file;
}

interface Harness {
  /** 每个夹具一套独立目录：一个用例里连开两个夹具时，后一个不该读到前一个正在写的账本。 */
  dir: string;
  settings: Settings;
  store: SkillUsageStore;
  skills: SkillLibrary;
  service: CurationService;
  actor: SkillActor;
  usageRecords: MemberUsageRecord[];
  errors: string[];
}

async function harness(
  options: {
    curation?: Partial<CurationSettings>;
    handler?: MockHandler;
    role?: UserRole;
    usage?: Record<string, Partial<SkillUsageRecord>>;
    proposals?: readonly unknown[];
    lastPassAt?: Record<string, number>;
    skills?: Record<string, SkillRecord>;
  } = {},
): Promise<Harness> {
  const settings = defaultSettings();
  settings.providers = [{ id: "demo", api: "mock", models: [{ id: "mock" }] }];
  settings.selection = { ...settings.selection, defaultModel: "demo/mock", aliases: {}, fallbacks: [] };
  settings.curation = { ...DEFAULT_CURATION, ...options.curation };

  const caseDir = await mkdtemp(join(dir, "case-"));
  const store = newStore(
    await seedUsageFile(caseDir, options.usage ?? {}, {
      proposals: options.proposals,
      lastPassAt: options.lastPassAt,
    }),
  );

  // 技能库也先落盘再 init：这样能造出「多少天前活动过」的样本，而不用改库的时间夹具。
  const records = Object.values(options.skills ?? {});
  if (records.length > 0) {
    await writeFile(join(caseDir, "skills.json"), JSON.stringify({ skills: records }), "utf8");
  }
  const skills = new SkillLibrary(join(caseDir, "skills.json"), { seedShared: false });
  await skills.init();

  const owner = { id: "u_owner", name: "老板", role: options.role ?? "admin" };
  const usageRecords: MemberUsageRecord[] = [];
  const errors: string[] = [];
  const service = new CurationService({
    store,
    skills,
    getSettings: () => settings,
    getModelDeps: () => ({
      settings,
      dataDir: caseDir,
      ...(options.handler ? { mockHandler: options.handler } : {}),
    }),
    owner,
    onUsageRecord: (record) => usageRecords.push(record),
    onError: (message) => errors.push(message),
  });
  return {
    dir: caseDir,
    settings,
    store,
    skills,
    service,
    actor: { id: owner.id, role: owner.role },
    usageRecords,
    errors,
  };
}

function mergeHandler(payload: unknown): MockHandler {
  return () => ({ text: "```json\n" + JSON.stringify(payload) + "\n```" });
}

function archiveProposal(overrides: Partial<LifecycleCurationProposal> = {}): LifecycleCurationProposal {
  const createdAt = nowMs - 5 * 60_000;
  return {
    id: "cur_seed",
    kind: "archive",
    status: "pending",
    origin: "sweep",
    createdAt,
    updatedAt: createdAt,
    ownerId: "u_owner",
    ownerName: "老板",
    reason: "用过 3 次，但连续 40 天没有任何活动",
    skillId: "sk_old",
    evidence: {
      subjects: [
        {
          skillId: "sk_old",
          skillName: "old-flow",
          scope: "personal",
          useCount: 3,
          viewCount: 0,
          patchCount: 0,
          idleDays: 40,
        },
      ],
      thresholdDays: CURATION_RULES.archiveAfterDays,
      detail: "连续 40 天没活动，超过归档阈值 30 天。采纳后这条技能不再出现在智能体清单里，但正文保留、随时能恢复",
    },
    ...overrides,
  };
}

function mergeProposal(overrides: Partial<ConsolidationCurationProposal> = {}): ConsolidationCurationProposal {
  const createdAt = nowMs - 5 * 60_000;
  return {
    id: "cur_merge",
    kind: "consolidate",
    status: "pending",
    origin: "model",
    createdAt,
    updatedAt: createdAt,
    ownerId: "u_owner",
    ownerName: "老板",
    reason: "这几条技能做的是同一件事，建议收拢到「report-docx」下",
    sourceIds: ["sk_a", "sk_b"],
    target: { skillId: "sk_t", name: "report-docx" },
    evidence: {
      subjects: [
        {
          skillId: "sk_a",
          skillName: "docx-writer",
          scope: "personal",
          useCount: 0,
          viewCount: 0,
          patchCount: 1,
          idleDays: 40,
        },
        {
          skillId: "sk_b",
          skillName: "word-report",
          scope: "personal",
          useCount: 0,
          viewCount: 0,
          patchCount: 0,
          idleDays: 40,
        },
      ],
      thresholdDays: 0,
      detail: "采纳后其余 2 条只归档、不删除，正文保留，随时能恢复",
    },
    ...overrides,
  };
}

/** 记账是 fire-and-forget：等内存里的账真的反映出来再落盘，别把补写留在删目录之后。 */
async function untilUsage(
  store: SkillUsageStore,
  skillId: string,
  predicate: (usage: SkillUsageRecord | undefined) => boolean,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate(await store.usageOf(skillId))) return;
    if (Date.now() - startedAt >= 5_000) throw new Error(`等待技能账本超时：${skillId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------- 生命周期纯函数

describe("策展生命周期（lifecycle）", () => {
  it("状态位不认识就整位丢掉，固定/归档时间/吸收去向按类型收窄", () => {
    expect(normalizeLifecycle({ state: "deleted", pinned: true })).toBeUndefined();
    expect(normalizeLifecycle(null)).toBeUndefined();
    expect(normalizeLifecycle("stale")).toBeUndefined();
    expect(normalizeLifecycle({ state: "stale" })).toEqual({ state: "stale" });
    expect(normalizeLifecycle({ state: "active", pinned: false })).toEqual({ state: "active" });
    expect(
      normalizeLifecycle({
        state: "archived",
        pinned: true,
        archivedAt: 123,
        absorbedInto: " report-docx ",
        absorbedIntoId: "sk_t",
      }),
    ).toEqual({
      state: "archived",
      pinned: true,
      archivedAt: 123,
      absorbedInto: " report-docx ",
      absorbedIntoId: "sk_t",
    });
    // 坏值不下传：非数字的归档时间、空字符串的去向都整字段丢掉。
    expect(normalizeLifecycle({ state: "archived", archivedAt: "123", absorbedInto: "   " })).toEqual({
      state: "archived",
    });
    expect(lifecycleStateOf(recordOf("sk_x", "x"))).toBe("active");
  });

  it("最近活动取「用/读/改/正文更新」四者的最大值，只看建库时间不算活动；未来时间戳按 0 天", () => {
    const skill = recordOf("sk_x", "x", { createdAt: daysAgo(50), updatedAt: daysAgo(20) });
    expect(lastActivityAtOf(skill, undefined)).toBe(daysAgo(20));
    expect(lastActivityAtOf(skill, usageOf("sk_x", { lastUsedAt: daysAgo(60) }))).toBe(daysAgo(20));
    expect(
      lastActivityAtOf(
        skill,
        usageOf("sk_x", { lastUsedAt: daysAgo(9), lastViewedAt: daysAgo(12), lastPatchedAt: daysAgo(30) }),
      ),
    ).toBe(daysAgo(9));
    expect(idleDaysOf(skill, usageOf("sk_x", { lastUsedAt: nowMs + DAY_MS }), nowMs)).toBe(0);
    expect(idleDaysOf(skill, undefined, nowMs)).toBe(20);
  });

  it("内置与固定永不参与，已归档是终态", () => {
    const plan = planLifecycle({
      now: nowMs,
      skills: [
        recordOf("sk_builtin", "builtin-flow", { builtin: true, updatedAt: daysAgo(90) }),
        recordOf("sk_pinned", "pinned-flow", {
          lifecycle: { state: "active", pinned: true },
          updatedAt: daysAgo(90),
        }),
        recordOf("sk_archived", "archived-flow", {
          lifecycle: { state: "archived", archivedAt: daysAgo(31) },
          updatedAt: daysAgo(90),
        }),
      ],
      usage: new Map(
        ["sk_builtin", "sk_pinned", "sk_archived"].map((id) => [
          id,
          usageOf(id, { useCount: 5, lastUsedAt: daysAgo(90) }),
        ]),
      ),
    });
    expect(plan.transitions).toEqual([]);
    expect(plan.archiveCandidates).toEqual([]);
  });

  it("跨过闲置阈值标记 stale；回到窗口内或「改后又被用」就复活", () => {
    const staleSkill = recordOf("sk_stale", "stale-flow", {
      lifecycle: { state: "stale" },
      updatedAt: daysAgo(40),
    });

    const fresh = planLifecycle({
      now: nowMs,
      skills: [recordOf("sk_fresh", "fresh-flow", { updatedAt: daysAgo(3) })],
      usage: new Map(),
    });
    expect(fresh.transitions).toEqual([]);
    expect(fresh.archiveCandidates).toEqual([]);

    const idle = planLifecycle({
      now: nowMs,
      skills: [recordOf("sk_idle", "idle-flow", { updatedAt: daysAgo(15) })],
      usage: new Map(),
    });
    expect(idle.transitions.map((item) => [item.from, item.to])).toEqual([["active", "stale"]]);
    expect(idle.transitions[0]?.neverUsed).toBe(true);
    expect(idle.archiveCandidates).toEqual([]);

    const backInWindow = planLifecycle({
      now: nowMs,
      skills: [staleSkill],
      usage: new Map([["sk_stale", usageOf("sk_stale", { useCount: 2, lastUsedAt: daysAgo(2) })]]),
    });
    expect(backInWindow.transitions.map((item) => [item.from, item.to])).toEqual([["stale", "active"]]);

    const effectiveAgain = planLifecycle({
      now: nowMs,
      skills: [staleSkill],
      usage: new Map([
        ["sk_stale", usageOf("sk_stale", { useCount: 2, lastUsedAt: daysAgo(40), reuseAfterPatch: true })],
      ]),
    });
    expect(effectiveAgain.transitions.map((item) => item.to)).toEqual(["active"]);
    expect(effectiveAgain.archiveCandidates).toEqual([]);
  });

  it("从没被用过的技能永不进入归档候选；归档阈值不会低于闲置阈值 +1", () => {
    const plan = planLifecycle({
      now: nowMs,
      skills: [recordOf("sk_never", "never-flow", { updatedAt: daysAgo(200) })],
      usage: new Map(),
      staleAfterDays: 14,
      archiveAfterDays: 30,
    });
    expect(plan.transitions.map((item) => item.to)).toEqual(["stale"]);
    expect(plan.archiveCandidates).toEqual([]);

    // archiveAfterDays 会被抬到 staleAfterDays + 1：闲置 31 天，两条都不该动。
    const clamped = planLifecycle({
      now: nowMs,
      skills: [recordOf("sk_used", "used-flow", { updatedAt: daysAgo(31) })],
      usage: new Map([["sk_used", usageOf("sk_used", { useCount: 4, lastUsedAt: daysAgo(31) })]]),
      staleAfterDays: 40,
      archiveAfterDays: 7,
    });
    expect(clamped.transitions).toEqual([]);
    expect(clamped.archiveCandidates).toEqual([]);

    const archivable = planLifecycle({
      now: nowMs,
      skills: [recordOf("sk_used", "used-flow", { updatedAt: daysAgo(31) })],
      usage: new Map([["sk_used", usageOf("sk_used", { useCount: 4, lastUsedAt: daysAgo(31) })]]),
    });
    expect(archivable.transitions.map((item) => item.to)).toEqual(["stale"]);
    expect(archivable.archiveCandidates[0]).toMatchObject({
      skillId: "sk_used",
      from: "active",
      to: "archived",
      useCount: 4,
      idleDays: 31,
      scope: "personal",
      ownerId: "u_owner",
    });
  });
});

// ---------------------------------------------------------------- 使用账本

describe("技能使用账本（SkillUsageStore）", () => {
  it("normalizeUsage 夹紧负数与坏值，复用代数不会超过编辑代数", () => {
    expect(
      normalizeUsage(
        { useCount: -3, viewCount: "x", patchGeneration: 2, lastReusedPatchGeneration: 9 },
        "sk_a",
      ),
    ).toEqual(usageOf("sk_a", { patchGeneration: 2, lastReusedPatchGeneration: 2 }));
    expect(normalizeUsage(null, "sk_b")).toEqual(usageOf("sk_b"));
    expect(normalizeUsage({ lastUsedAt: 0, lastViewedAt: -1, reuseAfterPatch: "yes" }, "sk_c")).toEqual(
      usageOf("sk_c"),
    );
  });

  it("提案还原：基座缺项整条丢弃，去向与忽略原因照样保留", () => {
    expect(normalizeCurationProposal(archiveProposal())).toMatchObject({ id: "cur_seed", kind: "archive" });
    expect(normalizeCurationProposal(null)).toBeUndefined();
    expect(normalizeCurationProposal({ ...archiveProposal(), id: "" })).toBeUndefined();
    expect(normalizeCurationProposal({ ...archiveProposal(), status: "gone" })).toBeUndefined();
    expect(normalizeCurationProposal({ ...archiveProposal(), kind: "delete" })).toBeUndefined();
    expect(normalizeCurationProposal({ ...archiveProposal(), ownerId: "  " })).toBeUndefined();
    expect(normalizeCurationProposal({ ...archiveProposal(), skillId: "" })).toBeUndefined();

    // 半条提案不如没有：合并缺来源或缺承接者名字一律丢。
    expect(normalizeCurationProposal({ ...mergeProposal(), sourceIds: [] })).toBeUndefined();
    expect(normalizeCurationProposal({ ...mergeProposal(), target: { name: "  " } })).toBeUndefined();
    expect(
      normalizeCurationProposal({ ...mergeProposal(), target: { name: "doc-writing", description: "d", instructions: "i" } }),
    ).toMatchObject({ kind: "consolidate", target: { name: "doc-writing", description: "d" } });

    const reloaded = normalizeCurationProposal({
      ...archiveProposal(),
      status: "dismissed",
      dismissReason: "留着以后可能用",
      appliedSkillId: "sk_t",
    });
    expect(reloaded).toMatchObject({ dismissReason: "留着以后可能用", appliedSkillId: "sk_t" });

    // 证据里的 subject 只有 skillId/skillName 齐全才留下，条数与负数按上限/零裁剪。
    const withSubjects = normalizeCurationProposal({
      ...mergeProposal(),
      evidence: {
        subjects: [
          { skillId: "sk_a", skillName: "docx-writer", useCount: 2, idleDays: -5 },
          { skillId: "sk_missing_name" },
          { skillName: "no-id" },
        ],
        thresholdDays: 0,
        detail: "x",
      },
    });
    expect(withSubjects?.evidence.subjects).toHaveLength(1);
    expect(withSubjects?.evidence.subjects[0]).toMatchObject({ skillId: "sk_a", idleDays: 0 });
  });

  it("记账延迟落盘后新实例能读回，编辑之后再用才点亮 reuseAfterPatch", async () => {
    const h = await harness({
      usage: { sk_patchy: { patchCount: 2, patchGeneration: 2, lastReusedPatchGeneration: 1 } },
    });
    h.store.recordView("sk_patchy");
    h.store.recordUse("sk_patchy");
    h.store.recordUse("");
    await untilUsage(h.store, "sk_patchy", (entry) => entry?.useCount === 1 && entry.viewCount === 1);
    await h.store.flush();

    const reopened = newStore(join(h.dir, "skill-usage.json"));
    expect(await reopened.usageOf("sk_patchy")).toMatchObject({
      useCount: 1,
      viewCount: 1,
      patchCount: 2,
      patchGeneration: 2,
      lastReusedPatchGeneration: 2,
      reuseAfterPatch: true,
    });
    expect(await reopened.usageOf("sk_missing")).toBeUndefined();

    await reopened.forgetSkill("sk_patchy");
    await reopened.forgetSkill("sk_nothing");
    await reopened.flush();
    expect((await reopened.usageSnapshot()).size).toBe(0);
  });

  it("同一方向只留一条待批提案，提案与流水按长度上限裁剪", async () => {
    const h = await harness();
    expect(await h.store.hasPendingProposal("archive", "sk_old")).toBe(false);
    await h.store.addProposals([archiveProposal()]);
    expect(await h.store.hasPendingProposal("archive", "sk_old")).toBe(true);
    expect(await h.store.hasPendingProposal("stale", "sk_old")).toBe(false);

    // 已忽略的同向提案不再挡路，下次扫描可以重新提议。
    await h.store.addProposals([archiveProposal({ id: "cur_dup", status: "dismissed", dismissReason: "先不动" })]);
    expect(await h.store.hasPendingProposal("archive", "sk_old")).toBe(true);
    await h.store.patchProposal("cur_seed", { status: "dismissed", dismissReason: "留着以后可能用" });
    expect(await h.store.hasPendingProposal("archive", "sk_old")).toBe(false);

    // 合并提案按 sourceIds 命中，不只看 skillId。
    await h.store.addProposals([mergeProposal()]);
    expect(await h.store.hasPendingProposal("consolidate", "sk_b")).toBe(true);

    const capped = Array.from({ length: CURATION_RULES.maxProposals + 20 }, (_, index) =>
      archiveProposal({ id: `cur_${index}`, skillId: `sk_${index}` }),
    );
    await h.store.addProposals(capped);
    const listed = await h.store.listProposals();
    expect(listed).toHaveLength(CURATION_RULES.maxProposals);
    expect(listed[0]?.createdAt).toBeGreaterThanOrEqual(listed[listed.length - 1]?.createdAt ?? 0);

    for (let index = 0; index < 5; index += 1) {
      await h.store.addLog({
        id: `log_${index}`,
        at: nowMs + index,
        ownerId: "u_owner",
        ownerName: "老板",
        outcome: "nothing",
        detail: `第 ${index} 次`,
        scanned: 1,
        transitions: [],
        proposalIds: [],
        modelRef: "demo/mock",
      });
    }
    expect(await h.store.listLog(2)).toHaveLength(2);
    expect((await h.store.listLog(0))[0]?.detail).toBe("第 4 次");
    expect(await h.store.getProposal("cur_none")).toBeUndefined();
    expect(await h.store.patchProposal("cur_none", { status: "dismissed" })).toBeUndefined();
    expect(await h.store.listProposals({ status: "pending", kind: "stale" })).toEqual([]);
  });

  it("坏账本降级成空清单并留一句错误，lastPassAt 按账号分格", async () => {
    const errors: string[] = [];
    const file = join(dir, "broken-usage.json");
    await writeFile(file, "{ not json", "utf8");
    const broken = newStore(file, (message) => errors.push(message));
    expect((await broken.usageSnapshot()).size).toBe(0);
    expect(await broken.listProposals()).toEqual([]);
    expect(await broken.listLog()).toEqual([]);
    expect(errors[0]).toContain("技能使用账本读取失败");

    const h = await harness();
    expect(await h.store.lastPassAt("u_owner")).toBe(0);
    await h.store.setLastPassAt("u_owner", daysAgo(1));
    expect(await h.store.lastPassAt("u_owner")).toBe(daysAgo(1));
    expect(await h.store.lastPassAt("u_other")).toBe(0);
  });
});

// ---------------------------------------------------------------- 合并建议的机械校验

describe("合并建议校验（prompt）", () => {
  it("围栏与前后缀噪声都能解析出 merges；不是 JSON 或结构不对就返回 undefined", () => {
    expect(extractMerges('这是结论：{"merges":[]}')).toEqual([]);
    expect(extractMerges('```json\n{"merges":[{"target":"a"}]}\n```')).toEqual([{ target: "a" }]);
    expect(extractMerges("我建议把 docx-writer 合并掉。")).toBeUndefined();
    expect(extractMerges('{"merges":{"not":"array"}}')).toBeUndefined();
  });

  it("来源必须在候选清单里，承接者不能自吸收，新建承接者必须自带描述与正文", () => {
    const index = new Map<string, SkillRecord>([
      ["docx-writer", recordOf("sk_a", "docx-writer")],
      ["word-report", recordOf("sk_b", "word-report")],
      ["report-docx", recordOf("sk_t", "report-docx")],
    ]);

    const reuse = validateMerges(
      [{ target: "report-docx", sources: ["docx-writer", "word-report"], reason: "同一件事的两种写法" }],
      index,
    );
    expect(reuse.merges).toHaveLength(1);
    expect(reuse.merges[0]?.target).toEqual({ skillId: "sk_t", name: "report-docx" });
    expect(reuse.merges[0]?.sources.map((item) => item.id)).toEqual(["sk_a", "sk_b"]);

    const fresh = validateMerges(
      [
        {
          target: "doc-writing",
          sources: ["DOCX-WRITER ", "word-report"],
          description: "把材料写成 Word 文档",
          instructions: "1. 起草大纲。\n2. 用 docx 技能生成文件。",
          reason: "两条做法重叠",
        },
      ],
      index,
    );
    expect(fresh.merges[0]?.target).toMatchObject({ name: "doc-writing", description: "把材料写成 Word 文档" });

    expect(
      validateMerges([{ target: "report-docx", sources: ["report-docx"] }], index).dropped[0],
    ).toContain("去掉承接者后没有来源");
    expect(validateMerges([{ target: "report-docx", sources: ["made-up-skill"] }], index).dropped[0]).toContain(
      "不在候选清单里",
    );
    expect(validateMerges([{ target: "doc-writing", sources: ["docx-writer"] }], index).dropped[0]).toContain(
      "缺少描述或正文",
    );
    expect(
      validateMerges([{ target: "Bad Name", sources: ["docx-writer"], description: "x", instructions: "y" }], index)
        .dropped[0],
    ).toContain("名字不合规");
    expect(
      validateMerges([{ target: "docx-writer", sources: ["docx-writer", "docx-writer"] }], index).dropped[0],
    ).toContain("重复名字");
    expect(validateMerges(["nope"], index).dropped[0]).toContain("合并建议不是对象");
    expect(validateMerges([{ target: "report-docx" }], index).dropped[0]).toContain("没有来源技能");
    expect(
      validateMerges(
        [
          {
            target: "report-docx",
            sources: Array.from({ length: CURATION_RULES.maxSourcesPerMerge + 1 }, () => "word-report"),
          },
        ],
        index,
      ).dropped[0],
    ).toContain("来源超过");
  });

  it("一条技能不能被两组合并同时占用，超出单次上限的建议不再校验", () => {
    const index = new Map<string, SkillRecord>([
      ["docx-writer", recordOf("sk_a", "docx-writer")],
      ["word-report", recordOf("sk_b", "word-report")],
      ["report-docx", recordOf("sk_t", "report-docx")],
    ]);
    const overlapping = validateMerges(
      [
        { target: "report-docx", sources: ["docx-writer"] },
        { target: "report-docx", sources: ["docx-writer"] },
      ],
      index,
    );
    expect(overlapping.merges).toHaveLength(1);
    expect(overlapping.dropped[0]).toContain("已被其他建议占用");

    const tooMany = Array.from({ length: CURATION_RULES.maxConsolidationsPerPass + 3 }, () => ({
      target: "report-docx",
      sources: ["word-report"],
    }));
    const capped = validateMerges(tooMany, index);
    expect(capped.merges.length + capped.dropped.length).toBe(CURATION_RULES.maxConsolidationsPerPass);
  });

  it("候选渲染带上使用计数与闲置天数，正文摘要压成一行并截断", () => {
    const line = renderCandidate(
      recordOf("sk_a", "docx-writer", {
        instructions: "1. 起草。\n2. 排版。".padEnd(2000, "空"),
        updatedAt: daysAgo(9),
      }),
      usageOf("sk_a", { useCount: 2, viewCount: 1, patchCount: 3, lastUsedAt: daysAgo(9) }),
      nowMs,
    );
    expect(line).toContain("- docx-writer（个人，闲置 9 天；用过 2 次，读过附件 1 次，改过 3 次）");
    expect(line).toContain("描述：用来验证策展的 docx-writer");
    expect((line.split("\n")[2]?.length ?? 0)).toBeLessThanOrEqual(
      CURATION_RULES.instructionsPreviewChars + 10,
    );
    expect(renderCandidate(recordOf("sk_e", "empty-flow", { instructions: "   " }), undefined, nowMs)).toContain(
      "（空）",
    );
    expect(renderCandidate(recordOf("sk_s", "shared-flow", { scope: "shared" }), undefined, nowMs)).toContain("共享");
  });
});

// ---------------------------------------------------------------- 策展服务：扫描

describe("策展扫描（CurationService.sweep）", () => {
  it("关闭与未到间隔只给原因，不动任何技能状态；force 才越过硬闸门", async () => {
    const off = await harness({ curation: { enabled: false } });
    await off.skills.create(off.actor, {
      scope: "personal",
      name: "old-flow",
      description: "旧流程",
      instructions: "1. 做旧事",
    });
    const disabled = await off.service.sweep();
    expect(disabled.skipped).toContain("策展已关闭");
    expect(disabled.proposals).toEqual([]);
    expect(off.skills.listForAgent("u_owner")[0]?.lifecycle).toBeUndefined();

    // 刚从库里 create 出来的技能时间戳是此刻，判不出闲置；用夹具造一条闲置两天的。
    const gated = await harness({
      lastPassAt: { u_owner: nowMs },
      curation: { staleAfterDays: 1 },
      skills: { old: recordOf("sk_old", "old-flow", { createdAt: daysAgo(2), updatedAt: daysAgo(2) }) },
    });
    const tooEarly = await gated.service.sweep();
    expect(tooEarly.skipped).toContain("未到策展间隔");
    expect(await gated.store.listLog()).toEqual([]);
    expect(gated.skills.findById("sk_old")?.lifecycle).toBeUndefined();

    const forced = await gated.service.sweep({ force: true });
    expect(forced.skipped).toBeUndefined();
    expect(forced.log?.outcome).toBe("transitioned");
    expect(gated.skills.listForAgent("u_owner")[0]?.lifecycle?.state).toBe("stale");

    // 间隔设置再小也抬到下限：刚扫过一次，第二次不 force 依然跳过。
    const second = await gated.service.sweep();
    expect(second.skipped).toContain("未到策展间隔");
  });

  it("闲置直接落地、归档只出提案，流水说清这次做了什么", async () => {
    const h = await harness({
      usage: {
        sk_used: { useCount: 4, lastUsedAt: daysAgo(40) },
        sk_never: {},
      },
      skills: {
        used: recordOf("sk_used", "used-flow"),
        never: recordOf("sk_never", "never-flow"),
        fresh: recordOf("sk_fresh", "fresh-flow", { createdAt: daysAgo(2), updatedAt: daysAgo(2) }),
      },
    });
    const result = await h.service.sweep();
    expect(result.log?.outcome).toBe("transitioned");
    expect(result.log?.detail).toContain("标记 2 条闲置");
    expect(result.log?.detail).toContain("产出 1 条待确认提案");
    expect(result.log?.scanned).toBe(3);

    const states = new Map(h.skills.listForAgent("u_owner").map((s) => [s.name, s.lifecycle?.state]));
    expect(states.get("used-flow")).toBe("stale");
    expect(states.get("never-flow")).toBe("stale");
    expect(states.get("fresh-flow")).toBeUndefined();

    expect(result.proposals).toHaveLength(1);
    const archive = result.proposals[0] as LifecycleCurationProposal;
    expect(archive).toMatchObject({ kind: "archive", origin: "sweep", skillId: "sk_used", status: "pending" });
    expect(archive.reason).toContain("用过 4 次");
    expect(archive.evidence.subjects[0]).toMatchObject({ skillName: "used-flow", useCount: 4, idleDays: 40 });
    expect(archive.evidence.thresholdDays).toBe(CURATION_RULES.archiveAfterDays);
    expect(archive.evidence.detail).toContain("正文保留、随时能恢复");
    // 归档只是提案：技能照常留在智能体的可见清单里，正文一个字节没动。
    expect(states.get("used-flow")).not.toBe("archived");
    expect(result.log?.transitions.map((item) => item.to)).toEqual(["stale", "stale"]);

    // 再扫一次（force）不会堆出第二条同样的待批归档提案。
    const again = await h.service.sweep({ force: true });
    expect(again.proposals).toEqual([]);
    expect(await h.store.listProposals({ status: "pending" })).toHaveLength(1);
    expect(again.log?.outcome).toBe("nothing");
    expect(again.log?.detail).toContain("没有需要处理的");
  });

  it("autoArchive 只吃掉本账号的个人技能，共享技能照样走提案", async () => {
    const h = await harness({
      curation: { autoArchive: true },
      usage: {
        sk_mine: { useCount: 2, lastUsedAt: daysAgo(60) },
        sk_shared: { useCount: 9, lastUsedAt: daysAgo(60) },
      },
      skills: {
        mine: recordOf("sk_mine", "mine-flow"),
        shared: recordOf("sk_shared", "shared-old", { scope: "shared", ownerId: "u_admin" }),
      },
    });
    const result = await h.service.sweep();
    expect(result.log?.detail).toContain("自动归档 1 条");
    expect(result.log?.transitions.some((item) => item.to === "archived" && item.skillId === "sk_mine")).toBe(true);

    expect(h.skills.listForAgent("u_owner").map((s) => s.name)).toEqual(["shared-old"]);
    expect(h.skills.findById("sk_mine")?.lifecycle?.state).toBe("archived");
    expect(result.proposals.map((item) => (item as LifecycleCurationProposal).skillId)).toEqual(["sk_shared"]);

    // 非管理员账号：别人的共享技能连状态都不该改，只在流水里留一句说明。
    const guest = await harness({
      role: "user",
      usage: { sk_shared: { useCount: 3, lastUsedAt: daysAgo(20) } },
      skills: { shared: recordOf("sk_shared", "shared-old", { scope: "shared", ownerId: "u_admin" }) },
    });
    const guestPass = await guest.service.sweep();
    expect(guestPass.log?.outcome).toBe("nothing");
    expect(guestPass.log?.detail).toContain("1 条技能不归本账号管");
    expect(guestPass.log?.transitions).toEqual([]);
    expect(guest.skills.findById("sk_shared")?.lifecycle).toBeUndefined();
    expect(guestPass.proposals).toEqual([]);
  });

  it("consolidate 打开时才有那一次模型调用，产出 origin=model 的提案并计入用量", async () => {
    const h = await harness({
      curation: { consolidate: true },
      handler: mergeHandler({
        merges: [{ target: "report-docx", sources: ["docx-writer", "word-report"], reason: "同一件事的两种写法" }],
      }),
      skills: {
        a: recordOf("sk_a", "docx-writer"),
        b: recordOf("sk_b", "word-report"),
        t: recordOf("sk_t", "report-docx"),
      },
    });
    const result = await h.service.sweep();
    const merge = result.proposals[0] as ConsolidationCurationProposal;
    expect(merge).toMatchObject({ kind: "consolidate", origin: "model", sourceIds: ["sk_a", "sk_b"] });
    expect(merge.target).toEqual({ skillId: "sk_t", name: "report-docx" });
    expect(merge.evidence.subjects.map((item) => item.skillId)).toEqual(["sk_a", "sk_b"]);
    expect(merge.evidence.detail).toContain("只归档、不删除");
    expect(result.log?.detail).toContain("提出 1 组合并");
    expect(result.log?.modelRef).toBe("demo/mock");
    expect(h.usageRecords).toHaveLength(1);
    expect(h.usageRecords[0]?.ref).toBe("demo/mock");

    // 候选少于两条根本不该花钱问模型。
    const single = await harness({
      curation: { consolidate: true },
      skills: { only: recordOf("sk_1", "solo-flow") },
    });
    const singlePass = await single.service.sweep();
    expect(singlePass.log?.detail).toContain("可比对的候选太少");
    expect(single.usageRecords).toHaveLength(0);
  });

  it("模型乱说话（非 JSON、编造名字、调用失败）只留痕，不产出提案也不抛错", async () => {
    const garbage = await harness({
      curation: { consolidate: true },
      handler: () => ({ text: "这两条看起来重复了，建议合并成一条。" }),
      skills: { a: recordOf("sk_a", "docx-writer"), b: recordOf("sk_b", "word-report") },
    });
    const garbagePass = await garbage.service.sweep();
    expect(garbagePass.proposals).toEqual([]);
    expect(garbagePass.log?.detail).toContain("缺少 merges 数组");

    const fabricated = await harness({
      curation: { consolidate: true },
      handler: mergeHandler({ merges: [{ target: "made-up-target", sources: ["not-in-list"] }] }),
      skills: { a: recordOf("sk_a", "docx-writer"), b: recordOf("sk_b", "word-report") },
    });
    const dropped = await fabricated.service.sweep();
    expect(dropped.proposals).toEqual([]);
    expect(dropped.log?.detail).toContain("丢弃 1 条");

    const broken = await harness({
      curation: { consolidate: true },
      handler: () => {
        throw new Error("上游 503");
      },
      skills: { a: recordOf("sk_a", "docx-writer"), b: recordOf("sk_b", "word-report") },
    });
    const brokenPass = await broken.service.sweep();
    expect(brokenPass.proposals).toEqual([]);
    expect(brokenPass.log?.detail).toContain("合并建议");
  });

  it("扫描内部炸掉也只降级成 skipped：读接口不该因此 500", async () => {
    const base = await harness();
    class FailingStore extends SkillUsageStore {
      override async usageSnapshot(): Promise<Map<string, SkillUsageRecord>> {
        throw new Error("账本读不动");
      }
    }
    const failing = new FailingStore(join(base.dir, "skill-usage.json"));
    openStores.push(failing);
    const errors: string[] = [];
    const service = new CurationService({
      store: failing,
      skills: base.skills,
      getSettings: () => base.settings,
      getModelDeps: () => ({ settings: base.settings, dataDir: base.dir }),
      owner: { id: "u_owner", name: "老板", role: "admin" },
      onError: (message) => errors.push(message),
    });
    const result = await service.sweep();
    expect(result).toEqual({ proposals: [], skipped: "策展失败：账本读不动" });
    expect(errors[0]).toContain("技能策展失败");
  });

  it("固定与内置技能连扫描都不看，闲置阈值按本账号设置算", async () => {
    const h = await harness({
      curation: { staleAfterDays: 3, archiveAfterDays: 5 },
      usage: {
        sk_pinned: { useCount: 5, lastUsedAt: daysAgo(60) },
        sk_builtin: { useCount: 5, lastUsedAt: daysAgo(60) },
      },
      skills: {
        pinned: recordOf("sk_pinned", "pinned-flow", { lifecycle: { state: "active", pinned: true } }),
        builtin: recordOf("sk_builtin", "builtin-flow", { builtin: true }),
      },
    });
    const result = await h.service.sweep();
    expect(result.log?.transitions).toEqual([]);
    expect(result.proposals).toEqual([]);
    expect(h.skills.findById("sk_pinned")?.lifecycle).toEqual({ state: "active", pinned: true });
  });
});

// ---------------------------------------------------------------- 策展服务：采纳

describe("提案采纳与忽略（applyProposal / dismissProposal）", () => {
  it("闲置与归档提案直接落生命周期，重复采纳幂等，已忽略不能再采纳", async () => {
    const h = await harness({
      skills: { old: recordOf("sk_old", "old-flow") },
      proposals: [
        archiveProposal(),
        archiveProposal({ id: "cur_stale", kind: "stale", reason: "先标闲置" }),
        archiveProposal({ id: "cur_gone", status: "dismissed", dismissReason: "留着" }),
      ],
    });
    const applied = await h.service.applyProposal(h.actor, "cur_seed");
    expect(applied).toMatchObject({ status: "applied" });
    expect(Number.isFinite(applied.appliedAt)).toBe(true);
    expect(h.skills.findById("sk_old")?.lifecycle?.state).toBe("archived");
    expect(h.skills.listForAgent("u_owner").map((s) => s.name)).toEqual([]);
    expect(h.skills.findById("sk_old")?.instructions).toContain("按步骤执行");

    // 归档不写去向（那是合并专属），也不会删任何文件。
    expect(h.skills.findById("sk_old")?.lifecycle?.absorbedInto).toBeUndefined();

    const again = await h.service.applyProposal(h.actor, "cur_seed");
    expect(again.status).toBe("applied");

    const stale = await h.service.applyProposal(h.actor, "cur_stale");
    expect(stale).toMatchObject({ kind: "stale", status: "applied" });
    expect(h.skills.findById("sk_old")?.lifecycle?.state).toBe("stale");

    await expect(h.service.applyProposal(h.actor, "cur_gone")).rejects.toThrow("提案已忽略，不能再生效");
    await expect(h.service.applyProposal(h.actor, "cur_none")).rejects.toThrow("策展提案不存在");
  });

  it("生命周期迁移不刷新 updatedAt，否则闲置过的技能永远闲置不了", async () => {
    const stamp = daysAgo(40);
    const h = await harness({
      skills: { old: recordOf("sk_old", "old-flow", { createdAt: stamp, updatedAt: stamp }) },
      proposals: [archiveProposal()],
    });
    await h.service.applyProposal(h.actor, "cur_seed");
    expect(h.skills.findById("sk_old")?.updatedAt).toBe(stamp);
    expect(Number(h.skills.findById("sk_old")?.lifecycle?.archivedAt)).toBeGreaterThan(0);

    await h.service.setSkillLifecycle(h.actor, "sk_old", { state: "active" });
    expect(h.skills.findById("sk_old")?.lifecycle).toEqual({ state: "active" });
    expect(h.skills.findById("sk_old")?.updatedAt).toBe(stamp);

    // 固定只是加一位（归档痕迹留着）；恢复会把归档痕迹一起清掉。
    await h.service.setSkillLifecycle(h.actor, "sk_old", { pinned: true, state: "archived" });
    expect(h.skills.findById("sk_old")?.lifecycle).toMatchObject({ state: "archived", pinned: true });
    await h.service.setSkillLifecycle(h.actor, "sk_old", { pinned: false, state: "active" });
    expect(h.skills.findById("sk_old")?.lifecycle).toEqual({ state: "active" });
  });

  it("合并采纳：先备好承接技能，再逐条归档写去向；来源缺失或管不了就整组拒绝", async () => {
    const fresh = await harness({
      skills: { a: recordOf("sk_a", "docx-writer"), b: recordOf("sk_b", "word-report") },
      proposals: [
        mergeProposal({
          target: {
            name: "doc-writing",
            description: "把材料写成 Word 文档",
            instructions: "1. 起草大纲。\n2. 用 docx 技能生成文件。\n3. 回读校验。",
          },
        }),
      ],
    });
    const landed = await fresh.service.applyProposal(fresh.actor, "cur_merge");
    expect(landed.status).toBe("applied");
    const targetId = String(landed.appliedSkillId);
    expect(targetId).toMatch(/^sk_/);
    expect(fresh.skills.listPersonal("u_owner").map((s) => s.name)).toEqual(["doc-writing", "docx-writer", "word-report"]);
    for (const id of ["sk_a", "sk_b"]) {
      expect(fresh.skills.findById(id)?.lifecycle).toMatchObject({
        state: "archived",
        absorbedInto: "doc-writing",
        absorbedIntoId: targetId,
      });
    }
    // 已生效的提案不能再忽略。
    await expect(fresh.service.dismissProposal("cur_merge", "还是不想合并")).rejects.toThrow("提案已生效，不能改为忽略");

    // 复用库里已有的一条承接：不新建技能，去向写成它自己的名字。
    const reuse = await harness({
      skills: {
        a: recordOf("sk_a", "docx-writer"),
        b: recordOf("sk_b", "word-report"),
        t: recordOf("sk_t", "report-docx"),
      },
      proposals: [mergeProposal()],
    });
    const reused = await reuse.service.applyProposal(reuse.actor, "cur_merge");
    expect(reused.appliedSkillId).toBe("sk_t");
    expect(reuse.skills.listPersonal("u_owner")).toHaveLength(3);
    expect(reuse.skills.findById("sk_a")?.lifecycle?.absorbedInto).toBe("report-docx");

    // 漂移一：来源被删 → 整组拒绝，一条都不归档。
    const drifted = await harness({
      skills: { a: recordOf("sk_a", "docx-writer") },
      proposals: [mergeProposal()],
    });
    await expect(drifted.service.applyProposal(drifted.actor, "cur_merge")).rejects.toThrow(
      "有来源技能已被删除，这组合并建议已经失效",
    );
    expect(drifted.skills.findById("sk_a")?.lifecycle).toBeUndefined();

    // 漂移二：来源不归本人管 → 整组拒绝，连承接技能也不建。
    const forbidden = await harness({
      role: "user",
      skills: {
        a: recordOf("sk_a", "docx-writer", { ownerId: "u_other" }),
        b: recordOf("sk_b", "word-report", { ownerId: "u_other" }),
      },
      proposals: [mergeProposal()],
    });
    await expect(forbidden.service.applyProposal(forbidden.actor, "cur_merge")).rejects.toThrow(
      "没有权限归档 docx-writer、word-report",
    );
    expect(forbidden.skills.listPersonal("u_owner")).toEqual([]);

    // 漂移三：承接技能被删。
    const targetGone = await harness({
      skills: { a: recordOf("sk_a", "docx-writer"), b: recordOf("sk_b", "word-report") },
      proposals: [mergeProposal()],
    });
    await expect(targetGone.service.applyProposal(targetGone.actor, "cur_merge")).rejects.toThrow(
      "承接技能已被删除，这组合并建议已经失效",
    );
  });

  it("忽略只标记并留下原因，超长原因截断", async () => {
    const h = await harness({
      skills: { old: recordOf("sk_old", "old-flow") },
      proposals: [archiveProposal(), archiveProposal({ id: "cur_long" })],
    });
    const dismissed = await h.service.dismissProposal("cur_seed", "  还在用，别动  ");
    expect(dismissed).toMatchObject({ status: "dismissed", dismissReason: "还在用，别动" });

    const long = await h.service.dismissProposal("cur_long", "长".repeat(CURATION_RULES.maxReasonChars + 40));
    expect(String(long.dismissReason)).toHaveLength(CURATION_RULES.maxReasonChars);
    expect(h.skills.findById("sk_old")?.lifecycle).toBeUndefined();
    await expect(h.service.dismissProposal("cur_none")).rejects.toThrow("策展提案不存在");
  });

  it("手动归档提案立刻可见、不重复，也不改状态", async () => {
    const h = await harness({ skills: { old: recordOf("sk_old", "old-flow", { updatedAt: daysAgo(3) }) } });
    const proposal = await h.service.proposeArchiveNow(h.actor, "sk_old");
    expect(proposal).toMatchObject({ kind: "archive", origin: "manual", skillId: "sk_old" });
    expect(proposal.evidence.subjects[0]?.idleDays).toBe(3);
    expect((await h.store.listProposals({ status: "pending" })).filter((p) => p.kind === "archive")).toHaveLength(1);

    const again = await h.service.proposeArchiveNow(h.actor, "sk_old");
    expect(again.id).toBe(proposal.id);
    expect(h.skills.findById("sk_old")?.lifecycle).toBeUndefined();

    await expect(h.service.proposeArchiveNow(h.actor, "sk_none")).rejects.toThrow("技能不存在");
    const guest = await harness({
      role: "user",
      skills: { shared: recordOf("sk_shared", "shared-old", { scope: "shared", ownerId: "u_admin" }) },
    });
    await expect(guest.service.proposeArchiveNow(guest.actor, "sk_shared")).rejects.toThrow(
      "没有权限归档这条技能",
    );
  });

  it("记账、快照与删除联动：已归档的技能也带着徽章", async () => {
    const h = await harness({
      skills: {
        live: recordOf("sk_live", "live-flow", { createdAt: daysAgo(5), updatedAt: daysAgo(5) }),
        gone: recordOf("sk_gone", "gone-flow", { lifecycle: { state: "archived", archivedAt: daysAgo(1) } }),
        other: recordOf("sk_other", "other-flow", { ownerId: "u_other" }),
      },
      usage: {
        sk_live: { useCount: 2, viewCount: 1, lastUsedAt: daysAgo(5) },
        sk_gone: { useCount: 7, lastUsedAt: daysAgo(80) },
        sk_other: { useCount: 99, lastUsedAt: daysAgo(1) },
        sk_ghost: { useCount: 3, lastUsedAt: daysAgo(1) },
      },
    });
    h.service.recordUsage("sk_live", "use");
    h.service.recordUsage("sk_live", "view");
    h.service.recordUsage("", "use");
    await untilUsage(h.store, "sk_live", (entry) => entry?.useCount === 3 && entry.viewCount === 2);
    await h.store.flush();

    const snapshot = await h.service.usageSnapshot();
    // 账本是全局的，快照只留这个账号看得见的（含已归档）；别人技能和已删技能都不进快照。
    expect(Object.keys(snapshot).sort()).toEqual(["sk_gone", "sk_live"]);
    expect(snapshot.sk_live).toMatchObject({ useCount: 3, viewCount: 2 });
    expect(snapshot.sk_gone?.useCount).toBe(7);
    expect(h.skills.listForAgent("u_owner").map((s) => s.name)).toEqual(["live-flow"]);

    // 正文被编辑 → 记一次 patch；技能被真删 → 账本跟着清掉，同名重建不会继承旧次数。
    const linked = new SkillLibrary(join(h.dir, "skills.json"), {
      seedShared: false,
      onPatch: (skillId) => h.store.recordPatch(skillId),
      onRemove: (skillId) => void h.store.forgetSkill(skillId),
    });
    await linked.init();
    await linked.update({ id: "u_owner", role: "admin" }, "sk_live", { instructions: "1. 换了个做法。" });
    await untilUsage(h.store, "sk_live", (entry) => entry?.patchCount === 1 && entry.patchGeneration === 1);
    await linked.remove({ id: "u_owner", role: "admin" }, "sk_gone");
    await untilUsage(h.store, "sk_gone", (entry) => entry === undefined);
    await h.store.flush();

    const after = await h.service.usageSnapshot();
    expect(after.sk_live).toMatchObject({ patchCount: 1, patchGeneration: 1, reuseAfterPatch: false });
    expect(after.sk_gone).toBeUndefined();
    expect(h.skills.listForAgent("u_owner").map((s) => s.name)).toEqual(["live-flow"]);
  });
});

// ---------------------------------------------------------------- 设置口径

describe("策展设置（sanitizeCuration）", () => {
  it("已知字段逐个校验，归档必须晚于闲置，未知字段直接拒绝", () => {
    expect(sanitizeCuration({ enabled: false, autoArchive: true, consolidate: true })).toEqual({
      enabled: false,
      autoArchive: true,
      consolidate: true,
    });
    expect(sanitizeCuration({ staleAfterDays: 7, archiveAfterDays: 21, intervalHours: 48 })).toEqual({
      staleAfterDays: 7,
      archiveAfterDays: 21,
      intervalHours: 48,
    });
    expect(sanitizeCuration({ modelRef: "  demo/mock  " })).toEqual({ modelRef: "demo/mock" });
    expect(sanitizeCuration({ modelRef: "" })).toEqual({});

    expect(() => sanitizeCuration([])).toThrow("curation 必须是对象");
    expect(() => sanitizeCuration({ intervalHours: 1 })).toThrow(/策展间隔需在/);
    expect(() => sanitizeCuration({ staleAfterDays: 0 })).toThrow("闲置阈值需在 1–90 天之间（整数）");
    expect(() => sanitizeCuration({ archiveAfterDays: 200 })).toThrow("归档阈值需在 7–180 天之间（整数）");
    expect(() => sanitizeCuration({ staleAfterDays: 30, archiveAfterDays: 30 })).toThrow(
      "归档阈值必须晚于闲置阈值",
    );
    expect(() => sanitizeCuration({ autoArchive: "yes" })).toThrow("策展开关必须是布尔值");
    expect(() => sanitizeCuration({ modelRef: 7 })).toThrow("策展模型引用必须是字符串");
    expect(() => sanitizeCuration({ archive: true })).toThrow("未知的策展字段 archive");
  });

  it("默认值就是 Hermes 的口径：14 天标记闲置、30 天提议归档、每周一次", () => {
    expect(DEFAULT_CURATION).toMatchObject({
      enabled: true,
      staleAfterDays: CURATION_RULES.staleAfterDays,
      archiveAfterDays: CURATION_RULES.archiveAfterDays,
      intervalHours: CURATION_RULES.intervalHours,
      autoArchive: false,
      consolidate: false,
    });
    expect(defaultSettings().curation).toEqual(DEFAULT_CURATION);
    const proposals: CurationProposal[] = [archiveProposal()];
    expect(proposals[0]?.kind).toBe("archive");
  });
});
