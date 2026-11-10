import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type ToolImpl } from "../src/agent/loop";
import type { LlmRequest } from "../src/provider/types";
import { MockProvider, type MockHandler } from "../src/provider/mock";

function lastUser(request: LlmRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function assistantTurns(request: LlmRequest): number {
  return request.messages.filter((message) => message.role === "assistant").length;
}

function run(handler: MockHandler, tools: ToolImpl[], extra: Record<string, unknown> = {}) {
  return runAgentLoop({
    provider: new MockProvider(handler),
    model: "mock",
    system: "测试",
    messages: [{ role: "user", content: "开始" }],
    tools,
    maxSteps: 12,
    signal: new AbortController().signal,
    retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    ...extra,
  });
}

const echoTool: ToolImpl = {
  schema: {
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  execute: async (args) => `echo:${String(args["text"] ?? "")}`,
};

describe("输出截断续写", () => {
  it("纯正文被截断时自动续写，并把两段拼成一份", async () => {
    const handler: MockHandler = (request) =>
      lastUser(request).includes("被截断了")
        ? { text: "：后半段结论。" }
        : { text: "第一段进展", finishReason: "length" };
    const result = await run(handler, [echoTool]);
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.text).toBe("第一段进展：后半段结论。");
  });

  it("续写提示要求别复述已写内容，并建议长文档分段落盘", async () => {
    const prompts: string[] = [];
    const handler: MockHandler = (request) => {
      const user = lastUser(request);
      if (user.includes("被截断了")) prompts.push(user);
      return prompts.length >= 2 ? { text: "收尾。" } : { text: "又一段", finishReason: "length" };
    };
    const result = await run(handler, [echoTool]);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[0]).toContain("从中断的地方直接继续写");
    expect(prompts[0]).toContain("append");
    expect(result.error).toBeUndefined();
  });

  it("反复截断到上限后如实标记，不当作完整交付", async () => {
    const handler: MockHandler = () => ({ text: "永远写不完的一段", finishReason: "length" });
    const result = await run(handler, [echoTool]);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("永远写不完的一段");
    // 1 次原始输出 + 4 次续写 = 5 段，第 6 次请求不再发出。
    expect(result.steps).toBe(5);
  });

  it("截断回复里的工具调用一律不执行，只回一条拆小动作的提示", async () => {
    const execute = vi.fn(async () => "不该被调用");
    const spyTool: ToolImpl = { ...echoTool, execute };
    const handler: MockHandler = (request) =>
      lastUser(request).includes("参数可能不完整")
        ? { text: "我拆成两次调用。" }
        : {
            text: "先读文件再写结论",
            toolCalls: [{ name: "echo", args: { text: "半截参数" } }],
            finishReason: "length",
          };
    const result = await run(handler, [spyTool]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toBe("先读文件再写结论我拆成两次调用。");
  });
});

describe("静默停止守卫", () => {
  it("工具跑完没有正文时先补一次提示，模型接着给出答复就不算失败", async () => {
    const handler: MockHandler = (request) => {
      const turns = assistantTurns(request);
      if (turns === 0) return { toolCalls: [{ name: "echo", args: { text: "干活" } }] };
      if (lastUser(request).includes("空回复")) return { text: "已完成：echo 返回了结果。" };
      return { text: "" };
    };
    const result = await run(handler, [echoTool]);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("已完成：echo 返回了结果。");
  });

  it("提醒之后仍然空手，就如实报错而不是回一条空消息", async () => {
    const handler: MockHandler = (request) =>
      assistantTurns(request) === 0
        ? { toolCalls: [{ name: "echo", args: { text: "干活" } }] }
        : { text: "" };
    const result = await run(handler, [echoTool]);
    expect(result.errorCode).toBe("silent_stop");
    expect(result.error).toContain("没有生成任何正文回复");
  });
});

describe("护栏接进循环", () => {
  it("同一个工具反复失败到上限会中止本轮", async () => {
    const handler: MockHandler = (request) => ({
      toolCalls: [{ name: "flaky", args: { attempt: assistantTurns(request) } }],
    });
    const flaky: ToolImpl = {
      schema: {
        name: "flaky",
        description: "总是失败",
        parameters: { type: "object", properties: { attempt: { type: "number" } } },
      },
      execute: async () => "错误：目标不存在",
    };
    const result = await run(handler, [flaky]);
    expect(result.errorCode).toBe("guardrail_halt");
    expect(result.error).toContain("已中止本次运行");
    expect(result.steps).toBe(8);
  });

  it("同一批调用反复重排时先整批不执行，再升级为中止", async () => {
    const batch = [
      { name: "echo", args: { text: "a" } },
      { name: "echo", args: { text: "b" } },
    ];
    const handler: MockHandler = (request) => ({
      toolCalls: assistantTurns(request) % 2 === 0 ? batch : [...batch].reverse(),
    });
    const result = await run(handler, [echoTool]);
    expect(result.errorCode).toBe("guardrail_halt");
    expect(result.error).toContain("工具调用在循环");
    expect(result.steps).toBe(6);
  });

  it("护栏拦截照样补齐 tool 结果行，不破坏调用/结果配对", async () => {
    let captured: LlmRequest | undefined;
    const handler: MockHandler = (request) => {
      captured = request;
      return { toolCalls: [{ name: "echo", args: { text: `第 ${assistantTurns(request)} 次` } }] };
    };
    const failing: ToolImpl = { ...echoTool, execute: async () => "错误：读取失败" };
    const result = await run(handler, [failing]);
    expect(result.errorCode).toBe("guardrail_halt");
    const open: string[] = [];
    let paired = 0;
    for (const message of captured?.messages ?? []) {
      if (message.role === "assistant") for (const call of message.toolCalls ?? []) open.push(call.id);
      if (message.role === "tool") {
        paired += 1;
        expect(open.shift()).toBe(message.toolCallId);
      }
    }
    expect(paired).toBeGreaterThan(0);
    expect(open).toHaveLength(0);
  });

  it("运行姿态挡掉的工具按说明回填，不算失败也不触发拦截", async () => {
    const handler: MockHandler = (request) =>
      assistantTurns(request) < 6
        ? { toolCalls: [{ name: "file_write", args: { path: `a${assistantTurns(request)}.md` } }] }
        : { text: "计划已经给出。" };
    const onToolResult = vi.fn();
    const result = await run(handler, [], {
      toolUnavailable: (name: string) => `计划轮不执行写入类动作：${name} 未挂载`,
      onToolResult,
    });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("计划已经给出。");
    // 每次都返回同一句说明：不该被当成「同参连续失败」而拦下或换成引用桩。
    const notices = onToolResult.mock.calls.map((call) => String(call[1]));
    expect(notices).toHaveLength(6);
    expect(notices.every((text) => text.startsWith("计划轮不执行写入类动作"))).toBe(true);
    expect(notices.some((text) => text.includes("不再执行这次调用"))).toBe(false);
    expect(notices.some((text) => text.includes("已省略"))).toBe(false);
  });

  it("transformToolResult 决定进入上下文的内容", async () => {
    const handler: MockHandler = (request) =>
      assistantTurns(request) === 0
        ? { toolCalls: [{ name: "echo", args: { text: "hi" } }] }
        : { text: "好了" };
    const onToolResult = vi.fn();
    const result = await run(handler, [echoTool], {
      transformToolResult: (name: string, raw: string) => `<untrusted source="${name}">${raw}</untrusted>`,
      onToolResult,
    });
    expect(result.text).toBe("好了");
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      '<untrusted source="echo">echo:hi</untrusted>',
      expect.objectContaining({ ok: true }),
    );
  });
});
