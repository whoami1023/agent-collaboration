// 结构化派发：一次工具调用同时建卡、发派发消息并唤醒成员；不允许的派发在落任何状态前就被拒绝。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { MissionStore } from "../src/agent/mission-ledger";
import { buildTools } from "../src/agent/tools";
import { Workboard } from "../src/workboard/board";
import { RoomBus } from "../src/room/bus";
import { WorkQueue } from "../src/room/work-queue";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceFiles } from "../src/files/workspace-files";
import { defaultSettings, type Settings } from "../src/core/settings";
import { DEFAULT_LIMITS, type Member } from "../src/core/types";
import type { LlmRequest } from "../src/provider/types";

const tempDirs: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function member(overrides: Partial<Member> & Pick<Member, "id" | "name" | "role">): Member {
  return {
    roomId: "room_test",
    status: "idle",
    depth: 0,
    spawnedBy: null,
    controlScope: "children",
    contextMode: "fork",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

async function makeRig() {
  const dir = await mkdtemp(join(tmpdir(), "ac-dispatch-"));
  tempDirs.push(dir);
  const bus = new RoomBus("room_test", "测试群");
  const main = ensureMainMember(bus);
  const writer = member({
    id: "m_writer",
    name: "写手",
    role: "sub",
    controlScope: "none",
    spawnedBy: main.id,
  });
  bus.addMember(writer);
  const board = new Workboard("room_test");
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  const settings: Settings = {
    ...defaultSettings(),
    providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }],
    limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 4, runTimeoutMs: 5_000 },
  };
  return { dir, bus, writer, board, skills, settings, files: new WorkspaceFiles(dir) };
}

describe("结构化派发 task_dispatch", () => {
  it("一次调用建卡、发消息并唤醒成员，成员真的接到任务", async () => {
    const rig = await makeRig();
    const queue = new WorkQueue("room_test");
    const requests: LlmRequest[] = [];
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: (request) => {
        requests.push(request);
        const system = request.messages[0]?.content ?? "";
        if (system.includes("里的主智能体")) {
          const stepped = request.messages.some((message) => message.role === "tool");
          return stepped
            ? { text: "已派发，等写手回报。" }
            : {
                toolCalls: [
                  {
                    name: "task_dispatch",
                    args: {
                      member: "写手",
                      title: "写一份接口说明",
                      detail: "按 files/api.md 的现有接口写，输出到 files/接口说明.md",
                      context: "接口定义在 files/api.md，先读再写；只覆盖 GET 与 POST，不要新增接口。",
                      files: ["files/api.md"],
                      acceptance: "files/接口说明.md 存在且覆盖全部接口",
                    },
                  },
                ],
              };
        }
        return { text: "收到任务，开始写。" };
      },
    });

    orchestrator.sendUserMessage("把接口说明交给写手");
    await waitFor(() =>
      queue.list().filter((item) => item.memberId === rig.writer.id).some((item) => item.state === "done"),
    );
    await waitFor(() => queue.list().every((item) => item.state === "done"));

    const card = rig.board.list()[0]!;
    expect(card.title).toBe("写一份接口说明");
    expect(card.ownerId).toBe(rig.writer.id);
    expect(card.acceptance).toContain("接口说明");
    const rootId = rig.bus.listMessages().find((message) => message.senderKind === "user")!.id;
    expect(card.chainRootId).toBe(rootId);

    const dispatchMessage = rig.bus.listMessages().find((message) => message.taskId === card.id)!;
    expect(dispatchMessage.senderId).toBe(rig.bus.listMembers().find((m) => m.role === "main")!.id);
    expect(dispatchMessage.mentions).toEqual([rig.writer.id]);
    expect(dispatchMessage.text).toContain("任务卡：");
    expect(dispatchMessage.chainRootId).toBe(rootId);
    expect(dispatchMessage.handoff).toMatchObject({
      fromName: "主智能体",
      context: expect.stringContaining("files/api.md"),
      files: ["files/api.md"],
    });

    // 写手确实被这条派发唤醒并跑过一轮，而不是只留下一条没人接的消息。
    expect(queue.list().some((item) => item.memberId === rig.writer.id && item.state === "done")).toBe(true);
    const writerRequest = requests.find(
      (request) => !request.messages[0]?.content.includes("里的主智能体"),
    )!;
    const writerPrompt = writerRequest.messages.map((message) => message.content).join("\n");
    expect(writerPrompt).toContain("【交接上下文包】");
    expect(writerPrompt).toContain("files/api.md");
    expect(writerPrompt).toContain("只覆盖 GET 与 POST");
  });

  it("成员一轮没有推进任务卡时，主智能体下一轮会收到任务台账与重规划要求", async () => {
    const rig = await makeRig();
    const queue = new WorkQueue("room_test");
    const missions = new MissionStore("room_test", { stallThreshold: 1, maxReplans: 2 });
    const requests: LlmRequest[] = [];
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      missions,
      mockHandler: (request) => {
        requests.push(request);
        const system = request.messages[0]?.content ?? "";
        const prompt = request.messages.map((message) => message.content).join("\n");
        if (system.includes("里的主智能体")) {
          if (prompt.includes("【停滞重规划】")) {
            return { text: "已重规划：先核对已有材料，再补缺口。" };
          }
          const stepped = request.messages.some((message) => message.role === "tool");
          return stepped
            ? { text: "已派发，等写手回报。" }
            : {
                toolCalls: [
                  {
                    name: "task_dispatch",
                    args: { member: "写手", title: "整理资料" },
                  },
                ],
              };
        }
        return { text: "处理完成，但没有更新任务卡。" };
      },
    });

    orchestrator.sendUserMessage("把资料整理这件事交给写手");
    await waitFor(() =>
      requests.some(
        (request) =>
          request.messages[0]?.content.includes("里的主智能体") &&
          request.messages.some((message) => message.content.includes("【停滞重规划】")),
      ),
    );

    const rootId = rig.bus.listMessages().find((message) => message.senderKind === "user")!.id;
    const mission = missions.get(rootId)!;
    expect(mission.replans).toBe(1);
    expect(rig.board.list()[0]?.chainRootId).toBe(rootId);
    expect(
      requests.some((request) =>
        request.messages.some((message) => message.content.includes("未完成：整理资料")),
      ),
    ).toBe(true);
  });

  it("整轮运行次数到顶后停止继续唤醒成员，并给出明确的系统提示", async () => {
    const rig = await makeRig();
    const settings: Settings = {
      ...rig.settings,
      limits: { ...rig.settings.limits, turnMaxRuns: 1 },
    };
    const queue = new WorkQueue("room_test");
    const requests: LlmRequest[] = [];
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: (request) => {
        requests.push(request);
        const system = request.messages[0]?.content ?? "";
        if (system.includes("里的主智能体")) {
          const stepped = request.messages.some((message) => message.role === "tool");
          return stepped
            ? { text: "已派发。" }
            : { toolCalls: [{ name: "task_dispatch", args: { member: "写手", title: "整理资料" } }] };
        }
        return { text: "写手不该跑到这里。" };
      },
    });

    orchestrator.sendUserMessage("把资料整理交给写手");
    await waitFor(() =>
      rig.bus
        .listMessages()
        .some((message) => message.senderKind === "system" && message.text.includes("运行次数上限")),
    );

    expect(queue.list().some((item) => item.memberId === rig.writer.id && item.state === "canceled")).toBe(true);
    expect(requests.some((request) => !request.messages[0]?.content.includes("里的主智能体"))).toBe(false);
  });

  it("计划轮不挂任务派发；委托模式下成员不能互相派活，且拒绝时不留任何状态", async () => {
    const rig = await makeRig();
    const main = rig.bus.listMembers().find((candidate) => candidate.role === "main")!;
    const planTools = buildTools(main, {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      runScope: "plan",
    });
    expect(planTools.some((tool) => tool.schema.name === "task_dispatch")).toBe(false);

    const reviewer = member({ id: "m_reviewer", name: "校对", role: "sub" });
    rig.bus.addMember(reviewer);
    const dispatch = buildTools(rig.writer, {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
    }).find((tool) => tool.schema.name === "task_dispatch")!;
    const result = await dispatch.execute({ member: "校对", title: "不该同级派活" }, signal);
    expect(result).toContain("成员之间不能互相派活");
    expect(rig.board.list()).toHaveLength(0);
    expect(rig.bus.listMessages()).toHaveLength(0);
  });
});
