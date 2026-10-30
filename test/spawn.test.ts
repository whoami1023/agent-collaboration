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
import { buildSubagentStandingInstructions } from "../src/agent/spawn/system-prompt";
import { resolveSpawnAdmission } from "../src/agent/spawn/spawn-plan";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { buildTools } from "../src/agent/tools";
import { DEFAULT_LIMITS, type Limits, type Member } from "../src/core/types";
import { SETTINGS_VERSION, type Settings } from "../src/core/settings";
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

describe("常设子成员指令（移植自 subagent-system-prompt.ts）", () => {
  it("不再提供下派指引，任何深度都写明不能创建成员", () => {
    const session = buildSubagentStandingInstructions({ spawnMode: "session" });
    expect(session).toContain("不能创建或下派子成员");
    expect(session).not.toContain("spawn_member");
    expect(session).not.toContain("可以为并行/复杂工作下派后代成员");
    const run = buildSubagentStandingInstructions({ spawnMode: "run" });
    expect(run).toContain("临时性");
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

describe("工具面不含创建成员通道", () => {
  it("主智能体与子成员的工具列表都没有 spawn_member", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-spawn-"));
    tempDirs.push(dir);
    const bus = new RoomBus("room_test", "测试群");
    const board = new Workboard("room_test");
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const deps = { bus, board, skills, userId: "u_test" };

    for (const member of [
      makeMember({ id: "m_main", role: "main", depth: 0, spawnedBy: null, controlScope: "children" }),
      makeMember({ controlScope: "children" }),
      makeMember({ controlScope: "none" }),
    ]) {
      const names = buildTools(member, deps).map((tool) => tool.schema.name);
      expect(names).not.toContain("spawn_member");
      expect(names).toContain("use_skill");
      expect(names).toContain("task_update");
    }
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
    settingsVersion: SETTINGS_VERSION,
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

describe("运行时禁止动态创建成员", () => {
  it("模型试图调用 spawn_member 时得到未知工具错误，且不会生成成员", async () => {
    const results: string[] = [];
    let phase = 0;
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      if (!system.includes("里的主智能体")) return { text: "收到" };
      if (phase === 0) {
        phase = 1;
        return { toolCalls: [{ name: "spawn_member", args: { name: "甲", task: "任务甲" } }] };
      }
      return { text: "我不能自己创建成员。" };
    };

    const { bus, orchestrator } = await makeRig(handler);
    bus.subscribe((event) => {
      if (event.type === "run" && event.event.type === "tool-result") {
        results.push(event.event.content);
      }
    });

    orchestrator.sendUserMessage("新建一个研究员");
    await waitFor(() => results.length > 0);
    expect(results[0]).toContain("没有名为 spawn_member 的工具");
    expect(bus.findMemberByName("甲")).toBeUndefined();
    expect(bus.listMembers().filter((member) => member.role === "sub")).toHaveLength(0);
    await waitFor(() => orchestrator.activeRuns === 0);
  });
});

describe("orchestrator.createMember（用户直接新建成员）", () => {
  it("按名字与描述创建 idle 子成员：记下 brief、广播系统消息、不派发任务", async () => {
    const { bus, board, orchestrator } = await makeRig(() => ({ text: "不该被调用" }));

    const member = await orchestrator.createMember({
      name: "调研员",
      description: "负责检索资料并给出带出处的结论",
    });

    expect(member).toMatchObject({
      name: "调研员",
      role: "sub",
      status: "idle",
      depth: 1,
      spawnedBy: "m_main",
      controlScope: "children",
      brief: "负责检索资料并给出带出处的结论",
    });
    expect(bus.findMemberByName("调研员")?.id).toBe(member.id);
    expect(board.list()).toHaveLength(0);
    expect(orchestrator.activeRuns).toBe(0);

    const last = bus.listMessages().at(-1);
    expect(last).toMatchObject({ senderKind: "system", kind: "system" });
    expect(last?.text).toContain("@调研员");
    expect(last?.text).toContain("负责检索资料并给出带出处的结论");
  });

  it("重名、保留名、空描述与成员数上限都会被拒绝，且不会留下半成品成员", async () => {
    const { bus, orchestrator } = await makeRig(() => ({ text: "不该被调用" }), {
      maxChildrenPerAgent: 1,
    });

    await orchestrator.createMember({ name: "甲", description: "第一个成员" });
    await expect(
      orchestrator.createMember({ name: "甲", description: "重名" }),
    ).rejects.toThrow(/已存在/);
    await expect(
      orchestrator.createMember({ name: "系统", description: "保留名" }),
    ).rejects.toThrow(/保留/);
    await expect(
      orchestrator.createMember({ name: "乙", description: "   " }),
    ).rejects.toThrow(/功能描述/);
    await expect(
      orchestrator.createMember({ name: "丙", description: "成员数已满" }),
    ).rejects.toThrow(/上限/);

    expect(bus.listMembers().filter((item) => item.role === "sub")).toHaveLength(1);
  });
});

describe("orchestrator.removeMember（用户移除成员）", () => {
  it("移除子成员：摘出花名册、任务改未指派、广播系统消息，迟到的状态更新不得复活", async () => {
    const events: string[] = [];
    const { bus, board, orchestrator } = await makeRig(() => ({ text: "不该被调用" }));
    bus.subscribe((event) => {
      if (event.type === "member-removed") events.push(event.memberId);
    });
    const member = await orchestrator.createMember({ name: "资料员", description: "整理资料并归档" });
    const task = board.create({ title: "整理季度资料", createdBy: "m_main", ownerId: member.id });

    const removed = await orchestrator.removeMember(member.id);

    expect(removed.id).toBe(member.id);
    expect(events).toEqual([member.id]);
    expect(bus.getMember(member.id)).toBeUndefined();
    expect(bus.findMemberByName("资料员")).toBeUndefined();
    expect(board.get(task.id)?.ownerId).toBeNull();
    const last = bus.listMessages().at(-1);
    expect(last).toMatchObject({ senderKind: "system", kind: "system" });
    expect(last?.text).toContain("@资料员");
    expect(last?.text).toContain("未指派");

    // 运行中迟到的状态更新不能把已移除成员写回花名册。
    bus.updateMember({ ...member, status: "idle" });
    expect(bus.getMember(member.id)).toBeUndefined();
  });

  it("主智能体与不存在的成员不能移除", async () => {
    const { orchestrator } = await makeRig(() => ({ text: "ok" }));
    await expect(orchestrator.removeMember("m_main")).rejects.toThrow(/主智能体/);
    await expect(orchestrator.removeMember("m_missing")).rejects.toThrow(/不存在/);
  });

  it("运行中的成员被移除时取消运行，迟到的结果不会发到群里", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("里的成员")) {
        return new Promise((resolve) => {
          gate.release = () => resolve({ text: "迟到的结论" });
        });
      }
      return { text: "已派发。" };
    };
    const { bus, orchestrator } = await makeRig(handler);
    const member = await orchestrator.createMember({ name: "调研员", description: "调研" });

    orchestrator.sendUserMessage("@调研员 开始调研");
    await waitFor(() => bus.getMember(member.id)?.status === "running");
    await orchestrator.removeMember(member.id);
    await waitFor(() => gate.release !== null);
    gate.release?.();
    await waitFor(() => orchestrator.activeRuns === 0);

    expect(bus.listMessages().some((message) => message.senderId === member.id)).toBe(false);
    expect(bus.getMember(member.id)).toBeUndefined();
  });
});
