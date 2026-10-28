import { describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { DEFAULT_LIMITS, type Limits } from "../src/core/types";
import type { Settings } from "../src/core/settings";
import type { MockHandler } from "../src/provider/mock";
import { buildTools } from "../src/agent/tools";

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeRig(handler: MockHandler, overrides: Partial<Limits> = {}) {
  const bus = new RoomBus("room_test", "测试群");
  const board = new Workboard("room_test");
  ensureMainMember(bus);
  const settings: Settings = {
    providers: [{ id: "demo", kind: "mock", model: "mock" }],
    activeProviderId: "demo",
    limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 6, runTimeoutMs: 5000, ...overrides },
  };
  const orchestrator = new Orchestrator({
    bus,
    board,
    getSettings: () => settings,
    mockHandler: handler,
  });
  return { bus, board, orchestrator, settings };
}

function collaborativeHandler(): MockHandler {
  return (request) => {
    const system = request.messages[0]?.content ?? "";
    const steps = request.messages.filter((message) => message.role === "assistant").length;
    const userText = request.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n");
    if (system.includes("里的主智能体")) {
      if (userText.includes("交回了结果")) {
        return { text: "综合结论：中心编排 + 事件总线更稳。" };
      }
      if (steps === 0) {
        return {
          toolCalls: [
            { name: "spawn_member", args: { name: "研究员", task: "调研调度方式并给出结论" } },
          ],
        };
      }
      return { text: "已派给研究员，等它的报告。" };
    }
    return {
      text: "调研结论：中心编排最稳。\n证据：对比了 3 个框架。\n未解决：长任务压测缺失。",
    };
  };
}

describe("group-chat collaboration", () => {
  it("用户提问 → 主智能体创建成员并 @ 派发 → 子报告 → 主综合", async () => {
    const { bus, board, orchestrator } = makeRig(collaborativeHandler());

    orchestrator.sendUserMessage("帮我调研多智能体协同的调度方式");

    await waitFor(() => Boolean(bus.findMemberByName("研究员")));
    const researcher = bus.findMemberByName("研究员");
    expect(researcher?.role).toBe("sub");
    expect(researcher?.spawnedBy).toBe("m_main");

    await waitFor(() =>
      bus.listMessages().some((message) => message.senderId === researcher?.id && message.kind === "announce"),
    );
    await waitFor(() =>
      bus.listMessages().some((message) => message.senderId === "m_main" && message.text.includes("综合结论")),
    );

    const dispatch = bus
      .listMessages()
      .find((message) => message.senderId === "m_main" && message.text.startsWith("@研究员"));
    expect(dispatch?.mentions).toEqual([researcher?.id]);

    const task = board.list()[0];
    expect(task?.ownerId).toBe(researcher?.id);
    expect(task?.messageIds.length).toBeGreaterThan(0);

    const researcherMessages = bus.listMessages().filter((message) => message.senderId === researcher?.id);
    expect(researcherMessages).toHaveLength(1);

    await waitFor(() => orchestrator.activeRuns === 0);
  });

  it("子成员的工具集里没有 spawn_member，主智能体才有", () => {
    const { bus, board, settings } = makeRig(collaborativeHandler());
    const main = bus.listMembers()[0];
    if (!main) throw new Error("缺少主智能体");
    const researcher = {
      id: "m_researcher",
      roomId: bus.roomId,
      name: "研究员",
      role: "sub" as const,
      status: "idle" as const,
      depth: 1,
      spawnedBy: main.id,
      controlScope: "none" as const,
      contextMode: "isolated" as const,
      systemPrompt: "",
      providerId: "default",
      createdAt: 0,
      lastActiveAt: 0,
    };
    const spawn = async () => "unused";
    const deps = { bus, board, limits: settings.limits, spawn };
    const mainTools = buildTools(main, deps).map((tool) => tool.schema.name);
    const subTools = buildTools(researcher, deps).map((tool) => tool.schema.name);
    expect(mainTools).toContain("spawn_member");
    expect(subTools).not.toContain("spawn_member");
    expect(subTools).toContain("task_update");
  });

  it("超过直接成员上限时会拒绝并说明原因", async () => {
    const toolResults: string[] = [];
    let phase = 0;
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("里的主智能体")) {
        if (phase === 0) {
          phase = 1;
          return { toolCalls: [{ name: "spawn_member", args: { name: "甲", task: "任务甲" } }] };
        }
        if (phase === 1) {
          phase = 2;
          return { toolCalls: [{ name: "spawn_member", args: { name: "乙", task: "任务乙" } }] };
        }
        return { text: phase === 2 ? (phase = 3, "本轮派发结束") : "" };
      }
      return { text: "收到" };
    };

    const { bus, orchestrator } = makeRig(handler, { maxChildrenPerAgent: 1 });
    bus.subscribe((event) => {
      if (event.type === "run" && event.event.type === "tool-result") {
        toolResults.push(event.event.content);
      }
    });

    orchestrator.sendUserMessage("派两个任务");
    await waitFor(() => toolResults.length >= 2);
    expect(toolResults[0]).toContain("已创建成员");
    expect(toolResults[1]).toContain("上限");
  });

  it("嵌套深度达到上限时拒绝创建", async () => {
    const toolResults: string[] = [];
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("里的主智能体")) {
        return { toolCalls: [{ name: "spawn_member", args: { name: "甲", task: "任务甲" } }] };
      }
      return { text: "收到" };
    };
    const { bus, orchestrator } = makeRig(handler, { maxSpawnDepth: 1 });
    bus.subscribe((event) => {
      if (event.type === "run" && event.event.type === "tool-result") {
        toolResults.push(event.event.content);
      }
    });
    orchestrator.sendUserMessage("派个任务");
    await waitFor(() => toolResults.length >= 1);
    expect(toolResults[0]).toContain("嵌套深度");
  });
});
