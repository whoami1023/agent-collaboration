import { parse as parseYaml } from "yaml";
import {
  KNOWLEDGE_PAGE_TYPES,
  PAGE_TYPE_DIRS,
  type KnowledgePageMeta,
  type KnowledgePageType,
} from "./types";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/** 解析页面开头的 YAML frontmatter；坏掉的 YAML 不抛错，按「没有元数据」处理。 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { data: {}, body: text.trim() };
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: text.slice(match[0].length).trim() };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,，;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function dateString(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    return value.trim().slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return fallback;
}

export function isKnowledgePageType(value: unknown): value is KnowledgePageType {
  return typeof value === "string" && (KNOWLEDGE_PAGE_TYPES as readonly string[]).includes(value);
}

/** 从路径首段推断类型；模型漏写 type 时用它兜底。 */
export function inferTypeFromPath(pagePath: string): KnowledgePageType {
  const dir = pagePath.split("/")[0] ?? "";
  for (const [type, mapped] of Object.entries(PAGE_TYPE_DIRS) as Array<
    [KnowledgePageType, string]
  >) {
    if (mapped === dir) return type;
  }
  return "note";
}

/** 路径与 frontmatter 里的 type 不一致时，以 type 对应的目录为准（schema.md 的约束）。 */
export function correctPagePath(pagePath: string, type: KnowledgePageType): string {
  const segments = pagePath.split("/");
  const rest = segments.slice(1).join("/") || pagePath;
  const expected = PAGE_TYPE_DIRS[type];
  if (segments[0] === expected) return pagePath;
  return `${expected}/${rest}`;
}

export function extractWikiLinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = (match[1] ?? "").split("|")[0]?.split("#")[0]?.trim();
    if (target) links.add(target);
  }
  return [...links];
}

export interface NormalizePageOptions {
  /** 元数据路径（`entities/x.md`）。 */
  path: string;
  /** 前端/服务端注入的来源 ID 列表；模型漏写时兜底。 */
  sourceIds?: string[];
  /** 日期兜底（YYYY-MM-DD）。 */
  today: string;
  /** 模型或文件名给出的标题兜底。 */
  fallbackTitle?: string;
  /** 模型漏写 type 时的兜底。 */
  fallbackType?: KnowledgePageType;
}

/** 把任意文本整理成「带合法 frontmatter 的页面」：类型、标题、标签、链接都补齐。 */
export function normalizePage(
  raw: string,
  options: NormalizePageOptions,
): { meta: KnowledgePageMeta; body: string } {
  const parsed = parseFrontmatter(raw);
  const dirType = inferTypeFromPath(options.path);
  const type = isKnowledgePageType(parsed.data["type"])
    ? parsed.data["type"]
    : (options.fallbackType ?? dirType);
  const title =
    (typeof parsed.data["title"] === "string" && parsed.data["title"].trim()) ||
    options.fallbackTitle ||
    options.path.split("/").pop()?.replace(/\.md$/i, "") ||
    "未命名页面";
  const body = parsed.body;
  const meta: KnowledgePageMeta = {
    path: options.path,
    type,
    title,
    tags: stringList(parsed.data["tags"]),
    related: stringList(parsed.data["related"]),
    sources: unique([
      ...stringList(parsed.data["sources"]),
      ...(options.sourceIds ?? []),
    ]),
    created: dateString(parsed.data["created"], options.today),
    updated: dateString(parsed.data["updated"], options.today),
    links: extractWikiLinks(body),
    size: Buffer.byteLength(raw, "utf8"),
  };
  return { meta, body };
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function yamlScalar(value: string): string {
  if (/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

/** 稳定输出：字段顺序固定，标签与关联按原顺序，便于文件 diff 与测试。 */
export function serializePage(meta: KnowledgePageMeta, body: string): string {
  const lines = [
    "---",
    `type: ${meta.type}`,
    `title: ${yamlScalar(meta.title)}`,
    `tags: ${yamlList(meta.tags)}`,
    `related: ${yamlList(meta.related)}`,
    `sources: ${yamlList(meta.sources)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    "---",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

/** 索引与工具里用的摘要：取第一段非标题正文，压成一行。 */
export function pageSummary(body: string, maxChars = 110): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("|") || line.startsWith(">")) continue;
    const text = line
      .replace(/^[-*+]\s+/, "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, target: string, label?: string) => label ?? target)
      .replace(/[*_`]/g, "")
      .trim();
    if (text) return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return "";
}
