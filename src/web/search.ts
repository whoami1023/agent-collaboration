/**
 * 无密钥网页搜索：优先 DuckDuckGo HTML 端点，空结果或失败时回退 Bing HTML。
 * 检索工作流参考 GitHub 上 usestring/skills 的 string-search 与 ythx-101/ask-search（MIT），
 * 引擎解析与回退逻辑为本项目实现，不依赖第三方 CLI 或 API Key。
 */
import { htmlToText, readHtmlAttribute } from "./html";
import { WEB_USER_AGENT } from "./fetch";

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_QUERY_CHARS = 300;
const MAX_RESULTS = 10;

export type SearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  provider: "duckduckgo" | "bing";
  results: WebSearchResult[];
  tookMs: number;
  warning?: string;
}

export interface SearchWebOptions {
  maxResults?: number;
  site?: string;
  freshness?: SearchFreshness;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface Anchor {
  attrs: string;
  inner: string;
}

function scanAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    anchors.push({ attrs: match[1] ?? "", inner: match[2] ?? "" });
  }
  return anchors;
}

function hasClass(attrs: string, name: string): boolean {
  const value = readHtmlAttribute(attrs, "class");
  return value ? value.split(/\s+/).includes(name) : false;
}

function cleanText(raw: string, maxChars: number): string {
  const text = htmlToText(raw).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function absolutize(url: URL): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString();
}

function unwrapDuckDuckGo(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, "https://duckduckgo.com");
  } catch {
    return undefined;
  }
  if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
    const target = url.searchParams.get("uddg");
    if (!target) return undefined;
    try {
      return absolutize(new URL(target));
    } catch {
      return undefined;
    }
  }
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return undefined;
  return absolutize(url);
}

function unwrapBing(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, "https://www.bing.com");
  } catch {
    return undefined;
  }
  if (url.hostname.endsWith("bing.com") && url.pathname.startsWith("/ck/a")) {
    const encoded = url.searchParams.get("u");
    if (encoded?.startsWith("a1")) {
      try {
        const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return absolutize(new URL(decoded));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (/(^|\.)bing\.com$/i.test(url.hostname)) return undefined;
  return absolutize(url);
}

function dedupe(results: WebSearchResult[], limit: number): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const item of results) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function parseDuckDuckGo(html: string, limit: number): WebSearchResult[] {
  const anchors = scanAnchors(html);
  const titles = anchors.filter((anchor) => hasClass(anchor.attrs, "result__a"));
  const snippets = anchors.filter((anchor) => hasClass(anchor.attrs, "result__snippet"));
  const results: WebSearchResult[] = [];
  titles.forEach((anchor, index) => {
    const url = unwrapDuckDuckGo(readHtmlAttribute(anchor.attrs, "href"));
    const title = cleanText(anchor.inner, 200);
    if (!url || !title) return;
    const snippet = snippets[index] ? cleanText(snippets[index]!.inner, 400) : "";
    results.push({ title, url, snippet });
  });
  return dedupe(results, limit);
}

function parseBing(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const rawBlock of blocks) {
    const block = rawBlock.split(/<\/li>/i)[0] ?? rawBlock;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1];
    if (!heading) continue;
    const link = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading);
    if (!link) continue;
    const url = unwrapBing(readHtmlAttribute(link[1] ?? "", "href"));
    const title = cleanText(link[2] ?? "", 200);
    if (!url || !title) continue;
    const snippetRaw =
      /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
      /<div\b[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
      "";
    results.push({ title, url, snippet: cleanText(snippetRaw, 400) });
    if (results.length >= limit) break;
  }
  return dedupe(results, limit);
}

async function fetchSearchHtml(
  url: string,
  options: SearchWebOptions,
  timeoutMs: number,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal,
    headers: {
      "user-agent": WEB_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function normalizeSite(raw: string | undefined): string | undefined {
  const value = raw?.trim().replace(/^site:\s*/i, "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return value && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) ? value.toLowerCase() : undefined;
}

export async function searchWeb(rawQuery: string, options: SearchWebOptions = {}): Promise<WebSearchResponse> {
  const startedAt = Date.now();
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (!query) throw new Error("搜索词不能为空");
  const limit =
    typeof options.maxResults === "number" && Number.isFinite(options.maxResults)
      ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(options.maxResults)))
      : 5;
  const site = normalizeSite(options.site);
  const effectiveQuery = site ? `${query} site:${site}` : query;
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.min(30_000, Math.max(1_000, Math.floor(options.timeoutMs)))
      : SEARCH_TIMEOUT_MS;

  const errors: string[] = [];
  const freshnessParam =
    options.freshness === "day" ? "d"
      : options.freshness === "week" ? "w"
        : options.freshness === "month" ? "m"
          : options.freshness === "year" ? "y"
            : undefined;

  const ddgUrl = new URL("https://html.duckduckgo.com/html/");
  ddgUrl.searchParams.set("q", effectiveQuery);
  if (freshnessParam) ddgUrl.searchParams.set("df", freshnessParam);
  try {
    const html = await fetchSearchHtml(ddgUrl.toString(), options, timeoutMs);
    const results = parseDuckDuckGo(html, limit);
    if (results.length > 0) {
      return { query: effectiveQuery, provider: "duckduckgo", results, tookMs: Date.now() - startedAt };
    }
    errors.push("DuckDuckGo 没有返回结果");
  } catch (error) {
    errors.push(`DuckDuckGo：${error instanceof Error ? error.message : String(error)}`);
  }

  const bingUrl = new URL("https://www.bing.com/search");
  bingUrl.searchParams.set("q", effectiveQuery);
  bingUrl.searchParams.set("count", String(Math.max(limit, 10)));
  bingUrl.searchParams.set("setlang", "zh-Hans");
  try {
    const html = await fetchSearchHtml(bingUrl.toString(), options, timeoutMs);
    const results = parseBing(html, limit);
    if (results.length > 0) {
      return {
        query: effectiveQuery,
        provider: "bing",
        results,
        tookMs: Date.now() - startedAt,
        warning: `已回退到 Bing（${errors.join("；")}）`,
      };
    }
    errors.push("Bing 没有返回结果");
  } catch (error) {
    errors.push(`Bing：${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error(`搜索失败：${errors.join("；")}`);
}

export const SEARCH_MAX_RESULTS = MAX_RESULTS;
