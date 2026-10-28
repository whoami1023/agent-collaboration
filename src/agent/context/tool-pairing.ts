// Tool-call / tool-result pairing classifier.
// Ported from OpenClaw packages/agent-core/src/harness/session/tool-result-pairing.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation), adapted to this project's
// flat LlmMessage seam (assistant.toolCalls / tool.toolCallId, string content).
// OpenClaw's synthetic-missing-result repair paths are omitted: this loop always
// commits a result for every call, so unclaimed/synthetic replacements cannot occur.

import type { LlmMessage, ToolCall } from "../../provider/types";

export type ToolCallOccurrence = {
  contentIndex: number;
  id: string;
  name?: string;
  result?: LlmMessage;
  sourceResult?: LlmMessage;
  sourceResultIndex?: number;
};

export type ToolUsePairingFrame = {
  startIndex: number;
  endIndex: number;
  assistant: LlmMessage;
  remainder: LlmMessage[];
  occurrences: ToolCallOccurrence[];
  failed: boolean;
};

type ToolResultRecord = {
  result: LlmMessage;
  sourceResult: LlmMessage;
  index: number;
  id?: string;
};

/** Tracks repeated provider ids by occurrence instead of collapsing them into a set. */
export function createToolCallOccurrenceQueue<T>(): {
  add: (id: string, occurrence: T) => void;
  claim: (id: string) => T | undefined;
  clear: () => void;
  readonly size: number;
} {
  const pendingById = new Map<string, T[]>();
  let pendingCount = 0;
  return {
    add(id, occurrence) {
      const pending = pendingById.get(id);
      if (pending) {
        pending.push(occurrence);
      } else {
        pendingById.set(id, [occurrence]);
      }
      pendingCount += 1;
    },
    claim(id) {
      const pending = pendingById.get(id);
      const occurrence = pending?.shift();
      if (!occurrence) {
        return undefined;
      }
      pendingCount -= 1;
      if (pending?.length === 0) {
        pendingById.delete(id);
      }
      return occurrence;
    },
    clear() {
      pendingById.clear();
      pendingCount = 0;
    },
    get size() {
      return pendingCount;
    },
  };
}

export function extractToolCallsFromAssistant(message: LlmMessage): ToolCall[] {
  return message.role === "assistant" ? (message.toolCalls ?? []) : [];
}

export function extractToolResultId(message: LlmMessage): string | null {
  return message.role === "tool" ? (message.toolCallId ?? null) : null;
}

/**
 * Legacy seam: a tool result without an id can only belong to the single call of its
 * frame. Ported from OpenClaw's normalizeLegacyToolResultId (error marking dropped —
 * LlmMessage has no isError field).
 */
function normalizeLegacyToolResultId(
  message: LlmMessage,
  toolCalls: ToolCallOccurrence[],
): LlmMessage {
  if (extractToolResultId(message) || toolCalls.length !== 1) {
    return message;
  }
  const toolCall = toolCalls[0];
  if (!toolCall) {
    return message;
  }
  return { ...message, toolCallId: toolCall.id };
}

/** Classifies call/result ownership without reordering or synthesizing transcript messages. */
export function classifyToolUseResultPairing(
  messages: readonly LlmMessage[],
  options?: { preserveUnframedToolResults?: boolean },
): ToolUsePairingFrame[] {
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const frameRecords: Array<ToolUsePairingFrame & { unclaimedResults?: ToolResultRecord[] }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant?.role !== "assistant") {
      continue;
    }
    let frame: (typeof frameRecords)[number] | undefined;
    for (const [contentIndex, toolCall] of (assistant.toolCalls ?? []).entries()) {
      if (!toolCall?.id) {
        continue;
      }
      if (!frame) {
        const previous = frameRecords[frameRecords.length - 1];
        if (previous) {
          previous.endIndex = index;
        }
        frame = {
          startIndex: index,
          endIndex: messages.length,
          assistant,
          remainder: [],
          unclaimedResults: undefined,
          occurrences: [],
          failed: false,
        };
        frameRecords.push(frame);
      }
      frame.occurrences.push({
        contentIndex,
        id: toolCall.id,
        name: toolCall.name,
      });
    }
  }

  for (const frame of frameRecords) {
    const { occurrences } = frame;
    const pending = createToolCallOccurrenceQueue<ToolCallOccurrence>();
    for (const occurrence of occurrences) {
      pending.add(occurrence.id, occurrence);
    }
    for (let index = frame.startIndex + 1; index < frame.endIndex; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      if (message.role !== "tool") {
        frame.remainder.push(message);
        continue;
      }
      const normalized = normalizeLegacyToolResultId(message, occurrences);
      const id = extractToolResultId(normalized);
      const occurrence = id ? pending.claim(id) : undefined;
      if (occurrence) {
        occurrence.result = normalized;
        occurrence.sourceResult = message;
        occurrence.sourceResultIndex = index;
        continue;
      }
      if (!id || !occurrences.some((candidate) => candidate.id === id)) {
        (frame.unclaimedResults ??= []).push({
          result: normalized,
          sourceResult: message,
          index,
          id: id ?? undefined,
        });
        if (preserveUnframed) {
          frame.remainder.push(normalized);
        }
        continue;
      }
    }
  }

  // Displaced results cross a frame only when exactly one unresolved occurrence can own them.
  let unresolvedById: Map<string, ToolCallOccurrence[]> | undefined;
  for (const frame of frameRecords) {
    for (const occurrence of frame.occurrences) {
      if (!occurrence.result) {
        unresolvedById ??= new Map();
        const unresolved = unresolvedById.get(occurrence.id);
        if (unresolved) {
          unresolved.push(occurrence);
        } else {
          unresolvedById.set(occurrence.id, [occurrence]);
        }
      }
    }
    if (!frame.unclaimedResults) {
      continue;
    }
    for (const record of frame.unclaimedResults) {
      const candidates = record.id ? unresolvedById?.get(record.id) : undefined;
      const candidate = candidates?.length === 1 ? candidates[0] : undefined;
      if (!candidate) {
        continue;
      }
      candidate.result = record.result;
      candidate.sourceResult = record.sourceResult;
      candidate.sourceResultIndex = record.index;
      if (preserveUnframed) {
        frame.remainder = frame.remainder.filter((message) => message !== record.result);
      }
    }
  }

  return frameRecords.map(({ unclaimedResults: _unclaimed, ...frame }) => frame);
}
