/*!
 * Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
 * MIT License, Copyright (c) OpenClaw contributors.
 * Sources: packages/markdown-core/src/frontmatter.ts (normalize/extract/parse, line fallback,
 * colon-rich freeform recovery, UNTERMINATED_FRONTMATTER), src/skills/loading/frontmatter.ts
 * (parseSkillFrontmatter), src/skills/loading/local-loader.ts:80-158 (name fallback,
 * "name is required" / "description is required", skip-with-diagnostic),
 * src/shared/frontmatter.ts (metadata JSON block, parseFrontmatterBool),
 * src/skills/loading/skill-root-discovery.ts (256 KB per SKILL.md).
 * Adaptations: our skill records store the body as `instructions`, so an empty body is an error
 * here instead of a file-path-only skill; OpenClaw's per-agent gating (os/requires/install,
 * command-dispatch) has no counterpart in the room runtime, so those fields are reported as
 * import warnings rather than dropped silently.
 */
import { isMap, parseDocument } from "yaml";

/** 与 OpenClaw 相同：单个 SKILL.md 最大 256 KB。 */
export const MAX_SKILL_MD_BYTES = 256 * 1024;

const FRONTMATTER_OPENING_DELIMITER = /^---[^\S\n]*\n/;
const FRONTMATTER_CLOSING_DELIMITER = /(?:^|\n)---[^\S\n]*(?:\n|(?![\s\S]))/;
const FREEFORM_TEXT_FIELDS = new Set(["description", "summary", "read_when"]);

export interface FrontmatterParseIssue {
  code: string;
  message: string;
}

export interface ParsedFrontmatterBlock {
  frontmatter: Record<string, string>;
  issues: FrontmatterParseIssue[];
}

function normalizeFrontmatterContent(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function extractFrontmatterBlock(
  normalized: string,
): { block: string; body: string } | undefined {
  const opening = FRONTMATTER_OPENING_DELIMITER.exec(normalized);
  if (!opening) return undefined;
  const tail = normalized.slice(opening[0].length);
  const closing = FRONTMATTER_CLOSING_DELIMITER.exec(tail);
  if (!closing) return undefined;
  return {
    block: tail.slice(0, closing.index),
    body: tail.slice(closing.index + closing[0].length),
  };
}

/** 去掉开头的 frontmatter 块，返回 Markdown 正文（即技能说明）。 */
export function stripFrontmatterBlock(content: string): string {
  const normalized = normalizeFrontmatterContent(content);
  return (extractFrontmatterBlock(normalized)?.body ?? normalized).trim();
}

function stripQuotes(value: string): string {
  const quote = value.at(0);
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

function coerceYamlValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** YAML 解析失败时的兜底：按 `key: value` 逐行读，缩进行并入上一个键。 */
function parseLineFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^([\w-]+):\s*(.*)$/);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (!key || rawValue === undefined) continue;
    let value = rawValue.trim();
    if (!value && /^[ \t]/.test(lines[i + 1] ?? "")) {
      const valueLines: string[] = [];
      while (i + 1 < lines.length) {
        const line = lines[i + 1];
        if (line === undefined || !/^[ \t]/.test(line)) break;
        valueLines.push(line);
        i += 1;
      }
      value = valueLines.join("\n").trim();
    } else {
      value = stripQuotes(value);
    }
    if (value) result[key] = value;
  }
  return result;
}

/**
 * `description: 说明: 细节` 这类含冒号的自由文本会让 YAML 解析报错。
 * OpenClaw 的恢复办法是把出错整行的值重新按 JSON 字符串写回，再重试解析。
 */
function quoteFreeformFieldAtError(block: string, errorPos: number | undefined): string {
  if (errorPos === undefined) return block;
  const lineStart = block.lastIndexOf("\n", errorPos) + 1;
  const lineEnd = block.indexOf("\n", errorPos);
  const end = lineEnd === -1 ? block.length : lineEnd;
  const line = block.slice(lineStart, end);
  const match = line.match(/^(?:([\w-]+)|"([\w-]+)"|'([\w-]+)'):\s*(.*)$/);
  const keyName = match?.[1] ?? match?.[2] ?? match?.[3];
  const rawValue = match?.[4]?.trim();
  if (
    !keyName ||
    !rawValue ||
    !FREEFORM_TEXT_FIELDS.has(keyName) ||
    /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(rawValue)
  ) {
    return block;
  }
  return `${block.slice(0, lineStart)}${keyName}: ${JSON.stringify(stripQuotes(rawValue))}${block.slice(end)}`;
}

function firstErrorPos(block: string): number | undefined {
  try {
    const doc = parseDocument(block, { schema: "core", prettyErrors: false });
    return doc.errors.find((error) => error.pos?.[0] !== undefined)?.pos?.[0];
  } catch {
    return undefined;
  }
}

function parseYamlFrontmatterOnce(
  block: string,
  fallback: Record<string, string>,
): ParsedFrontmatterBlock {
  try {
    const doc = parseDocument(block, { schema: "core", prettyErrors: false });
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return {
        frontmatter: {},
        issues: doc.errors.map((error) => ({
          code: String(error.code ?? error.name),
          message: error.message,
        })),
      };
    }
    const parsed = doc.toJS() as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        frontmatter: {},
        issues: [{ code: "INVALID_ROOT", message: "frontmatter must be a YAML mapping" }],
      };
    }
    const result: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = rawKey.trim();
      const coerced = key ? coerceYamlValue(value) : undefined;
      if (coerced) result[key] = coerced;
    }
    // `key: # 注释` 是 YAML 注释，不该被行解析救回来；其余缺失键用行解析兜底。
    for (const [key, value] of Object.entries(fallback)) {
      if (!Object.hasOwn(result, key) && !/^#(?:\s|$)/.test(value)) result[key] = value;
    }
    return { frontmatter: result, issues: [] };
  } catch (error) {
    return {
      frontmatter: {},
      issues: [
        {
          code: "YAML_EXCEPTION",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export function parseFrontmatterBlock(content: string): ParsedFrontmatterBlock {
  const normalized = normalizeFrontmatterContent(content);
  const block = extractFrontmatterBlock(normalized)?.block;
  if (block === undefined) {
    return FRONTMATTER_OPENING_DELIMITER.test(normalized)
      ? {
          frontmatter: {},
          issues: [
            { code: "UNTERMINATED_FRONTMATTER", message: "missing closing --- delimiter" },
          ],
        }
      : { frontmatter: {}, issues: [] };
  }
  if (!block.trim()) return { frontmatter: {}, issues: [] };

  const fallback = parseLineFrontmatter(block);
  let parsed = parseYamlFrontmatterOnce(block, fallback);
  let recovered = block;
  // 每轮只修一个出错字段并重试，避免为了一个坏描述毁掉整份 frontmatter。
  for (let i = 0; i < FREEFORM_TEXT_FIELDS.size && parsed.issues.length > 0; i += 1) {
    const next = quoteFreeformFieldAtError(recovered, firstErrorPos(recovered));
    if (next === recovered) break;
    recovered = next;
    parsed = parseYamlFrontmatterOnce(recovered, fallback);
  }
  return parsed;
}

export class SkillMarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMarkdownError";
  }
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  instructions: string;
  homepage?: string;
  /** 可选分类：技能库据此分组，无法识别时由导入流程回退或推断。 */
  category?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  warnings: string[];
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return fallback;
}

/**
 * 文件名/目录名 → 技能名兜底。OpenClaw 用技能所在目录的 basename：
 * `pdf-forms/SKILL.md` 推导为 `pdf-forms`，而不是文件自己。
 */
export function skillNameFromFile(filename: string): string {
  const segments = filename.split(/[\\/]/).filter(Boolean);
  let base = segments.at(-1) ?? "";
  if (/^skill\.(md|markdown|txt)$/i.test(base) && segments.length > 1) {
    base = segments.at(-2) ?? base;
  }
  return base
    .replace(/\.(md|markdown|txt)$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function metadataWarning(frontmatter: Record<string, string>): string | undefined {
  const raw = frontmatter["metadata"];
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "frontmatter 的 metadata 不是合法 JSON，导入时已忽略。";
  }
  const block =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  const openclaw = block?.["openclaw"];
  const manifest =
    typeof openclaw === "object" && openclaw !== null
      ? (openclaw as Record<string, unknown>)
      : undefined;
  const gated = manifest?.["requires"] ?? manifest?.["install"] ?? manifest?.["os"];
  if (!gated) return undefined;
  return "该技能声明依赖宿主机工具或平台条件（requires / install / os）；作战室提供 run_command 与联网工具，但不会自动安装依赖，可能只能部分执行。";
}

/**
 * 解析一份 SKILL.md：frontmatter 的 name/description + 正文说明。
 * 规则与 OpenClaw 的 loadSingleSkillDirectory 一致：name 缺失时回退到文件名，
 * name 或 description 仍然缺失即视为无效技能。
 */
export function parseSkillMarkdown(
  content: string,
  options: { filename?: string } = {},
): ParsedSkillMarkdown {
  if (typeof content !== "string" || !content.trim()) {
    throw new SkillMarkdownError("SKILL.md 内容为空");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_MD_BYTES) {
    throw new SkillMarkdownError(`SKILL.md 不能超过 ${MAX_SKILL_MD_BYTES / 1024} KB`);
  }
  const parsed = parseFrontmatterBlock(content);
  const issue = parsed.issues[0];
  if (issue) {
    throw new SkillMarkdownError(`frontmatter 解析失败：${issue.code}: ${issue.message}`);
  }
  const frontmatter = parsed.frontmatter;
  const name = (frontmatter["name"]?.trim() || skillNameFromFile(options.filename ?? "")).trim();
  if (!name) throw new SkillMarkdownError("name is required（frontmatter 缺少 name，且无法从文件名推导）");
  const description = frontmatter["description"]?.trim();
  if (!description) throw new SkillMarkdownError("description is required（frontmatter 缺少 description）");
  const instructions = stripFrontmatterBlock(content);
  if (!instructions) throw new SkillMarkdownError("SKILL.md 正文为空，没有可执行的技能说明");

  const warnings: string[] = [];
  const metadataNote = metadataWarning(frontmatter);
  if (metadataNote) warnings.push(metadataNote);
  const modelInvocable = !parseBool(frontmatter["disable-model-invocation"], false);
  if (!modelInvocable) warnings.push("该技能设置了 disable-model-invocation，只能由用户显式调用。");

  return {
    name,
    description,
    instructions,
    homepage: frontmatter["homepage"]?.trim() || undefined,
    category: frontmatter["category"]?.trim() || undefined,
    userInvocable: parseBool(frontmatter["user-invocable"], true),
    modelInvocable,
    warnings,
  };
}
