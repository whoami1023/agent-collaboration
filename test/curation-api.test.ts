// 技能策展 P3 的 HTTP 面：读路径顺手扫描、手动扫描、提案采纳/忽略、手动归档、生命周期开关与设置校验。
// 夹具直接落盘 skills.json 与 skill-usage.json，这样能造出「多少天前活动过」的样本；
// 每个用例单独起一套目录与服务，两个账号共用同一份全局账本与技能库（与线上一致）。

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { DAY_MS } from "../src/skills/curation/lifecycle";
import type {
  ConsolidationCurationProposal,
  LifecycleCurationProposal,
  SkillUsageRecord,
} from "../src/skills/curation/types";
import { SkillLibrary, type SkillRecord } from "../src/skills/library";
import { TemplateLibrary } from "../src/templates/template-library";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import { createApp } from "../src/server/app";

let dir: string | undefined;
let registry: WorkspaceRegistry | undefined;
let server: Server | undefined;
let baseUrl = "";
interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; auth?: string } = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.auth ? { cookie: options.auth } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return (response.headers.getSetCookie()[0] ?? "").split(";")[0];
}

interface Env {
  dir: string;
  skills: SkillLibrary;
  ownerId: string;
  ownerCookie: string;
  aliceId: string;
  aliceCookie: string;
}

const nowMs = Date.now();

function daysAgo(days: number): number {
  return nowMs - days * DAY_MS;
}

function skillOf(
  id: string,
  name: string,
  ownerId: string,
  overrides: Partial<SkillRecord> = {},
): SkillRecord {
  return {
    id,
    scope: "personal",
    ownerId,
    name,
    description: `用来验证策展接口的 ${name}`,
    instructions: "1. 打开文件。\n2. 按步骤执行。\n3. 回读确认结果。",
    createdAt: daysAgo(40),
    updatedAt: daysAgo(40),
    ...overrides,
  };
}

function usageOf(skillId: string, overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    skillId,
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    patchGeneration: 0,
    lastReusedPatchGeneration: 0,
    reuseAfterPatch: false,
    ...overrides,
  };
}

function archiveProposalOf(
  ownerId: string,
  skillId: string,
  id = "cur_seed",
): LifecycleCurationProposal {
  const createdAt = nowMs - 60_000;
  return {
    id,
    kind: "archive",
    status: "pending",
    origin: "sweep",
    createdAt,
    updatedAt: createdAt,
    ownerId,
    ownerName: "老板",
    reason: "用过 3 次，但连续 40 天没有任何活动",
    skillId,
    evidence: {
      subjects: [
        {
          skillId,
          skillName: "used-flow",
          scope: "personal",
          useCount: 3,
          viewCount: 0,
          patchCount: 0,
          idleDays: 40,
        },
      ],
      thresholdDays: 30,
      detail: "连续 40 天没活动，超过归档阈值 30 天。采纳后这条技能不再出现在智能体清单里，但正文保留、随时能恢复",
    },
  };
}

function mergeProposalOf(
  ownerId: string,
  sourceIds: readonly string[],
  target: { skillId?: string; name: string },
  id = "cur_merge",
): ConsolidationCurationProposal {
  const createdAt = nowMs - 60_000;
  return {
    id,
    kind: "consolidate",
    status: "pending",
    origin: "model",
    createdAt,
    updatedAt: createdAt,
    ownerId,
    ownerName: "老板",
    reason: `这几条技能做的是同一件事，建议收拢到「${target.name}」下`,
    sourceIds: [...sourceIds],
    target,
    evidence: { subjects: [], thresholdDays: 0, detail: "采纳后只归档、不删除" },
  };
}

/**
 * 起一套独立环境：先建账号（拿到 ownerId），再把技能库与账本落盘，最后装配服务器。
 * 账本里的 lastPassAt 要按 ownerId 记录，所以只能在账号建好之后写。
 */
async function boot(
  options: {
    skills?: (ownerId: string, aliceId: string) => SkillRecord[];
    usage?: Record<string, Partial<SkillUsageRecord>>;
    proposals?: (ownerId: string) => unknown[];
    lastPassAtOwner?: "now";
  } = {},
): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "ac-curationapi-"));
  dir = root;
  const auth = new AuthService(join(root, "auth.json"));
  await auth.init();
  const owner = await auth.setupAdmin({ username: "owner", displayName: "老板", password: "secret123" });
  const alice = await auth.createUser(owner.user, {
    username: "alice",
    displayName: "Alice",
    password: "alicepass1",
  });
  await mkdir(join(root, "workspaces", owner.user.id), { recursive: true });

  const skills = new SkillLibrary(join(root, "skills.json"), { seedShared: false });
  const records = options.skills?.(owner.user.id, alice.id) ?? [];
  if (records.length > 0) {
    await writeFile(join(root, "skills.json"), JSON.stringify({ skills: records }), "utf8");
  }
  await skills.init();

  const usage: Record<string, SkillUsageRecord> = {};
  for (const [skillId, overrides] of Object.entries(options.usage ?? {})) {
    usage[skillId] = usageOf(skillId, overrides);
  }
  await writeFile(
    join(root, "workspaces", "skill-usage.json"),
    JSON.stringify({
      usage,
      proposals: options.proposals?.(owner.user.id) ?? [],
      log: [],
      lastPassAt: options.lastPassAtOwner === "now" ? { [owner.user.id]: nowMs } : {},
    }),
    "utf8",
  );

  registry = new WorkspaceRegistry(join(root, "workspaces"), skills);
  const templates = new TemplateLibrary(join(root, "templates.json"));
  await templates.init();
  const app = createApp({ auth, workspaces: registry, skills, templates, webDist: join(root, "missing-dist") });
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器未监听");
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    dir: root,
    skills,
    ownerId: owner.user.id,
    ownerCookie: await login("owner", "secret123"),
    aliceId: alice.id,
    aliceCookie: await login("alice", "alicepass1"),
  };
}

interface SweepBody {
  log?: { outcome: string; detail: string; transitions: Array<{ skillId: string; to: string }>; modelRef: string };
  proposals: Array<Record<string, unknown>>;
  skipped?: string;
}

interface CurationBody {
  settings: Record<string, unknown>;
  proposals: Array<Record<string, unknown>>;
  log: Array<Record<string, unknown>>;
  usage: Record<string, SkillUsageRecord>;
  sweep: SweepBody;
}

afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  await registry?.closeAll();
  registry = undefined;
  if (dir) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    dir = undefined;
  }
});

describe("技能策展 REST", () => {
  it("未登录 401；读面板顺手扫一次：闲置直接落地，归档只出提案", async () => {
    const env = await boot({
      usage: {
        sk_used: { useCount: 3, lastUsedAt: daysAgo(40) },
        sk_never: {},
      },
      skills: (ownerId) => [
        skillOf("sk_used", "used-flow", ownerId),
        skillOf("sk_never", "never-flow", ownerId),
        skillOf("sk_fresh", "fresh-flow", ownerId, { createdAt: daysAgo(0), updatedAt: daysAgo(0) }),
      ],
    });

    expect((await call("/api/skills/curation")).status).toBe(401);

    // 阈值只在这次账号的设置里放短，用来造迁移；默认可跑不到这么快的闲置。
    const configured = await call("/api/settings", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { curation: { staleAfterDays: 1, archiveAfterDays: 7 } },
    });
    expect(configured.status).toBe(200);

    const panel = await call("/api/skills/curation", { auth: env.ownerCookie });
    expect(panel.status).toBe(200);
    const body = panel.body as unknown as CurationBody;
    expect(body.settings).toMatchObject({ enabled: true, staleAfterDays: 1, archiveAfterDays: 7 });
    expect(body.sweep.skipped).toBeUndefined();
    expect(body.sweep.log?.outcome).toBe("transitioned");
    expect(body.sweep.log?.detail).toContain("标记 2 条闲置");
    expect(body.sweep.log?.detail).toContain("产出 1 条待确认提案");
    expect(body.sweep.log?.transitions.map((item) => item.skillId).sort()).toEqual(["sk_never", "sk_used"]);

    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ kind: "archive", status: "pending", skillId: "sk_used" });
    expect(body.log).toHaveLength(1);
    expect(body.usage.sk_used).toMatchObject({ useCount: 3, viewCount: 0 });

    // 闲置只是标记：技能还在智能体清单里；归档也还没落地。
    const listed = await call("/api/skills", { auth: env.ownerCookie });
    const personal = listed.body["personal"] as Array<Record<string, unknown>>;
    expect(personal.find((item) => item["name"] === "used-flow")?.["lifecycle"]).toMatchObject({
      state: "stale",
    });

    // 间隔闸门：刚扫过一次，再读只回原因，不再迁移。
    const again = (await call("/api/skills/curation", { auth: env.ownerCookie })).body as unknown as CurationBody;
    expect(again.sweep.skipped).toContain("未到策展间隔");
    expect(again.log).toHaveLength(1);
  });

  it("POST sweep：force 越闸门；consolidate 打开后问一次模型，演示模型给不出 merges 也只留痕", async () => {
    const env = await boot({
      lastPassAtOwner: "now",
      skills: (ownerId) => [
        skillOf("sk_old", "old-flow", ownerId),
        skillOf("sk_a", "docx-writer", ownerId),
      ],
    });
    await call("/api/settings", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { curation: { staleAfterDays: 1, archiveAfterDays: 7 } },
    });

    const gated = await call("/api/skills/curation/sweep", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(gated.status).toBe(200);
    expect((gated.body as unknown as SweepBody).skipped).toContain("未到策展间隔");

    const forced = await call("/api/skills/curation/sweep", {
      method: "POST",
      auth: env.ownerCookie,
      body: { force: true },
    });
    expect(forced.status).toBe(200);
    const forcedBody = forced.body as unknown as SweepBody;
    expect(forcedBody.skipped).toBeUndefined();
    expect(forcedBody.log?.outcome).toBe("transitioned");
    expect(forcedBody.log?.detail).toContain("标记 2 条闲置");

    const merged = await call("/api/skills/curation/sweep", {
      method: "POST",
      auth: env.ownerCookie,
      body: { force: true, consolidate: true },
    });
    expect(merged.status).toBe(200);
    const mergedBody = merged.body as unknown as SweepBody;
    expect(mergedBody.log?.modelRef).toBe("demo/mock");
    // 演示模型不会按策展提示词输出 JSON：机制要求它只留痕、不出提案、不抛错。
    expect(mergedBody.proposals).toEqual([]);
    expect(mergedBody.log?.detail).toContain("merges");
  });

  it("采纳：闲置/归档提案直接落生命周期，重复采纳幂等，未知 404", async () => {
    const env = await boot({
      proposals: (ownerId) => [archiveProposalOf(ownerId, "sk_old")],
      skills: (ownerId) => [skillOf("sk_old", "old-flow", ownerId)],
    });

    const applied = await call("/api/skills/curation/proposals/cur_seed/apply", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(applied.status).toBe(200);
    expect(applied.body["proposal"]).toMatchObject({ id: "cur_seed", status: "applied" });
    const archived = await call("/api/skills", { auth: env.ownerCookie });
    const own = (archived.body["personal"] as Array<Record<string, unknown>>).find(
      (item) => item["id"] === "sk_old",
    );
    expect(own?.["lifecycle"]).toMatchObject({ state: "archived" });
    // 归档不删正文。
    expect(String(own?.["instructions"])).toContain("按步骤执行");

    const again = await call("/api/skills/curation/proposals/cur_seed/apply", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body["proposal"]).toMatchObject({ status: "applied" });

    const missing = await call("/api/skills/curation/proposals/cur_none/apply", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(missing.status).toBe(404);
    expect(missing.body["error"]).toBe("策展提案不存在");
  });

  it("提案在全局账本里，但别人的账号不能采纳别人的个人技能", async () => {
    const env = await boot({
      proposals: (ownerId) => [archiveProposalOf(ownerId, "sk_old")],
      skills: (ownerId) => [skillOf("sk_old", "old-flow", ownerId)],
    });

    const foreign = await call("/api/skills/curation/proposals/cur_seed/apply", {
      method: "POST",
      auth: env.aliceCookie,
      body: {},
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body["error"]).toBe("只能管理自己的个人技能");

    const listed = await call("/api/skills", { auth: env.ownerCookie });
    const own = (listed.body["personal"] as Array<Record<string, unknown>>).find(
      (item) => item["id"] === "sk_old",
    );
    expect(own?.["lifecycle"]).toBeUndefined();
  });

  it("忽略：默认原因、自定原因，已生效的不能再忽略", async () => {
    const env = await boot({
      proposals: (ownerId) => [
        archiveProposalOf(ownerId, "sk_old", "cur_one"),
        archiveProposalOf(ownerId, "sk_old", "cur_two"),
      ],
      skills: (ownerId) => [skillOf("sk_old", "old-flow", ownerId)],
    });

    const byDefault = await call("/api/skills/curation/proposals/cur_one/dismiss", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(byDefault.status).toBe(200);
    expect(byDefault.body["proposal"]).toMatchObject({ status: "dismissed", dismissReason: "用户忽略" });

    await call("/api/skills/curation/proposals/cur_two/apply", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    const rejected = await call("/api/skills/curation/proposals/cur_two/dismiss", {
      method: "POST",
      auth: env.ownerCookie,
      body: { reason: "晚了" },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body["error"]).toContain("提案已生效");

    const missing = await call("/api/skills/curation/proposals/cur_none/dismiss", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(missing.status).toBe(404);
  });

  it("手动归档提案 201、重复返回同一条、未知技能 400", async () => {
    const env = await boot({ skills: (ownerId) => [skillOf("sk_old", "old-flow", ownerId)] });

    const created = await call("/api/skills/curation/archive", {
      method: "POST",
      auth: env.ownerCookie,
      body: { skillId: "sk_old" },
    });
    expect(created.status).toBe(201);
    expect(created.body["proposal"]).toMatchObject({
      kind: "archive",
      origin: "manual",
      skillId: "sk_old",
      status: "pending",
    });

    const again = await call("/api/skills/curation/archive", {
      method: "POST",
      auth: env.ownerCookie,
      body: { skillId: "sk_old" },
    });
    expect(again.status).toBe(201);
    expect(again.body["proposal"]).toMatchObject({
      id: (created.body["proposal"] as { id: string }).id,
    });

    const missing = await call("/api/skills/curation/archive", {
      method: "POST",
      auth: env.ownerCookie,
      body: { skillId: "sk_none" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body["error"]).toBe("技能不存在");
  });

  it("生命周期开关：固定/归档/恢复、坏值 400、别人的技能 403", async () => {
    const stamp = daysAgo(40);
    const env = await boot({
      skills: (ownerId) => [skillOf("sk_old", "old-flow", ownerId, { createdAt: stamp, updatedAt: stamp })],
    });

    const pinned = await call("/api/skills/sk_old/lifecycle", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { pinned: true, state: "archived" },
    });
    expect(pinned.status).toBe(200);
    const pinnedSkill = pinned.body["skill"] as Record<string, unknown>;
    expect(pinnedSkill["lifecycle"]).toMatchObject({ state: "archived", pinned: true });
    // 生命周期迁移不刷新 updatedAt，否则闲置过的技能永远闲置不了。
    expect(pinnedSkill["updatedAt"]).toBe(stamp);

    const restored = await call("/api/skills/sk_old/lifecycle", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { state: "active", pinned: false },
    });
    expect((restored.body["skill"] as Record<string, unknown>)["lifecycle"]).toEqual({ state: "active" });

    const badState = await call("/api/skills/sk_old/lifecycle", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { state: "retired" },
    });
    expect(badState.status).toBe(400);
    expect(badState.body["error"]).toContain("生命周期只能是");

    const badPinned = await call("/api/skills/sk_old/lifecycle", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { pinned: "yes" },
    });
    expect(badPinned.status).toBe(400);
    expect(badPinned.body["error"]).toBe("固定标记必须是布尔值");

    const missing = await call("/api/skills/sk_none/lifecycle", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { state: "stale" },
    });
    expect(missing.status).toBe(404);

    const foreign = await call("/api/skills/sk_old/lifecycle", {
      method: "PUT",
      auth: env.aliceCookie,
      body: { state: "archived" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body["error"]).toBe("只能管理自己的个人技能");
  });

  it("合并采纳走 HTTP：复用承接技能并逐条归档，来源缺失整组拒绝", async () => {
    const env = await boot({
      proposals: (ownerId) => [
        mergeProposalOf(ownerId, ["sk_a", "sk_b"], { skillId: "sk_t", name: "report-docx" }),
      ],
      skills: (ownerId) => [
        skillOf("sk_a", "docx-writer", ownerId),
        skillOf("sk_b", "word-report", ownerId),
        skillOf("sk_t", "report-docx", ownerId),
      ],
    });

    const applied = await call("/api/skills/curation/proposals/cur_merge/apply", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(applied.status).toBe(200);
    expect(applied.body["proposal"]).toMatchObject({ status: "applied", appliedSkillId: "sk_t" });

    const listed = await call("/api/skills", { auth: env.ownerCookie });
    const personal = listed.body["personal"] as Array<Record<string, unknown>>;
    expect(personal).toHaveLength(3);
    for (const id of ["sk_a", "sk_b"]) {
      expect(personal.find((item) => item["id"] === id)?.["lifecycle"]).toMatchObject({
        state: "archived",
        absorbedInto: "report-docx",
        absorbedIntoId: "sk_t",
      });
    }
  });

  it("合并来源被删就整组拒绝，不留下半途状态", async () => {
    const env = await boot({
      proposals: (ownerId) => [
        mergeProposalOf(ownerId, ["sk_a", "sk_b"], { skillId: "sk_t", name: "report-docx" }),
      ],
      skills: (ownerId) => [skillOf("sk_a", "docx-writer", ownerId), skillOf("sk_t", "report-docx", ownerId)],
    });
    const rejected = await call("/api/skills/curation/proposals/cur_merge/apply", {
      method: "POST",
      auth: env.ownerCookie,
      body: {},
    });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body["error"])).toContain("已被删除");

    const listed = await call("/api/skills", { auth: env.ownerCookie });
    const a = (listed.body["personal"] as Array<Record<string, unknown>>).find(
      (item) => item["id"] === "sk_a",
    );
    expect(a?.["lifecycle"]).toBeUndefined();
  });

  it("PUT /api/settings 收口 curation 字段，坏值与未知字段 400", async () => {
    const env = await boot();

    const saved = await call("/api/settings", {
      method: "PUT",
      auth: env.ownerCookie,
      body: {
        curation: {
          enabled: true,
          staleAfterDays: 7,
          archiveAfterDays: 21,
          intervalHours: 48,
          autoArchive: true,
          consolidate: false,
          modelRef: "  demo/mock  ",
        },
      },
    });
    expect(saved.status).toBe(200);
    expect((saved.body["settings"] as { curation: unknown }).curation).toEqual({
      enabled: true,
      staleAfterDays: 7,
      archiveAfterDays: 21,
      intervalHours: 48,
      autoArchive: true,
      consolidate: false,
      modelRef: "demo/mock",
    });

    const cleared = await call("/api/settings", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { curation: { modelRef: "" } },
    });
    const curation = (cleared.body["settings"] as { curation: Record<string, unknown> }).curation;
    expect(curation).toMatchObject({ autoArchive: true, staleAfterDays: 7 });
    expect(curation["modelRef"] ?? undefined).toBeUndefined();

    const cases: Array<{ body: unknown; error: string }> = [
      { body: { enabled: "yes" }, error: "策展开关必须是布尔值" },
      { body: { staleAfterDays: 0 }, error: "闲置阈值需在 1–90 天" },
      { body: { archiveAfterDays: 3 }, error: "归档阈值需在 7–180 天" },
      { body: { staleAfterDays: 30, archiveAfterDays: 14 }, error: "归档阈值必须晚于闲置阈值" },
      { body: { intervalHours: 1 }, error: "策展间隔需在 24–720 小时" },
      { body: { modelRef: 42 }, error: "策展模型引用必须是字符串" },
      { body: { mystery: true }, error: "未知的策展字段 mystery" },
      { body: [], error: "curation 必须是对象" },
    ];
    for (const item of cases) {
      const bad = await call("/api/settings", {
        method: "PUT",
        auth: env.ownerCookie,
        body: { curation: item.body },
      });
      expect(bad.status).toBe(400);
      expect(String(bad.body["error"])).toContain(item.error);
    }

    // 失败的写入不该动上一次保存的值。
    const panel = (await call("/api/skills/curation", { auth: env.ownerCookie })).body as unknown as CurationBody;
    expect(panel.settings).toMatchObject({ staleAfterDays: 7, archiveAfterDays: 21, autoArchive: true });
  });

  it("关闭策展后读路径不扫描、不迁移，只说明原因", async () => {
    const env = await boot({
      usage: { sk_used: { useCount: 2, lastUsedAt: daysAgo(40) } },
      skills: (ownerId) => [skillOf("sk_used", "used-flow", ownerId)],
    });
    await call("/api/settings", {
      method: "PUT",
      auth: env.ownerCookie,
      body: { curation: { enabled: false, staleAfterDays: 1 } },
    });

    const panel = (await call("/api/skills/curation", { auth: env.ownerCookie })).body as unknown as CurationBody;
    expect(panel.sweep.skipped).toContain("策展已关闭");
    expect(panel.sweep.proposals).toEqual([]);
    expect(panel.log).toEqual([]);
    expect(panel.proposals).toEqual([]);

    const listed = await call("/api/skills", { auth: env.ownerCookie });
    const skill = (listed.body["personal"] as Array<Record<string, unknown>>).find(
      (item) => item["id"] === "sk_used",
    );
    expect(skill?.["lifecycle"]).toBeUndefined();
  });
});
