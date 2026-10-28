// Compaction cut-point selection.
// Ported from OpenClaw packages/agent-core/src/harness/compaction/compaction-cut-point.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation), adapted to the flat
// LlmMessage transcript: session entries and their projected messages collapse to
// one array here, so entry indexes are message indexes.

import { classifyToolUseResultPairing, extractToolCallsFromAssistant } from "./tool-pairing";
import { estimateTokens } from "./token-estimate";
import type { LlmMessage } from "../../provider/types";

/** Turn-start roles on this seam: user turns, including persisted compaction summaries. */
function isTurnStartMessage(message: LlmMessage): boolean {
  return message.role === "user";
}

function isCutPointMessage(message: LlmMessage): boolean {
  return message.role === "assistant" || isTurnStartMessage(message);
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(
  messages: LlmMessage[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const message = messages[i];
    if (message && isTurnStartMessage(message)) {
      return i;
    }
  }
  return -1;
}

export interface CompactionRetentionConstraints {
  /** An admitted, unprocessed user remains intact even before its budget is prepared. */
  preserveFromEntryId?: string;
  /** Automatic callers supply the remaining foreground budget and its message estimator. */
  budget?: {
    maxTokens: number;
    reserveTokens: number;
    estimateTokens: (message: LlmMessage) => number;
  };
}

function createToolPairCutResolver(messages: LlmMessage[], entryIndexes: number[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  const entryIndexAt = (messageIndex: number): number => {
    const entryIndex = entryIndexes[messageIndex];
    if (entryIndex === undefined) {
      throw new Error("Tool pairing references a message outside the compaction entries");
    }
    return entryIndex;
  };
  for (const frame of classifyToolUseResultPairing(messages)) {
    const start = entryIndexAt(frame.startIndex);
    let end = start;
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResultIndex !== undefined) {
        end = Math.max(end, entryIndexAt(occurrence.sourceResultIndex));
      }
    }
    if (end === start) {
      continue;
    }
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // A result can arrive after another assistant fragment or tool batch. Keep
  // its actual owning occurrence on the same side of the compaction boundary.
  return (index: number): number => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = ranges[middle];
      if (!candidate) {
        throw new Error("Compaction tool range is missing from the selected search interval");
      }
      if (candidate.start < index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const range = ranges[low - 1];
    return range && index <= range.end ? range.start : index;
  };
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
  messages: LlmMessage[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  constraints?: CompactionRetentionConstraints,
): {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
} {
  const retention = constraints?.budget;
  let cutIndex: number | undefined;
  let lastAllowedCut = endIndex - 1;
  const toolMessages: LlmMessage[] = [];
  const toolEntryIndexes: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const message = messages[i];
    if (constraints?.preserveFromEntryId && String(i) === constraints.preserveFromEntryId) {
      lastAllowedCut = i;
    }
    if (message && isCutPointMessage(message)) {
      cutIndex = i;
    }
    if (
      message?.role === "tool" ||
      (message?.role === "assistant" && extractToolCallsFromAssistant(message).length > 0)
    ) {
      toolMessages.push(message);
      toolEntryIndexes.push(i);
    }
  }
  if (cutIndex === undefined) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  const resolveCutPoint = createToolPairCutResolver(toolMessages, toolEntryIndexes);
  cutIndex = resolveCutPoint(cutIndex);
  lastAllowedCut = resolveCutPoint(lastAllowedCut);
  let accumulatedTokens = 0;

  // The latest valid cut also handles an oversized trailing tool result that
  // exhausts the budget before the reverse walk reaches its preceding boundary.
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (isCutPointMessage(message)) {
      cutIndex = resolveCutPoint(i);
    }
    accumulatedTokens += retention?.estimateTokens(message) ?? estimateTokens(message);
    if (accumulatedTokens >= keepRecentTokens) {
      break;
    }
  }
  cutIndex = Math.min(cutIndex, lastAllowedCut);
  if (retention) {
    let retainedTokens = 0;
    let fittingCut = endIndex;
    let tailLimit = retention.maxTokens;
    for (let i = endIndex - 1; i >= cutIndex; i--) {
      const message = messages[i];
      retainedTokens += message ? retention.estimateTokens(message) : 0;
      if (retainedTokens > tailLimit) {
        break;
      }
      if (
        i <= lastAllowedCut &&
        message &&
        isCutPointMessage(message) &&
        resolveCutPoint(i) === i
      ) {
        if (fittingCut === endIndex) {
          // The summary maximum is a reservation, not a minimum: small windows
          // retain one complete atom and give the summary the remaining room.
          tailLimit = Math.max(retainedTokens, retention.maxTokens - retention.reserveTokens);
        }
        fittingCut = i;
      }
    }
    if (fittingCut === endIndex) {
      return { firstKeptEntryIndex: endIndex, turnStartIndex: -1, isSplitTurn: false };
    }
    cutIndex = fittingCut;
  }
  // OpenClaw walks the cut back across harness-only metadata entries; on this flat
  // seam every slot is a message, so the cut already sits on a message boundary and
  // never crosses the prior-compaction boundary (startIndex excludes it).
  const cutMessage = messages[cutIndex];
  if (!cutMessage) {
    throw new Error("compaction cut point does not reference a transcript message");
  }
  const startsTurn = isTurnStartMessage(cutMessage);
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(messages, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}
