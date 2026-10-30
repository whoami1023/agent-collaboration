import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { DEFAULT_LIMITS, type Limits, type PublicUser } from "../src/core/types";
import type { Settings } from "../src/core/settings";
import type { MockHandler } from "../src/provider/mock";
import { SkillLibrary } from "../src/skills/library";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function makeRig(handler: MockHandler, overrides: Partial<Limits> = {}) {
  const bus = new RoomBus("room_test", "测试群");
  const board = new Workboard("room_test");
  ensureMainMember(bus);
  const dir = await mkdtemp(join(tmpdir(), "ac-collab-"));
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
  return { bus, board, orchestrator, settings, skills };
}

describe("group-chat collaboration", () => {
  it("主智能体没有创建成员的通道，被要求建成员时只能直接回答", async () => {
    let toolNames: string[] = [];
    let system = "";
    const handler: MockHandler = (request) => {
      toolNames = request.tools.map((tool) => tool.name);
      system = request.messages[0]?.content ?? "";
      return { text: "我不能自己创建成员，请在左侧「新建成员」中创建。" };
    };

    const { bus, orchestrator } = await makeRig(handler);
    orchestrator.sendUserMessage("帮我新建一个研究员");

    await waitFor(() => bus.listMessages().some((message) => message.senderKind === "member"));
    expect(toolNames).not.toContain("spawn_member");
    expect(toolNames).toContain("task_create");
    expect(system).not.toContain("spawn_member");
    expect(system).toContain("新建成员");
    expect(bus.listMembers().filter((member) => member.role === "sub")).toHaveLength(0);
    await waitFor(() => orchestrator.activeRuns === 0);
  });

  it("用户新建的成员被 @ 后执行任务，报告唤醒主智能体汇总", async () => {
    const handler: MockHandler = (request) => {
      const system = request.messages[0]?.content ?? "";
      const userText = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      if (system.includes("里的主智能体")) {
        if (userText.includes("交回了结果")) return { text: "综合结论：中心编排 + 事件总线更稳。" };
        return { text: "已收到，等成员报告。" };
      }
      return { text: "调研结论：中心编排最稳。\n证据：对比了 3 个框架。" };
    };

    const { bus, orchestrator } = await makeRig(handler);
    const researcher = await orchestrator.createMember({
      name: "调研员",
      description: "负责调研多智能体协同方案",
    });

    orchestrator.sendUserMessage("@调研员 调研多智能体协同的调度方式");

    const asked = bus.listMessages().find((message) => message.senderKind === "user");
    expect(asked?.mentions).toEqual([researcher.id]);

    await waitFor(() =>
      bus.listMessages().some((message) => message.senderId === researcher.id && message.kind === "announce"),
    );
    await waitFor(() =>
      bus.listMessages().some((message) => message.senderId === "m_main" && message.text.includes("综合结论")),
    );

    expect(bus.listMembers().filter((member) => member.role === "sub")).toHaveLength(1);
    const researcherMessages = bus.listMessages().filter((message) => message.senderId === researcher.id);
    expect(researcherMessages).toHaveLength(1);
    await waitFor(() => orchestrator.activeRuns === 0);
  });

  it("运行前读取成员最新技能白名单：提示词只出现勾选的技能", async () => {
    let system = "";
    const handler: MockHandler = (request) => {
      system = request.messages[0]?.content ?? "";
      return { text: "收到" };
    };
    const { bus, orchestrator, skills } = await makeRig(handler);
    const adminUser: PublicUser = {
      id: "u_test",
      username: "owner",
      displayName: "老板",
      role: "admin",
      createdAt: 0,
      mainAgentId: "m_main",
      roomId: "room_test",
    };
    await skills.create(adminUser, {
      scope: "shared",
      name: "research-brief",
      description: "三段式简报",
      instructions: "# 调研\n先给结论。",
    });
    await skills.create(adminUser, {
      scope: "shared",
      name: "summarize",
      description: "摘要",
      instructions: "# 摘要\n压缩成要点。",
    });
    const main = bus.listMembers().find((member) => member.role === "main");
    if (!main) throw new Error("缺少主智能体");
    // 模拟右侧「智能体文件 → 技能」保存后的在线更新：只勾选 research-brief。
    main.skillNames = ["research-brief"];
    bus.updateMember(main);

    orchestrator.sendUserMessage("你好");
    await waitFor(() => system.length > 0);
    expect(system).toContain("research-brief");
    expect(system).not.toContain("summarize");
    await waitFor(() => orchestrator.activeRuns === 0);
  });
});
