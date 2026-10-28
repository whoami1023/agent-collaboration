// Token estimation for the flat LlmMessage transcript.
// Ported from OpenClaw packages/agent-core/src/harness/compaction/compaction-cut-point.ts
// (estimateTokens) and compaction.ts (estimateContextTokens), MIT License —
// Copyright (c) 2026 OpenClaw Foundation. Adapted: LlmMessage has no image blocks,
// thinking blocks, or provider usage blocks yet, so the usage-backed path collapses
// to a full-transcript estimate — exactly OpenClaw's behavior behind an
// "unavailable context" barrier.

import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "./cjk-chars";
import { getCompactionContent, stringifyCompactionValue } from "./utils";
import type { LlmMessage } from "../../provider/types";

export const IMAGE_BLOCK_TOKENS = 2_000;
const IMAGE_BLOCK_CHARS = IMAGE_BLOCK_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

function countContentChars(
  content: string | Array<{ type: string; content?: unknown; text?: string }>,
): number {
  const { text, omissionText } = getCompactionContent(content);
  const images =
    typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
  // Charge the largest role/separator even for mixed text.
  const omissionChars = omissionText ? omissionText.length + "\n\n[Tool result]: ".length : 0;
  return estimateStringChars(text) + images * IMAGE_BLOCK_CHARS + omissionChars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: LlmMessage): number {
  let chars = 0;
  switch (message.role) {
    case "assistant": {
      chars += estimateStringChars(message.content);
      for (const block of message.toolCalls ?? []) {
        chars +=
          estimateStringChars(block.name) +
          estimateStringChars(stringifyCompactionValue(block.args));
      }
      break;
    }
    case "user":
    case "tool":
    case "system": {
      chars = countContentChars(message.content);
      break;
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens not covered by usable provider usage. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: LlmMessage[]): ContextUsageEstimate {
  // LlmMessage carries no usage blocks: every transcript token is a trailing estimate.
  let trailingTokens = 0;
  for (const message of messages) {
    trailingTokens += estimateTokens(message);
  }
  return {
    tokens: trailingTokens,
    usageTokens: 0,
    trailingTokens,
    lastUsageIndex: null,
  };
}
