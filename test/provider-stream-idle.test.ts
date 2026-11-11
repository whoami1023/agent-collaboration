// 流式响应空闲超时：连接还在但长时间不来数据时必须主动中止，而不是跟着整轮超时一起挂住。
import { describe, expect, it } from "vitest";
import {
  ProviderStreamIdleError,
  readSseLines,
  transportError,
  type ReadSseOptions,
} from "../src/provider/http";

function streamOf(chunks: string[], options: { close?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.close !== false) controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>, options: ReadSseOptions): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readSseLines(body, options)) lines.push(line);
  return lines;
}

describe("SSE 读流的空闲超时", () => {
  it("正常分块按行输出，不因空闲窗口误伤", async () => {
    const lines = await collect(streamOf(["data: a\nb", "\nc\n"]), { idleMs: 1_000 });
    expect(lines).toEqual(["data: a", "b", "c"]);
  });

  it("已收到的行照常交付，随后停住的行等到窗口耗尽才中止", async () => {
    const seen: string[] = [];
    const body = streamOf(["data: first\n\n"], { close: false });
    await expect(
      (async () => {
        for await (const line of readSseLines(body, { idleMs: 40 })) seen.push(line);
      })(),
    ).rejects.toBeInstanceOf(ProviderStreamIdleError);
    expect(seen).toEqual(["data: first", ""]);
  });

  it("错误可被传输层直接转成可读文案", () => {
    const error = new ProviderStreamIdleError(40);
    expect(error.name).toBe("ProviderStreamIdleError");
    expect(error.idleMs).toBe(40);
    expect(transportError(error)).toContain("没有收到任何新数据");
  });
});
