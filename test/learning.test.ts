// 学习层 P1（回合后复盘 → 长期记忆）。
// 覆盖三道闸门（格式校验 / 密钥拦截 / 去重）、复盘提示词解析、账本读写与迁移、
// 以及 LearningService 的触发条件与 propose / auto 两种落地模式。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { DEFAULT_LIMITS } from "../src/core/types";
import { SkillLibrary } from "../src/skills/library";
import {
  DEFAULT_LEARNING,
  defaultSettings,
  loadSettings,
  sanitizeLearning,
  type LearningMode,
  type Settings,
} from "../src/core/settings";
import type { LlmRequest } from "../src/provider/types";
import type { MockHandler } from "../src/provider/mock";
import { MemorySearchManager } from "../src/memory/manager";
import {
  buildDedupeEntries,
  containsSecret,
  isDuplicateOf,
  normalizeSkillName,
  validateCandidate,
  validateSkillCandidate,
} from "../src/agent/learning/filters";
import {
  LEARNING_SYSTEM_PROMPT,
  buildReviewUserPrompt,
  extractEntries,
  extractReview,
  type ReviewMaterial,
} from "../src/agent/learning/prompt";
import { LearningStore, dayKeyOf, normalizeProposal } from "../src/agent/learning/store";
import { LearningService, type LearningServiceDeps } from "../src/agent/learning/service";
import {
  LEARNING_RULES,
  type LearningProposal,
  type LearningRunInput,
  type MemoryProposal,
  type ReviewLog,
  type SkillProposal,
} from "../src/agent/learning/types";

let dir: string;
// 账本写入是延迟落盘的，afterEach 必须先 flush 再删目录，否则补写的临时文件会把目录重新建出来。
const openStores: LearningStore[] = [];

function newStore(file: string, onError?: (message: string) => void): LearningStore {
  const store = new LearningStore(file, onError);
  openStores.push(store);
  return store;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-learning-"));
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

const LONG_REPLY =
  "已按你的要求把包管理器统一换成 pnpm，README 与脚本里的 npm 命令也都改好了，后续提交沿用这个口径。";

function runInput(overrides: Partial<LearningRunInput> = {}): LearningRunInput {
  return {
    memberId: "m_main",
    memberName: "主智能体",
    memberRole: "main",
    modelRef: "demo/mock",
    roomId: "room_main",
    roomName: "测试作战室",
    runId: "run_1",
    triggerText: "以后这个仓库统一用 pnpm，不要再执行 npm install。",
    finalText: LONG_REPLY,
    toolNames: ["bash", "edit_file"],
    transcript: "用户：以后统一用 pnpm\n主智能体：好的，已经全部改完。",
    unattended: false,
    ...overrides,
  };
}

/** 复盘模型固定输出 entries / skills；省略参数表示输出空数组（最常见的正确回答）。 */
function reviewHandler(
  entries?: unknown[],
  onCall?: (request: LlmRequest) => void,
  skills?: unknown[],
): MockHandler {
  return (request) => {
    onCall?.(request);
    return { text: "```json\n" + JSON.stringify({ entries: entries ?? [], skills: skills ?? [] }) + "\n```" };
  };
}

function oneEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: "这个仓库统一使用 pnpm 作为包管理器，不要执行 npm install。",
    triggers: ["包管理器", "pnpm"],
    importance: 8,
    rationale: "用户：以后统一用 pnpm",
    ...overrides,
  };
}

function oneSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "pnpm-migration",
    description: "把一个 Node 仓库从 npm 切换到 pnpm 并同步脚本与文档",
    instructions:
      "1. 读取 package.json 与 CI 配置，确认现有包管理器。\n2. 用 pnpm import 生成锁文件。\n3. 把脚本与文档里的 npm 命令改成 pnpm。\n4. 运行测试确认依赖解析一致。",
    category: "engineering",
    triggers: ["迁移 pnpm", "包管理器"],
    rationale: "本轮完整跑通了切换流程",
    ...overrides,
  };
}

interface Harness {
  settings: Settings;
  store: LearningStore;
  memory: MemorySearchManager;
  service: LearningService;
  skills: SkillLibrary;
  learned: Array<{ proposals: readonly LearningProposal[]; log: ReviewLog }>;
  usageRecords: Array<{ ref: string }>;
}

function memoryOf(proposal: LearningProposal | undefined): MemoryProposal {
  if (!proposal || proposal.kind !== "memory") throw new Error("缺少记忆提案");
  return proposal;
}

function skillOf(proposal: LearningProposal | undefined): SkillProposal {
  if (!proposal || proposal.kind !== "skill") throw new Error("缺少技能提案");
  return proposal;
}

function harness(
  options: {
    mode?: LearningMode;
    everyNRuns?: number;
    dailyCap?: number;
    modelRef?: string;
    handler?: MockHandler;
    deps?: Partial<LearningServiceDeps>;
  } = {},
): Harness {
  const settings = defaultSettings();
  settings.providers = [{ id: "demo", api: "mock", models: [{ id: "mock" }] }];
  settings.selection = { ...settings.selection, defaultModel: "demo/mock", aliases: {}, fallbacks: [] };
  settings.learning = {
    mode: options.mode ?? "propose",
    everyNRuns: options.everyNRuns ?? 1,
    dailyCap: options.dailyCap ?? 20,
    ...(options.modelRef === undefined ? {} : { modelRef: options.modelRef }),
  };
  const memory = new MemorySearchManager({ workspaceDir: dir, bus: new RoomBus("room_main", "测试作战室") });
  const store = newStore(join(dir, "learning.json"));
  // 个人技能只在测试目录里落盘；不预装共享技能，避免噪声干扰技能提案。
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  const learned: Harness["learned"] = [];
  const usageRecords: Harness["usageRecords"] = [];
  const service = new LearningService({
    store,
    getSettings: () => settings,
    getModelDeps: () => ({ settings, dataDir: dir, mockHandler: options.handler ?? reviewHandler() }),
    memory,
    skills,
    skillOwner: { id: "u_test", role: "admin" },
    onLearned: (payload) => learned.push(payload),
    onUsageRecord: (record) => usageRecords.push(record),
    ...options.deps,
  });
  return { settings, store, memory, service, skills, learned, usageRecords };
}

describe("复盘闸门（filters）", () => {
  it("密钥与凭据形态一律拦截，正常技术陈述放行", () => {
    expect(containsSecret("DeepSeek key=sk-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(containsSecret("password: hunter22")).toBe(true);
    expect(containsSecret("https://user:pass@internal.example/api")).toBe(true);
    expect(containsSecret("这个仓库统一使用 pnpm 作为包管理器")).toBe(false);

    expect(validateCandidate({ content: "sk-abcdefghijklmnopqrstuvwxyz 可用于调用内部接口" })).toEqual({
      reason: "疑似包含密钥或凭据",
    });
  });

  it("承诺式开头、超长正文与非对象候选各给一条可读的丢弃原因", () => {
    expect(validateCandidate({ content: "好的，我接下来会注意这一点，后续都按这个来" })).toEqual({
      reason: "只是承诺或客套，不是事实",
    });
    expect(validateCandidate({ content: "我会把这件事记下来的，请放心使用新的流程安排" })).toEqual({
      reason: "只是承诺或客套，不是事实",
    });
    expect(validateCandidate({ content: "长".repeat(LEARNING_RULES.maxContentChars + 1) })).toEqual({
      reason: `正文超过 ${LEARNING_RULES.maxContentChars} 字`,
    });
    expect(validateCandidate({ content: "   " })).toEqual({ reason: "正文为空" });
    expect(validateCandidate(null)).toEqual({ reason: "候选不是对象" });
  });

  it("正文折叠空白，triggers 去空去密钥、截断并限数量，importance 夹到 1–10", () => {
    const ok = validateCandidate({
      content: "  网关   决策：内部服务\n间通信用 gRPC   ",
      triggers: [
        " 网关 决策 ",
        "sk-abcdefghijklmnopqrstuvwxyz",
        "",
        "x".repeat(80),
        "第二个",
        "第三个",
        "第四个",
        "第五个",
        "第六个",
      ],
      importance: 99,
      rationale: "  依据\n原文  ",
    });
    if ("reason" in ok) throw new Error("应当通过校验");
    expect(ok.content).toBe("网关 决策：内部服务 间通信用 gRPC");
    expect(ok.triggers).toHaveLength(LEARNING_RULES.maxTriggers);
    expect(ok.triggers[0]).toBe("网关 决策");
    expect(ok.triggers.some((item) => item.length > LEARNING_RULES.maxTriggerChars)).toBe(false);
    expect(ok.triggers.some((item) => item === "第六个")).toBe(false);
    expect(ok.importance).toBe(10);
    expect(ok.rationale).toBe("依据 原文");

    const low = validateCandidate({ content: "本机安装了 Docker Desktop。", importance: 0 });
    if ("reason" in low) throw new Error("应当通过校验");
    expect(low.importance).toBe(1);
    expect(validateCandidate({ content: "本机安装了 Docker Desktop。", importance: "9" })).toMatchObject({ importance: 5 });
  });

  it("去重忽略标点与空白，同一条事实换个说法也算重复", () => {
    const entries = ["- 用户偏好：这个仓库统一使用 pnpm 作为包管理器 <!-- importance: 8 -->"];
    expect(isDuplicateOf("这个仓库统一使用pnpm作为包管理器", entries.map((line) => line.replace(/^-\s*/, "")))).toBe(true);
    expect(isDuplicateOf("结论：这个仓库统一使用 pnpm 作为包管理器。", entries.map((line) => line.replace(/^-\s*/, "")))).toBe(true);
    expect(isDuplicateOf("部署脚本需要 root 权限才能跑。", entries.map((line) => line.replace(/^-\s*/, "")))).toBe(false);
    // 归一化后不足 8 字的短条目不参与包含判断，避免「好的」这类词到处误命中。
    expect(isDuplicateOf("用 pnpm", entries)).toBe(false);
  });

  it("去重语料 = 记忆条目行（去掉列表符号与标题）+ 待确认提案", () => {
    const memory = ["# 长期记忆", "", "- 第一条既有事实", "  * 第二条既有事实", "正文行没有列表符号"].join("\n");
    const pending = [{ kind: "memory", content: "还没确认的提案" }] as MemoryProposal[];
    expect(buildDedupeEntries(memory, pending)).toEqual([
      "第一条既有事实",
      "第二条既有事实",
      "正文行没有列表符号",
      "还没确认的提案",
    ]);
  });

  it("技能名统一 slug 化，转不出合法名字就放弃提议", () => {
    expect(normalizeSkillName("  My Skill_2 ")).toBe("my-skill-2");
    expect(normalizeSkillName("pnpm---migration")).toBe("pnpm-migration");
    expect(normalizeSkillName("技能")).toBeUndefined();
    expect(normalizeSkillName("")).toBeUndefined();
    expect(normalizeSkillName(42)).toBeUndefined();
  });

  it("技能候选按技能库口径收口：名称、描述、说明长度、分类与密钥", () => {
    const ok = validateSkillCandidate(oneSkill());
    if ("reason" in ok) throw new Error("应当通过校验");
    expect(ok).toMatchObject({
      name: "pnpm-migration",
      description: "把一个 Node 仓库从 npm 切换到 pnpm 并同步脚本与文档",
      category: "engineering",
      triggers: ["迁移 pnpm", "包管理器"],
      rationale: "本轮完整跑通了切换流程",
    });
    expect(ok.instructions).toContain("pnpm import");

    expect(validateSkillCandidate({ ...oneSkill(), name: "Bad Name!" })).toMatchObject({ name: "bad-name" });
    expect(validateSkillCandidate({ ...oneSkill(), name: "技能" })).toEqual({
      reason: "技能名需为小写字母、数字或短横线（最长 48 位）",
    });
    expect(validateSkillCandidate({ ...oneSkill(), description: "  " })).toEqual({ reason: "技能描述为空" });
    expect(
      validateSkillCandidate({ ...oneSkill(), description: "长".repeat(LEARNING_RULES.maxSkillDescriptionChars + 1) }),
    ).toEqual({ reason: `技能描述超过 ${LEARNING_RULES.maxSkillDescriptionChars} 字` });
    expect(validateSkillCandidate({ ...oneSkill(), instructions: "太短" })).toEqual({
      reason: `技能说明少于 ${LEARNING_RULES.minSkillInstructionsChars} 字`,
    });
    expect(
      validateSkillCandidate({ ...oneSkill(), instructions: "长".repeat(LEARNING_RULES.maxSkillInstructionsChars + 1) }),
    ).toEqual({ reason: `技能说明超过 ${LEARNING_RULES.maxSkillInstructionsChars} 字` });
    expect(
      validateSkillCandidate({ ...oneSkill(), instructions: `${"步骤".repeat(20)} password: hunter22` }),
    ).toEqual({ reason: "技能说明疑似包含密钥或凭据" });
    expect(validateSkillCandidate(null)).toEqual({ reason: "技能候选不是对象" });

    const inferred = validateSkillCandidate({
      ...oneSkill(),
      name: "tanzania-research",
      description: "为坦桑尼亚调研生成结构化提纲",
      category: "不存在的分类",
    });
    if ("reason" in inferred) throw new Error("应当通过校验");
    expect(inferred.category).toBe("research");

    const capped = validateSkillCandidate({
      ...oneSkill(),
      triggers: ["一", "二", "三", "四", "五", "六"],
    });
    if ("reason" in capped) throw new Error("应当通过校验");
    expect(capped.triggers).toHaveLength(LEARNING_RULES.maxTriggers);
  });
});

describe("复盘提示词（prompt）", () => {
  it("系统提示是逐字常量：不含本轮素材，便于命中上游上下文缓存", () => {
    expect(LEARNING_SYSTEM_PROMPT).toContain("复盘助手");
    expect(LEARNING_SYSTEM_PROMPT).toContain('{"entries":[],"skills":[]}');
    expect(LEARNING_SYSTEM_PROMPT).toContain(String(LEARNING_RULES.maxEntriesPerReview));
    expect(LEARNING_SYSTEM_PROMPT).toContain(String(LEARNING_RULES.maxSkillsPerReview));
    expect(LEARNING_SYSTEM_PROMPT).not.toContain("pnpm");
    expect(LEARNING_SYSTEM_PROMPT).not.toContain("room_main");
    // Hermes 的 DO_NOT_CAPTURE：失败序列不得包装成可靠流程。
    expect(LEARNING_SYSTEM_PROMPT).toContain("没跑通的做法不是技能");
    expect(LEARNING_SYSTEM_PROMPT).toContain("不要写死路");
    expect(LEARNING_SYSTEM_PROMPT).toContain("指不出出处的「事实」不要记");
  });

  it("用户素材分区拼装并各自截断，末尾固定要求输出 JSON", () => {
    const material: ReviewMaterial = {
      roomName: "测试作战室",
      memberName: "主智能体",
      memberRole: "main",
      target: "account",
      targetFile: "MEMORY.md",
      triggerText: "以后统一用 pnpm",
      finalText: LONG_REPLY,
      toolNames: ["bash", "edit_file"],
      transcript: "很长的记录".repeat(3000),
      existingMemory: "",
      existingSkills: "",
    };
    const prompt = buildReviewUserPrompt(material);
    expect(prompt).toContain("群聊：测试作战室");
    expect(prompt).toContain("被复盘的成员：@主智能体（主智能体）");
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("bash、edit_file");
    expect(prompt).toContain("（空）");
    expect(prompt).toContain("【本轮群聊记录】");
    expect(prompt).toContain("已截断");
    expect(prompt.length).toBeLessThan(LEARNING_RULES.transcriptChars + LEARNING_RULES.memorySnapshotChars + 3000);
    expect(prompt.endsWith("现在输出 JSON。")).toBe(true);

    const sub = buildReviewUserPrompt({
      ...material,
      memberRole: "sub",
      memberName: "调研员",
      target: "member",
      targetFile: "agents/m_doc/MEMORY.md",
      toolNames: [],
    });
    expect(sub).toContain("@调研员（子成员）");
    expect(sub).toContain("agents/m_doc/MEMORY.md");
    expect(sub).toContain("（本轮没有调用工具）");
    expect(sub).toContain("【已有技能（不要重复提议）】");
    expect(sub).toContain("（无）");

    const withSkills = buildReviewUserPrompt({
      ...material,
      existingSkills: "- pnpm-migration：把一个 Node 仓库从 npm 切换到 pnpm",
    });
    expect(withSkills).toContain("pnpm-migration：把一个 Node 仓库从 npm 切换到 pnpm");
  });

  it("extractEntries 容忍代码块与前后闲话，解析不出 entries 数组就返回 undefined", () => {
    expect(extractEntries('{"entries":[]}')).toEqual([]);
    expect(extractEntries("```json\n{\"entries\":[{\"content\":\"a\"}]}\n```")).toEqual([{ content: "a" }]);
    expect(extractEntries("好的，这是结果：\n{\"entries\":[{\"content\":\"a\"}]}\n希望有帮助")).toEqual([
      { content: "a" },
    ]);
    expect(extractEntries("这一轮没有值得记的东西。")).toBeUndefined();
    expect(extractEntries("{\"entries\":[")).toBeUndefined();
    expect(extractEntries("{\"note\":\"没有 entries 字段\"}")).toBeUndefined();
    expect(extractEntries("{}")).toBeUndefined();
  });

  it("extractReview 同时取记忆与技能，允许只输出其中一类", () => {
    expect(extractReview('{"entries":[{"content":"a"}],"skills":[{"name":"x"}]}')).toEqual({
      entries: [{ content: "a" }],
      skills: [{ name: "x" }],
    });
    expect(extractReview('{"skills":[{"name":"x"}]}')).toEqual({ entries: [], skills: [{ name: "x" }] });
    expect(extractReview('{"entries":[{"content":"a"}]}')).toEqual({ entries: [{ content: "a" }], skills: [] });
    expect(extractEntries('{"skills":[{"name":"x"}]}')).toEqual([]);
    // 字段存在但不是数组，说明模型没有按约定输出，整轮按失败处理。
    expect(extractReview('{"entries":"不是数组"}')).toBeUndefined();
    expect(extractReview('{"skills":{}}')).toBeUndefined();
    expect(extractReview("这一轮没有值得沉淀的东西。")).toBeUndefined();
  });
});

describe("学习账本（LearningStore）", () => {
  const proposal = (id: string, createdAt: number, status: MemoryProposal["status"] = "pending"): MemoryProposal => ({
    id,
    kind: "memory",
    status,
    createdAt,
    updatedAt: createdAt,
    memberId: "m_main",
    memberName: "主智能体",
    memberRole: "main",
    roomId: "room_main",
    roomName: "测试作战室",
    runId: "run_1",
    target: "account",
    content: `第 ${id} 条事实`,
    triggers: ["pnpm"],
    importance: 6,
    rationale: "依据",
  });

  it("提案与流水按新到旧排列，跨实例读回同一份账本", async () => {
    const file = join(dir, "learning.json");
    const store = newStore(file);
    await store.addProposals([proposal("mem_old", 1000), proposal("mem_new", 2000)]);
    await store.addLog({
      id: "rev_1",
      at: 1500,
      memberId: "m_main",
      memberName: "主智能体",
      roomId: "room_main",
      runId: "run_1",
      outcome: "proposed",
      detail: "产出 2 条待确认提案",
      proposalIds: ["mem_old", "mem_new"],
      modelRef: "demo/mock",
    });
    await store.flush();

    const reopened = newStore(file);
    expect((await reopened.listProposals()).map((item) => item.id)).toEqual(["mem_new", "mem_old"]);
    expect((await reopened.listProposals({ status: "pending" })).map((item) => item.id)).toEqual([
      "mem_new",
      "mem_old",
    ]);
    expect((await reopened.listLog())[0]?.proposalIds).toEqual(["mem_old", "mem_new"]);
    expect(await reopened.reviewsToday(1500)).toBe(1);
    expect(await reopened.reviewsToday(Date.UTC(2020, 0, 1))).toBe(0);

    const patched = await reopened.patchProposal("mem_new", { status: "applied", appliedPath: "MEMORY.md" });
    expect(patched?.status).toBe("applied");
    expect(await reopened.getProposal("mem_missing")).toBeUndefined();
    expect(await reopened.patchProposal("mem_missing", { status: "applied" })).toBeUndefined();
  });

  it("技能提案与记忆提案共用账本，可按 kind 过滤并跨实例读回", async () => {
    const file = join(dir, "kind-learning.json");
    const skillProposal: SkillProposal = {
      id: "skill_1",
      kind: "skill",
      status: "pending",
      createdAt: 2000,
      updatedAt: 2000,
      memberId: "m_doc",
      memberName: "调研员",
      memberRole: "sub",
      roomId: "room_main",
      roomName: "测试作战室",
      runId: "run_1",
      rationale: "依据",
      skill: {
        name: "pnpm-migration",
        description: "把一个 Node 仓库从 npm 切换到 pnpm",
        instructions: "第一步：读取 package.json。第二步：生成锁文件。",
        category: "engineering",
        triggers: ["pnpm"],
      },
    };

    const store = newStore(file);
    await store.addProposals([proposal("mem_1", 1000), skillProposal]);
    await store.flush();

    const reopened = newStore(file);
    expect((await reopened.listProposals()).map((item) => item.kind)).toEqual(["skill", "memory"]);
    expect((await reopened.listProposals({ kind: "skill" })).map((item) => item.id)).toEqual(["skill_1"]);
    expect((await reopened.listProposals({ kind: "memory" })).map((item) => item.id)).toEqual(["mem_1"]);
    expect(skillOf(await reopened.getProposal("skill_1"))).toMatchObject({
      memberRole: "sub",
      skill: {
        name: "pnpm-migration",
        category: "engineering",
        triggers: ["pnpm"],
      },
    });
  });

  it("P1 老账本没有 kind 的记录补成记忆提案，字段不全的技能记录整条丢弃", async () => {
    const file = join(dir, "legacy-learning.json");
    await writeFile(
      file,
      JSON.stringify({
        proposals: [
          {
            id: "mem_legacy",
            status: "pending",
            createdAt: 1000,
            memberId: "m_main",
            memberName: "主智能体",
            memberRole: "main",
            roomId: "room_main",
            roomName: "测试作战室",
            runId: "run_1",
            target: "account",
            content: "老账本里的记忆事实",
            triggers: ["pnpm"],
            importance: 7,
            rationale: "依据",
          },
          {
            id: "skill_broken",
            status: "pending",
            createdAt: 2000,
            kind: "skill",
            skill: { name: "broken", description: "缺少说明" },
          },
          {
            id: "skill_legacy",
            status: "pending",
            createdAt: 3000,
            kind: "skill",
            skill: { name: "legacy-skill", description: "旧技能", instructions: "步骤" },
          },
        ],
        log: [],
      }),
      "utf8",
    );

    const listed = await newStore(file).listProposals();
    expect(listed.map((item) => item.id)).toEqual(["skill_legacy", "mem_legacy"]);
    expect(listed[0]).toMatchObject({ kind: "skill", skill: { category: "other" } });
    expect(memoryOf(listed[1]).content).toBe("老账本里的记忆事实");
    expect(normalizeProposal({ id: "mem_weird", status: "pending", createdAt: 1, kind: "weird", content: "按记忆处理" }))
      .toMatchObject({ kind: "memory" });
  });

  it("坏 JSON 与畸形条目退回空账本而不是让工作区加载失败", async () => {
    const file = join(dir, "broken-learning.json");
    await writeFile(file, "{ 这不是 JSON", "utf8");
    const errors: string[] = [];
    const store = newStore(file, (message) => errors.push(message));
    expect(await store.listProposals()).toEqual([]);
    expect(errors[0]).toContain("学习账本读取失败");
  });

  it("每日复盘数只数当天的流水，条目上限裁掉最老的部分", async () => {
    const file = join(dir, "cap-learning.json");
    const store = newStore(file);
    const now = Date.now();
    await store.addProposals(
      Array.from({ length: LEARNING_RULES.maxProposals + 20 }, (_, index) =>
        proposal(`mem_${index}`, now + index),
      ),
    );
    expect(await store.listProposals()).toHaveLength(LEARNING_RULES.maxProposals);
    expect(dayKeyOf(Date.UTC(2026, 10, 5, 23, 59))).toBe("2026-11-05");
  });
});

describe("设置：学习层字段", () => {
  it("sanitizeLearning 收口取值范围，未知字段与坏值直接报错", () => {
    expect(sanitizeLearning({ mode: "auto", everyNRuns: 3, dailyCap: 50, modelRef: " demo/mock " })).toEqual({
      mode: "auto",
      everyNRuns: 3,
      dailyCap: 50,
      modelRef: "demo/mock",
    });
    expect(sanitizeLearning({ modelRef: "   " })).toEqual({ modelRef: undefined });
    expect(sanitizeLearning({})).toEqual({});
    expect(() => sanitizeLearning([])).toThrow("learning 必须是对象");
    expect(() => sanitizeLearning({ mode: "always" })).toThrow(/复盘模式只能是/);
    expect(() => sanitizeLearning({ everyNRuns: 0 })).toThrow(/1–20/);
    expect(() => sanitizeLearning({ everyNRuns: 2.5 })).toThrow(/1–20/);
    expect(() => sanitizeLearning({ dailyCap: 201 })).toThrow(/1–200/);
    expect(() => sanitizeLearning({ modelRef: 42 })).toThrow(/必须是字符串/);
    expect(() => sanitizeLearning({ everyday: true })).toThrow(/未知的学习层字段 everyday/);
  });

  it("v4 设置文件缺 learning 时补默认值，坏字段退回默认而不是报错", async () => {
    const file = join(dir, "settings-v4.json");
    await writeFile(
      file,
      JSON.stringify({ settingsVersion: 4, providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }] }),
      "utf8",
    );
    expect((await loadSettings(file)).learning).toEqual(DEFAULT_LEARNING);

    const broken = join(dir, "settings-v4-broken.json");
    await writeFile(
      broken,
      JSON.stringify({ settingsVersion: 4, learning: { mode: "always", everyNRuns: 999 } }),
      "utf8",
    );
    expect((await loadSettings(broken)).learning).toEqual(DEFAULT_LEARNING);

    const kept = join(dir, "settings-v4-partial.json");
    await writeFile(kept, JSON.stringify({ settingsVersion: 4, learning: { mode: "off" } }), "utf8");
    expect((await loadSettings(kept)).learning).toEqual({ ...DEFAULT_LEARNING, mode: "off" });
  });
});

describe("复盘服务（LearningService）触发条件", () => {
  it("mode=off 时完全不触发：不调模型、不留流水", async () => {
    let calls = 0;
    const h = harness({ mode: "off", handler: reviewHandler([oneEntry()], () => void calls++) });
    await h.service.afterRun(runInput());
    expect(calls).toBe(0);
    expect(await h.store.listProposals()).toEqual([]);
    expect(await h.store.listLog()).toEqual([]);
    expect(h.learned).toHaveLength(0);
  });

  it("无人值守（定时任务）与短回复不复盘", async () => {
    let calls = 0;
    const handler = reviewHandler([oneEntry()], () => void calls++);

    const unattended = harness({ handler });
    await unattended.service.afterRun(runInput({ unattended: true }));
    expect(calls).toBe(0);
    expect(await unattended.store.listLog()).toEqual([]);

    const short = harness({ handler });
    await short.service.afterRun(runInput({ finalText: "改好了。" }));
    expect(calls).toBe(0);

    const blank = harness({ handler });
    await blank.service.afterRun(runInput({ finalText: " ".repeat(200) }));
    expect(calls).toBe(0);
  });

  it("每 N 轮复盘一次：计数取模，不足 N 轮的直接放行不留痕", async () => {
    let calls = 0;
    const h = harness({ everyNRuns: 3, handler: reviewHandler([oneEntry()], () => void calls++) });
    for (let index = 0; index < 2; index += 1) {
      await h.service.afterRun(runInput({ runId: `run_${index}` }));
    }
    expect(calls).toBe(0);
    await h.service.afterRun(runInput({ runId: "run_3" }));
    expect(calls).toBe(1);
    expect(await h.store.listProposals({ status: "pending" })).toHaveLength(1);
  });

  it("每日上限命中后只记一条 skipped，不再调用模型", async () => {
    let calls = 0;
    const h = harness({ dailyCap: 1, handler: reviewHandler([oneEntry()], () => void calls++) });
    await h.service.afterRun(runInput({ runId: "run_1" }));
    expect(calls).toBe(1);
    await h.service.afterRun(runInput({ runId: "run_2" }));
    expect(calls).toBe(1);

    const log = await h.store.listLog();
    expect(log[0]?.outcome).toBe("skipped");
    expect(log[0]?.detail).toContain("达到每日上限");
    expect(await h.store.listProposals({ status: "pending" })).toHaveLength(1);
  });

  it("复盘走一次没有工具的单轮补全，系统提示逐字复用", async () => {
    const requests: LlmRequest[] = [];
    const h = harness({ handler: reviewHandler([oneEntry()], (request) => requests.push(request)) });
    await h.service.afterRun(runInput());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.messages[0]).toEqual({ role: "system", content: LEARNING_SYSTEM_PROMPT });
    expect(requests[0]?.messages[1]?.content).toContain("【成员本轮的回复】");
    expect(requests[0]?.signal).toBeDefined();
  });

  it("成员模型不可用时记 failed 流水，不影响群聊", async () => {
    const h = harness({ modelRef: "ghost/model" });
    await h.service.afterRun(runInput());
    const log = await h.store.listLog();
    expect(log[0]?.outcome).toBe("failed");
    expect(log[0]?.detail).toContain("复盘模型不可用");
    expect(await h.store.listProposals()).toEqual([]);
  });

  it("模型输出不是 JSON 时本轮不写入，只留一条 failed", async () => {
    const h = harness({ handler: () => ({ text: "这一轮没有值得长期记住的东西，我不写了。" }) });
    await h.service.afterRun(runInput());
    const log = await h.store.listLog();
    expect(log[0]?.outcome).toBe("failed");
    expect(log[0]?.detail).toContain("不是可解析的 JSON");
    expect(await h.store.listProposals()).toEqual([]);
  });

  it("afterRun 永不抛错：账本坏了也只走 onError", async () => {
    const settings = defaultSettings();
    settings.providers = [{ id: "demo", api: "mock", models: [{ id: "mock" }] }];
    settings.learning = { mode: "propose", everyNRuns: 1, dailyCap: 20 };
    const failingStore = {
      reviewsToday: async () => {
        throw new Error("磁盘坏了");
      },
    } as unknown as LearningStore;
    const errors: string[] = [];
    const service = new LearningService({
      store: failingStore,
      getSettings: () => settings,
      getModelDeps: () => ({ settings, dataDir: dir, mockHandler: reviewHandler([oneEntry()]) }),
      memory: new MemorySearchManager({ workspaceDir: dir, bus: new RoomBus("room_main", "测试作战室") }),
      onError: (message) => errors.push(message),
    });
    await expect(service.afterRun(runInput())).resolves.toBeUndefined();
    expect(errors[0]).toContain("复盘失败");
  });
});

describe("复盘服务（LearningService）产出与落地", () => {
  it("propose 模式只产出待确认记忆提案，绝不碰记忆文件", async () => {
    const h = harness({ mode: "propose", handler: reviewHandler([oneEntry({ importance: 9 })]) });
    await h.service.afterRun(runInput());

    const pending = await h.store.listProposals({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(memoryOf(pending[0]).content).toBe("这个仓库统一使用 pnpm 作为包管理器，不要执行 npm install。");
    expect(memoryOf(pending[0]).target).toBe("account");
    expect(memoryOf(pending[0]).triggers).toEqual(["包管理器", "pnpm"]);
    expect(memoryOf(pending[0]).importance).toBe(9);
    expect(pending[0]?.memberId).toBe("m_main");
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);

    const log = await h.store.listLog();
    expect(log[0]?.outcome).toBe("proposed");
    expect(log[0]?.detail).toContain("产出 1 条待确认记忆");
    expect(log[0]?.modelRef).toBe("demo/mock");
    expect(log[0]?.proposalIds).toEqual([pending[0]?.id]);
    expect(h.learned[0]?.proposals).toHaveLength(1);
    expect(h.usageRecords[0]?.ref).toBe("demo/mock");
  });

  it("auto 模式直接落盘：主智能体写账号 MEMORY.md，子成员写自己的档案", async () => {
    const account = harness({ mode: "auto", handler: reviewHandler([oneEntry()]) });
    await account.service.afterRun(runInput());
    const accountLog = await account.store.listLog();
    expect(accountLog[0]?.outcome).toBe("applied");
    expect(accountLog[0]?.detail).toContain("自动写入 1/1 条");
    const written = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(written).toContain("# 长期记忆");
    expect(written).toContain("- 这个仓库统一使用 pnpm 作为包管理器，不要执行 npm install。");
    expect(written).toContain("<!-- trigger: 包管理器, pnpm -->");
    expect(written).toContain("<!-- importance: 8 -->");
    expect((await account.store.listProposals())[0]?.appliedPath).toBe("MEMORY.md");

    const second = harness({
      mode: "auto",
      handler: reviewHandler([oneEntry({ content: "调研员负责的房间统一用中文命名。", rationale: "用户：房间名统一中文" })]),
    });
    await second.service.afterRun(runInput({ memberId: "m_doc", memberName: "调研员", memberRole: "sub" }));
    expect((await second.store.listProposals())[0]).toMatchObject({ kind: "memory", target: "member" });
    const own = await readFile(join(dir, "agents", "m_doc", "MEMORY.md"), "utf8");
    expect(own).toContain("调研员负责的房间统一用中文命名。");
    expect(await second.memory.readAgentFile("agents/m_doc/MEMORY.md", { full: true })).toMatchObject({
      content: expect.stringContaining("中文命名"),
    });
  });

  it("既有的记忆与待确认提案让重复条目被丢弃，本轮记 nothing", async () => {
    await writeFile(
      join(dir, "MEMORY.md"),
      "# 长期记忆\n\n- 用户偏好：这个仓库统一使用 pnpm 作为包管理器，不要执行 npm install。\n",
      "utf8",
    );
    const h = harness({
      handler: reviewHandler([oneEntry(), oneEntry({ content: "这个仓库统一使用 pnpm 作为包管理器，不要执行 npm install。" })]),
    });
    await h.service.afterRun(runInput());
    expect(await h.store.listProposals()).toEqual([]);
    const log = await h.store.listLog();
    expect(log[0]?.outcome).toBe("nothing");
    expect(log[0]?.detail).toContain("丢弃 2 条");
    expect(log[0]?.detail).toContain("重复");
  });

  it("单次最多产出 3 条，模型给出更多也截断", async () => {
    const h = harness({
      handler: reviewHandler(
        Array.from({ length: 6 }, (_, index) => oneEntry({ content: `第 ${index} 条独立的部署约定，彼此不重复。` })),
      ),
    });
    await h.service.afterRun(runInput());
    expect(await h.store.listProposals({ status: "pending" })).toHaveLength(LEARNING_RULES.maxEntriesPerReview);
    expect((await h.store.listLog())[0]?.outcome).toBe("proposed");
  });

  it("模型认为没得学（entries 为空）也要留一条 nothing 流水并广播", async () => {
    const h = harness();
    await h.service.afterRun(runInput());
    expect((await h.store.listLog())[0]?.outcome).toBe("nothing");
    expect(h.learned).toHaveLength(1);
    expect(h.learned[0]?.proposals).toEqual([]);
  });

  it("采纳提案才写入记忆；已写入的不能忽略，已忽略的不能再生效", async () => {
    const h = harness({ handler: reviewHandler([oneEntry()]) });
    await h.service.afterRun(runInput());
    const [proposal] = await h.store.listProposals();
    if (!proposal) throw new Error("缺少提案");

    const applied = await h.service.applyProposal(proposal.id);
    expect(applied).toMatchObject({ status: "applied", appliedPath: "MEMORY.md" });
    expect(typeof applied.appliedAt).toBe("number");
    expect(await h.service.applyProposal(proposal.id)).toMatchObject({ status: "applied" });
    await expect(h.service.dismissProposal(proposal.id)).rejects.toThrow("已写入记忆的提案不能忽略");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("pnpm");

    const other = harness({ handler: reviewHandler([oneEntry({ content: "看板任务卡默认状态是 todo。" })]) });
    await other.service.afterRun(runInput({ memberId: "m_other", runId: "run_other" }));
    const [dismissed] = await other.store.listProposals();
    if (!dismissed) throw new Error("缺少提案");
    expect(await other.service.dismissProposal(dismissed.id, "一次性事实")).toMatchObject({
      status: "dismissed",
      dismissReason: "一次性事实",
    });
    await expect(other.service.applyProposal(dismissed.id)).rejects.toThrow("提案已忽略");
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);

    await expect(h.service.applyProposal("mem_missing")).rejects.toThrow("提案不存在");
    await expect(h.service.dismissProposal("mem_missing")).rejects.toThrow("提案不存在");
  });

  it("成员被移除后它的待确认提案一并 dismissed，历史流水保留", async () => {
    const h = harness({ handler: reviewHandler([oneEntry()]) });
    await h.service.afterRun(runInput());
    expect(await h.service.dropMember("m_main")).toBe(1);
    expect((await h.store.listProposals())[0]).toMatchObject({ status: "dismissed", dismissReason: "成员已移除" });
    expect(await h.store.listLog()).toHaveLength(1);
    expect(await h.service.dropMember("m_nobody")).toBe(0);
  });
});

describe("复盘服务（LearningService）技能提案", () => {
  it("propose 模式同时产出记忆与技能提案，技能停在待确认", async () => {
    const h = harness({ mode: "propose", handler: reviewHandler([oneEntry()], undefined, [oneSkill()]) });
    await h.service.afterRun(runInput());

    const pending = await h.store.listProposals({ status: "pending" });
    expect(pending.map((item) => item.kind).sort()).toEqual(["memory", "skill"]);
    const skill = skillOf(pending.find((item) => item.kind === "skill"));
    expect(skill).toMatchObject({
      memberId: "m_main",
      status: "pending",
      rationale: "本轮完整跑通了切换流程",
      skill: {
        name: "pnpm-migration",
        category: "engineering",
        triggers: ["迁移 pnpm", "包管理器"],
      },
    });
    expect(h.skills.listPersonal("u_test")).toEqual([]);
    const log = (await h.store.listLog())[0];
    expect(log?.outcome).toBe("proposed");
    expect(log?.detail).toContain("产出 1 条待确认记忆");
    expect(log?.detail).toContain("1 条技能提案待确认");
    expect(h.learned[0]?.proposals).toHaveLength(2);
  });

  it("auto 模式只自动写记忆，技能不会被自动创建且流水明确说明", async () => {
    const h = harness({ mode: "auto", handler: reviewHandler([oneEntry()], undefined, [oneSkill()]) });
    await h.service.afterRun(runInput());

    const proposals = await h.store.listProposals();
    expect(memoryOf(proposals.find((item) => item.kind === "memory"))).toMatchObject({
      status: "applied",
      appliedPath: "MEMORY.md",
    });
    expect(skillOf(proposals.find((item) => item.kind === "skill"))).toMatchObject({ status: "pending" });
    expect(h.skills.listPersonal("u_test")).toEqual([]);
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("pnpm");

    const log = (await h.store.listLog())[0];
    expect(log?.outcome).toBe("applied");
    expect(log?.detail).toContain("自动写入 1/1 条记忆");
    expect(log?.detail).toContain("1 条技能提案待确认（技能不会被自动创建）");
    expect(log?.proposalIds).toHaveLength(1);
  });

  it("采纳技能提案创建个人技能，并通知工作区授权给来源成员", async () => {
    const grants: Array<{ memberId: string; skillName: string }> = [];
    const h = harness({
      handler: reviewHandler([], undefined, [oneSkill()]),
      deps: {
        grantSkillToMember: async (memberId, skillName) => {
          grants.push({ memberId, skillName });
        },
      },
    });
    await h.service.afterRun(runInput());
    const [pending] = await h.store.listProposals();
    const proposal = skillOf(pending);

    const applied = await h.service.applyProposal(proposal.id);
    expect(applied).toMatchObject({
      status: "applied",
      appliedPath: "技能库/pnpm-migration",
      appliedSkillName: "pnpm-migration",
    });
    expect(applied.appliedSkillId).toMatch(/^sk_/);
    expect(grants).toEqual([{ memberId: "m_main", skillName: "pnpm-migration" }]);

    const personal = h.skills.listPersonal("u_test");
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({
      name: "pnpm-migration",
      scope: "personal",
      ownerId: "u_test",
      category: "engineering",
      description: "把一个 Node 仓库从 npm 切换到 pnpm 并同步脚本与文档",
    });
    expect(personal[0]?.instructions).toContain("pnpm import");

    // 重复采纳幂等；已创建的技能提案不能忽略。
    expect(await h.service.applyProposal(proposal.id)).toMatchObject({ status: "applied" });
    expect(h.skills.listPersonal("u_test")).toHaveLength(1);
    await expect(h.service.dismissProposal(proposal.id)).rejects.toThrow(
      "已创建的技能提案不能忽略，请在技能库里删除该技能",
    );
  });

  it("授权失败不影响技能创建，只走 onError 提示", async () => {
    const errors: string[] = [];
    const h = harness({
      handler: reviewHandler([], undefined, [oneSkill()]),
      deps: {
        grantSkillToMember: async () => {
          throw new Error("总线忙");
        },
        onError: (message) => errors.push(message),
      },
    });
    await h.service.afterRun(runInput());
    const [pending] = await h.store.listProposals();
    const applied = await h.service.applyProposal(skillOf(pending).id);
    expect(applied).toMatchObject({ status: "applied" });
    expect(errors[0]).toBe("技能已创建，但授权给 @主智能体 失败：总线忙");
  });

  it("技能名已存在或已在待确认提案里就不再提；单轮最多 1 个", async () => {
    const existing = harness({ handler: reviewHandler([], undefined, [oneSkill()]) });
    await existing.skills.create(
      { id: "u_test", role: "admin" },
      {
        scope: "personal",
        name: "pnpm-migration",
        description: "已有技能",
        instructions: "步骤".repeat(30),
      },
    );
    await existing.service.afterRun(runInput());
    expect(await existing.store.listProposals()).toEqual([]);
    expect((await existing.store.listLog())[0]?.detail).toContain("技能库或待确认提案里已有 pnpm-migration");

    const pending = harness({ handler: reviewHandler([], undefined, [oneSkill()]) });
    await pending.service.afterRun(runInput());
    expect(await pending.store.listProposals()).toHaveLength(1);
    await pending.service.afterRun(runInput({ runId: "run_2" }));
    expect(await pending.store.listProposals()).toHaveLength(1);
    expect((await pending.store.listLog())[0]?.detail).toContain("技能库或待确认提案里已有 pnpm-migration");

    const capped = harness({
      handler: reviewHandler(
        [],
        undefined,
        [oneSkill(), oneSkill({ name: "second-skill", description: "另一个可复用做法" })],
      ),
    });
    await capped.service.afterRun(runInput());
    const skills = await capped.store.listProposals({ kind: "skill" });
    expect(skills).toHaveLength(LEARNING_RULES.maxSkillsPerReview);
    expect(skillOf(skills[0]).skill.name).toBe("pnpm-migration");
  });

  it("技能候选不合规或含密钥时丢弃，只留 nothing 流水", async () => {
    const h = harness({
      handler: reviewHandler([], undefined, [
        oneSkill({ instructions: `${"步骤".repeat(20)} password: hunter22` }),
      ]),
    });
    await h.service.afterRun(runInput());
    expect(await h.store.listProposals()).toEqual([]);
    const log = (await h.store.listLog())[0];
    expect(log?.outcome).toBe("nothing");
    expect(log?.detail).toContain("技能说明疑似包含密钥或凭据");
  });

  it("技能库未接入时技能候选跳过并说明原因，不影响记忆提案", async () => {
    const h = harness({
      handler: reviewHandler([oneEntry()], undefined, [oneSkill()]),
      deps: { skills: undefined, skillOwner: undefined },
    });
    await h.service.afterRun(runInput());
    const proposals = await h.store.listProposals();
    expect(proposals.map((item) => item.kind)).toEqual(["memory"]);
    const log = (await h.store.listLog())[0];
    expect(log?.detail).toContain("技能库未接入，技能候选已跳过");
  });

  it("复盘素材带上账号已有技能，提示模型不要重复提议", async () => {
    let userContent = "";
    const h = harness({
      handler: reviewHandler([], (request) => {
        userContent = String(request.messages[1]?.content ?? "");
      }),
    });
    await h.skills.create(
      { id: "u_test", role: "admin" },
      {
        scope: "personal",
        name: "existing-skill",
        description: "已有能力",
        instructions: "步骤".repeat(30),
      },
    );
    await h.service.afterRun(runInput());
    expect(userContent).toContain("【已有技能（不要重复提议）】");
    expect(userContent).toContain("existing-skill：已有能力");
  });
});

describe("运行时接线（orchestrator → 学习层）", () => {
  it("成员把结论交付到群里之后，才带着本轮素材触发一次复盘", async () => {
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const settings = defaultSettings();
    settings.providers = [{ id: "demo", api: "mock", models: [{ id: "mock" }] }];
    settings.selection = { ...settings.selection, defaultModel: "demo/mock", aliases: {}, fallbacks: [] };
    settings.limits = { ...DEFAULT_LIMITS, maxStepsPerRun: 3, runTimeoutMs: 10_000 };

    const bus = new RoomBus("room_main", "测试作战室");
    ensureMainMember(bus);
    const deliveries: LearningRunInput[] = [];
    const orchestrator = new Orchestrator({
      bus,
      board: new Workboard("room_main"),
      getSettings: () => settings,
      skills,
      ownerId: "u_test",
      mockHandler: () => ({ text: LONG_REPLY }),
      learning: { afterRun: async (input) => void deliveries.push(input) },
    });
    orchestrator.sendUserMessage("以后这个仓库统一用 pnpm。");

    const startedAt = Date.now();
    while (!bus.listMessages().some((message) => message.senderKind === "member" && message.text.includes("pnpm"))) {
      if (Date.now() - startedAt > 15_000) throw new Error("等待成员交付超时");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // 复盘挂在交付之后，给它一个短窗口把 afterRun 排队跑完。
    for (let attempt = 0; attempt < 40 && deliveries.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    orchestrator.stop();

    expect(deliveries).toHaveLength(1);
    const input = deliveries[0];
    if (!input) throw new Error("缺少复盘素材");
    expect(input).toMatchObject({
      memberName: "主智能体",
      memberRole: "main",
      roomId: "room_main",
      roomName: "测试作战室",
      unattended: false,
    });
    // 成员没有单独选模型时带的是「default」别名，复盘据此跟随账号默认模型
    expect(input.modelRef).toBe("default");
    expect(input.finalText).toContain("pnpm");
    expect(input.triggerText).toContain("统一用 pnpm");
    expect(input.runId).toMatch(/^run_/);
  }, 30_000);
});
