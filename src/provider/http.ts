// 传输层公共件：SSE 行读取、超时信号组合、请求头合成与带状态的 HTTP 错误。

/** 上游返回的非 2xx：保留状态码与截断后的响应体，供探针分类与用户排错。 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly code?: string,
    readonly typeName?: string,
  ) {
    super(`模型接口 ${status}${code ? `（${code}）` : ""}：${body.slice(0, 400) || "无响应体"}`);
    this.name = "ProviderHttpError";
  }
}

export async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

/** 自定义头里忽略大小写地取一个键（用户可能写 `Authorization` 或 `authorization`）。 */
export function applyHeaders(
  target: Record<string, string>,
  overrides: Record<string, string> | undefined,
): void {
  if (!overrides) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.trim()) continue;
    if (!value.trim()) {
      const existing = Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (existing) delete target[existing];
      continue;
    }
    const existing = Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (existing) delete target[existing];
    target[key] = value;
  }
}

/** 把请求级超时与调用方取消信号合成一个信号（Node 20+ 提供 AbortSignal.any）。 */
export function composeSignal(caller: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined || timeoutMs <= 0) return caller;
  const timeout = AbortSignal.timeout(Math.floor(timeoutMs));
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, timeout]);
  const controller = new AbortController();
  const abortBoth = () => controller.abort();
  caller.addEventListener("abort", abortBoth, { once: true });
  timeout.addEventListener("abort", abortBoth, { once: true });
  return controller.signal;
}

/** 从错误对象里取可读信息（AbortError 归一成「超时/取消」文案）。 */
export function transportError(err: unknown): string {
  if (err instanceof ProviderHttpError) return err.message;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "模型请求超时或被取消";
    return err.message;
  }
  return String(err);
}

export interface PostStreamParams {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 发起流式 POST，校验状态与响应体可用性，返回 SSE 流。 */
export async function postForStream(params: PostStreamParams): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(params.body),
    signal: params.signal ?? null,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    let code: string | undefined;
    let typeName: string | undefined;
    try {
      const parsed = JSON.parse(detail) as { error?: { code?: unknown; type?: unknown } };
      code = typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
      typeName = typeof parsed.error?.type === "string" ? parsed.error.type : undefined;
    } catch {
      // 非 JSON 错误体（网关 HTML 页等）保留原文即可。
    }
    throw new ProviderHttpError(response.status, detail, code, typeName);
  }
  return response.body;
}
