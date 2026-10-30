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
});
