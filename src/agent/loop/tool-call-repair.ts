// Ported and combined from OpenClaw (https://github.com/openclaw/openclaw):
// packages/tool-call-repair/src/{grammar,payload,attempt}.ts and
// packages/normalization-core/src/{balanced-json,json-coercion,record-coerce,string-coerce}.ts.
// MIT License — Copyright (c) 2026 OpenClaw Foundation. Permission is hereby granted, free of
// charge, to any person obtaining a copy of this software and associated documentation files, to
// deal in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to
// inclusion of this permission notice in all copies or substantial portions of the Software.
//
// Repairs model text that looks like a tool call but was not emitted as a native tool call:
// JSON tool_calls objects, `<function=name><parameter name=...>`, `[tool:name] {json}`,
// `<|channel|>commentary to=name code {...}`, legacy `[TOOL_CALL] { tool => ..., args => ... }`,
// and ReAct `Action: ... / Action Input: ...` forms.

// ---------------------------------------------------------------------------
// Normalization helpers (local equivalents of @openclaw/normalization-core)
// ---------------------------------------------------------------------------

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function safeParseJsonRecord(text: string): Record<string, unknown> | undefined {
  const value = safeParseJson(text);
  return isRecord(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type BalancedJsonFragment = { json: string; startIndex: number; endIndex: number };

/** Extracts the first balanced JSON object/array from text. */
export function extractBalancedJsonPrefix(
  raw: string,
  opts: { openers?: readonly ("{" | "[")[]; skipQuotedOpeners?: boolean } = {},
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);
  let start = 0;
  if (!opts.skipQuotedOpeners) {
    while (start < raw.length && raw[start] !== "{" && raw[start] !== "[") {
      start += 1;
    }
  }
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if ((char === "{" || char === "[") && openers.includes(char)) {
      if (stack.length === 0) {
        start = index;
      }
      stack.push(char);
    } else if (stack.length > 0 && char === (stack.at(-1) === "{" ? "}" : "]")) {
      stack.pop();
      if (stack.length === 0) {
        return { json: raw.slice(start, index + 1), startIndex: start, endIndex: index };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grammar (scanXmlishToolCall, scanJsonObject, char predicates, markers)
// ---------------------------------------------------------------------------

/** Legacy marker some models emit after a serialized JSON tool request. */
export const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
/** Harmony stream marker that introduces the target channel before a tool call. */
export const HARMONY_CHANNEL_MARKER = "<|channel|>";
/** Harmony stream marker that may separate the header from the JSON payload. */
export const HARMONY_MESSAGE_MARKER = "<|message|>";
/** Harmony stream marker that may close a serialized tool-call payload. */
export const HARMONY_CALL_MARKER = "<|call|>";

/** Tool names in bracket/plain-text repairs intentionally match provider-safe ids only. */
export function isPlainTextToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

/** XML-ish function tags allow namespace punctuation used by some model families. */
export function isXmlishNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_.:-]/.test(char));
}

/** Skips spaces and tabs only, preserving line boundaries for grammar decisions. */
export function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

/** Skips indentation whitespace without crossing the current line boundary. */
export function skipLineIndentation(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[^\S\r\n]/u.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

/** Skips all JavaScript whitespace when line structure is no longer meaningful. */
export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

/** Consumes either Unix or Windows line endings and returns the first offset after them. */
export function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === "\r") {
    return text[start + 1] === "\n" ? start + 2 : start + 1;
  }
  if (text[start] === "\n") {
    return start + 1;
  }
  return null;
}

export type StructuralLineBreakOptions = {
  lineBreakOffsets: ReadonlySet<number>;
};

export function consumeStructuralLineBreakAfterHorizontalWhitespace(
  text: string,
  start: number,
  options?: StructuralLineBreakOptions,
): number | null {
  const right = skipHorizontalWhitespace(text, start);
  const actual = consumeLineBreak(text, right);
  if (actual !== null) {
    return actual;
  }
  for (let offset = start; offset <= right; offset += 1) {
    if (options?.lineBreakOffsets.has(offset)) {
      return offset;
    }
  }
  return null;
}

const utf8Encoder = new TextEncoder();

/** Returns the encoded byte length when a source span stays within its serialized limit. */
export function utf8ByteLengthWithinLimit(
  text: string,
  start: number,
  end: number,
  maxBytes: number,
): number | null {
  if (end - start > maxBytes) {
    return null;
  }
  const byteLength = utf8Encoder.encode(text.slice(start, end)).byteLength;
  return byteLength <= maxBytes ? byteLength : null;
}

export type XmlishToolCallSpan = { end: number; start: number };
export type XmlishToolCallParameterSpan = {
  name: XmlishToolCallSpan;
  value: XmlishToolCallSpan;
};
type XmlishToolCallCandidate = {
  activeParameterOpenEnd?: number;
  name: XmlishToolCallSpan;
  nameComplete: boolean;
  parameters: readonly XmlishToolCallParameterSpan[];
  payload?: XmlishToolCallSpan;
  syntax: "function" | "named-bracket" | "tool-bracket";
};
export type XmlishToolCallScan =
  | { at: number; candidate?: XmlishToolCallCandidate; kind: "invalid" }
  // `completeEnd` is safe for static stripping only; the prefix remains non-executable.
  | { candidate?: XmlishToolCallCandidate; completeEnd?: number; kind: "prefix" }
  | (XmlishToolCallCandidate & {
      end: number;
      kind: "complete";
      payload: XmlishToolCallSpan;
    });

const FUNCTION_OPEN = "<function=";
const FUNCTION_CLOSE = "</function>";
const PARAMETER_OPEN = "<parameter=";
const PARAMETER_CLOSE = "</parameter>";

export function startsWithAsciiMarkerIgnoreCase(
  text: string,
  cursor: number,
  marker: string,
): boolean {
  return text.slice(cursor, cursor + marker.length).toLowerCase() === marker;
}

export function isAsciiMarkerPrefixIgnoreCase(
  text: string,
  cursor: number,
  marker: string,
): boolean {
  const rest = text.slice(cursor, cursor + marker.length).toLowerCase();
  return rest.length < marker.length && marker.startsWith(rest);
}

export function indexOfAsciiMarkerIgnoreCase(text: string, marker: string, start: number): number {
  for (
    let cursor = text.indexOf("<", start);
    cursor !== -1;
    cursor = text.indexOf("<", cursor + 1)
  ) {
    if (startsWithAsciiMarkerIgnoreCase(text, cursor, marker)) {
      return cursor;
    }
  }
  return -1;
}

/** Scan at most one character beyond the accepted tool-name limit. */
export function scanToolCallNameEnd(
  text: string,
  start: number,
  isNameChar = isXmlishNameChar,
): number {
  let end = start;
  while (isNameChar(text[end]) && end - start < 121) {
    end += 1;
  }
  return end;
}

/** Uncapped structural scan shared by parsing, stripping, and stream buffering. */
export function scanXmlishToolCall(
  text: string,
  start = 0,
  structuralLineBreaks?: StructuralLineBreakOptions,
): XmlishToolCallScan {
  let cursor = start;
  let syntax: XmlishToolCallCandidate["syntax"];
  let name: XmlishToolCallSpan;

  if (text[cursor] === "<") {
    if (
      !startsWithAsciiMarkerIgnoreCase(text, cursor, FUNCTION_OPEN) &&
      !isAsciiMarkerPrefixIgnoreCase(text, cursor, FUNCTION_OPEN)
    ) {
      return { kind: "invalid", at: start };
    }
    if (text.length - cursor < FUNCTION_OPEN.length) {
      return { kind: "prefix" };
    }
    cursor += FUNCTION_OPEN.length;
    const nameStart = cursor;
    cursor = scanToolCallNameEnd(text, nameStart);
    name = { start: nameStart, end: cursor };
    syntax = "function";
    if (cursor - nameStart > 120) {
      return { kind: "invalid", at: cursor };
    }
    if (cursor === text.length) {
      return { kind: "prefix", candidate: { syntax, name, nameComplete: false, parameters: [] } };
    }
    if (cursor === nameStart || text[cursor] !== ">") {
      return { kind: "invalid", at: cursor };
    }
    cursor += 1;
  } else if (text[cursor] === "[") {
    cursor += 1;
    const firstNameStart = cursor;
    cursor = scanToolCallNameEnd(text, firstNameStart, isPlainTextToolNameChar);
    if (cursor - firstNameStart > 120) {
      return { kind: "invalid", at: cursor };
    }
    const firstName = text.slice(firstNameStart, cursor);
    if (cursor === text.length && "tool".startsWith(firstName)) {
      return { kind: "prefix" };
    }
    syntax = "named-bracket";
    name = { start: firstNameStart, end: cursor };
    if (text[cursor] === ":" && firstName === "tool") {
      syntax = "tool-bracket";
      cursor += 1;
      const nameStart = cursor;
      cursor = scanToolCallNameEnd(text, nameStart, isPlainTextToolNameChar);
      name = { start: nameStart, end: cursor };
      if (cursor - nameStart > 120) {
        return { kind: "invalid", at: cursor };
      }
    }
    if (cursor === text.length) {
      return { kind: "prefix", candidate: { syntax, name, nameComplete: false, parameters: [] } };
    }
    if (name.start === name.end || text[cursor] !== "]") {
      return { kind: "invalid", at: cursor };
    }
    cursor += 1;
    if (syntax === "named-bracket") {
      if (cursor === text.length) {
        return { kind: "prefix", candidate: { syntax, name, nameComplete: true, parameters: [] } };
      }
      const afterLineBreak = consumeStructuralLineBreakAfterHorizontalWhitespace(
        text,
        cursor,
        structuralLineBreaks,
      );
      if (afterLineBreak === null) {
        return { kind: "invalid", at: cursor };
      }
      cursor = afterLineBreak;
    }
  } else {
    return { kind: "invalid", at: start };
  }

  const bodyStart = cursor;
  const parameters: XmlishToolCallParameterSpan[] = [];
  const candidate = (
    payloadEnd: number,
    activeParameterOpenEnd?: number,
  ): XmlishToolCallCandidate & { payload: XmlishToolCallSpan } => ({
    syntax,
    name,
    nameComplete: true,
    parameters,
    payload: { start: bodyStart, end: payloadEnd },
    ...(activeParameterOpenEnd === undefined ? {} : { activeParameterOpenEnd }),
  });
  let lastParameterEnd: number | undefined;
  const prefix = (payloadEnd: number, activeParameterOpenEnd?: number): XmlishToolCallScan => ({
    kind: "prefix",
    candidate: candidate(payloadEnd, activeParameterOpenEnd),
    completeEnd: syntax === "tool-bracket" ? lastParameterEnd : undefined,
  });
  const complete = (payloadEnd: number, end = payloadEnd): XmlishToolCallScan => ({
    kind: "complete",
    ...candidate(payloadEnd),
    end,
  });
  while (true) {
    const markerStart = skipWhitespace(text, cursor);
    if (markerStart === text.length) {
      return syntax === "tool-bracket" && lastParameterEnd !== undefined
        ? complete(lastParameterEnd)
        : { kind: "prefix", candidate: candidate(text.length) };
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, FUNCTION_CLOSE)) {
      return syntax !== "function" && parameters.length === 0
        ? { kind: "invalid", at: markerStart, candidate: candidate(markerStart) }
        : complete(markerStart, markerStart + FUNCTION_CLOSE.length);
    }
    if (isAsciiMarkerPrefixIgnoreCase(text, markerStart, FUNCTION_CLOSE)) {
      return prefix(markerStart);
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, PARAMETER_OPEN)) {
      const nameStart = markerStart + PARAMETER_OPEN.length;
      const nameEnd = scanToolCallNameEnd(text, nameStart);
      if (nameEnd - nameStart > 120) {
        return { kind: "invalid", at: markerStart, candidate: candidate(markerStart) };
      }
      if (nameEnd === text.length) {
        return prefix(markerStart);
      }
      if (nameEnd === nameStart || text[nameEnd] !== ">") {
        return { kind: "invalid", at: markerStart, candidate: candidate(markerStart) };
      }
      const valueStart = nameEnd + 1;
      const closeStart = indexOfAsciiMarkerIgnoreCase(text, PARAMETER_CLOSE, valueStart);
      if (closeStart === -1) {
        return prefix(text.length, valueStart);
      }
      const end = closeStart + PARAMETER_CLOSE.length;
      parameters.push({
        name: { start: nameStart, end: nameEnd },
        value: { start: valueStart, end: closeStart },
      });
      cursor = end;
      lastParameterEnd = end;
      continue;
    }
    if (isAsciiMarkerPrefixIgnoreCase(text, markerStart, PARAMETER_OPEN)) {
      return prefix(markerStart);
    }
    if (syntax === "tool-bracket" && lastParameterEnd !== undefined) {
      return complete(lastParameterEnd);
    }
    return { kind: "invalid", at: markerStart, candidate: candidate(markerStart) };
  }
}

export type JsonObjectScanState = {
  depth: number;
  escaped: boolean;
  inString: boolean;
};

/** Continue the same object scan across parser spans or bounded stream chunks. */
export function scanJsonObject(
  text: string,
  start: number,
  state: JsonObjectScanState = { depth: 0, escaped: false, inString: false },
): { end: number; kind: "complete" | "prefix"; state: JsonObjectScanState } {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (char === "\\") {
        state.escaped = true;
      } else if (char === '"') {
        state.inString = false;
      }
      continue;
    }
    if (char === '"') {
      state.inString = true;
    } else if (char === "{") {
      state.depth += 1;
    } else if (char === "}") {
      state.depth -= 1;
      if (state.depth === 0) {
        return { kind: "complete", end: index + 1, state };
      }
    }
  }
  return { kind: "prefix", end: text.length, state };
}

// ---------------------------------------------------------------------------
// Plain-text payload parsing (payload.ts)
// ---------------------------------------------------------------------------

export type PlainTextToolCallNameMatcher = {
  hasExactName(name: string): boolean;
  hasNamePrefix?(prefix: string): boolean;
};

export type PlainTextToolCallParseOptions = {
  allowedToolNames?: readonly string[];
  maxPayloadBytes?: number;
};

/** Parsed standalone plain-text tool call block with source offsets for repair. */
export type PlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  /** Exclusive end offset of the parsed block. */
  end: number;
  /** Tool name parsed from bracket, Harmony, or XML-ish syntax. */
  name: string;
  raw: string;
  /** Inclusive start offset of the parsed block. */
  start: number;
};

const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;
const MAX_PLAIN_TEXT_TOOL_NAME_CHARS = 120;
const HARMONY_CHANNELS = ["commentary", "analysis", "final"] as const;
// Case folding only admits candidates; the canonical Harmony scanner retains its case rules.
const PLAIN_TEXT_TOOL_CALL_CANDIDATE_RE =
  /(?:^|[\r\n])[^\S\r\n]*(?:\[(?:tool:)?[A-Za-z0-9_-]+\]\s*(?:\{|<parameter=)|(?:<\|channel\|>)?(?:commentary|analysis|final)[ \t]+to=|<function=)/i;

export type PlainTextJsonToolCallSpan = { end: number; start: number };
export type PlainTextJsonToolCallSyntax = "harmony" | "named-bracket" | "tool-bracket";
export type PlainTextJsonToolCallState = JsonObjectScanState;
export type PlainTextJsonToolCallCandidate = {
  json?: JsonObjectScanState;
  name: PlainTextJsonToolCallSpan;
  nameComplete: boolean;
  payload?: PlainTextJsonToolCallSpan;
  syntax: PlainTextJsonToolCallSyntax;
};
export type PlainTextJsonToolCallScan =
  | { at: number; candidate?: PlainTextJsonToolCallCandidate; kind: "invalid" }
  | { candidate?: PlainTextJsonToolCallCandidate; kind: "prefix" }
  | (PlainTextJsonToolCallCandidate & {
      end: number;
      kind: "complete";
      nameComplete: true;
      payload: PlainTextJsonToolCallSpan;
    });

type PlainTextToolCallScanBranches = {
  json: PlainTextJsonToolCallScan;
  matches: { json: boolean; xmlish: boolean };
  xmlish: ReturnType<typeof scanXmlishToolCall>;
};

export type PlainTextToolCallScan = PlainTextToolCallScanBranches &
  (
    | {
        end: number;
        kind: "complete";
        next: number;
        overCap: boolean;
        payloadStart: number;
        settled: boolean;
      }
    | {
        completeEnd?: number;
        kind: "prefix";
        next: number;
        overCap: boolean;
        payloadStart?: number;
      }
    | {
        at: number;
        kind: "invalid";
        next: number;
        overCap: boolean;
        payloadStart?: number;
      }
  );

type PlainTextJsonToolCallOpening = {
  cursor: number;
  kind: "complete";
  value: PlainTextJsonToolCallCandidate & { nameComplete: true };
};
type PlainTextJsonToolCallOpeningScan =
  | PlainTextJsonToolCallOpening
  | Extract<PlainTextJsonToolCallScan, { kind: "invalid" | "prefix" }>;

function isLiteralPrefixAt(text: string, start: number, literal: string): boolean {
  const available = text.length - start;
  return start >= 0 && available < literal.length && literal.startsWith(text.slice(start));
}

function candidate<NameComplete extends boolean>(
  syntax: PlainTextJsonToolCallSyntax,
  name: PlainTextJsonToolCallSpan,
  nameComplete: NameComplete,
  payload?: PlainTextJsonToolCallSpan,
  json?: PlainTextJsonToolCallState,
): PlainTextJsonToolCallCandidate & { nameComplete: NameComplete } {
  return { syntax, name, nameComplete, ...(payload ? { payload } : {}), ...(json ? { json } : {}) };
}

function scanBracketOpening(
  text: string,
  start: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextJsonToolCallOpeningScan {
  let cursor = start + 1;
  let syntax: PlainTextJsonToolCallSyntax = "named-bracket";
  if (text.startsWith("tool:", cursor)) {
    syntax = "tool-bracket";
    cursor += "tool:".length;
  } else if (isLiteralPrefixAt(text, cursor, "tool:")) {
    return { kind: "prefix" };
  }
  const nameStart = cursor;
  const nameEnd = scanToolCallNameEnd(text, nameStart, isPlainTextToolNameChar);
  if (nameEnd - nameStart > MAX_PLAIN_TEXT_TOOL_NAME_CHARS) {
    return { kind: "invalid", at: nameStart + MAX_PLAIN_TEXT_TOOL_NAME_CHARS };
  }
  const name = { start: nameStart, end: nameEnd };
  cursor = nameEnd;
  if (cursor === text.length) {
    return {
      kind: "prefix",
      ...(nameStart === nameEnd ? {} : { candidate: candidate(syntax, name, false) }),
    };
  }
  if (nameStart === nameEnd || text[cursor] !== "]") {
    return { kind: "invalid", at: cursor };
  }
  cursor += 1;
  const value = candidate(syntax, name, true);
  if (syntax === "named-bracket") {
    const horizontalEnd = skipHorizontalWhitespace(text, cursor);
    if (horizontalEnd === text.length) {
      return { kind: "prefix", candidate: value };
    }
    const afterLineBreak = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      cursor,
      structuralLineBreaks,
    );
    if (afterLineBreak === null) {
      return { kind: "invalid", at: horizontalEnd, candidate: value };
    }
    cursor = afterLineBreak;
  }
  return { kind: "complete", cursor, value };
}

function scanHarmonyOpening(text: string, start: number): PlainTextJsonToolCallOpeningScan {
  let cursor = start;
  if (text.startsWith(HARMONY_CHANNEL_MARKER, cursor)) {
    cursor += HARMONY_CHANNEL_MARKER.length;
  } else if (isLiteralPrefixAt(text, cursor, HARMONY_CHANNEL_MARKER)) {
    return { kind: "prefix" };
  } else if (text[cursor] === "<") {
    return { kind: "invalid", at: cursor };
  }

  const channel = HARMONY_CHANNELS.find((value) => text.startsWith(value, cursor));
  if (!channel) {
    return HARMONY_CHANNELS.some((value) => isLiteralPrefixAt(text, cursor, value))
      ? { kind: "prefix" }
      : { kind: "invalid", at: cursor };
  }
  cursor += channel.length;
  if (cursor === text.length) {
    return { kind: "prefix" };
  }
  if (text[cursor] !== " " && text[cursor] !== "\t") {
    return { kind: "invalid", at: cursor };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("to=", cursor)) {
    return isLiteralPrefixAt(text, cursor, "to=")
      ? { kind: "prefix" }
      : { kind: "invalid", at: cursor };
  }
  cursor += "to=".length;

  const nameStart = cursor;
  const nameEnd = scanToolCallNameEnd(text, nameStart, isPlainTextToolNameChar);
  if (nameEnd - nameStart > MAX_PLAIN_TEXT_TOOL_NAME_CHARS) {
    return { kind: "invalid", at: nameStart + MAX_PLAIN_TEXT_TOOL_NAME_CHARS };
  }
  const name = { start: nameStart, end: nameEnd };
  cursor = nameEnd;
  if (cursor === text.length) {
    return {
      kind: "prefix",
      ...(nameStart === nameEnd ? {} : { candidate: candidate("harmony", name, false) }),
    };
  }
  if (nameStart === nameEnd || (text[cursor] !== " " && text[cursor] !== "\t")) {
    return { kind: "invalid", at: cursor };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  const value = candidate("harmony", name, true);
  if (!text.startsWith("code", cursor)) {
    return isLiteralPrefixAt(text, cursor, "code")
      ? { kind: "prefix", candidate: value }
      : { kind: "invalid", at: cursor, candidate: value };
  }
  cursor = skipWhitespace(text, cursor + "code".length);
  if (text.startsWith(HARMONY_MESSAGE_MARKER, cursor)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  } else if (isLiteralPrefixAt(text, cursor, HARMONY_MESSAGE_MARKER)) {
    return { kind: "prefix", candidate: value };
  } else if (text[cursor] === "<") {
    return { kind: "invalid", at: cursor, candidate: value };
  }
  return { kind: "complete", cursor, value };
}

/** Uncapped structural scan shared by parsing, stripping, and stream buffering. */
export function scanPlainTextJsonToolCall(
  text: string,
  start = 0,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextJsonToolCallScan {
  const opening =
    text[start] === "["
      ? scanBracketOpening(text, start, structuralLineBreaks)
      : scanHarmonyOpening(text, start);
  if (opening.kind !== "complete") {
    return opening;
  }

  const value = opening.value;
  const payloadStart = skipWhitespace(text, opening.cursor);
  if (payloadStart === text.length) {
    return { kind: "prefix", candidate: value };
  }
  if (text[payloadStart] !== "{") {
    return { kind: "invalid", at: payloadStart, candidate: value };
  }

  const json = scanJsonObject(text, payloadStart);
  const payload = { start: payloadStart, end: json.end };
  if (json.kind === "prefix") {
    return {
      kind: "prefix",
      candidate: candidate(value.syntax, value.name, true, payload, json.state),
    };
  }

  const closingCandidate = candidate(value.syntax, value.name, true, payload, json.state);
  const namedBracket = value.syntax === "named-bracket";
  const closingStart = skipWhitespace(text, json.end);
  if (namedBracket && closingStart === text.length) {
    return { kind: "prefix", candidate: closingCandidate };
  }
  const name = text.slice(value.name.start, value.name.end);
  const closings = namedBracket
    ? [END_TOOL_REQUEST, `[/${name}]`]
    : [HARMONY_CALL_MARKER, END_TOOL_REQUEST, `[/${name}]`];
  for (const closing of closings) {
    if (text.startsWith(closing, closingStart)) {
      return { ...value, payload, kind: "complete", end: closingStart + closing.length };
    }
    if (closingStart < text.length && isLiteralPrefixAt(text, closingStart, closing)) {
      return { kind: "prefix", candidate: closingCandidate };
    }
  }
  return namedBracket
    ? { kind: "invalid", at: closingStart, candidate: closingCandidate }
    : { ...value, payload, kind: "complete", end: json.end };
}

/** Classifies one JSON/XML call candidate and provides monotonic scan progress. */
export function scanPlainTextToolCall(
  text: string,
  start = 0,
  options?: {
    matcher?: PlainTextToolCallNameMatcher;
    maxPayloadBytes?: number;
    structuralLineBreaks?: StructuralLineBreakOptions;
  },
): PlainTextToolCallScan {
  const xmlish = scanXmlishToolCall(text, start, options?.structuralLineBreaks);
  const json = scanPlainTextJsonToolCall(text, start, options?.structuralLineBreaks);
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  const allowed = (
    scan: PlainTextToolCallScanBranches["json" | "xmlish"],
  ): {
    accepted: boolean;
    payload?: PlainTextJsonToolCallSpan;
  } => {
    const value = scan.kind === "complete" ? scan : scan.candidate;
    if (!value) {
      return { accepted: scan.kind === "prefix" };
    }
    const name = text.slice(value.name.start, value.name.end);
    const matches = value.nameComplete
      ? (options?.matcher?.hasExactName(name) ?? true)
      : (options?.matcher?.hasNamePrefix?.(name) ?? true);
    return matches
      ? { accepted: true, ...(value.payload ? { payload: value.payload } : {}) }
      : { accepted: false };
  };
  const xml = allowed(xmlish);
  const jsonValue = allowed(json);
  const branches = {
    json,
    matches: { json: jsonValue.accepted, xmlish: xml.accepted },
    xmlish,
  };
  const overCap = (payload?: PlainTextJsonToolCallSpan) =>
    Boolean(
      payload &&
      utf8ByteLengthWithinLimit(text, payload.start, payload.end, maxPayloadBytes) === null,
    );
  const xmlOverCap = overCap(xml.payload);
  const jsonOverCap = overCap(jsonValue.payload);
  const complete =
    xml.accepted && xmlish.kind === "complete"
      ? xmlish
      : jsonValue.accepted && json.kind === "complete"
        ? json
        : undefined;
  if (complete) {
    const payloadOverCap = complete === xmlish ? xmlOverCap : jsonOverCap;
    if (complete === xmlish || payloadOverCap || parseJsonArguments(text, complete.payload)) {
      return {
        ...branches,
        end: complete.end,
        kind: "complete",
        next: complete.end,
        overCap: payloadOverCap,
        payloadStart: complete.payload.start,
        settled:
          complete.end > complete.payload.end || skipWhitespace(text, complete.end) < text.length,
      };
    }
    return {
      ...branches,
      at: complete.end,
      kind: "invalid",
      next: complete.end,
      overCap: false,
      payloadStart: complete.payload.start,
    };
  }
  const invalid =
    xmlOverCap && xmlish.kind === "invalid"
      ? xmlish
      : jsonOverCap && json.kind === "invalid"
        ? json
        : undefined;
  if (invalid?.candidate?.payload) {
    return {
      ...branches,
      at: invalid.at,
      kind: "invalid",
      next: invalid.at,
      overCap: true,
      payloadStart: invalid.candidate.payload.start,
    };
  }

  const xmlPrefix = xml.accepted && xmlish.kind === "prefix";
  const jsonPrefix = jsonValue.accepted && json.kind === "prefix";
  if (xmlPrefix || jsonPrefix) {
    const payload = xmlPrefix ? xml.payload : jsonValue.payload;
    return {
      ...branches,
      ...(xmlish.kind === "prefix" && xmlish.completeEnd !== undefined
        ? { completeEnd: xmlish.completeEnd }
        : {}),
      kind: "prefix",
      next: text.length,
      overCap: xmlPrefix ? xmlOverCap : jsonOverCap,
      ...(payload ? { payloadStart: payload.start } : {}),
    };
  }

  let next = start + 1;
  if (xml.accepted) {
    next = Math.max(next, xmlish.kind === "invalid" ? xmlish.at : text.length);
  }
  if (jsonValue.accepted) {
    next = Math.max(
      next,
      json.kind === "complete" ? json.end : json.kind === "invalid" ? json.at : text.length,
    );
  }
  return { ...branches, at: next, kind: "invalid", next, overCap: false };
}

function parseJsonArguments(
  text: string,
  payload: PlainTextJsonToolCallSpan,
): Record<string, unknown> | null {
  return safeParseJsonRecord(text.slice(payload.start, payload.end)) ?? null;
}

function extractXmlishParameterValue(
  text: string,
  start: number,
  end: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): string {
  let value = text.slice(start, end);
  if (consumeLineBreak(text, skipHorizontalWhitespace(text, start)) === null) {
    const boundary = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      start,
      structuralLineBreaks,
    );
    if (boundary !== null) {
      const offset = boundary - start;
      value = `${value.slice(0, offset)}\n${value.slice(offset)}`;
    }
  }
  const payloadStart = consumeLineBreak(value, 0);
  if (payloadStart === null) {
    return value;
  }
  return value.slice(payloadStart).replace(/(?:\r\n|[\r\n])$/u, "");
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    let block: PlainTextToolCallBlock | undefined;
    for (const scanCall of [scanPlainTextJsonToolCall, scanXmlishToolCall]) {
      const scan = scanCall(text, cursor, structuralLineBreaks);
      if (scan.kind !== "complete") {
        continue;
      }
      const name = text.slice(scan.name.start, scan.name.end);
      if (allowedToolNames && !allowedToolNames.has(name)) {
        continue;
      }
      if (
        utf8ByteLengthWithinLimit(text, scan.payload.start, scan.payload.end, maxPayloadBytes) ===
        null
      ) {
        continue;
      }
      const args =
        "parameters" in scan
          ? Object.fromEntries(
              scan.parameters.map((parameter) => [
                text.slice(parameter.name.start, parameter.name.end),
                extractXmlishParameterValue(
                  text,
                  parameter.value.start,
                  parameter.value.end,
                  structuralLineBreaks,
                ),
              ]),
            )
          : parseJsonArguments(text, scan.payload);
      if (args) {
        block = {
          arguments: args,
          end: scan.end,
          name,
          raw: text.slice(cursor, scan.end),
          start: cursor,
        };
        break;
      }
    }
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

/** Removes full-line standalone plain-text tool-call blocks from user-visible text. */
export function stripPlainTextToolCallBlocks(text: string): string {
  if (!PLAIN_TEXT_TOOL_CALL_CANDIDATE_RE.test(text)) {
    return text;
  }
  return projectPlainTextToolCallBlocks(text).text;
}

/** Call-grammar settlement; callers also retain any mutable Markdown ownership. */
export function projectPlainTextToolCallBlocks(
  text: string,
  options: {
    settleBefore?: number;
    preview?: boolean;
    isProtectionSettled?: (offset: number) => boolean;
  } = {},
): {
  text: string;
  retainStart: number;
  retainedOutputStart: number;
  unsettled: boolean;
} {
  let result = "";
  let cursor = 0;
  let index = 0;
  let retainStart = 0;
  let retainedOutputStart = 0;
  let pending = false;
  const pendingResult = (end?: number) => ({
    text: result + text.slice(cursor, end),
    retainStart,
    retainedOutputStart,
    unsettled: true,
  });
  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === "\n" || text[index - 1] === "\r";
    if (!lineStart) {
      index += 1;
      continue;
    }
    if (!pending && index <= (options.settleBefore ?? text.length)) {
      retainStart = index;
      retainedOutputStart = result.length + index - cursor;
    }
    const blockStart = skipLineIndentation(text, index);
    const scan = scanPlainTextToolCall(text, blockStart);
    if (scan.kind === "invalid") {
      // The scanner owns everything before `at` as one malformed candidate. Honor that
      // progress so nested line starts inside its payload are not rescanned quadratically.
      index = Math.max(index + 1, scan.next);
      continue;
    }
    if (options.preview && scan.kind === "prefix") {
      return pendingResult(index);
    }
    pending ||= scan.kind === "prefix" || !scan.settled;
    let blockEnd = scan.kind === "complete" ? scan.end : scan.completeEnd;
    if (blockEnd === undefined) {
      // A trailing candidate may still become a hidden call; the caller must not publish it.
      return pendingResult();
    }
    result += text.slice(cursor, index);
    while (true) {
      const adjacentStart = skipLineIndentation(text, blockEnd);
      const adjacent = scanPlainTextToolCall(text, adjacentStart);
      if (options.preview && adjacent.kind === "prefix") {
        return pendingResult(cursor);
      }
      pending ||= adjacent.kind === "prefix" || (adjacent.kind === "complete" && !adjacent.settled);
      const adjacentEnd =
        adjacent.kind === "complete"
          ? adjacent.end
          : adjacent.kind === "prefix"
            ? adjacent.completeEnd
            : undefined;
      if (adjacentEnd === undefined || adjacentEnd <= blockEnd) {
        break;
      }
      blockEnd = adjacentEnd;
    }
    const lineBreakStart = skipLineIndentation(text, blockEnd);
    cursor =
      lineBreakStart === text.length
        ? lineBreakStart
        : (consumeLineBreak(text, lineBreakStart) ?? blockEnd);
    index = cursor;
  }
  result += text.slice(cursor);
  // Keep a terminal CR until a possible LF settles newline consumption.
  if (!pending && text.endsWith("\n") && text.length <= (options.settleBefore ?? text.length)) {
    retainStart = text.length;
    retainedOutputStart = result.length;
  }
  return {
    text: result,
    retainStart,
    retainedOutputStart,
    unsettled: pending,
  };
}

// ---------------------------------------------------------------------------
// Detection (attempt.ts): classify model text that looks like an unexecuted
// tool call, and decide whether it is an executable repair or a near miss.
// ---------------------------------------------------------------------------

type ToolCallShapedTextDetection = {
  kind: "json_tool_call" | "xml_tool_call" | "bracketed_tool_call" | "react_action";
  toolName?: string;
};

const TOOL_TEXT_PREFILTER_RE =
  /(?:tool[_\s-]?calls?|function[_\s-]?call|["'](?:name|tool_name|function|arguments|args|input|parameters|tool_calls)["']|<\s*tool_call\b|Action\s*:|\[END_TOOL_REQUEST\])/i;
const MAX_SCAN_CHARS = 20_000;
const MAX_JSON_CANDIDATES = 20;
const MAX_JSON_CANDIDATE_CHARS = 8_000;

function readToolName(record: Record<string, unknown>): string | undefined {
  return (
    readTrimmedString(record.name) ??
    readTrimmedString(record.tool_name) ??
    readTrimmedString(record.tool) ??
    readTrimmedString(record.function_name)
  );
}

function hasToolArgs(record: Record<string, unknown>): boolean {
  const parameters = asOptionalRecord(record.parameters);
  // Keep tool-definition schemas literal.
  return (
    "arguments" in record ||
    "args" in record ||
    "input" in record ||
    ("parameters" in record &&
      typeof record.description !== "string" &&
      record.type !== "function" &&
      parameters?.type !== "object" &&
      !asOptionalRecord(parameters?.properties))
  );
}

function classifyJsonValue(
  value: unknown,
  hasToolName?: PlainTextToolCallNameMatcher["hasExactName"],
): ToolCallShapedTextDetection | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const detection = classifyJsonValue(item, hasToolName);
      if (detection) {
        return detection;
      }
    }
    return null;
  }

  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }

  const toolCalls = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCalls)) {
    return (
      classifyJsonValue(toolCalls, hasToolName) ?? (hasToolName ? null : { kind: "json_tool_call" })
    );
  }

  const functionRecord = asOptionalRecord(
    record.function ?? record.function_call ?? record.functionCall,
  );
  if (functionRecord) {
    if (record.type === "function" && "parameters" in functionRecord) {
      return null;
    }
    const toolName = readToolName(functionRecord);
    if (toolName && (hasToolName?.(toolName) ?? true) && hasToolArgs(functionRecord)) {
      return { kind: "json_tool_call", toolName };
    }
  }

  const toolName = readToolName(record);
  if (toolName && hasToolName && !hasToolName(toolName)) {
    return null;
  }
  if (toolName && hasToolArgs(record)) {
    return { kind: "json_tool_call", toolName };
  }

  const type = readTrimmedString(record.type)?.toLowerCase();
  if (
    toolName &&
    (type === "tool_call" ||
      type === "toolcall" ||
      type === "tooluse" ||
      type === "tool_use" ||
      type === "function_call" ||
      type === "functioncall")
  ) {
    return { kind: "json_tool_call", toolName };
  }

  return null;
}

function* iterateJsonCandidates(text: string): Generator<string> {
  // Fenced candidates take precedence even when balanced JSON appears earlier.
  const fenceRe = /```(?:json|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRe)) {
    const candidate = match[1]?.trim();
    if (candidate && candidate.length <= MAX_JSON_CANDIDATE_CHARS) {
      yield candidate;
    }
  }

  let count = 0;
  for (let index = 0; index < text.length && count < MAX_JSON_CANDIDATES; index += 1) {
    const ch = text[index];
    if (ch !== "{" && ch !== "[") {
      continue;
    }
    // Bound each diagnostic scan even when prose contains many unmatched braces.
    const fragment = extractBalancedJsonPrefix(
      text.slice(index, index + MAX_JSON_CANDIDATE_CHARS + 1),
    );
    if (!fragment) {
      continue;
    }
    const candidate = fragment.json;
    if (candidate.length > 1) {
      count += 1;
      yield candidate;
    }
    index += fragment.endIndex;
  }
}

function detectJsonToolCall(text: string): ToolCallShapedTextDetection | null {
  for (const candidate of iterateJsonCandidates(text)) {
    try {
      const detection = classifyJsonValue(JSON.parse(candidate));
      if (detection) {
        return detection;
      }
    } catch {
      // Text only needs to be diagnostic-grade; malformed JSON stays text.
    }
  }
  return null;
}

function detectXmlToolCall(text: string): ToolCallShapedTextDetection | null {
  if (!/<\s*tool_call\b/i.test(text)) {
    return null;
  }
  if (!/<\s*function=/i.test(text) && !/["']name["']\s*:\s*["'][^"']{1,120}["']/i.test(text)) {
    return null;
  }
  const toolName =
    /<\s*function=([A-Za-z0-9_.:-]{1,120})\b/i.exec(text)?.[1] ??
    /["']name["']\s*:\s*["']([^"']{1,120})["']/i.exec(text)?.[1]?.trim();
  return { kind: "xml_tool_call", ...(toolName ? { toolName } : {}) };
}

const LEGACY_TOOL_CALL_OPEN_RE = /\[\s*TOOL_CALL\s*\]\s*{/gi;
const LEGACY_TOOL_NAME_RE = /\btool\s*=>\s*["']([A-Za-z_][A-Za-z0-9_.:-]{0,119})["']/gi;
const LEGACY_ARGS_RE = /\bargs\s*=>/gi;
const LEGACY_FIELD_GAP_CHARS = 8_000;

// `[TOOL_CALL] { tool => "name", args => ... }`: the leftmost opener whose first
// `tool =>` within 8,000 characters is followed by `args =>` within another 8,000.
// Matches of each part never overlap, so both passes only move forward.
function findLegacyBracketedToolName(text: string): string | undefined {
  const argsStarts = Array.from(text.matchAll(LEGACY_ARGS_RE), (match) => match.index);
  const callable: Array<{ start: number; name: string }> = [];
  let nextArgs = 0;
  for (const match of text.matchAll(LEGACY_TOOL_NAME_RE)) {
    const end = match.index + match[0].length;
    while (nextArgs < argsStarts.length && argsStarts[nextArgs]! < end) {
      nextArgs += 1;
    }
    if (nextArgs < argsStarts.length && argsStarts[nextArgs]! - end <= LEGACY_FIELD_GAP_CHARS) {
      callable.push({ start: match.index, name: match[1]! });
    }
  }
  let nextCallable = 0;
  for (const opener of text.matchAll(LEGACY_TOOL_CALL_OPEN_RE)) {
    const end = opener.index + opener[0].length;
    while (nextCallable < callable.length && callable[nextCallable]!.start < end) {
      nextCallable += 1;
    }
    const tool = callable[nextCallable];
    if (!tool) {
      return undefined;
    }
    if (tool.start - end <= LEGACY_FIELD_GAP_CHARS) {
      return tool.name;
    }
  }
  return undefined;
}

function detectBracketedToolCall(text: string): ToolCallShapedTextDetection | null {
  const legacyToolName = findLegacyBracketedToolName(text);
  if (legacyToolName) {
    return { kind: "bracketed_tool_call", toolName: legacyToolName };
  }

  const match =
    /^\s*\[([A-Za-z_][A-Za-z0-9_.:-]{0,119})\]\s+[\s\S]*?\[END_TOOL_REQUEST\]\s*$/i.exec(text);
  if (!match?.[1]) {
    return null;
  }
  return { kind: "bracketed_tool_call", toolName: match[1] };
}

function detectReactAction(text: string): ToolCallShapedTextDetection | null {
  const match =
    /(?:^|\n)[^\S\n]*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})[^\S\n]*\n\s*Action Input\s*:/i.exec(
      text,
    );
  if (!match?.[1]) {
    return null;
  }
  return { kind: "react_action", toolName: match[1] };
}

/** Detects assistant-visible text that looks like an unexecuted tool call instead of prose. */
export function detectToolCallShapedText(text: string): ToolCallShapedTextDetection | null {
  const trimmed = text.slice(0, MAX_SCAN_CHARS).trim();
  if (!trimmed || !TOOL_TEXT_PREFILTER_RE.test(trimmed)) {
    return null;
  }
  return (
    detectBracketedToolCall(trimmed) ??
    detectXmlToolCall(trimmed) ??
    detectJsonToolCall(trimmed) ??
    detectReactAction(trimmed)
  );
}

// `<tool_call>body</tool_call>` (also `tool_calls`, `function_call`), closing tag in
// any case, body trimmed. A `\s*([\s\S]*?)\s*` body lets all three parts split one
// whitespace run, so the tags are checked directly.
function unwrapToolCallTag(text: string): string | undefined {
  const open = /^<(tool_calls?|function_call)>/i.exec(text);
  if (!open) {
    return undefined;
  }
  const close = `</${open[1]!}>`;
  if (text.length < open[0].length + close.length) {
    return undefined;
  }
  if (text.slice(-close.length).toLowerCase() !== close.toLowerCase()) {
    return undefined;
  }
  return text.slice(open[0].length, text.length - close.length).trim();
}

function isStructuredCall(
  text: string,
  hasToolName: PlainTextToolCallNameMatcher["hasExactName"],
): boolean {
  const body = unwrapToolCallTag(text) ?? text;
  const detection = classifyJsonValue(safeParseJson(body), hasToolName);
  if (detection?.toolName) {
    return true;
  }
  if (parseStandalonePlainTextToolCallBlocks(body)?.some((block) => hasToolName(block.name))) {
    return true;
  }
  const invoke =
    /^<(invoke|tool_call|function_call)\s+name=["']([^"']+)["']\s*>[\s\S]*<\/\1>$/i.exec(body);
  if (invoke && hasToolName(invoke[2] ?? "")) {
    return true;
  }
  const action =
    /^Action[ \t]*:[ \t]*([A-Za-z_][A-Za-z0-9_.:-]{0,119})[ \t]*\r?\n[ \t]*Action Input[ \t]*:[ \t]*([\s\S]+)$/i.exec(
      body,
    );
  if (action) {
    const input = action[2]?.trim() ?? "";
    // JSON-shaped input must be complete; multiline prose is not a ReAct call.
    return (
      hasToolName(action[1] ?? "") &&
      Boolean(input) &&
      (!/^[{["]|[\r\n]/.test(input) || safeParseJson(input) !== undefined)
    );
  }
  const legacy =
    /^\[\s*TOOL_CALL\s*\]\s*\{\s*tool\s*=>\s*(["'])([A-Za-z_][A-Za-z0-9_.:-]{0,119})\1\s*,\s*args\s*=>\s*(\{[\s\S]*\})\s*\}\s*\[\s*\/TOOL_CALL\s*\]$/i.exec(
      body,
    );
  return Boolean(
    legacy && hasToolName(legacy[2] ?? "") && asOptionalRecord(safeParseJson(legacy[3] ?? "")),
  );
}

// Text ending in a fenced block: `prefix`, then the earliest opening fence line whose
// marker matches the final closing line, then `body` up to that closing line. The
// closing line is fixed by the end of the text, so each line start is tried once.
function splitTrailingFence(text: string): { prefix: string; body: string } | undefined {
  const marker = text.slice(-3);
  if (marker !== "```" && marker !== "~~~") {
    return undefined;
  }
  let closeLineStart = text.length - 3;
  while (
    closeLineStart > 0 &&
    (text[closeLineStart - 1] === " " || text[closeLineStart - 1] === "\t")
  ) {
    closeLineStart -= 1;
  }
  const closeNewline = closeLineStart - 1;
  if (closeNewline < 0 || text[closeNewline] !== "\n") {
    return undefined;
  }
  const openLine = /[ \t]*(```|~~~)(?:json|xml)?[ \t]*\r?\n/iy;
  for (let lineStart = 0; lineStart <= closeNewline;) {
    openLine.lastIndex = lineStart;
    const open = openLine.exec(text);
    const bodyStart = openLine.lastIndex;
    if (open?.[1] === marker && bodyStart <= closeNewline) {
      const bodyEnd =
        closeNewline > bodyStart && text[closeNewline - 1] === "\r"
          ? closeNewline - 1
          : closeNewline;
      return {
        prefix: text.slice(0, Math.max(0, lineStart - 1)),
        body: text.slice(bodyStart, bodyEnd),
      };
    }
    const nextNewline = text.indexOf("\n", lineStart);
    if (nextNewline < 0) {
      break;
    }
    lineStart = nextNewline + 1;
  }
  return undefined;
}

/** Detects a non-executable near miss; this must never be used to dispatch a tool. */
export function isPlainTextToolCallAttempt(
  text: string,
  hasToolName: PlainTextToolCallNameMatcher["hasExactName"],
): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 256_000) {
    return false;
  }
  if (isStructuredCall(trimmed, hasToolName)) {
    return true;
  }
  const fence = splitTrailingFence(trimmed);
  const trailing = /^([^\n]+)\n\s*((?:<|\{|\[|Action\s*:)[\s\S]*)$/i.exec(trimmed);
  const prefix = (fence?.prefix ?? trailing?.[1] ?? "").trim();
  const body = fence?.body ?? trailing?.[2];
  const announcement = /^(?:I(?:'ll| will| am going to)|Let me) (.+?)(?: now)?[.!:]?$/i.exec(
    prefix,
  )?.[1];
  const announcedTool =
    /^(?:call|invoke|run|execute|use) (?:the )?([A-Za-z_][A-Za-z0-9_.:-]*)(?: tool)?$/i.exec(
      announcement ?? "",
    )?.[1];
  const fileAnnouncement = /^(?:create|read|write|update|delete) the file$/i.test(
    announcement ?? "",
  );
  const toolLabel = /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(prefix) && hasToolName(prefix);
  // Accept only a tool label or complete action announcement, not explanatory prose.
  if (!body || (prefix && !toolLabel && !hasToolName(announcedTool ?? "") && !fileAnnouncement)) {
    return false;
  }
  return isStructuredCall(body.trim(), hasToolName);
}

/** Parses JSON-shaped tool_calls payloads (OpenAI-style objects) into blocks. */
export function parseJsonToolCallPayload(
  text: string,
  hasToolName: PlainTextToolCallNameMatcher["hasExactName"],
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.every(visit);
    }
    const record = asOptionalRecord(value);
    if (!record) {
      return false;
    }
    const functionRecord = asOptionalRecord(
      record.function ?? record.function_call ?? record.functionCall,
    );
    if (functionRecord) {
      const name = readToolName(functionRecord);
      if (!name || !hasToolName(name)) {
        return false;
      }
      const args = asOptionalRecord(functionRecord.arguments ?? functionRecord.args);
      const rawArgs = functionRecord.arguments ?? functionRecord.args ?? functionRecord.input;
      const parsedArgs = args ?? (typeof rawArgs === "string" ? safeParseJsonRecord(rawArgs) : undefined);
      if (!parsedArgs) {
        return false;
      }
      blocks.push({
        arguments: parsedArgs,
        end: text.length,
        name,
        raw: text,
        start: 0,
      });
      return true;
    }
    const name = readToolName(record);
    if (name && hasToolName(name)) {
      const args = asOptionalRecord(record.arguments ?? record.args ?? record.input);
      if (args) {
        blocks.push({ arguments: args, end: text.length, name, raw: text, start: 0 });
        return true;
      }
    }
    const toolCalls = record.tool_calls ?? record.toolCalls;
    if (Array.isArray(toolCalls)) {
      return toolCalls.length > 0 && toolCalls.every(visit);
    }
    return false;
  };
  for (const candidate of iterateJsonCandidates(text)) {
    const parsed: unknown = safeParseJson(candidate);
    if (parsed !== undefined && visit(parsed)) {
      return blocks;
    }
    blocks.length = 0;
  }
  return null;
}
