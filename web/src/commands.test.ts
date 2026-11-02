import { describe, expect, it } from "vitest";
import type { Member, RoomMessage, TaskCard } from "../../src/core/types";
import type { MaskedSettings } from "./api";
import {
  buildContextReport,
  buildHelpReport,
  buildStatusReport,
  getSlashQuery,
  parseSlashCommand,
  SLASH_COMMANDS,
  suggestSlashCommands,
  type CommandData,
} from "./commands";

function member(status: Member["status"], name = "成员"): Member {
  return {
    id: `m_${name}`,
    roomId: "room_main",
    name,
    role: "sub",
    status,
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "children",
    contextMode: "isolated",
    systemPrompt: "",
    providerId: "demo",
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function message(text: string, seq: number): RoomMessage {
  return {
    id: `msg_${seq}`,
    roomId: "room_main",
    seq,
    ts: 0,
    senderId: "u1",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text,
    mentions: [],
    mentionsRaw: [],
  };
}

function task(status: TaskCard["status"], title: string): TaskCard {
  return {
    id: `task_${title}`,
    roomId: "room_main",
    title,
    detail: "",
    ownerId: null,
    status,
    deps: [],
    artifacts: [],
    messageIds: [],
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
  };
}

const settings: MaskedSettings = {
  providers: [
    { id: "demo", kind: "mock", model: "mock", hasApiKey: false },
    { id: "deepseek", kind: "openai", model: "deepseek-chat", hasApiKey: true },
  ],
  activeProviderId: "deepseek",
  limits: {
    maxRoomWindowChars: 200,
    contextWindowTokens: 64_000,
    maxActiveTranscriptBytes: "2mb",
    maxStepsPerRun: 12,
    runTimeoutMs: 120_000,
    maxConcurrent: 8,
  },
};

function data(overrides: Partial<CommandData> = {}): CommandData {
  return {
    roomName: "老板 的作战室",
    mode: "delegate",
    members: [member("running", "主智能体"), member("idle", "调研员")],
    messages: [message("旧消息", 1), message("新消息", 2)],
    tasks: [task("todo", "调研"), task("done", "汇总")],
    settings,
    workspaceFileCount: 3,
    ...overrides,
  };
}

describe("斜杠命令解析", () => {
  it("识别命令、大小写、参数与冒号形式", () => {
    expect(parseSlashCommand("  /CLEAR  ")).toMatchObject({
      kind: "command",
      command: { name: "clear" },
      args: "",
    });
    expect(parseSlashCommand("/stop now")).toMatchObject({
      kind: "command",
      command: { name: "stop" },
      args: "now",
    });
    expect(parseSlashCommand("/status:插件")).toMatchObject({
      kind: "command",
      command: { name: "status" },
      args: "插件",
    });
    expect(parseSlashCommand("/help")).toMatchObject({
      kind: "command",
      command: { name: "help" },
    });
    expect(parseSlashCommand("/context")).toMatchObject({
      kind: "command",
      command: { name: "context" },
    });
  });

  it("未知命令单独标记，普通文本 / 单独的斜杠不拦截", () => {
    expect(parseSlashCommand("/nope 参数")).toEqual({ kind: "unknown", name: "nope", args: "参数" });
    expect(parseSlashCommand("hello /clear")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("命令表覆盖全部本地命令", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "new",
      "clear",
      "stop",
      "status",
      "context",
    ]);
  });

  it("/new 的说明要说清「与上一个任务无关」且保留文件工作区", () => {
    const command = SLASH_COMMANDS.find((item) => item.name === "new");
    expect(command?.summary).toContain("与之前无关");
    expect(command?.summary).toContain("文件工作区保留");
  });
});

describe("命令提示", () => {
  it("只在消息开头的命令片段上弹出：参数、普通文本、双斜杠都不弹", () => {
    expect(getSlashQuery("/")).toBe("");
    expect(getSlashQuery("/st")).toBe("st");
    expect(getSlashQuery("  /ST")).toBe("st");
    expect(getSlashQuery("/stop ")).toBeNull();
    expect(getSlashQuery("/stop now")).toBeNull();
    expect(getSlashQuery("/help:参数")).toBeNull();
    expect(getSlashQuery("//")).toBeNull();
    expect(getSlashQuery("hello /st")).toBeNull();
    expect(getSlashQuery("")).toBeNull();
  });

  it("空查询按注册表顺序给出全部命令", () => {
    expect(suggestSlashCommands("").map((command) => command.name)).toEqual(
      SLASH_COMMANDS.map((command) => command.name),
    );
  });

  it("按精确、前缀、包含、说明命中排序", () => {
    expect(suggestSlashCommands("st").map((command) => command.name)).toEqual([
      "stop",
      "status",
    ]);
    expect(suggestSlashCommands("stop").map((command) => command.name)).toEqual(["stop"]);
    expect(suggestSlashCommands("ST").map((command) => command.name)).toEqual([
      "stop",
      "status",
    ]);
    expect(suggestSlashCommands("cle").map((command) => command.name)).toEqual(["clear"]);
    expect(suggestSlashCommands("new").map((command) => command.name)).toEqual(["new"]);
    // 说明命中：“聊天记录”同时出现在 /new 与 /clear 的摘要里，按注册表顺序给
    expect(suggestSlashCommands("聊天记录").map((command) => command.name)).toEqual([
      "new",
      "clear",
    ]);
    expect(suggestSlashCommands("e").map((command) => command.name)).toContain("help");
  });

  it("没有任何匹配时返回空列表", () => {
    expect(suggestSlashCommands("zzz")).toEqual([]);
  });
});

describe("命令报告", () => {
  it("/status 汇总成员、任务、模型与文件", () => {
    const report = buildStatusReport(data());
    expect(report).toContain("房间：老板 的作战室");
    expect(report).toContain("协作模式：委派");
    expect(report).toContain("成员：2（运行中 1 · 空闲 1）");
    expect(report).toContain("消息：已加载 2 条");
    expect(report).toContain("任务：2（待办 1 · 完成 1）");
    expect(report).toContain("文件工作区：3 个文件");
    expect(report).toContain("模型：deepseek · deepseek-chat");
  });

  it("/status 标记未配置密钥，并按需展示异常成员", () => {
    const report = buildStatusReport(
      data({
        members: [member("error", "故障成员")],
        tasks: [],
        settings: { ...settings, activeProviderId: "demo" },
        workspaceFileCount: null,
      }),
    );
    expect(report).toContain("成员：1（运行中 0 · 空闲 0 · 异常 1）");
    expect(report).toContain("任务：0");
    expect(report).not.toContain("文件工作区");
    expect(report).toContain("模型：demo · mock（未配置密钥）");
  });

  it("/context 估算群聊窗口并展示预算与运行限制", () => {
    const report = buildContextReport(data());
    expect(report).toContain("群聊窗口：最近 2 条");
    expect(report).toContain("上限 200 字符");
    expect(report).toContain("64000 tokens");
    expect(report).toContain("模型视图字节上限：2mb");
    expect(report).toContain("最多 12 步工具调用、单次超时 2 分钟、并发 8");
    expect(report).toContain("MEMORY.md");
  });

  it("/context 在窗口很小时至少保留最新一条", () => {
    const report = buildContextReport(
      data({
        messages: [message("第一条消息", 1), message("第二条消息", 2)],
        settings: { ...settings, limits: { maxRoomWindowChars: 10 } },
      }),
    );
    expect(report).toContain("最近 1 条");
    expect(report).toContain("上限 10 字符");
  });

  it("/help 列出全部命令与影响说明", () => {
    const help = buildHelpReport();
    for (const command of SLASH_COMMANDS) expect(help).toContain(command.usage);
    expect(help).toContain("不会作为聊天消息发给智能体");
    expect(help).toContain("智能体记忆不受影响");
    // 帮助要说清 /new 与 /clear 的分别，以及两者都可恢复。
    expect(help).toContain("/new 只把聊天记录与任务卡归档起来");
    expect(help).toContain("/clear 连文件成果一起归档");
    expect(help).toContain("都能在右侧「归档」恢复");
  });
});
