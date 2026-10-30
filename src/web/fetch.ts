/**
 * 抓取正文。行为对齐 OpenClaw agents/tools/web-fetch（MIT）的核心契约：
 * 只抓 http(s)、逐跳校验重定向、限制响应字节数与返回字符数、记录最终 URL 与抽取方式；
 * 未移植 readability/缓存/spill，HTML 走本项目的有界抽取（见 html.ts）。
 */
import { extractTitle, htmlToMarkdown } from "./html";
import { assertPublicHttpUrl, WebUrlBlockedError, type LookupFn } from "./ssrf";

export const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_START = 2_000_000;

export type ExtractKind = "html" | "text" | "json" | "binary";

export interface WebPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  extractor: ExtractKind;
  text: string;
  totalChars: number;
  truncated: boolean;
  nextStart?: number;
  warning?: string;
  redirects: number;
  tookMs: number;
}

export interface FetchPageOptions {
  maxChars?: number;
  start?: number;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}

const CHALLENGE_TITLE =
  /just a moment|attention required|access denied|verify you are human|are you a robot|安全验证|人机验证|请稍候|请完成验证|访问验证/i;
const CHALLENGE_TEXT =
  /cf-mitigated|challenge-platform|cf_chl_|captcha|unusual traffic|verify you are human|checking your browser|环境异常|完成验证后即可继续访问|访问异常|请输入验证码/i;

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function classify(contentType: string): ExtractKind {
  const type = contentType.toLowerCase();
  if (type.includes("text/html") || type.includes("application/xhtml")) return "html";
  if (type.includes("json")) return "json";
  if (type.startsWith("text/") || type.includes("xml") || type.includes("javascript")) return "text";
  if (!type) return "html";
  return "binary";
}

function detectCharset(contentType: string, bytes: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const meta =
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(head)?.[1];
  return meta ?? "utf-8";
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = /^(gb2312|gbk|gb18030)$/i.test(charset) ? "gb18030" : charset;
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged, truncated };
}

function buildWarning(input: {
  status: number;
  extractor: ExtractKind;
  title?: string;
  text: string;
  htmlLength: number;
  bytesTruncated: boolean;
}): string | undefined {
  const notes: string[] = [];
  if (input.status === 401 || input.status === 403) {
    notes.push(`HTTP ${input.status}：站点拒绝抓取或需要登录，正文可能不是目标内容。`);
  } else if (input.status === 404 || input.status === 410) {
    notes.push(`HTTP ${input.status}：页面不存在或已删除。`);
  } else if (input.status === 429) {
    notes.push("HTTP 429：请求过于频繁，建议稍后再试。");
  }
  const challenge =
    (input.title && CHALLENGE_TITLE.test(input.title)) ||
    (input.text.length < 3_000 && CHALLENGE_TEXT.test(input.text)) ||
    (input.title && input.text.length < 500 && CHALLENGE_TEXT.test(input.title));
  if (challenge && input.extractor === "html") {
    notes.push("页面疑似验证/反爬拦截页，正文可能不可信；请换用官方 API、RSS 或让用户粘贴内容。");
  } else if (input.extractor === "html" && input.text.length < 200 && input.htmlLength > 20_000) {
    notes.push("页面疑似由 JavaScript 动态渲染，当前抓取只能拿到空壳；建议改用官方 API 或让用户提供正文。");
  }
  if (input.extractor === "binary") {
    notes.push("不支持的内容类型：只解析 HTML、纯文本与 JSON，二进制文件（PDF/图片/压缩包）请提供可读文本。");
  }
  if (input.bytesTruncated) {
    notes.push("响应体超过抓取上限，只读取了前半部分。");
  }
  return notes.length > 0 ? notes.join("\n") : undefined;
}

export async function fetchWebPage(rawUrl: string, options: FetchPageOptions = {}): Promise<WebPage> {
  const startedAt = Date.now();
  const maxChars = clamp(options.maxChars, 500, 50_000, DEFAULT_MAX_CHARS);
  const start = clamp(options.start, 0, MAX_START, 0);
  const maxBytes = clamp(options.maxBytes, 64_000, 2_000_000, DEFAULT_MAX_BYTES);
  const timeoutMs = clamp(options.timeoutMs, 1_000, 60_000, DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let current = await assertPublicHttpUrl(rawUrl, options.lookup);
  let redirects = 0;
  let response: Response | undefined;
  while (redirects <= MAX_REDIRECTS) {
    let hop: Response;
    try {
      hop = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "user-agent": WEB_USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
    } catch (error) {
      if (error instanceof WebUrlBlockedError) throw error;
      const name = (error as { name?: string } | null)?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        throw new Error(`抓取超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if ([301, 302, 303, 307, 308].includes(hop.status)) {
      const location = hop.headers.get("location");
      await hop.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`服务器返回 ${hop.status} 但没有跳转地址`);
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次，已停止`);
      current = await assertPublicHttpUrl(new URL(location, current).toString(), options.lookup);
      continue;
    }
    response = hop;
    break;
  }
  if (!response) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次，已停止`);

  const contentType = response.headers.get("content-type") ?? "";
  const extractor = classify(contentType);
  if (extractor === "binary") {
    await response.body?.cancel().catch(() => undefined);
    return {
      url: rawUrl,
      finalUrl: current.toString(),
      status: response.status,
      contentType,
      extractor,
      text: "",
      totalChars: 0,
      truncated: false,
      warning: buildWarning({
        status: response.status,
        extractor,
        text: "",
        htmlLength: 0,
        bytesTruncated: false,
      }),
      redirects,
      tookMs: Date.now() - startedAt,
    };
  }

  const { bytes, truncated: bytesTruncated } = await readCapped(response, maxBytes);
  const raw = decodeBytes(bytes, detectCharset(contentType, bytes));
  const title = extractor === "html" ? extractTitle(raw) : undefined;
  const fullText =
    extractor === "html"
      ? htmlToMarkdown(raw, current.toString())
      : extractor === "text"
        ? raw.replace(/\r\n?/g, "\n")
        : raw;
  const totalChars = fullText.length;
  const text = fullText.slice(start, start + maxChars);
  const nextStart = start + text.length < totalChars ? start + text.length : undefined;
  const warning = buildWarning({
    status: response.status,
    extractor,
    ...(title ? { title } : {}),
    text: fullText,
    htmlLength: raw.length,
    bytesTruncated,
  });

  return {
    url: rawUrl,
    finalUrl: current.toString(),
    status: response.status,
    contentType,
    ...(title ? { title } : {}),
    extractor,
    text,
    totalChars,
    truncated: nextStart !== undefined,
    ...(nextStart !== undefined ? { nextStart } : {}),
    ...(warning ? { warning } : {}),
    redirects,
    tookMs: Date.now() - startedAt,
  };
}
