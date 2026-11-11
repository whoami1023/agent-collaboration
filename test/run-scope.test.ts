// 覆盖「运行姿态」这套通用闸门：工具白名单、plans/ 前缀写入、唤醒规则与逐轮指令。
// 姿态是机制、/plan 只是它的第一个调用方，所以这里的断言全部围绕「本轮能做什么」而不是「计划」。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRunScope, scopeToolUnavailable } from "../src/agent/run-scope";
import { buildTools } from "../src/agent/tools";
import { buildInstruction, buildSystemPrompt, type PromptContext } from "../src/agent/prompts";
import { MockProvider, type MockHandler } from "../src/provider/mock";
import { decideWakes } from "../src/room/wake";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceFiles } from "../src/files/workspace-files";
import { defaultSettings, type Settings } from "../src/core/settings";
import { runAgentLoop, type ToolImpl } from "../src/agent/loop";
import { DEFAULT_LIMITS, type Member, type RoomMessage } from "../src/core/types";

const tempDirs: string[] = [];
const signal = new AbortController().signal;

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

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "m_main",
    roomId: "room_test",
    name: "主智能体",
    role: "main",
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

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg_1",
    roomId: "room_test",
    seq: 1,
    ts: 0,
    senderId: "user",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text: "",
    mentions: [],
    mentionsRaw: [],
    ...overrides,
  };
}

function fakeTool(name: string): ToolImpl {
  return {
    schema: { name, description: name, parameters: { type: "object", properties: {}, required: [] } },
    execute: async () => `已执行 ${name}`,
  };
}

async function makeRig() {
  const dir = await mkdtemp(join(tmpdir(), "ac-runscope-"));
  tempDirs.push(dir);
  const bus = new RoomBus("room_test", "测试群");
  const board = new Workboard("room_test");
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  const files = new WorkspaceFiles(dir);
  return { bus, board, skills, files, dir };
}

describe("applyRunScope：工具集收窄是白名单闸门", () => {
  it("缺省姿态原样返回同一个数组：普通轮一个工具都不动", () => {
    const tools = [fakeTool("file_write"), fakeTool("run_command")];
    expect(applyRunScope(tools, undefined)).toBe(tools);
  });

  it("计划轮只留白名单，写入类与命令类工具直接不出现在清单里", () => {
    const tools = [
      fakeTool("file_read"),
      fakeTool("file_list"),
      fakeTool("task_list"),
      fakeTool("task_create"),
      fakeTool("file_write"),
      fakeTool("task_update"),
      fakeTool("task_attach_artifact"),
      fakeTool("memory_append"),
      fakeTool("run_command"),
      fakeTool("run_skill_script"),
      fakeTool("cron"),
    ];
    const names = applyRunScope(tools, "plan").map((tool) => tool.schema.name);
    expect(names).toEqual(["file_read", "file_list", "task_list", "task_create", "file_write"]);
  });

  it("以后新增加入工具默认进不了计划轮，闸门不会因为清单变长而漏风", () => {
    const names = applyRunScope([fakeTool("git_commit")], "plan").map((tool) => tool.schema.name);
    expect(names).toEqual([]);
  });
});

describe("计划轮的真实工具面", () => {
  it("只能读、只能建任务卡，改动类与定时类工具全部缺席", async () => {
    const rig = await makeRig();
    const deps = {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      files: rig.files,
      runScope: "plan" as const,
    };
    const names = buildTools(member(), deps).map((tool) => tool.schema.name);
    for (const expected of ["file_read", "file_list", "task_list", "task_create", "file_write", "web_search"]) {
      expect(names).toContain(expected);
    }
    for (const banned of ["task_update", "task_attach_artifact", "run_command", "run_skill_script", "cron"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("普通轮的工具面不受影响", async () => {
    const rig = await makeRig();
    const deps = {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      files: rig.files,
    };
    const names = buildTools(member(), deps).map((tool) => tool.schema.name);
    expect(names).toContain("task_update");
    expect(names).toContain("run_command");
  });

  it("计划轮能把计划写进 plans/ 下的文件", async () => {
    const rig = await makeRig();
    const write = buildTools(member(), {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      files: rig.files,
      runScope: "plan",
    }).find((tool) => tool.schema.name === "file_write");
    expect(write).toBeDefined();

    const result = await write!.execute({ path: "plans/2026-11-05-topic.md", content: "# 计划\n" }, signal);
    expect(result).toContain("已写入");
    expect(await readFile(join(rig.dir, "files", "plans", "2026-11-05-topic.md"), "utf8")).toContain("# 计划");
  });

  it("计划轮写 plans/ 之外一律被拒，落盘的只有计划文件", async () => {
    const rig = await makeRig();
    const write = buildTools(member(), {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      files: rig.files,
      runScope: "plan",
    }).find((tool) => tool.schema.name === "file_write")!;

    for (const path of ["notes/x.md", "MEMORY.md", "plans/../escape.md", "../outside.md", "plans", ""]) {
      const result = await write.execute({ path, content: "不该落盘" }, signal);
      expect(result).toContain("本轮是计划轮");
      expect(result).toContain("等用户批准");
    }
    await expect(readFile(join(rig.dir, "files", "notes", "x.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(rig.dir, "files", "escape.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(rig.dir, "files", "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it("路径归一化后交给底层工具：./plans/a.md 与反斜杠写法都能落地", async () => {
    const rig = await makeRig();
    const write = buildTools(member(), {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      files: rig.files,
      runScope: "plan",
    }).find((tool) => tool.schema.name === "file_write")!;

    expect(await write.execute({ path: "./plans/a.md", content: "A" }, signal)).toContain("plans/a.md");
    expect(await write.execute({ path: "plans\\sub\\b.md", content: "B" }, signal)).toContain("plans/sub/b.md");
    expect(await readFile(join(rig.dir, "files", "plans", "a.md"), "utf8")).toBe("A");
    expect(await readFile(join(rig.dir, "files", "plans", "sub", "b.md"), "utf8")).toBe("B");
  });
});

describe("task_list：回读确认用的只读看板视图", () => {
  it("列出任务卡的状态、负责人与成果，可按状态或成员过滤", async () => {
    const rig = await makeRig();
    const researcher = member({ id: "m_sub", name: "研究员", role: "sub", depth: 1, spawnedBy: "m_main" });
    rig.bus.addMember(member());
    rig.bus.addMember(researcher);
    const board = rig.board;
    const a = board.create({ title: "收集资料", createdBy: "m_main", ownerId: researcher.id });
    const b = board.create({ title: "写初稿", createdBy: "m_main" });
    board.update(b.id, { status: "doing" });
    board.attachArtifact(a.id, { name: "资料清单", path: "plans/materials.md", addedBy: researcher.id });

    const tool = buildTools(member(), {
      bus: rig.bus,
      board,
      skills: rig.skills,
      userId: "u_test",
    }).find((item) => item.schema.name === "task_list")!;

    const all = await tool.execute({}, signal);
    expect(all).toContain("任务卡 2 张");
    expect(all).toContain(`${a.id}｜收集资料｜todo｜@研究员，成果 1 项：plans/materials.md`);
    expect(all).toContain(`${b.id}｜写初稿｜doing｜@未指派，成果 0 项`);

    const doingOnly = await tool.execute({ status: "doing" }, signal);
    expect(doingOnly).toContain("写初稿");
    expect(doingOnly).not.toContain("收集资料");

    const byOwner = await tool.execute({ owner: "研究员" }, signal);
    expect(byOwner).toContain("收集资料");
    expect(byOwner).not.toContain("写初稿");

    expect(await tool.execute({ owner: "不存在" }, signal)).toContain("找不到成员");
    expect(await tool.execute({ status: "archived" }, signal)).toContain("status 只能是");
    expect(await tool.execute({ status: "failed" }, signal)).toContain("没有符合条件的任务卡");
  });

  it("计划轮里也能建任务卡，但改状态与登记产出不行", async () => {
    const rig = await makeRig();
    const names = buildTools(member(), {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      runScope: "plan",
    }).map((tool) => tool.schema.name);
    expect(names).toContain("task_create");
    expect(names).not.toContain("task_update");
    expect(names).not.toContain("task_attach_artifact");
  });
});

describe("计划轮规则走逐轮消息通道", () => {
  it("计划轮的指令带上只读规则与交付物要求，普通轮不带", () => {
    const plan = buildInstruction(member(), message({ text: "/plan 调研 A", runScope: "plan" }));
    expect(plan).toContain("本轮是计划轮（只读闸门已生效）");
    expect(plan).toContain("只能写 plans/ 下的计划文件");
    expect(plan).toContain("@ 成员也不会唤醒他们");
    expect(plan).toContain("等你批准后我再分派执行");
    expect(plan).toContain("回应用户");

    const normal = buildInstruction(member(), message({ text: "调研 A" }));
    expect(normal).not.toContain("计划轮");
    expect(normal.length).lessThan(plan.length);
  });

  it("系统提示词不认姿态：普通轮的字节前缀继续稳定", () => {
    const context: PromptContext = {
      roomName: "测试作战室",
      member: member(),
      members: [member()],
      parentName: null,
      taskTitles: new Map(),
      mode: "delegate",
      limits: {
        maxChildrenPerAgent: 5,
        maxSpawnDepth: 5,
        maxConcurrent: 8,
        maxStepsPerRun: 24,
      },
      skills: [],
      availableTools: new Set(["file_list", "file_read", "file_write", "task_list", "run_command"]),
    };
    const prompt = buildSystemPrompt(context);
    expect(prompt).not.toContain("计划轮");
    expect(prompt).toContain("命令执行");
  });
});

describe("计划轮整轮跑通", () => {
  it("越界写入被拒、任务卡能建、@ 不派活、发回的消息带同一个姿态", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-runscope-orch-"));
    tempDirs.push(dir);
    const bus = new RoomBus("room_test", "测试群");
    const board = new Workboard("room_test");
    ensureMainMember(bus);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const settings: Settings = {
      ...defaultSettings(),
      providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }],
      limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 6, runTimeoutMs: 5000 },
    };
    const toolResults: string[] = [];
    let phase = 0;
    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => settings,
      skills,
      ownerId: "u_test",
      files: new WorkspaceFiles(dir),
      mockHandler: (request) => {
        const system = request.messages[0]?.content ?? "";
        if (!system.includes("里的主智能体")) return { text: "收到" };
        if (phase === 0) {
          phase = 1;
          return {
            toolCalls: [
              { name: "file_write", args: { path: "notes/leak.md", content: "不该落盘" } },
              { name: "file_write", args: { path: "plans/plan.md", content: "# 计划" } },
              { name: "task_create", args: { title: "核对现状", detail: "负责人：调研员" } },
            ],
          };
        }
        return { text: "@调研员 按计划核对现状。等你批准后我再派活。" };
      },
    });
    bus.subscribe((event) => {
      if (event.type === "run" && event.event.type === "tool-result") {
        toolResults.push(event.event.content);
      }
    });
    const researcher = await orchestrator.createMember({ name: "调研员", description: "核对现状" });

    orchestrator.sendUserMessage("先别动手，出个计划", "plan");
    await waitFor(() => toolResults.length >= 3);
    await waitFor(() => orchestrator.activeRuns === 0);

    expect(toolResults.some((item) => item.includes("本轮是计划轮") && item.includes("notes/"))).toBe(true);
    expect(await readFile(join(dir, "files", "plans", "plan.md"), "utf8")).toContain("# 计划");
    await expect(readFile(join(dir, "files", "notes", "leak.md"), "utf8")).rejects.toThrow();
    expect(board.list()).toHaveLength(1);
    expect(board.list()[0]?.status).toBe("todo");

    const reply = bus.listMessages().at(-1);
    expect(reply?.senderId).toBe("m_main");
    expect(reply?.runScope).toBe("plan");
    expect(reply?.mentions).toContain(researcher.id);
    // 计划轮的 @ 只是写在群里给人看，不唤醒成员，也不把任务派下去。
    expect(bus.getMember(researcher.id)?.status).toBe("idle");
    expect(orchestrator.activeRuns).toBe(0);
    expect(board.list()[0]?.ownerId).toBeNull();
  });
});

describe("越界调用的回执", () => {
  it("收窄掉的工具被调用时说清「本轮姿态不允许」，而不是谎报「工具不存在」", async () => {
    const rig = await makeRig();
    const tools = buildTools(member(), {
      bus: rig.bus,
      board: rig.board,
      skills: rig.skills,
      userId: "u_test",
      files: rig.files,
      runScope: "plan",
    });
    expect(tools.map((tool) => tool.schema.name)).not.toContain("run_command");

    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((item) => item.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "run_command", args: { command: "ls" } }] };
      return { text: "已按只读姿态汇报计划" };
    };
    const results: string[] = [];
    const loop = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "先出计划" }],
      tools,
      toolUnavailable: (name) => scopeToolUnavailable("plan", name),
      maxSteps: 5,
      signal,
      onToolResult: (_call, content) => results.push(content),
    });

    expect(loop.error).toBeUndefined();
    expect(loop.text).toBe("已按只读姿态汇报计划");
    expect(results[0]).toContain("计划轮里不挂载 run_command");
    expect(results[0]).toContain("工具本身没坏");
    expect(results[0]).toContain("plans/ 下的计划文件");
    // 普通轮没有姿态，回执保持原来的「没有名为 X 的工具」。
    const plainResults: string[] = [];
    const plain = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开工" }],
      tools: [fakeTool("file_read")],
      maxSteps: 5,
      signal,
      onToolResult: (_call, content) => plainResults.push(content),
    });
    expect(plain.text).toBe("已按只读姿态汇报计划");
    expect(plainResults[0]).toBe("错误：没有名为 run_command 的工具");
  });
});

describe("唤醒闸门", () => {
  it("计划轮里智能体的 @ 不唤醒成员", () => {
    const researcher = member({ id: "m_sub", name: "研究员", role: "sub", depth: 1, spawnedBy: "m_main" });
    const decision = decideWakes(
      message({
        senderId: "m_main",
        senderName: "主智能体",
        senderKind: "member",
        mentions: [researcher.id],
        runScope: "plan",
      }),
      [member(), researcher],
    );
    expect(decision.wakes).toEqual([]);
    expect(decision.skipped[0]?.reason).toContain("计划轮");
  });

  it("用户在计划轮里 @ 成员仍然生效：挡的是这一轮把活真的派下去", () => {
    const researcher = member({ id: "m_sub", name: "研究员", role: "sub", depth: 1, spawnedBy: "m_main" });
    const decision = decideWakes(
      message({ text: "@研究员 先看这个", mentions: [researcher.id], runScope: "plan" }),
      [member(), researcher],
    );
    // 用户的 @ 照常派活，且显式 @ 优先：只叫被点的人，不起主智能体兜底。
    expect(decision.wakes).toEqual([researcher.id]);
    expect(decision.skipped).toEqual([]);
  });

  it("普通轮的 @ 不受影响", () => {
    const researcher = member({ id: "m_sub", name: "研究员", role: "sub", depth: 1, spawnedBy: "m_main" });
    const decision = decideWakes(
      message({
        senderId: "m_main",
        senderName: "主智能体",
        senderKind: "member",
        mentions: [researcher.id],
      }),
      [member(), researcher],
    );
    expect(decision.wakes).toEqual([researcher.id]);
  });
});
