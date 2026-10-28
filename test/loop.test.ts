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

  it("达到最大步数会中止", async () => {
    let counter = 0;
    const handler: MockHandler = () => {
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
    expect(result.error).toContain("最大步数");
    expect(counter).toBe(3);
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
