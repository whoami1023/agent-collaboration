/*!
 * Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
 * MIT License, Copyright (c) OpenClaw contributors.
 * Sources: src/shared/text/assistant-internal-scaffolding.ts (stage order),
 * assistant-text-transforms.ts (memories / legacy bracket / trace lines / invisible text),
 * reasoning-tags.ts + packages/markdown-core/src/reasoning-tag-syntax.ts (reasoning tag names),
 * tool-call-xml-transform.ts (tool tag names), model-special-token-transform.ts,
 * code-ranges.ts + packages/markdown-core/src/markdown-code-regions.ts (code protection),
 * ui/src/components/markdown-text.ts (line-break normalisation, block art).
 * Adaptations: OpenClaw resolves code regions with micromark and runs an incremental
 * checkpoint projector for streamed appends; we re-derive the visible text from the whole
 * append (same result, single pass) and detect code with a line scanner over fences +
 * inline spans. `final`-tag reset, GLM payload repair and plain-text tool-call blocks are
 * provider features this runtime never emits, so they are not ported.
 */

export interface CodeRange {
  start: number;
  end: number;
  block: boolean;
}

const REASONING_TAG_NAMES = new Set([
  "think",
  "thinking",
  "thought",
  "reasoning",
  "internal",
  "antthinking",
]);

const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "tool_calls",
  "function_call",
  "function_calls",
  "function_response",
  "function",
  "invoke",
  "parameter",
  "parameters",
  "arguments",
]);

const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜\s]*[|｜]>/g;
const TAG_RE = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)\b[^>]*?>/g;
const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const BRACKET_OPEN_RE = /\[\s*TOOL_(CALL|RESULT)\s*\]/g;

/**
 * 逐行匹配的内部轨迹行。用 y(sticky) 而不是 ^：始终从 trim 后的行首锚定，
 * 也不会像 g 那样把 lastIndex 泄漏到下一次 test。
 */
const TRACE_LINE_RE = new RegExp(
  "(?:>\\s*)?(?:\\p{Extended_Pictographic}\\uFE0F?\\s*)*" +
    "(?:(?:tool[ \\s_-]*call|tool[ \\s_-]*result|function[ \\s_-]*calls?)[:=]" +
    "|(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|" +
    "Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\\s*[:=])",
  "iuy",
);

const BLOCK_ART_LINE_RE = /^[\t \u00a0▀▄█]+$/u;
const BLOCK_ART_GLYPH_RE = /[▀▄█]/u;
const BLANK_OR_INVISIBLE_RE = /^[\s\u200b-\u200f\u2060\ufeff]*$/u;

export function normalizeLineBreaks(value: string): string {
  if (!value.includes("\r") && !value.includes("\u2028") && !value.includes("\u2029")) {
    return value;
  }
  return value.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}

/** QR / 字符画这类整块 ▀▄█ 文本要原样等宽显示，不能被当普通段落折行。 */
export function isBlockArtText(value: string): boolean {
  if (!BLOCK_ART_GLYPH_RE.test(value)) return false;
  const lines = normalizeLineBreaks(value)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return (
    lines.length >= 2 &&
    lines.every((line) => BLOCK_ART_LINE_RE.test(line) && BLOCK_ART_GLYPH_RE.test(line)) &&
    (value.match(/[▀▄█]/gu)?.length ?? 0) >= 8
  );
}

/**
 * 受保护区间：围栏代码块（未闭合时保护到文本末尾，所以流式半截代码不会被当脚手架删掉）
 * 和行内反引号片段。区间里出现的标签示例是给用户看的，一律保留。
 */
export function findCodeRanges(text: string): CodeRange[] {
  if (!text) return [];
  const ranges: CodeRange[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let open: { fence: string; markerLength: number; start: number } | undefined;

  for (const line of lines) {
    const lineEnd = offset + line.length;
    const trimmed = line.trimStart();
    const run = /^(`{3,}|~{3,})/.exec(trimmed);
    if (open) {
      const closes =
        trimmed.startsWith(open.fence) && trimmed.replace(/`|~/g, "").length === 0;
      if (closes) {
        ranges.push({ start: open.start, end: lineEnd, block: true });
        open = undefined;
      }
      offset = lineEnd + 1;
      continue;
    }
    if (run) {
      open = { fence: run[1]![0]!, markerLength: run[1]!.length, start: offset };
      offset = lineEnd + 1;
      continue;
    }
    for (const span of inlineCodeSpans(line)) {
      ranges.push({ start: offset + span[0], end: offset + span[1], block: false });
    }
    offset = lineEnd + 1;
  }

  if (open) ranges.push({ start: open.start, end: text.length, block: true });
  return ranges;
}

/** CommonMark 的反引号配对：闭合串长度必须等于开启串长度。 */
function inlineCodeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (;;) {
    const open = line.indexOf("`", cursor);
    if (open === -1) break;
    let length = 1;
    while (line[open + length] === "`") length += 1;
    const close = findBacktickRun(line, open + length, length);
    if (close === -1) break;
    spans.push([open, close + length]);
    cursor = close + length;
  }
  return spans;
}

function findBacktickRun(line: string, from: number, length: number): number {
  let cursor = from;
  for (;;) {
    const index = line.indexOf("`", cursor);
    if (index === -1) return -1;
    let run = 1;
    while (line[index + run] === "`") run += 1;
    if (run === length) return index;
    cursor = index + run;
  }
}

function isProtected(position: number, ranges: readonly CodeRange[]): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

/** 按代码区间切段，只改写非代码片段，代码片段原样拼回。 */
function mapOutsideCode(text: string, ranges: readonly CodeRange[], step: (chunk: string) => string): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) result += step(text.slice(cursor, range.start));
    const end = Math.max(range.end, cursor);
    result += text.slice(Math.max(range.start, cursor), end);
    cursor = end;
  }
  return result + step(text.slice(cursor));
}

/**
 * 成对标签块的隐藏逻辑（reasoning 与 tool-call 共用一套）：同名族嵌套计数；
 * 未闭合的开标签一直隐藏到文本末尾，所以流式输出时半截思考不会闪现，
 * 但代价是正文里孤立的 `<invoke>` 也会吞掉后续文本——和 OpenClaw 的取舍一致。
 */
function hideTaggedBlocks(text: string, names: ReadonlySet<string>): string {
  if (!text.includes("<")) return text;
  let result = "";
  let cursor = 0;
  let depth = 0;
  let hiddenFrom = 0;
  for (const match of text.matchAll(TAG_RE)) {
    const index = match.index ?? 0;
    const raw = match[2]!.toLowerCase();
    const bare = raw.slice(raw.lastIndexOf(":") + 1);
    if (!names.has(raw) && !names.has(bare)) continue;
    if (match[1] === "/") {
      if (depth === 1) result += text.slice(cursor, hiddenFrom);
      depth = Math.max(0, depth - 1);
      if (depth === 0) cursor = index + match[0].length;
      continue;
    }
    if (depth === 0) hiddenFrom = index;
    depth += 1;
  }
  return depth > 0 ? result + text.slice(cursor, hiddenFrom) : result + text.slice(cursor);
}

function hideMemoryBlocks(text: string): string {
  if (!MEMORY_TAG_RE.test(text)) return text;
  MEMORY_TAG_RE.lastIndex = 0;
  let result = "";
  let cursor = 0;
  let inside = false;
  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const index = match.index ?? 0;
    const isClose = match[1] === "/";
    if (!inside) {
      result += text.slice(cursor, index);
      inside = !isClose;
    } else if (isClose) {
      inside = false;
    }
    cursor = index + match[0].length;
  }
  return inside ? result : result + text.slice(cursor);
}

/**
 * 早期模型的 `[TOOL_CALL] … [/TOOL_CALL]` 形态，只删确实像工具负载的块。
 */
function hideBracketToolBlocks(text: string): string {
  if (!/\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i.test(text)) return text;
  let result = "";
  let cursor = 0;
  for (const open of text.matchAll(BRACKET_OPEN_RE)) {
    const openStart = open.index ?? 0;
    if (openStart < cursor) continue;
    const payloadStart = openStart + open[0].length;
    const isResult = open[1]!.toUpperCase() === "RESULT";
    const closeRe = isResult ? /\[\s*\/\s*TOOL_RESULT\s*\]/gi : /\[\s*\/\s*TOOL_CALL\s*\]/gi;
    closeRe.lastIndex = payloadStart;
    const close = closeRe.exec(text);
    const payload = text.slice(payloadStart, close?.index);
    const looksLikePayload = isResult
      ? /^\s*[{[]/.test(payload) || /\b(?:tool|result|output|content)\s*[:=]/i.test(payload)
      : /\btool\s*[:=]\s*["'][A-Za-z_][\w.:-]*["']/i.test(payload);
    if (!looksLikePayload) continue;
    result += text.slice(cursor, openStart);
    cursor = close ? (close.index ?? 0) + close[0].length : text.length;
    if (cursor >= text.length) break;
  }
  return result + text.slice(cursor);
}

/** 逐行丢弃轨迹行，行首落在代码区间内的行保留。 */
function hideTraceLines(text: string, ranges: readonly CodeRange[]): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 240 && !isProtected(start, ranges) && TRACE_LINE_RE.test(trimmed)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export interface ScaffoldingOptions {
  /** 流式追加时不 trim 开头空行，避免每个 delta 都把正文往上顶。 */
  streaming?: boolean;
}

/** 作战室里的智能体文本先过这一层，再交给 Markdown 渲染。 */
export function stripAssistantScaffolding(text: string, options?: ScaffoldingOptions): string {
  if (!text) return "";
  const normalized = normalizeLineBreaks(text);
  const ranges = findCodeRanges(normalized);

  let projected = normalized;
  projected = mapOutsideCode(projected, ranges, (chunk) => hideTaggedBlocks(chunk, REASONING_TAG_NAMES));
  projected = mapOutsideCode(projected, ranges, (chunk) => hideTaggedBlocks(chunk, TOOL_CALL_TAG_NAMES));
  projected = mapOutsideCode(projected, ranges, hideMemoryBlocks);
  projected = mapOutsideCode(projected, ranges, hideBracketToolBlocks);
  projected = mapOutsideCode(projected, ranges, (chunk) => chunk.replace(MODEL_SPECIAL_TOKEN_RE, ""));
  projected = hideTraceLines(projected, ranges);

  const withoutLeadingBlanks = options?.streaming
    ? projected
    : projected.replace(/^(?:[ \t]*\n)+/, "");
  return BLANK_OR_INVISIBLE_RE.test(withoutLeadingBlanks) ? "" : withoutLeadingBlanks;
}
