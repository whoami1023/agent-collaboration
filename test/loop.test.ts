import { describe, expect, it, vi } from "vitest";
import { ToolSuspensionSignal, runAgentLoop, type ToolImpl } from "../src/agent/loop";
import { MockProvider, type MockHandler } from "../src/provider/mock";

const echoTool: ToolImpl = {
  schema: {
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  execute: async (args) => `echo:${String(args["text"] ?? "")}`,
};

describe("agent loop", () => {
  it("执行工具后把结果喂回模型并结束", async () => {
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "echo", args: { text: "hi" } }] };
      return { text: "完成" };
    };
    const onToolResult = vi.fn();
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 5,
      signal: new AbortController().signal,
      onToolResult,
    });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("完成");
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      "echo:hi",
      expect.objectContaining({ ok: true }),
    );
  });

  it("连续相同的工具调用会被中止", async () => {
    const handler: MockHandler = () => ({
      toolCalls: [{ name: "echo", args: { text: "same" } }],
    });
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 10,
      signal: new AbortController().signal,
    });
    expect(result.error).toContain("重复");
  });

  it("达到最大步数时停止工具调用并生成收尾总结", async () => {
    let counter = 0;
    const handler: MockHandler = (request) => {
      if (request.tools.length === 0) return { text: "收尾总结：已完成调研，未完成压测。" };
      counter += 1;
      return { toolCalls: [{ name: "echo", args: { text: String(counter) } }] };
    };
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    expect(result.error).toBeUndefined();
    expect(result.maxStepsReached).toBe(true);
    expect(result.text).toContain("收尾总结");
    expect(result.steps).toBe(4);
    expect(counter).toBe(3);
  });

  it("收尾调用失败时保留已有文本，不丢弃整轮进展", async () => {
    let counter = 0;
    const handler: MockHandler = (request) => {
      if (request.tools.length === 0) throw new Error("收尾接口失败");
      counter += 1;
      return {
        text: `阶段发现 ${counter}`,
        toolCalls: [{ name: "echo", args: { text: String(counter) } }],
      };
    };
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    expect(result.error).toBeUndefined();
    expect(result.maxStepsReached).toBe(true);
    expect(result.text).toContain("阶段发现 2");
  });

  it("工具挂起后不再请求模型，同批后续工具不执行", async () => {
    let modelCalls = 0;
    let echoCalls = 0;
    const askTool: ToolImpl = {
      schema: { name: "ask", description: "提问", parameters: { type: "object", properties: {} } },
      executionMode: "sequential",
      retry: "never",
      execute: async () => {
        throw new ToolSuspensionSignal({
          kind: "awaiting_user",
          questionId: "ask_1",
          messageId: "msg_1",
        });
      },
    };
    const countingEcho: ToolImpl = {
      ...echoTool,
      execute: async (args) => {
        echoCalls += 1;
        return `echo:${String(args["text"] ?? "")}`;
      },
    };
    const seen: string[] = [];
    const handler: MockHandler = () => {
      modelCalls += 1;
      return {
        text: "先说一句",
        toolCalls: [
          { name: "ask", args: {} },
          { name: "echo", args: { text: "不该执行" } },
        ],
      };
    };
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [askTool, countingEcho],
      maxSteps: 5,
      signal: new AbortController().signal,
      onToolResult: (call, content) => seen.push(`${call.name}:${content}`),
    });
    expect(modelCalls).toBe(1);
    expect(result.cancelled).toBe(false);
    expect(result.text).toBe("先说一句");
    expect(result.suspended).toEqual({
      kind: "awaiting_user",
      questionId: "ask_1",
      messageId: "msg_1",
    });
    expect(echoCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("ask:");
  });

  it("续跑时把回答插在已完成历史之后", async () => {
    const seen: string[][] = [];
    const handler: MockHandler = (request) => {
      seen.push(request.messages.map((message) => `${message.role}:${message.content}`));
      return { text: "继续完成" };
    };
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [],
      maxSteps: 3,
      signal: new AbortController().signal,
      resume: {
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ask", args: {} }] },
          { role: "tool", toolCallId: "c1", content: "本轮已挂起，等待用户回答" },
        ],
        pendingCalls: [],
        steps: 1,
      },
      resumeFollowUp: "用户回答：完整报告",
    });
    expect(result.text).toBe("继续完成");
    const sent = seen[0]!;
    expect(sent.at(-1)).toBe("user:用户回答：完整报告");
    const historyAt = sent.indexOf("tool:本轮已挂起，等待用户回答");
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(historyAt).toBeLessThan(sent.length - 1);
  });

  it("中止信号会终止运行", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgentLoop({
        provider: new MockProvider(() => ({ text: "never" })),
        model: "mock",
        system: "测试",
        messages: [{ role: "user", content: "开始" }],
        tools: [],
        maxSteps: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("大预算在只剩 3 步时提醒收尾且只提醒一次，小预算不打扰", async () => {
    const userTurnsOf = (request: Parameters<MockHandler>[0]) =>
      request.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    let counter = 0;
    const handler: MockHandler = (request) => {
      turns.push(userTurnsOf(request));
      if (request.tools.length === 0) return { text: "收尾总结" };
      counter += 1;
      return { toolCalls: [{ name: "echo", args: { text: String(counter) } }] };
    };
    const turns: string[][] = [];
    const big = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 24,
      signal: new AbortController().signal,
    });
    const noticedAt = (list: string[]) => list.filter((c) => c.includes("步数预算只剩 3 步")).length;
    const firstNoticeTurn = turns.findIndex((list) => noticedAt(list) > 0);
    expect(big.maxStepsReached).toBe(true);
    expect(firstNoticeTurn).toBe(21);
    expect(turns.slice(0, firstNoticeTurn).every((list) => noticedAt(list) === 0)).toBe(true);
    // 只注入一次：之后每轮都带着同一条提醒，不会重复叠加。
    expect(turns.slice(firstNoticeTurn).every((list) => noticedAt(list) === 1)).toBe(true);

    turns.length = 0;
    const small = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 6,
      signal: new AbortController().signal,
    });
    expect(small.maxStepsReached).toBe(true);
    expect(turns.some((list) => list.some((c) => c.includes("步数预算只剩")))).toBe(false);
  });

  it("推理增量通过回调逐段下发，不混入正文与工具结果", async () => {
    const handler: MockHandler = (request) =>
      request.tools.length > 0
        ? {
            reasoning: "先看环境，再决定调用哪个工具。",
            text: "结论",
            toolCalls: [{ name: "echo", args: { text: "hi" } }],
          }
        : { text: "完成" };
    const deltas: string[] = [];
    const texts: string[] = [];
    const result = await runAgentLoop({
      provider: new MockProvider(handler),
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [echoTool],
      maxSteps: 1,
      signal: new AbortController().signal,
      onReasoningDelta: (delta) => deltas.push(delta),
      onDelta: (delta) => texts.push(delta),
    });
    expect(deltas.join("")).toBe("先看环境，再决定调用哪个工具。");
    expect(texts.join("")).toContain("结论");
    expect(deltas.join("")).not.toContain("echo");
    expect(result.text).toContain("完成");
  });
});
