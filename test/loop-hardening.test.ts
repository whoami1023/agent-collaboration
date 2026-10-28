import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type ToolImpl } from "../src/agent/loop";
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
  });

  it("工具抛错时按配置重试，最终返回失败信息", async () => {
    let attempts = 0;
    const flakyTool: ToolImpl = {
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
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ name: "flaky" }), "成功");
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
