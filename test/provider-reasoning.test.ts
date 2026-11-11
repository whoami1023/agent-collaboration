// 推理模型的思考字段：OpenAI 兼容流里 reasoning_content / reasoning 都要单独解析，
// 且必须排在正文之前作为独立事件下发，不能混入 content。
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "../src/provider/openai-compatible";
import type { LlmEvent } from "../src/provider/types";

let server: Server | undefined;
let baseUrl = "";

function serveSse(lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const line of lines) response.write(`data: ${line}\n\n`);
      response.end(`data: [DONE]\n\n`);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") throw new Error("端口分配失败");
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

async function collect(base: string): Promise<LlmEvent[]> {
  const provider = new OpenAiCompatibleProvider({ id: "test", baseUrl: base, apiKey: "k", model: "m" });
  const events: LlmEvent[] = [];
  for await (const event of provider.stream({
    model: "m",
    messages: [{ role: "user", content: "开始" }],
    tools: [],
  })) {
    events.push(event);
  }
  return events;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe("OpenAI 兼容推理流", () => {
  it("reasoning_content 与 reasoning 都按顺序作为 reasoning 事件下发", async () => {
    baseUrl = await serveSse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: "先核对资料。" } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning: "再检查环境。" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "结论如下。" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    const events = await collect(baseUrl);
    expect(events.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", delta: "先核对资料。" },
      { type: "reasoning", delta: "再检查环境。" },
    ]);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", delta: "结论如下。" },
    ]);
    expect(events.findIndex((event) => event.type === "reasoning")).toBeLessThan(
      events.findIndex((event) => event.type === "text"),
    );
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });

  it("没有推理字段时不产生 reasoning 事件", async () => {
    baseUrl = await serveSse([
      JSON.stringify({ choices: [{ delta: { content: "普通回答" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);
    const events = await collect(baseUrl);
    expect(events.some((event) => event.type === "reasoning")).toBe(false);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", delta: "普通回答" },
    ]);
  });
});
