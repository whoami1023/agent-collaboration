import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type ToolImpl } from "../src/agent/loop";
import { MockProvider, type MockHandler } from "../src/provider/mock";
import {
  ToolFailure,
  classifyToolResult,
  toolErrorText,
  toolFailureText,
} from "../src/agent/tool-errors";

function loopWith(handler: MockHandler, tools: ToolImpl[], extra: Record<string, unknown> = {}) {
  return runAgentLoop({
    provider: new MockProvider(handler),
    model: "mock",
    system: "测试",
    messages: [{ role: "user", content: "开始" }],
    tools,
    maxSteps: 8,
    signal: new AbortController().signal,
    retry: { attempts: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    ...extra,
  });
}

describe("工具失败契约", () => {
  it("结构化失败保留「错误：」首行，并追加 code、原因、下一步与核验", () => {
    const text = toolErrorText(
      new ToolFailure("not_found", "文件不存在：reports/a.md", {
        why: "文件还没写出",
        next: "先用 file_list 确认路径",
        verify: "file_read reports/a.md 能读到内容",
      }),
    );
    expect(text.startsWith("错误：文件不存在：reports/a.md")).toBe(true);
    expect(text).toContain("错误码：not_found");
    expect(text).toContain("原因：文件还没写出");
    expect(text).toContain("下一步：先用 file_list 确认路径");
    expect(text).toContain("核验：file_read reports/a.md 能读到内容");
  });

  it("没有补充说明时不追加噪音", () => {
    expect(toolFailureText("invalid_argument", "path 不能为空")).toBe("错误：path 不能为空");
  });

  it("按文本与 JSON 状态归类稳定 code", () => {
    expect(classifyToolResult("正常结果")).toEqual({ ok: true });
    expect(classifyToolResult("错误：path 不能为空").code).toBe("invalid_argument");
    expect(classifyToolResult("读取失败：文件不存在：a.md").code).toBe("not_found");
    expect(classifyToolResult("错误：技能 x 未对 @甲 启用").code).toBe("permission_denied");
    expect(classifyToolResult("工具执行失败：HTTP 429 Too Many Requests").code).toBe("rate_limited");
    expect(classifyToolResult("命令结束，退出码：2").code).toBe("command_failed");
    expect(classifyToolResult(JSON.stringify({ disabled: true, warning: "记忆检索暂时不可用" })).code).toBe(
      "unavailable",
    );
    expect(classifyToolResult(JSON.stringify({ status: "not_found", error: "x" })).code).toBe(
      "not_found",
    );
  });

  it("工具返回的结构化失败连 code 一起交给 onToolResult", async () => {
    const tool: ToolImpl = {
      schema: { name: "probe", description: "探测", parameters: { type: "object", properties: {} } },
      execute: async () =>
        toolFailureText("not_found", "目标不存在：a.md", { next: "换一个路径" }),
    };
    const handler: MockHandler = (request) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "已根据错误调整" }
        : { toolCalls: [{ name: "probe", args: {} }] };
    const onToolResult = vi.fn();
    const result = await loopWith(handler, [tool], { onToolResult });
    expect(result.text).toBe("已根据错误调整");
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "probe" }),
      expect.stringContaining("下一步：换一个路径"),
      { ok: false, code: "not_found" },
    );
  });

  it("抛出的 ToolFailure 走同一套 code，不再被当成未知异常", async () => {
    const tool: ToolImpl = {
      schema: { name: "boom", description: "失败", parameters: { type: "object", properties: {} } },
      execute: async () => {
        throw new ToolFailure("conflict", "文件已存在：reports/a.md", {
          next: "传 overwrite=true 覆盖，或换一个路径",
        });
      },
    };
    const handler: MockHandler = (request) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "已处理冲突" }
        : { toolCalls: [{ name: "boom", args: {} }] };
    const onToolResult = vi.fn();
    await loopWith(handler, [tool], { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "boom" }),
      expect.stringContaining("错误码：conflict"),
      { ok: false, code: "conflict" },
    );
  });

  it("未挂载的工具标记为 unknown_tool", async () => {
    const handler: MockHandler = (request) =>
      request.messages.some((message) => message.role === "tool")
        ? { text: "知道了" }
        : { toolCalls: [{ name: "missing", args: {} }] };
    const onToolResult = vi.fn();
    await loopWith(handler, [], { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "missing" }),
      expect.stringContaining("没有名为 missing 的工具"),
      { ok: false, code: "unknown_tool" },
    );
  });
});
