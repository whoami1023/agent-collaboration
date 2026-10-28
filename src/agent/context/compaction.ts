// Automatic context compaction.
// Ported from OpenClaw packages/agent-core/src/harness/compaction/compaction.ts +
// compaction-details.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation),
// adapted to the flat LlmMessage transcript: session entries collapse to message
// indexes, and the persisted compaction boundary is a marked user message whose
// details (file lists, unresolved request) are re-parsed from its text.

import {
  estimateContextTokens,
  estimateTokens,
} from "./token-estimate";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "./cjk-chars";
import { findCutPoint, type CompactionRetentionConstraints } from "./cut-point";
import { extractFileOpsFromMessage, computeFileLists, createFileOps, formatFileOperations, mergeSummaryFileOperations, getCompactionContent, type FileOperations } from "./utils";
import {
  SUMMARIZATION_PROMPT,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  runSummarizationCompletion,
  type SummarizationTransport,
} from "./summarization";
import { CompactionError, err, ok, type Result } from "./result";
import { sliceUtf16Safe, truncateUtf16Safe } from "./utf16-slice";
import type { LlmMessage } from "../../provider/types";

// Persisted summaries replay on every later request, so their owner enforces
// this provider-independent 16K hard bound.
export const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
export const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const TURN_CONTEXT_PREFIX = "\n\n---\n\n**本轮上文（切分轮次）：**\n\n";
const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... 当前请求过长，中间已截断 ...]\n";
const MAX_REQUIRED_ASK_CONTEXT_CHARS = 2_000;
const REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER = "\n[... 切分轮次原始请求过长，中间已截断 ...]\n";
/** Longest run-owned request a boundary carries; longer values are dropped on read. */
export const MAX_LATEST_USER_REQUEST_CHARS = 800;

/** Boundary marker for the synthetic user message that carries a compaction summary. */
export const COMPACTION_SUMMARY_MARKER = "[上下文检查点摘要｜更早的历史已压缩，以下为结构化摘要]";

export function buildCompactionSummaryMessage(summary: string): LlmMessage {
  return { role: "user", content: `${COMPACTION_SUMMARY_MARKER}\n${summary}` };
}

export function isCompactionSummaryMessage(message: LlmMessage): boolean {
  return message.role === "user" && message.content.startsWith(COMPACTION_SUMMARY_MARKER);
}

export function readCompactionSummary(message: LlmMessage): string {
  return message.content.slice(COMPACTION_SUMMARY_MARKER.length + 1);
}

function parseTaggedFileList(text: string, tag: string): string[] {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  if (!match?.[1]) {
    return [];
  }
  return match[1].split("\n").filter((line) => line.trim() && !line.startsWith("...and"));
}

/** Recover file metadata already embedded in a persisted summary. */
export function extractFileListsFromSummary(text: string): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  return {
    readFiles: parseTaggedFileList(text, "read-files"),
    modifiedFiles: parseTaggedFileList(text, "modified-files"),
  };
}

/** Recover the unresolved-request section already embedded in a persisted summary. */
export function extractLatestUnresolvedRequestFromSummary(text: string): string | undefined {
  const match = /## 尚未解决的当前请求\n([\s\S]*?)(\n\n|$)/.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return typeof parsed === "string" && parsed.length <= MAX_LATEST_USER_REQUEST_CHARS
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
  latestUnresolvedUserRequest?: string;
  qualityDegraded?: true;
}

/** Generated compaction data ready to replace transcript history. */
export interface CompactionResult<T = unknown> {
  summary: string;
  /** Index where retained history starts. */
  firstKeptIndex: number;
  tokensBefore: number;
  details?: T;
}

function latestUserText(messages: LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const source = getCompactionContent(message.content).text.trim();
      if (source) {
        return source;
      }
    }
  }
  return "";
}

export function extractLatestUserRequest(messages: LlmMessage[]): string | undefined {
  const source = latestUserText(messages);
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

/** Bounds a split turn's source ask; the safeguard summary and the no-summary reduction share it. */
export function formatRequiredAskContext(rawAsk: string): string {
  const source = rawAsk.trim();
  if (source.length <= MAX_REQUIRED_ASK_CONTEXT_CHARS) {
    return source;
  }
  const contentBudget =
    MAX_REQUIRED_ASK_CONTEXT_CHARS - REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -tailBudget)}`;
}

export function capCompactionSummary(
  summary: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
  preservedSuffix = "",
) {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const suffix = preservedSuffix && summary.endsWith(preservedSuffix) ? preservedSuffix : "";
  if (maxChars < SUMMARY_TRUNCATED_MARKER.length + suffix.length) {
    return truncateUtf16Safe(summary, maxChars);
  }
  const budget = maxChars - SUMMARY_TRUNCATED_MARKER.length - suffix.length;
  const prefix = suffix ? summary.slice(0, -suffix.length) : summary;
  return `${truncateUtf16Safe(prefix, budget)}${SUMMARY_TRUNCATED_MARKER}${suffix}`;
}

/** Let each summary owner preserve its structure before checking the foreground token budget. */
export function fitCompactionSummary<T extends { summary: string }>(
  tokenBudget: number | undefined,
  render: (maxChars: number) => T | undefined,
): Result<T, CompactionError> {
  const fits = (candidate: T) =>
    tokenBudget === undefined ||
    estimateStringChars(candidate.summary) / CHARS_PER_TOKEN_ESTIMATE <= tokenBudget;
  const full = render(MAX_COMPACTION_SUMMARY_CHARS);
  if (full && fits(full)) {
    return ok(full);
  }
  let low = 1;
  let high = MAX_COMPACTION_SUMMARY_CHARS - 1;
  let fitted: T | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = render(mid);
    if (!candidate) {
      low = mid + 1;
    } else if (fits(candidate)) {
      fitted = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return fitted
    ? ok(fitted)
    : err(
        new CompactionError(
          "summarization_failed",
          "压缩摘要无法在前台提示与保留历史旁边放下，请缩小请求或换用更大上下文窗口。",
        ),
      );
}

export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return false;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}

/** Caller-owned formats replace the default headings; focus remains additive. */
export type CompactionSummaryPrompt =
  | { kind: "turn-prefix" }
  | { kind: "custom"; instructions: string };

export async function generateSummary(
  currentMessages: LlmMessage[],
  transport: SummarizationTransport,
  reserveTokens: number,
  opts?: {
    customInstructions?: string;
    previousSummary?: string;
    summaryPrompt?: CompactionSummaryPrompt;
    errorLabel?: string;
  },
): Promise<Result<string, CompactionError>> {
  const maxTokens = Math.floor(
    (opts?.summaryPrompt?.kind === "turn-prefix" ? 0.5 : 0.8) * reserveTokens,
  );
  const selectedPrompt =
    opts?.summaryPrompt?.kind === "turn-prefix"
      ? TURN_PREFIX_SUMMARIZATION_PROMPT
      : opts?.summaryPrompt?.kind === "custom"
        ? opts.summaryPrompt.instructions
        : undefined;
  const prompt =
    selectedPrompt ??
    (opts?.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
  return await runSummarizationCompletion({
    messages: currentMessages,
    prompt,
    customInstructions: opts?.customInstructions,
    previousSummary: opts?.previousSummary,
    transport,
    maxTokens,
    errorLabel:
      opts?.summaryPrompt?.kind === "turn-prefix" ? "轮次前缀摘要" : (opts?.errorLabel ?? "上下文摘要"),
  });
}

export interface CompactionPreparation {
  /** Remaining foreground summary tokens, independent of the summarizer's context window. */
  summaryTokenBudget?: number;
  /** Index where retained history starts. */
  firstKeptIndex: number;
  /** Messages summarized into the history summary. */
  messagesToSummarize: LlmMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: LlmMessage[];
  isSplitTurn: boolean;
  /** Bounded request that the run owner will resume after compaction. */
  latestUnresolvedUserRequest?: string;
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File metadata already embedded in the previous compaction summary. */
  previousSummaryDetails?: CompactionDetails;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  settings: CompactionSettings;
}

export interface PrepareCompactionOptions {
  requestState?: "unresolved";
  constraints?: CompactionRetentionConstraints;
  summaryTokenBudget?: number;
  customInstructions?: string;
}

/** Prepare the transcript for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
  messages: LlmMessage[],
  settings: CompactionSettings,
  options?: PrepareCompactionOptions,
): Result<CompactionPreparation | undefined, CompactionError> {
  if (messages.length < 2) {
    return ok(undefined);
  }
  const lastMessage = messages.at(-1);
  if (!lastMessage) {
    return ok(undefined);
  }

  const prevBoundaryIndex = messages.findLastIndex(isCompactionSummaryMessage);

  let previousSummary: string | undefined;
  let previousSummaryDetails: CompactionDetails | undefined;
  let previousLatestUnresolvedUserRequest: string | undefined;
  let boundaryStart = 0;
  if (prevBoundaryIndex >= 0) {
    const prevText = readCompactionSummary(messages[prevBoundaryIndex]!);
    previousSummary = prevText;
    const fileLists = extractFileListsFromSummary(prevText);
    const previousLatestRequest = extractLatestUnresolvedRequestFromSummary(prevText);
    previousSummaryDetails = {
      readFiles: fileLists.readFiles,
      modifiedFiles: fileLists.modifiedFiles,
      ...(previousLatestRequest ? { latestUnresolvedUserRequest: previousLatestRequest } : {}),
    };
    previousLatestUnresolvedUserRequest = previousLatestRequest;
    boundaryStart = prevBoundaryIndex + 1;
  }
  const boundaryEnd = messages.length;

  const contextUsage = estimateContextTokens(messages);
  const tokensBefore = contextUsage.tokens;
  const totalEstimatedTokens = messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  const latestUnresolvedUserRequest = options?.requestState
    ? (extractLatestUserRequest(messages) ?? previousLatestUnresolvedUserRequest)
    : undefined;

  // Provider usage includes prompt/schema tokens omitted by estimateTokens. Normalize its
  // trigger units to the cut walk, capped at a one-token retained tail.
  const triggerUnitScale =
    !options?.constraints?.budget &&
    totalEstimatedTokens > 0 &&
    Number.isFinite(totalEstimatedTokens) &&
    Number.isFinite(contextUsage.usageTokens)
      ? Math.min(
          Math.max(1, settings.keepRecentTokens),
          Math.max(1, contextUsage.usageTokens / totalEstimatedTokens),
        )
      : 1;
  const keepRecentTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    settings.keepRecentTokens / triggerUnitScale,
  );

  const constraints = options?.constraints;

  const cutPoint = findCutPoint(
    messages,
    boundaryStart,
    boundaryEnd,
    keepRecentTokens,
    constraints,
  );
  if (cutPoint.firstKeptEntryIndex === boundaryEnd) {
    return err(
      new CompactionError(
        "summarization_failed",
        "没有完整的近期消息能在前台提示、工具与摘要旁边放下。请缩小请求或选择更大的上下文窗口。",
      ),
    );
  }

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = messages.slice(boundaryStart, Math.max(historyEnd, boundaryStart));
  const turnPrefixMessages =
    cutPoint.isSplitTurn && historyEnd >= boundaryStart
      ? messages.slice(historyEnd, cutPoint.firstKeptEntryIndex)
      : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return ok(undefined);
  }
  const fileOps = createFileOps();
  if (previousSummaryDetails) {
    mergeSummaryFileOperations(fileOps, previousSummaryDetails);
  }
  for (const msg of messagesToSummarize) {
    extractFileOpsFromMessage(msg, fileOps);
  }
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return ok({
    firstKeptIndex: cutPoint.firstKeptEntryIndex,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    tokensBefore,
    previousSummary,
    previousSummaryDetails,
    fileOps,
    settings,
    ...(options?.summaryTokenBudget !== undefined
      ? { summaryTokenBudget: options.summaryTokenBudget }
      : {}),
  });
}

export async function compact(
  preparation: CompactionPreparation,
  transport: SummarizationTransport,
  customInstructions?: string,
): Promise<Result<CompactionResult, CompactionError>> {
  const { firstKeptIndex, messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary, settings } =
    preparation;
  if (!Number.isInteger(firstKeptIndex) || firstKeptIndex < 0) {
    return err(new CompactionError("invalid_session", "压缩边界索引无效"));
  }

  const summarize = (
    messages: LlmMessage[],
    previous?: string,
    summaryPrompt?: CompactionSummaryPrompt,
  ) =>
    generateSummary(messages, transport, settings.reserveTokens, {
      customInstructions,
      previousSummary: previous,
      summaryPrompt,
    });
  const summarizeTurnPrefix = isSplitTurn && turnPrefixMessages.length > 0;
  const historyResult =
    messagesToSummarize.length > 0 || !summarizeTurnPrefix
      ? await summarize(messagesToSummarize, previousSummary)
      : ok<string, CompactionError>(
          previousSummaryWithoutFileOperations(preparation) ?? "No prior history.",
        );
  if (!historyResult.ok) {
    return err(historyResult.error);
  }

  let latestContext = "";
  if (summarizeTurnPrefix) {
    const turnPrefixResult = await summarize(turnPrefixMessages, undefined, {
      kind: "turn-prefix",
    });
    if (!turnPrefixResult.ok) {
      return err(turnPrefixResult.error);
    }
    latestContext = `${TURN_CONTEXT_PREFIX}${turnPrefixResult.value}`;
  }
  return finalizeCompaction(preparation, historyResult.value, latestContext);
}

/**
 * Builds the same commit-ready artifact without a model call, for when summary
 * generation failed. The prepared cut keeps the recent suffix verbatim; the
 * previous summary, a split turn's raw source ask, file operations, and the
 * unresolved request carry forward, and the dropped span is named, not summarized.
 */
export function compactWithoutSummary(
  preparation: CompactionPreparation,
): Result<CompactionResult, CompactionError> {
  const droppedCount =
    preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
  const sourceAsk = preparation.isSplitTurn
    ? formatRequiredAskContext(latestUserText(preparation.turnPrefixMessages))
    : "";
  const requiredContext =
    `[有 ${droppedCount} 条更早的消息因摘要生成失败被移除且未做摘要。此摘要之后的消息为原文；如旧细节仍然重要，请咨询用户。]\n\n` +
    (sourceAsk ? `## 当前轮次的原始请求\n${JSON.stringify(sourceAsk)}\n\n` : "");
  return finalizeCompaction(
    preparation,
    previousSummaryWithoutFileOperations(preparation) ?? "",
    "",
    requiredContext,
  );
}

// File metadata is re-merged by finalizeCompaction, so the carried summary drops its old copy.
function previousSummaryWithoutFileOperations(
  preparation: CompactionPreparation,
): string | undefined {
  const { previousSummary, previousSummaryDetails } = preparation;
  const previousFileOperations = previousSummaryDetails
    ? formatFileOperations(previousSummaryDetails.readFiles, previousSummaryDetails.modifiedFiles)
    : "";
  return previousFileOperations && previousSummary?.endsWith(previousFileOperations)
    ? previousSummary.slice(0, -previousFileOperations.length)
    : previousSummary;
}

function finalizeCompaction(
  preparation: CompactionPreparation,
  historySummary: string,
  latestContext: string,
  requiredContext = "",
): Result<CompactionResult, CompactionError> {
  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  const fileOperations = formatFileOperations(readFiles, modifiedFiles);
  // Required prefix content survives fitting; only the history and split-turn context shrink.
  const requiredPrefix = `${requiredContext}${
    preparation.latestUnresolvedUserRequest
      ? `## 尚未解决的当前请求\n${JSON.stringify(preparation.latestUnresolvedUserRequest)}\n\n`
      : ""
  }`;
  const fitted = fitCompactionSummary(preparation.summaryTokenBudget, (maxChars) => {
    const requiredChars = fileOperations.length + requiredPrefix.length;
    if (maxChars <= requiredChars + SUMMARY_TRUNCATED_MARKER.length) {
      return undefined;
    }
    const preservedHistoryChars = Math.min(
      historySummary.length,
      Math.floor(
        (preparation.summaryTokenBudget === undefined ? maxChars : maxChars - requiredChars) / 2,
      ),
    );
    const latestContextBudget =
      maxChars - requiredChars - SUMMARY_TRUNCATED_MARKER.length - preservedHistoryChars;
    // Fitting must keep generated split-turn context beside required metadata,
    // including its heading and loss marker when that context is shortened.
    if (
      preparation.summaryTokenBudget !== undefined &&
      latestContext &&
      latestContextBudget < TURN_CONTEXT_PREFIX.length + SUMMARY_TRUNCATED_MARKER.length + 1
    ) {
      return undefined;
    }
    const suffix = `${latestContextBudget > 0 ? capCompactionSummary(latestContext, latestContextBudget) : ""}${fileOperations}`;
    return {
      summary: `${requiredPrefix}${capCompactionSummary(
        `${historySummary}${suffix}`,
        maxChars - requiredPrefix.length,
        suffix,
      )}`,
    };
  });
  if (!fitted.ok) {
    return fitted;
  }

  return ok({
    summary: fitted.value.summary,
    firstKeptIndex: preparation.firstKeptIndex,
    tokensBefore: preparation.tokensBefore,
    details: {
      readFiles,
      modifiedFiles,
      ...(preparation.latestUnresolvedUserRequest
        ? { latestUnresolvedUserRequest: preparation.latestUnresolvedUserRequest }
        : {}),
    } as CompactionDetails,
  });
}
