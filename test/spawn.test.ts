// 覆盖 P3 从 OpenClaw 移植的 spawn 管线：limits、准入、能力分级、血缘深度、任务名、信封。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  isSubagentSpawnDepthAllowed,
  resolveAgentMaxConcurrent,
} from "../src/agent/spawn/agent-limits";
import { resolveSubagentCapabilities } from "../src/agent/spawn/capabilities";
import { getDepthFromEntryLookup, isSubagentFromEntry } from "../src/agent/spawn/depth";
import {
  resolveChildAdmission,
  reserveChildAdmissionSlot,
  clearPendingChildAdmissions,
} from "../src/agent/spawn/child-admission";
import { normalizeMemberName } from "../src/agent/spawn/task-name";
import {
  buildSubagentSpawnEnvelope,
  buildSubagentStandingInstructions,
  resolveSpawnMode,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
} from "../src/agent/spawn/system-prompt";
import { resolveSpawnAdmission } from "../src/agent/spawn/spawn-plan";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { buildTools } from "../src/agent/tools";
import { DEFAULT_LIMITS, type Limits, type Member } from "../src/core/types";
import type { Settings } from "../src/core/settings";
import type { MockHandler } from "../src/provider/mock";
import { SkillLibrary } from "../src/skills/library";

const tempDirs: string[] = [];

afterEach(async () => {
  clearPendingChildAdmissions();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent limits（移植自 agent-limits.ts）", () => {
  it("默认值与 OpenClaw 一致", () => {
    expect(DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT).toBe(5);
    expect(DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH).toBe(5);
    expect(isSubagentSpawnDepthAllowed(4, 5)).toBe(true);
    expect(isSubagentSpawnDepthAllowed(5, 5)).toBe(false);
  });

  it("并发默认值随 CPU 提升且不低于 8，配置值向下取整并至少为 1", () => {
    expect(resolveAgentMaxConcurrent(undefined)).toBeGreaterThanOrEqual(8);
    expect(resolveAgentMaxConcurrent(2.7)).toBe(2);
    expect(resolveAgentMaxConcurrent(0)).toBe(1);
  });
});

describe("capabilities（移植自 subagent-capabilities.ts）", () => {
  it("depth 0=main，帽内=orchestrator，达帽=leaf 且失去 children 控制权", () => {
    expect(resolveSubagentCapabilities({ depth: 0, maxSpawnDepth: 5 })).toMatchObject({
      role: "main",
      controlScope: "children",
    });
    expect(resolveSubagentCapabilities({ depth: 2, maxSpawnDepth: 5 })).toMatchObject({
      role: "orchestrator",
      controlScope: "children",
    });
    expect(resolveSubagentCapabilities({ depth: 5, maxSpawnDepth: 5 })).toMatchObject({
      role: "leaf",
      controlScope: "none",
    });
  });
});

describe("depth（移植自 subagent-depth-policy.ts）", () => {
  it("优先读取存储深度，否则沿 spawnedBy 血缘链回溯", () => {
    const entries: Record<string, { depth?: number; spawnedBy?: string }> = {
      a: { spawnedBy: "b" },
      b: { spawnedBy: "c" },
      c: { depth: 0 },
    };
    expect(getDepthFromEntryLookup("a", (key) => entries[key])).toBe(2);
    expect(getDepthFromEntryLookup("missing", () => undefined)).toBe(0);
  });

  it("血缘成环时用 visited 断环，不会无限递归", () => {
    const entries: Record<string, { spawnedBy?: string }> = {
      x: { spawnedBy: "y" },
      y: { spawnedBy: "x" },
    };
    expect(() => getDepthFromEntryLookup("x", (key) => entries[key])).not.toThrow();
  });

  it("isSubagentFromEntry：有 spawnedBy 或 depth>0 即视为子成员", () => {
    expect(isSubagentFromEntry({ spawnedBy: "m_main" })).toBe(true);
    expect(isSubagentFromEntry({ depth: 0, spawnedBy: null })).toBe(false);
  });
});

describe("child admission（移植自 child-admission.ts）", () => {
  it("深度优先于成员数上限", () => {
    const result = resolveChildAdmission({
      callerDepth: 5,
      maxSpawnDepth: 5,
      collect: false,
      activeChildren: 0,
      maxActiveChildren: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.governingCap).toBe("subagents.maxSpawnDepth");
  });

  it("announce 模式受 maxChildrenPerAgent 约束", () => {
    const result = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 5,
      collect: false,
      activeChildren: 5,
      maxActiveChildren: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.governingCap).toBe("subagents.maxChildrenPerAgent");
  });

  it("collect 模式另受组内总数上限约束", () => {
    const total = resolveChildAdmission({
      callerDepth: 0,
      maxSpawnDepth: 5,
      collect: true,
      activeChildren: 0,
      maxActiveChildren: 5,
      totalChildren: 8,
      maxTotalChildren: 8,
    });
    expect(total.ok).toBe(false);
    if (!total.ok) expect(total.governingCap).toBe("groups.maxTotalPerGroup");
  });

  it("待启动槽位：未释放前并发准入会把它计入活跃数", () => {
    let seenActive = -1;
    const first = reserveChildAdmissionSlot({
      controllerKey: "m_main",
      childKey: "m_child1",
      resolveAdmission: (pending) => {
        seenActive = pending;
        return { ok: true } as const;
      },
    });
    expect(first.ok).toBe(true);
    expect(seenActive).toBe(0);

    const second = reserveChildAdmissionSlot({
      controllerKey: "m_main",
      resolveAdmission: (pending) =>
        resolveSpawnAdmission({
          callerDepth: 0,
          limits: { maxChildrenPerAgent: 1 },
          activeChildren: 0,
          additionalActiveChildren: pending,
        }),
    });
    expect(second.ok).toBe(false);
    first.release();

    const third = reserveChildAdmissionSlot({
      controllerKey: "m_main",
      resolveAdmission: (pending) =>
        resolveSpawnAdmission({
          callerDepth: 0,
          limits: { maxChildrenPerAgent: 1 },
          activeChildren: 0,
          additionalActiveChildren: pending,
        }),
    });
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
    if (third.ok) third.release(); // 幂等
  });
});

describe("task name（移植自 subagent-task-name.ts）", () => {
  it("去 @ 前缀、校验字符集并拒绝保留名", () => {
    expect(normalizeMemberName("@研究员").name).toBe("研究员");
    expect(normalizeMemberName("  ").error).toContain("不能为空");
    expect(normalizeMemberName("a".repeat(13)).error).toContain("不合法");
    expect(normalizeMemberName("系统").error).toContain("保留名称");
  });
});

describe("spawn envelope（移植自 subagent-system-prompt.ts）", () => {
  it("常设指令按深度区分协调者与末端执行者", () => {
    const orchestrator = buildSubagentStandingInstructions({ spawnMode: "session", childDepth: 1, maxSpawnDepth: 5 });
    expect(orchestrator).toContain("下派子成员");
    expect(orchestrator).toContain("可以为并行/复杂工作下派后代成员");
    const leaf = buildSubagentStandingInstructions({ spawnMode: "session", childDepth: 5, maxSpawnDepth: 5 });
    expect(leaf).toContain("末端执行者：不能再下派");
  });

  it("任务消息把 [子成员任务] 包在内部运行时上下文标记内", () => {
    const envelope = buildSubagentSpawnEnvelope({
      completionMode: "announce",
      spawnMode: "session",
      task: "调研调度方式",
      requesterName: "主智能体",
      childName: "研究员",
      childDepth: 1,
      maxSpawnDepth: 5,
    });
    expect(envelope.message).toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(envelope.message).toContain("[子成员任务]");
    expect(envelope.message).toContain("调研调度方式");
    expect(envelope.acceptedNote).toContain("交回派发方");
  });

  it("resolveSpawnMode 与 OpenClaw 一致：显式优先，thread 请求转 session", () => {
    expect(resolveSpawnMode({ requestedMode: "run", threadRequested: true })).toBe("run");
    expect(resolveSpawnMode({ threadRequested: true })).toBe("session");
    expect(resolveSpawnMode({ threadRequested: false })).toBe("run");
  });
});

function makeMember(overrides: Partial<Member>): Member {
  return {
    id: "m_x",
    roomId: "room_test",
    name: "x",
    role: "sub",
    status: "idle",
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    providerId: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

describe("能力门控的工具面", () => {
  it("spawn_member 始终注册，但 leaf 调用被执行侧护栏拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-spawn-"));
    tempDirs.push(dir);
    const bus = new RoomBus("room_test", "测试群");
    const board = new Workboard("room_test");
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const deps = {
      bus,
      board,
      limits: DEFAULT_LIMITS,
      skills,
      userId: "u_test",
      spawn: async () => "unused",
    };
    const leaf = makeMember({ controlScope: "none" });
    const leafTools = buildTools(leaf, deps);
    expect(leafTools.map((tool) => tool.schema.name)).toContain("spawn_member");
    const leafSpawn = leafTools.find((tool) => tool.schema.name === "spawn_member");
    const rejected = await leafSpawn?.execute({ name: "乙", task: "不该成功" }, new AbortController().signal);
    expect(String(rejected)).toContain("末端执行者不能再下派");

    const orchestratorMember = makeMember({ controlScope: "children" });
    const orchTools = buildTools(orchestratorMember, deps);
    expect(orchTools.map((tool) => tool.schema.name)).toContain("spawn_member");
    const orchSpawn = orchTools.find((tool) => tool.schema.name === "spawn_member");
    const allowed = await orchSpawn?.execute({ name: "乙", task: "任务" }, new AbortController().signal);
    expect(String(allowed)).toBe("unused");
  });

  it("深度达上限的协调成员调用 spawn_member 时得到嵌套深度拒绝文案", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-spawn-"));
    tempDirs.push(dir);
    const bus = new RoomBus("room_test", "测试群");
    const board = new Workboard("room_test");
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const deps = {
      bus,
      board,
      limits: { ...DEFAULT_LIMITS, maxSpawnDepth: 2 },
      skills,
      userId: "u_test",
      spawn: async () => "unused",
    };
    const atCap = makeMember({ controlScope: "children", depth: 2 });
    const spawnTool = buildTools(atCap, deps).find((tool) => tool.schema.name === "spawn_member");
    const result = await spawnTool?.execute({ name: "丙", task: "任务" }, new AbortController().signal);
    expect(String(result)).toContain("嵌套深度已达上限");
  });
});

async function makeRig(handler: MockHandler, overrides: Partial<Limits> = {}) {
  const bus = new RoomBus("room_test", "测试群");
  const board = new Workboard("room_test");
  ensureMainMember(bus);
  const dir = await mkdtemp(join(tmpdir(), "ac-spawn-orch-"));
  tempDirs.push(dir);
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  const settings: Settings = {
    providers: [{ id: "demo", kind: "mock", model: "mock" }],
    activeProviderId: "demo",
    limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 6, runTimeoutMs: 5000, ...overrides },
  };
  const orchestrator = new Orchestrator({
    bus,
    board,
    getSettings: () => settings,
    skills,
    ownerId: "u_test",
    mockHandler: handler,
  });
  return { bus, board, orchestrator, settings };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("orchestrator spawn 管线端到端", () => {
  it("主→协调成员→末端子成员两级下派，信封与回执符合移植语义", async () => {
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      const steps = request.messages.filter((message) => message.role === "assistant").length;
      const userText = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      if (system.includes("里的主智能体")) {
        if (userText.includes("交回了结果")) return { text: "综合结论完成。" };
        if (steps === 0) {
          return { toolCalls: [{ name: "spawn_member", args: { name: "协调员", task: "拆分并完成调研" } }] };
        }
        return { text: "已派给协调员。" };
      }
      if (system.includes("协调者（orchestrator")) {
        if (steps === 0) {
          return { toolCalls: [{ name: "spawn_member", args: { name: "调研员", task: "收集资料" } }] };
        }
        return { text: "协调员结论：资料已齐。" };
      }
      return { text: "末端结论：只做了分派任务。" };
    };

    const { bus, orchestrator } = await makeRig(handler, { maxSpawnDepth: 2 });

    orchestrator.sendUserMessage("两级下派试试");

    await waitFor(() => Boolean(bus.findMemberByName("协调员")));
    const coordinator = bus.findMemberByName("协调员");
    expect(coordinator?.depth).toBe(1);
    expect(coordinator?.controlScope).toBe("children");

    const dispatch = bus
      .listMessages()
      .find((message) => message.text.startsWith("@协调员"));
    expect(dispatch?.text).toContain("[子成员任务]");
    expect(dispatch?.mentions).toContain(coordinator?.id);

    await waitFor(() => Boolean(bus.findMemberByName("调研员")));
    const leaf = bus.findMemberByName("调研员");
    expect(leaf?.depth).toBe(2);
    expect(leaf?.controlScope).toBe("none");

    await waitFor(() =>
      bus.listMessages().some((message) => message.senderId === leaf?.id && message.kind === "announce"),
    );
    await waitFor(() =>
      bus.listMessages().some((message) => message.senderId === coordinator?.id && message.kind === "announce"),
    );
    await waitFor(() => orchestrator.activeRuns === 0);
  });

  it("达深度上限的成员是 leaf：提示词写明不能再下派，且派发被准入拒绝", async () => {
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      const steps = request.messages.filter((message) => message.role === "assistant").length;
      if (system.includes("里的主智能体")) {
        if (steps === 0) {
          return { toolCalls: [{ name: "spawn_member", args: { name: "一层", task: "继续派" } }] };
        }
        return { text: "等待报告。" };
      }
      if (system.includes("末端执行者（leaf") && steps === 0) {
        return { toolCalls: [{ name: "spawn_member", args: { name: "二层", task: "不该成功" } }] };
      }
      return { text: "收到" };
    };

    const { bus, orchestrator } = await makeRig(handler, { maxSpawnDepth: 1 });

    orchestrator.sendUserMessage("深度封顶测试");
    await waitFor(() => Boolean(bus.findMemberByName("一层")));
    const first = bus.findMemberByName("一层");
    expect(first?.controlScope).toBe("none");
    expect(bus.findMemberByName("二层")).toBeUndefined();

    // 准入层验证：depth=1 的成员在 max=1 下再派会命中嵌套深度上限。
    const admission = resolveSpawnAdmission({
      callerDepth: 1,
      limits: { maxSpawnDepth: 1 },
      activeChildren: 0,
    });
    expect(admission.ok).toBe(false);
    await waitFor(() => orchestrator.activeRuns === 0);
  });
});
