import { describe, expect, it, vi } from "vitest";
import { fillMissingToolResults, runAgentLoop, type ToolImpl } from "../src/agent/loop";
import { ToolFailure } from "../src/agent/tool-errors";
import type { LlmMessage } from "../src/provider/types";
import { MockProvider, type MockHandler } from "../src/provider/mock";

const echoTool: ToolImpl = {
  schema: {
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  execute: async (args) => `echo:${String(args["text"] ?? "")}`,
};

function run(handler: MockHandler, tools: ToolImpl[], extra: Record<string, unknown> = {}) {
  return runAgentLoop({
    provider: new MockProvider(handler),
    model: "mock",
    system: "测试",
    messages: [{ role: "user", content: "开始" }],
    tools,
    maxSteps: 6,
    signal: new AbortController().signal,
    retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 10, jitter: 0 },
    ...extra,
  });
}

describe("agent loop hardening", () => {
  it("Xmlish 文本式工具调用被修复执行并从可见文本中剥离", async () => {
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) {
        return { text: "<function=echo><parameter=text>hi</parameter></function>" };
      }
      return { text: "完成" };
    };
    const onRepair = vi.fn();
    const onToolResult = vi.fn();
    const result = await run(handler, [echoTool], { onRepair, onToolResult });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("完成");
    expect(onRepair).toHaveBeenCalledWith({ toolNames: ["echo"] });
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      "echo:hi",
      expect.objectContaining({ ok: true }),
    );
  });

  it("JSON tool_calls 文本被修复执行", async () => {
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) {
        return { text: '{"name":"echo","arguments":{"text":"json"}}' };
      }
      return { text: "好" };
    };
    const onRepair = vi.fn();
    const result = await run(handler, [echoTool], { onRepair });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("好");
    expect(onRepair).toHaveBeenCalledWith({ toolNames: ["echo"] });
  });

  it("bracketed 文本式工具调用被修复执行", async () => {
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) {
        return { text: '[tool:echo] {"text":"bracket"}' };
      }
      return { text: "好" };
    };
    const onToolResult = vi.fn();
    const result = await run(handler, [echoTool], { onToolResult });
    expect(result.error).toBeUndefined();
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "echo" }),
      "echo:bracket",
      expect.objectContaining({ ok: true }),
    );
  });

  it("无法执行的近失调用警告模型后继续，最终以普通文本结束", async () => {
    const handler: MockHandler = (request) => {
      const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (lastUser.includes("格式无法执行")) return { text: "收到，我直接给结论。" };
      return { text: "Action: nonexistent_tool\nAction Input: {\"x\":1}" };
    };
    const result = await run(handler, [echoTool]);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("收到，我直接给结论。");
  });

  it("长重复输出被 repetition guard 中止", async () => {
    const repeated = "同样的句子不断重复。".repeat(1700);
    const singleDeltaProvider = {
      id: "single",
      async *stream() {
        yield { type: "text" as const, delta: repeated };
        yield { type: "done" as const, stopReason: "stop" };
      },
    };
    const result = await runAgentLoop({
      provider: singleDeltaProvider,
      model: "mock",
      system: "测试",
      messages: [{ role: "user", content: "开始" }],
      tools: [],
      maxSteps: 6,
      signal: new AbortController().signal,
    });
    expect(result.error).toContain("重复输出");
    expect(result.errorCode).toBe("repetition_detected");
  });

  it("sequential 工具独占执行；中途 steering 释放剩余调用", async () => {
    const order: string[] = [];
    let afterFirst = false;
    const seqTool: ToolImpl = {
      schema: {
        name: "seq",
        description: "独占",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      executionMode: "sequential",
      execute: async (args) => {
        const id = String(args["id"] ?? "");
        order.push(id);
        if (id === "a") afterFirst = true;
        return "ok";
      },
    };
    let pulled = 0;
    let followUp: LlmMessage[] | undefined;
    const handler: MockHandler = (request) => {
      const assistantSteps = request.messages.filter((m) => m.role === "assistant").length;
      if (assistantSteps === 0) {
        return {
          toolCalls: [
            { name: "seq", args: { id: "a" } },
            { name: "seq", args: { id: "b" } },
            { name: "seq", args: { id: "c" } },
          ],
        };
      }
      followUp = request.messages;
      const sawSteering = request.messages.some(
        (m) => m.role === "user" && m.content === "steer:打断",
      );
      return { text: sawSteering ? "已按新指令处理" : "没有收到打断" };
    };
    const result = await run(handler, [seqTool], {
      pullPending: () => {
        if (afterFirst && pulled === 0) {
          pulled += 1;
          return [{ role: "user", content: "steer:打断" }];
        }
        return [];
      },
    });
    expect(result.text).toBe("已按新指令处理");
    expect(order).toEqual(["a"]);
    // 被释放的 b、c 也必须各有一条工具结果，且排在打断消息之前，否则真实接口会 400。
    const sent = followUp ?? [];
    const assistantAt = sent.findIndex((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) === 3);
    expect(assistantAt).toBeGreaterThanOrEqual(0);
    const ids = (sent[assistantAt]?.toolCalls ?? []).map((call) => call.id);
    const results = sent
      .slice(assistantAt + 1)
      .filter((m) => m.role === "tool")
      .map((m) => m.toolCallId);
    expect(results).toEqual(ids);
    const steeringAt = sent.findIndex((m) => m.role === "user" && m.content === "steer:打断");
    expect(steeringAt).toBeGreaterThan(assistantAt + 3);
  });

  it("悬空的 tool_calls 会在请求前补上说明性结果", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "测试" },
      { role: "user", content: "开始" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "seq", args: { id: "a" } },
          { id: "call_b", name: "seq", args: { id: "b" } },
        ],
      },
      { role: "tool", toolCallId: "call_a", content: "ok" },
      { role: "user", content: "新消息" },
    ];
    fillMissingToolResults(messages);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    const synthetic = messages[4];
    expect(synthetic?.role === "tool" ? synthetic.toolCallId : undefined).toBe("call_b");
    expect(messages[5]?.content).toBe("新消息");
  });

  it("工具结果乱序时按 tool_calls 顺序重排", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "测试" },
      { role: "user", content: "开始" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "run_batch", args: {} },
          { id: "call_b", name: "file_read", args: {} },
        ],
      },
      { role: "tool", toolCallId: "call_b", content: "挂起占位" },
      { role: "tool", toolCallId: "call_a", content: "真实结果" },
    ];
    fillMissingToolResults(messages);
    const results = messages.filter((m) => m.role === "tool");
    expect(results.map((m) => (m.role === "tool" ? m.toolCallId : ""))).toEqual(["call_a", "call_b"]);
    expect(results.map((m) => m.content)).toEqual(["真实结果", "挂起占位"]);
  });

  it("工具抛错时按配置重试，最终返回失败信息", async () => {
    let attempts = 0;
    const flakyTool: ToolImpl = {
      retry: "idempotent",
      schema: {
        name: "flaky",
        description: "会抛错",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("第一次失败");
        return "成功";
      },
    };
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "flaky", args: {} }] };
      return { text: "完成" };
    };
    const onToolResult = vi.fn();
    const result = await run(handler, [flakyTool], { onToolResult });
    expect(result.text).toBe("完成");
    expect(attempts).toBe(2);
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "flaky" }),
      "成功",
      expect.objectContaining({ ok: true }),
    );
  });

  it("未声明可重试的工具失败后不重跑", async () => {
    let attempts = 0;
    const writeTool: ToolImpl = {
      schema: {
        name: "write_once",
        description: "有副作用",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => {
        attempts += 1;
        throw new Error("写完才报错");
      },
    };
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "write_once", args: {} }] };
      return { text: "收到" };
    };
    const result = await run(handler, [writeTool]);
    expect(result.text).toBe("收到");
    expect(attempts).toBe(1);
  });

  it("声明可重试的工具遇到确定性错误不重试", async () => {
    let attempts = 0;
    const readTool: ToolImpl = {
      retry: "safe",
      schema: {
        name: "read_safe",
        description: "只读",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => {
        attempts += 1;
        throw new ToolFailure("invalid_argument", "path 不能为空");
      },
    };
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "read_safe", args: {} }] };
      return { text: "收到" };
    };
    const onToolRetry = vi.fn();
    await run(handler, [readTool], { onToolRetry });
    expect(attempts).toBe(1);
    expect(onToolRetry).not.toHaveBeenCalled();
  });

  it("声明可重试的工具遇到瞬时错误会重试并记录次数", async () => {
    let attempts = 0;
    const readTool: ToolImpl = {
      retry: "safe",
      schema: {
        name: "read_flaky",
        description: "只读但暂时不可用",
        parameters: { type: "object", properties: {} },
      },
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new ToolFailure("rate_limited", "上游限流");
        return "读到了";
      },
    };
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "read_flaky", args: {} }] };
      return { text: "完成" };
    };
    const onToolRetry = vi.fn();
    const onToolResult = vi.fn();
    await run(handler, [readTool], { onToolRetry, onToolResult });
    expect(attempts).toBe(2);
    expect(onToolRetry).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_flaky", attempt: 1 }),
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_flaky" }),
      "读到了",
      expect.objectContaining({ ok: true }),
    );
  });

  it("未知工具返回错误结果并继续，不中断循环", async () => {
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0) return { toolCalls: [{ name: "ghost", args: {} }] };
      return { text: "没有该工具也继续了" };
    };
    const result = await run(handler, [echoTool]);
    expect(result.text).toBe("没有该工具也继续了");
  });
});
