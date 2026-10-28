// Conversation serialization and summary-input budgeting.
// Ported from OpenClaw packages/agent-core/src/harness/compaction/utils.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation), adapted to this project's
// flat LlmMessage seam (string content; role "tool" plays OpenClaw's toolResult role;
// persisted-sender provenance is not modeled here, so user labels carry no suffix).

import { estimateStringChars } from "./cjk-chars";
import { sliceUtf16Safe, truncateUtf16Safe } from "./utf16-slice";
import { createToolCallOccurrenceQueue } from "./tool-pairing";
import type { LlmMessage } from "../../provider/types";

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function addFilePaths(target: Set<string>, value: unknown): void {
  for (const path of Array.isArray(value) ? value : []) {
    if (typeof path === "string") {
      target.add(path);
    }
  }
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Restore file metadata recorded by an earlier compaction summary. */
export function mergeSummaryFileOperations(
  fileOps: FileOperations,
  details: { readFiles: string[]; modifiedFiles: string[] },
): void {
  addFilePaths(fileOps.read, details.readFiles);
  addFilePaths(fileOps.edited, details.modifiedFiles);
}

/** Add file operations from tool calls to an accumulator (read/write/edit gates). */
export function extractFileOpsFromMessage(message: LlmMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") {
    return;
  }
  for (const toolCall of message.toolCalls ?? []) {
    const args = toolCall.args as Record<string, unknown>;
    const path = [args?.path, args?.file_path, args?.filePath].find(
      (value): value is string => typeof value === "string",
    );
    if (!path) {
      continue;
    }
    switch (toolCall.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles: readOnly, modifiedFiles };
}

// File lists ratchet across compactions, so an unbounded join grows without limit
// in long sessions. Hard caps keep the model-visible section bounded per the
// context-budget invariant; overflow collapses to a "...and N more" line.
const MAX_FILE_OPS_LIST_CHARS = 900;

function formatBoundedFileList(tag: string, files: string[], maxChars: number): string {
  if (files.length === 0 || maxChars <= 0) {
    return "";
  }
  const openTag = `<${tag}>\n`;
  const closeTag = `\n</${tag}>`;
  const lines: string[] = [];
  let usedChars = openTag.length + closeTag.length;

  for (let i = 0; i < files.length; i++) {
    const line = `${files[i]}\n`;
    const remaining = files.length - i - 1;
    const overflowLine = remaining > 0 ? `...and ${remaining} more\n` : "";
    const projected = usedChars + line.length + overflowLine.length;
    if (projected > maxChars) {
      const overflow = `...and ${files.length - i} more\n`;
      if (usedChars + overflow.length <= maxChars) {
        lines.push(overflow);
      }
      break;
    }
    lines.push(line);
    usedChars += line.length;
  }

  return lines.length > 0 ? `${openTag}${lines.join("").trimEnd()}${closeTag}` : "";
}

/** Format file lists as bounded summary metadata tags. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections = [
    formatBoundedFileList("read-files", readFiles, MAX_FILE_OPS_LIST_CHARS),
    formatBoundedFileList("modified-files", modifiedFiles, MAX_FILE_OPS_LIST_CHARS),
  ].filter(Boolean);
  // Both 900-character lists and their separators fit the 2,000-character section cap.
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

const TOOL_RESULT_MAX_CHARS = 2000;
const IMPORTANT_TOOL_RESULT_TAIL =
  /(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)/i;
// Covers truncation and elision markers for any UTF-16 length.
const ELISION_MARKER_RESERVE_CHARS = 64;

export function stringifyCompactionValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const tailChars = Math.min(Math.floor(maxChars * 0.3), 600);
  const diagnosticSearch = sliceUtf16Safe(text, -maxChars);
  const diagnosticMatches = [
    ...diagnosticSearch.matchAll(new RegExp(IMPORTANT_TOOL_RESULT_TAIL.source, "gi")),
  ];
  const diagnosticMatch =
    diagnosticMatches.findLast((match) =>
      /^(error|exception|fatal|panic|errno)$/i.test(match[0]),
    ) ?? diagnosticMatches.at(-1);
  if (diagnosticMatch) {
    const head = truncateUtf16Safe(text, maxChars - tailChars);
    const displacedHead = sliceUtf16Safe(text, Math.max(0, head.length - 32), maxChars);
    // A routine footer can match failure words. Never shorten the original
    // retained head when doing so would discard an existing diagnostic.
    if (!IMPORTANT_TOOL_RESULT_TAIL.test(displacedHead)) {
      const diagnosticOffset = text.length - diagnosticSearch.length + (diagnosticMatch.index ?? 0);
      const tailStart = Math.min(diagnosticOffset, text.length - tailChars);
      // An early diagnostic already lives in the retained prefix; reusing it
      // as a tail would overlap the head and miscount omitted characters.
      if (tailStart >= head.length) {
        const tail = sliceUtf16Safe(text, tailStart, tailStart + tailChars);
        const truncatedChars = text.length - head.length - tail.length;
        const omissionPosition = tailStart + tail.length < text.length ? "middle/trailing" : "more";
        // Commands usually report their actual failure last; preserve that tail
        // so summaries can explain what failed.
        return `${head}\n\n[... ${truncatedChars} ${omissionPosition} characters truncated]\n\n${tail}`;
      }
    }
  }
  const headBudget = maxChars - tailChars - ELISION_MARKER_RESERVE_CHARS;
  const prefix = truncateUtf16Safe(text, maxChars);
  // Preserve diagnostics the old prefix already held; ordinary results also
  // need their terminal facts, with the marker inside the same budget.
  const tail = IMPORTANT_TOOL_RESULT_TAIL.test(prefix) ? "" : sliceUtf16Safe(text, -tailChars);
  const head = tail ? truncateUtf16Safe(prefix, headBudget) : prefix;
  const truncatedChars = text.length - head.length - tail.length;
  return `${head}\n\n[... ${truncatedChars} more characters truncated]${tail ? `\n\n${tail}` : ""}`;
}

/**
 * Project summary content once so rendering and token accounting share omission facts.
 * LlmMessage content is a string; the block-projection branches are retained for
 * callers that later embed structured tool payloads.
 */
export function getCompactionContent(
  content: string | Array<{ type: string; content?: unknown; text?: string }>,
): { text: string; omissionText: string } {
  const omissions = new Set<string>();
  const text =
    typeof content === "string"
      ? content
      : content
          .map((block) => {
            let blockText = "";
            if (
              (block.type === "text" ||
                block.type === "toolResult" ||
                block.type === "tool_result") &&
              block.text
            ) {
              blockText = block.text;
            } else if (
              (block.type === "toolResult" || block.type === "tool_result") &&
              typeof block.content === "string"
            ) {
              blockText = block.content;
            }
            if (block.type !== "text" && !blockText) {
              // This projection knows only what it omits, not whether a model processed it.
              omissions.add(
                block.type === "image"
                  ? "[image data omitted from summary input]"
                  : "[non-text data omitted from summary input]",
              );
            }
            return blockText;
          })
          .filter(Boolean)
          .join("\n");
  return { text, omissionText: [...omissions].join("\n") };
}

/** Serialize transcript messages to plain text for summarization prompts. */
export function serializeConversation(messages: LlmMessage[]): string {
  return serializeConversationEntries(messages).entries.join(ENTRY_SEPARATOR);
}

const ENTRY_SEPARATOR = "\n\n";
// A sampled tool result names its call; long arguments keep their start.
const MAX_CALL_LABEL_ARGUMENT_CHARS = 120;
const MAX_CALL_LABEL_CHARS = 300;

function formatCallLabel(name: string, args: ReadonlyArray<readonly [string, string]>): string {
  const label = `${name}(${args
    .map(
      ([key, text]) =>
        `${key}=${text.length > MAX_CALL_LABEL_ARGUMENT_CHARS ? `${truncateUtf16Safe(text, MAX_CALL_LABEL_ARGUMENT_CHARS)}...` : text}`,
    )
    .join(", ")})`;
  return label.length > MAX_CALL_LABEL_CHARS
    ? `${truncateUtf16Safe(label, MAX_CALL_LABEL_CHARS)}...)`
    : label;
}

export interface SerializedConversationEntries {
  entries: string[];
  /** Tool-result entries rendered with the call that produced them, for sampled input. */
  labeledResults: Map<number, string>;
  /** User-message entry indices, which carry the asks, decisions and corrections. */
  userEntries: number[];
}

export function serializeConversationEntries(messages: LlmMessage[]): SerializedConversationEntries {
  const parts: string[] = [];
  const labeledResults = new Map<number, string>();
  const userEntries: number[] = [];
  // Providers may repeat a call ID; each result claims the oldest unanswered call with it.
  const callLabels = createToolCallOccurrenceQueue<string>();

  for (const msg of messages) {
    // The system instruction is owned outside the conversation being summarized.
    if (msg.role === "system") {
      continue;
    }
    if (msg.role === "user" || msg.role === "tool") {
      // Claim even for an empty result, so a later result with the same ID gets its own call.
      const callLabel = msg.role === "tool" ? callLabels.claim(msg.toolCallId ?? "") : undefined;
      const { text, omissionText } = getCompactionContent(msg.content);
      const content = [omissionText, text].filter(Boolean).join("\n");
      if (!content) {
        continue;
      }
      if (msg.role === "tool") {
        const label = callLabel ?? `${msg.toolCallId ?? "?"}(...)`;
        labeledResults.set(
          parts.length,
          `[Tool result of ${label}]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`,
        );
        parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
      } else {
        userEntries.push(parts.length);
        parts.push(`[User]: ${content}`);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      // Results answer the latest assistant turn; calls an earlier turn left
      // unanswered (aborted, failed) must not label them.
      callLabels.clear();

      if (msg.content) {
        textParts.push(msg.content);
      }
      for (const block of msg.toolCalls ?? []) {
        const args = Object.entries(block.args).map(
          ([key, value]) => [key, stringifyCompactionValue(value)] as const,
        );
        const argsStr = args.map(([key, text]) => `${key}=${text}`).join(", ");
        toolCalls.push(`${block.name}(${argsStr})`);
        callLabels.add(block.id, formatCallLabel(block.name, args));
      }

      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    }
  }

  return { entries: parts, labeledResults, userEntries };
}

/**
 * Upper bound for the conversation text of one summary request, in CJK-weighted
 * characters (about 40k tokens). Summary latency and cost follow this bound, not
 * the session size, so a 1M-token window compacts as fast as a 128k one.
 */
export const MAX_SUMMARY_INPUT_CHARS = 160_000;
const MAX_SAMPLED_ENTRY_CHARS = 6_000;
const MIN_TRIMMED_ENTRY_CHARS = 200;
const TRIMMED_ENTRY_HEAD_SHARE = 0.7;
const SUMMARY_INPUT_TAIL_SHARE = 0.5;
const SUMMARY_INPUT_USER_SHARE = 0.25;
const SUMMARY_INPUT_HEAD_SHARE = 0.1;
const SUMMARY_INPUT_MIDDLE_SLICES = 8;
// Older user messages share their budget evenly, within these bounds each.
const MAX_USER_ENTRY_CHARS = 2_000;
const MIN_USER_ENTRY_CHARS = 400;
// A gap marker ("[... 12345 entries omitted ...]") and its separator stay under 40 characters.
const OMISSION_MARKER_CHARS = 40;

/**
 * Keep both ends of `text` within `maxChars` CJK-weighted characters: the start
 * usually states the request and the end its latest instruction or result.
 * Weighted length is at least the UTF-16 length, so each binary search is
 * bounded by the weight budget, not by the size of the text.
 */
function elideMiddleWithinWeight(text: string, maxChars: number): string | undefined {
  const available = maxChars - ELISION_MARKER_RESERVE_CHARS;
  if (available < MIN_TRIMMED_ENTRY_CHARS) {
    return undefined;
  }
  const headBudget = Math.floor(available * TRIMMED_ENTRY_HEAD_SHARE);
  let low = 0;
  let high = Math.min(text.length, headBudget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateStringChars(truncateUtf16Safe(text, mid)) <= headBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const head = truncateUtf16Safe(text, low);
  const tailBudget = available - estimateStringChars(head);
  low = Math.max(head.length, text.length - tailBudget);
  high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateStringChars(sliceUtf16Safe(text, mid)) <= tailBudget) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  const tail = sliceUtf16Safe(text, low);
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters omitted ...]\n\n${tail}`;
}

export interface BoundedConversation {
  text: string;
  /** Entries left out entirely; the text names each gap where it occurs. */
  omittedEntries: number;
  /** Entries kept with their middle elided. */
  trimmedEntries: number;
}

/**
 * Serialize messages for one summary request within `maxChars` CJK-weighted
 * characters. Small inputs are unchanged. Larger inputs keep, in this order:
 * the newest entries verbatim (half the budget); older user messages, which
 * carry the asks, decisions and corrections (a quarter, newest first, each up
 * to 2,000 characters); the oldest entries (a tenth); and eight evenly spaced
 * runs of what remains. Sampled entries are trimmed to 6,000 characters, every
 * gap is marked with its entry count, and each tool result names its call,
 * because sampling can separate the two. The transcript itself is not changed.
 */
export function serializeConversationWithinBudget(
  messages: LlmMessage[],
  maxChars: number,
): BoundedConversation {
  const serialized = serializeConversationEntries(messages);
  const separatorChars = ENTRY_SEPARATOR.length;
  const totalChars =
    serialized.entries.reduce((sum, entry) => sum + estimateStringChars(entry), 0) +
    separatorChars * Math.max(0, serialized.entries.length - 1);
  if (totalChars <= maxChars) {
    return {
      text: serialized.entries.join(ENTRY_SEPARATOR),
      omittedEntries: 0,
      trimmedEntries: 0,
    };
  }
  const entries = serialized.entries.map(
    (entry, index) => serialized.labeledResults.get(index) ?? entry,
  );
  const weights = entries.map((entry) => estimateStringChars(entry));

  const selected = new Map<number, string>();
  let trimmedEntries = 0;
  // Every maximal run of left-out entries renders one marker; the whole span starts as one.
  let usedChars = OMISSION_MARKER_CHARS;

  // Keeps the entry within `limit`, eliding its middle when needed. The cost
  // includes the change in gap markers: taking an entry inside a gap splits it.
  const take = (index: number, limit: number, maxEntryChars = limit): boolean => {
    if (selected.has(index)) {
      return true;
    }
    const leftOpen = index > 0 && !selected.has(index - 1);
    const rightOpen = index < entries.length - 1 && !selected.has(index + 1);
    const markerDelta = leftOpen && rightOpen ? 1 : !leftOpen && !rightOpen ? -1 : 0;
    const markerCost = markerDelta * OMISSION_MARKER_CHARS;
    const entry = entries[index] ?? "";
    const entryLimit = Math.min(limit - markerCost, maxEntryChars + separatorChars);
    let text = entry;
    let chars = (weights[index] ?? 0) + separatorChars;
    if (chars > entryLimit) {
      const trimmed = elideMiddleWithinWeight(entry, entryLimit - separatorChars);
      if (trimmed === undefined) {
        return false;
      }
      text = trimmed;
      chars = estimateStringChars(trimmed) + separatorChars;
    }
    // Shares only order the passes; the whole input never exceeds maxChars.
    if (usedChars + chars + markerCost > maxChars) {
      return false;
    }
    if (text !== entry) {
      trimmedEntries += 1;
    }
    selected.set(index, text);
    usedChars += chars + markerCost;
    return true;
  };

  // Newest entries carry the live task, so they stay verbatim. Only the newest
  // entry may be trimmed, when it alone exceeds the tail share.
  let tailStart = entries.length;
  const tailLimit = Math.floor(maxChars * SUMMARY_INPUT_TAIL_SHARE);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const remaining = tailLimit - usedChars;
    const verbatim = (weights[index] ?? 0) + separatorChars <= remaining;
    if ((!verbatim && tailStart !== entries.length) || !take(index, remaining)) {
      break;
    }
    tailStart = index;
  }

  // Older user messages state what was asked, decided and corrected; a fact the
  // user gave once must not depend on where the samples fall. When they do not
  // all fit, they are spread evenly across the history, newest first.
  const olderUsers = serialized.userEntries.filter((index) => index < tailStart);
  if (olderUsers.length > 0) {
    const userBudget = Math.floor(maxChars * SUMMARY_INPUT_USER_SHARE);
    const userLimit = usedChars + userBudget;
    const userEntryChars = Math.min(
      MAX_USER_ENTRY_CHARS,
      Math.max(
        MIN_USER_ENTRY_CHARS,
        Math.floor(userBudget / olderUsers.length - OMISSION_MARKER_CHARS),
      ),
    );
    const userCosts = olderUsers.reduce(
      (sum, index) =>
        sum +
        Math.min((weights[index] ?? 0) + separatorChars, userEntryChars + separatorChars) +
        OMISSION_MARKER_CHARS,
      0,
    );
    const stride = Math.max(1, userCosts / userBudget);
    for (let position = olderUsers.length - 1; position >= 0; position -= stride) {
      const index = olderUsers[Math.round(position)];
      if (index === undefined || !take(index, userLimit - usedChars, userEntryChars)) {
        break;
      }
    }
  }

  // The oldest entries usually state the goal and the constraints of the session.
  let headEnd = 0;
  const headLimit = usedChars + Math.floor(maxChars * SUMMARY_INPUT_HEAD_SHARE);
  while (headEnd < tailStart && take(headEnd, headLimit - usedChars, MAX_SAMPLED_ENTRY_CHARS)) {
    headEnd += 1;
  }

  // Evenly spaced runs show how the remaining span developed.
  const middleCount = tailStart - headEnd;
  if (middleCount > 0) {
    const sliceLimit = Math.floor((maxChars - usedChars) / SUMMARY_INPUT_MIDDLE_SLICES);
    let nextFree = headEnd;
    for (let slice = 0; slice < SUMMARY_INPUT_MIDDLE_SLICES; slice += 1) {
      let index = Math.max(
        nextFree,
        headEnd + Math.floor((slice * middleCount) / SUMMARY_INPUT_MIDDLE_SLICES),
      );
      const sliceEnd = usedChars + sliceLimit;
      while (index < tailStart && take(index, sliceEnd - usedChars, MAX_SAMPLED_ENTRY_CHARS)) {
        index += 1;
      }
      nextFree = index;
    }
  }

  const parts: string[] = [];
  let omittedEntries = 0;
  let gap = 0;
  // The extra iteration flushes a trailing gap.
  for (let index = 0; index <= entries.length; index += 1) {
    const text = selected.get(index);
    if (text === undefined && index < entries.length) {
      gap += 1;
      continue;
    }
    if (gap > 0) {
      parts.push(`[... ${gap} ${gap === 1 ? "entry" : "entries"} omitted ...]`);
      omittedEntries += gap;
      gap = 0;
    }
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return { text: parts.join(ENTRY_SEPARATOR), omittedEntries, trimmedEntries };
}
