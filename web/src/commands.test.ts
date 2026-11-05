import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Member, type RoomMessage, type TaskCard } from "../../src/core/types";
import type { MaskedModel, MaskedSettings } from "./api";
import {
  buildContextReport,
  buildHelpReport,
  buildModelReport,
  buildStatusReport,
  getSlashQuery,
  parseModelCommand,
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
    modelRef: "demo/mock",
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

function maskedModel(id: string, name: string, contextWindow: number): MaskedModel {
  return {
    id,
    name,
    contextWindow,
    maxTokens: 8192,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    status: "available",
  };
}

const settings: MaskedSettings = {
  providers: [
    {
      id: "demo",
      api: "mock",
      auth: "none",
      hasApiKey: false,
      models: [maskedModel("mock", "演示桩", 0)],
    },
    {
      id: "deepseek",
      api: "openai-completions",
      auth: "api-key",
      baseUrl: "https://api.deepseek.com/v1",
      hasApiKey: true,
      models: [maskedModel("deepseek-chat", "DeepSeek Chat", 128_000)],
    },
  ],
  selection: {
    defaultModel: "deepseek/deepseek-chat",
    aliases: { deepseek: "deepseek/deepseek-chat" },
    fallbacks: ["demo/mock"],
    modelParams: {},
    params: {},
    allow: [],
  },
  limits: {
    ...DEFAULT_LIMITS,
    maxRoomWindowChars: 200,
    contextWindowTokens: 64_000,
    maxActiveTranscriptBytes: "2mb",
    maxStepsPerRun: 12,
    runTimeoutMs: 120_000,
    maxConcurrent: 8,
  },
  learning: { mode: "propose", everyNRuns: 2, dailyCap: 20 },
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
      "model",
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

describe("/model 解析", () => {
  const main: Member = { ...member("idle", "主智能体"), role: "main" };
  const sub: Member = member("idle", "调研员");

  it("空参数只列清单", () => {
    expect(parseModelCommand("", [main, sub])).toEqual({ kind: "list" });
  });

  it("单个模型引用落到主智能体", () => {
    expect(parseModelCommand("deepseek/deepseek-chat", [main, sub])).toEqual({
      kind: "set",
      memberId: main.id,
      ref: "deepseek/deepseek-chat",
    });
    expect(parseModelCommand("default", [main, sub])).toEqual({
      kind: "set",
      memberId: main.id,
      ref: "default",
    });
  });

  it("@成员名或成员名加引用落到该成员", () => {
    expect(parseModelCommand("@调研员 deepseek-chat", [main, sub])).toMatchObject({
      kind: "set",
      memberId: sub.id,
      ref: "deepseek-chat",
    });
    expect(parseModelCommand("调研员 deepseek-chat extra", [main, sub])).toMatchObject({
      kind: "set",
      memberId: sub.id,
      ref: "deepseek-chat extra",
    });
  });

  it("找不到成员、主智能体按成员指定、缺少主智能体都给出中文错误", () => {
    expect(parseModelCommand("@不存在 demo/mock", [main, sub])).toMatchObject({
      kind: "list",
      error: "没有找到成员 @不存在",
    });
    expect(parseModelCommand("主智能体 demo/mock", [main, sub])).toMatchObject({
      kind: "list",
      error: "主智能体直接用 /model <模型引用>",
    });
    expect(parseModelCommand("demo/mock", [sub])).toMatchObject({
      kind: "list",
      error: "没有找到主智能体",
    });
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
    expect(report).toContain("模型：deepseek/deepseek-chat");
  });

  it("/status 标记未配置密钥，并按需展示异常成员", () => {
    const noKey: MaskedSettings = {
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === "deepseek" ? { ...provider, hasApiKey: false } : provider,
      ),
    };
    const report = buildStatusReport(
      data({
        members: [member("error", "故障成员")],
        tasks: [],
        settings: noKey,
        workspaceFileCount: null,
      }),
    );
    expect(report).toContain("成员：1（运行中 0 · 空闲 0 · 异常 1）");
    expect(report).toContain("任务：0");
    expect(report).not.toContain("文件工作区");
    expect(report).toContain("模型：deepseek/deepseek-chat（未配置密钥）");
  });

  it("/status 不把 mock 供应商标成缺密钥", () => {
    const report = buildStatusReport(
      data({ settings: { ...settings, selection: { ...settings.selection, defaultModel: "demo/mock" } } }),
    );
    expect(report).toContain("模型：demo/mock");
    expect(report).not.toContain("demo/mock（未配置密钥）");
  });

  it("/model 列出默认、备用、别名、各供应商模型与成员归属", () => {
    const report = buildModelReport(data());
    expect(report).toContain("· 默认：deepseek/deepseek-chat");
    expect(report).toContain("· 备用：demo/mock");
    expect(report).toContain("· 别名：deepseek→deepseek/deepseek-chat");
    expect(report).toContain("· demo（mock）：mock");
    expect(report).toContain("· deepseek（openai-completions）：deepseek-chat · 128k");
    expect(report).toContain("成员：主智能体→demo/mock、调研员→demo/mock");
    expect(report).toContain("/model @成员 <模型引用>");
  });

  it("/model 标出未配置密钥的供应商，且设置缺失时给出提示", () => {
    const noKey: MaskedSettings = {
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === "deepseek" ? { ...provider, hasApiKey: false } : provider,
      ),
    };
    expect(buildModelReport(data({ settings: noKey }))).toContain(
      "deepseek-chat · 128k（未配置密钥）",
    );
    expect(buildModelReport(data({ settings: null }))).toContain("设置还没加载完");
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
        settings: { ...settings, limits: { ...DEFAULT_LIMITS, maxRoomWindowChars: 10 } },
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

describe("/model 命令", () => {
  const main: Member = { ...member("idle", "主智能体"), role: "main" };
  const sub = member("idle", "调研员");

  it("空参数只列清单，单个模型引用落到主智能体", () => {
    expect(parseModelCommand("", [main, sub])).toEqual({ kind: "list" });
    expect(parseModelCommand("deepseek/deepseek-chat", [main, sub])).toEqual({
      kind: "set",
      memberId: main.id,
      ref: "deepseek/deepseek-chat",
    });
    expect(parseModelCommand("default", [main, sub])).toEqual({
      kind: "set",
      memberId: main.id,
      ref: "default",
    });
  });

  it("带成员名或 @成员名时改该成员，并保留多段模型引用", () => {
    expect(parseModelCommand("@调研员 deepseek/deepseek-reasoner", [main, sub])).toEqual({
      kind: "set",
      memberId: sub.id,
      ref: "deepseek/deepseek-reasoner",
    });
    expect(parseModelCommand("调研员 deepseek chat", [main, sub])).toEqual({
      kind: "set",
      memberId: sub.id,
      ref: "deepseek chat",
    });
  });

  it("成员不存在或想把引用直接给主智能体时给出错误", () => {
    expect(parseModelCommand("不存在 deepseek/x", [main, sub]).error).toContain("没有找到成员");
    expect(parseModelCommand("@主智能体 deepseek/x", [main, sub]).error).toContain(
      "主智能体直接用 /model",
    );
  });

  it("报告列出默认、备用、别名、各供应商模型与成员当前引用", () => {
    const report = buildModelReport(data({ members: [main, sub] }));
    expect(report).toContain("默认：deepseek/deepseek-chat");
    expect(report).toContain("备用：demo/mock");
    expect(report).toContain("别名：deepseek→deepseek/deepseek-chat");
    expect(report).toContain("deepseek（openai-completions）：deepseek-chat · 128k");
    expect(report).toContain("主智能体→demo/mock");
    expect(report).toContain("用法：/model <模型引用> 改主智能体");
  });

  it("设置未加载时给出提示而不是崩溃", () => {
    expect(buildModelReport(data({ settings: null }))).toContain("设置还没加载完");
  });
});
