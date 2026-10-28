// Hard byte bound over the model view plus the failed-attempt latch.
// Ported from OpenClaw src/context-engine/bounded-context.ts and
// src/context-engine/transcript-byte-limit.ts (MIT License — Copyright (c) 2026
// OpenClaw Foundation), adapted to the flat LlmMessage transcript: the leading
// system instruction is an owner-held message outside the swept range, expired
// runtime-context bodies are not modeled on this seam, and the thread_bootstrap
// epoch is returned as observability data instead of a persistent projection.

import { createHash } from "node:crypto";
import { estimateTokens } from "./token-estimate";
import { classifyToolUseResultPairing } from "./tool-pairing";
import { parseNonNegativeByteSize } from "./byte-size";
import type { LlmMessage } from "../../provider/types";

export const BOUNDED_CONTEXT_NOTICE =
  "⚠️ 正在以有界的近期上下文继续。更早的历史在本次请求中被省略；如有需要的早期细节请重新发送。完整历史仍然保存在会话记录中。";

/** Configured model-view byte ceiling; <= 0 or unparsable disables the bound. */
export function resolveMaxActiveTranscriptBytes(
  value: unknown,
): number | undefined {
  const parsed = parseNonNegativeByteSize(value);
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

export interface TranscriptByteCompactionLatch {
  memberId: string;
  maxBytes: number;
  activeBytes: number;
}

/** A failed/no-progress byte attempt rearms only after another threshold of growth. */
export function refreshTranscriptByteCompactionLatch(
  latch: TranscriptByteCompactionLatch | undefined,
  memberId: string,
  maxBytes: number | undefined,
  activeBytes: number | undefined,
): TranscriptByteCompactionLatch | undefined {
  if (
    !latch ||
    maxBytes === undefined ||
    latch.memberId !== memberId ||
    latch.maxBytes !== maxBytes
  ) {
    return undefined;
  }
  if (activeBytes === undefined) {
    return latch;
  }
  if (activeBytes < maxBytes || activeBytes - latch.activeBytes >= maxBytes) {
    return undefined;
  }
  return activeBytes < latch.activeBytes ? { ...latch, activeBytes } : latch;
}

export interface BoundedAssembly {
  messages: LlmMessage[];
  estimatedTokens: number;
  /** sha256 over the cut inputs; stable while the same window is retained. */
  epoch: string;
  omittedMessages: number;
}

/**
 * Bounds only the model view over the managed range; required instructions and the
 * pending input stay with their owners. `messages` excludes the owner-held system
 * message.
 */
export function boundTranscriptAssembly(
  messages: readonly LlmMessage[],
  maxBytes: number | undefined,
  tokenBudget?: number,
): { messages: LlmMessage[]; bounded?: BoundedAssembly } {
  if (maxBytes === undefined) {
    return { messages: [...messages] };
  }
  let bytes = 2;
  let tokens = 0;
  let cut = messages.length;
  let exceedsByteBudget = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    bytes += Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    tokens += estimateTokens(message);
    if (bytes > maxBytes) {
      exceedsByteBudget = true;
      break;
    }
    if (tokenBudget !== undefined && tokens > tokenBudget) {
      continue;
    }
    if (message.role === "user") {
      cut = index;
    }
  }
  // Ordinary token pressure still belongs to semantic compaction.
  if (!exceedsByteBudget) {
    return { messages: [...messages] };
  }
  // User messages can arrive between a call and its result. Advance past the
  // complete occurrence rather than retaining an orphan or exceeding the budget.
  for (const frame of classifyToolUseResultPairing(messages)) {
    if (frame.startIndex >= cut) {
      break;
    }
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResultIndex !== undefined && occurrence.sourceResultIndex >= cut) {
        cut = occurrence.sourceResultIndex + 1;
        while (cut < messages.length && messages[cut]?.role !== "user") {
          cut++;
        }
      }
    }
  }
  const retained = messages.slice(cut);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([maxBytes, messages[cut - 1], retained]))
    .digest("hex");
  return {
    messages: retained,
    bounded: {
      messages: retained,
      estimatedTokens: retained.reduce((sum, message) => sum + estimateTokens(message), 0),
      epoch: `bounded:${fingerprint}`,
      omittedMessages: messages.length - retained.length,
    },
  };
}
