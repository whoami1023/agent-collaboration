// Context-budget orchestrator: decides when the transcript needs semantic
// compaction (token pressure) or a hard byte bound, runs the ported OpenClaw
// pipeline, and reports what it did. Structure follows OpenClaw's context-engine
// registry flow (compaction trigger → prepare → compact → fallback without
// summary → byte-bound assembly → failed-attempt latch), MIT License —
// Copyright (c) 2026 OpenClaw Foundation; adapted to the flat LlmMessage seam.

import {
  DEFAULT_COMPACTION_SETTINGS,
  buildCompactionSummaryMessage,
  compact,
  compactWithoutSummary,
  prepareCompaction,
  shouldCompact,
  type CompactionSettings,
} from "./compaction";
import { estimateContextTokens, estimateTokens } from "./token-estimate";
import {
  boundTranscriptAssembly,
  refreshTranscriptByteCompactionLatch,
  type BoundedAssembly,
  type TranscriptByteCompactionLatch,
} from "./bounded-context";
import type { SummarizationTransport } from "./summarization";
import type { LlmMessage } from "../../provider/types";

export interface ContextBudgetConfig {
  /** Hard model-view byte ceiling over the managed transcript; undefined disables it. */
  maxActiveTranscriptBytes?: number;
  /** Provider context window in tokens; <= 0 or undefined disables token compaction. */
  contextWindowTokens?: number;
  compaction?: CompactionSettings;
}

export interface ApplyContextBudgetParams {
  /** Full transcript with the owner-held system instruction at index 0. */
  messages: LlmMessage[];
  config: ContextBudgetConfig;
  memberId: string;
  transport: SummarizationTransport;
  byteLatch?: TranscriptByteCompactionLatch;
  requestState?: "unresolved";
}

export interface ContextBudgetOutcome {
  messages: LlmMessage[];
  compacted?: {
    tokensBefore: number;
    replacedMessages: number;
    qualityDegraded: boolean;
  };
  bounded?: BoundedAssembly;
  byteLatch?: TranscriptByteCompactionLatch;
}

function activeTranscriptBytes(messages: readonly LlmMessage[]): number {
  let bytes = 2;
  for (const message of messages) {
    bytes += Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
  }
  return bytes;
}

export async function applyContextBudget(
  params: ApplyContextBudgetParams,
): Promise<ContextBudgetOutcome> {
  const system = params.messages[0];
  const settings = params.config.compaction ?? DEFAULT_COMPACTION_SETTINGS;
  let managed = params.messages.slice(1);
  if (system === undefined || managed.length === 0) {
    return { messages: [...params.messages] };
  }

  let compacted: ContextBudgetOutcome["compacted"];
  let byteLatch = params.byteLatch;
  const maxBytes = params.config.maxActiveTranscriptBytes;
  const window = params.config.contextWindowTokens ?? 0;

  const tokenPressure =
    window > 0 &&
    settings.enabled &&
    shouldCompact(estimateContextTokens(managed).tokens, window, settings);
  const activeBytes = activeTranscriptBytes(managed);
  const bytePressure =
    maxBytes !== undefined &&
    activeBytes > maxBytes &&
    refreshTranscriptByteCompactionLatch(byteLatch, params.memberId, maxBytes, activeBytes) ===
      undefined;

  if (tokenPressure || bytePressure) {
    const summaryTokenBudget =
      window > 0
        ? Math.max(1_024, Math.floor((window - settings.keepRecentTokens) / 2))
        : undefined;
    const preparation = prepareCompaction(managed, settings, {
      ...(params.requestState ? { requestState: params.requestState } : {}),
      ...(summaryTokenBudget !== undefined ? { summaryTokenBudget } : {}),
    });
    // 与 OpenClaw 相同：只有真正的失败或无进展才下闩；"压缩不适用"不算失败。
    if (!preparation.ok) {
      if (bytePressure && maxBytes !== undefined) {
        byteLatch = { memberId: params.memberId, maxBytes, activeBytes };
      }
    } else if (preparation.value) {
      const p = preparation.value;
      let summary = await compact(p, params.transport);
      let qualityDegraded = false;
      if (!summary.ok) {
        const fallback = compactWithoutSummary(p);
        if (fallback.ok) {
          summary = fallback;
          qualityDegraded = true;
        }
      }
      if (!summary.ok) {
        // 摘要与无摘要兜底都失败：下闩抑制同阈值重试。
        if (maxBytes !== undefined) {
          byteLatch = { memberId: params.memberId, maxBytes, activeBytes };
        }
      } else {
        const candidate = [
          buildCompactionSummaryMessage(summary.value.summary),
          ...managed.slice(summary.value.firstKeptIndex),
        ];
        const candidateTokens = candidate.reduce((sum, m) => sum + estimateTokens(m), 0);
        const droppedCount = p.messagesToSummarize.length + p.turnPrefixMessages.length;
        // A reduction that frees no tokens is no progress: rear the latch and stop.
        if (droppedCount > 0 && candidateTokens < p.tokensBefore) {
          compacted = {
            tokensBefore: summary.value.tokensBefore,
            replacedMessages: droppedCount,
            qualityDegraded,
          };
          managed = candidate;
        } else if (maxBytes !== undefined) {
          byteLatch = { memberId: params.memberId, maxBytes, activeBytes };
        }
      }
    }
  }

  let bounded: BoundedAssembly | undefined;
  const boundedView = boundTranscriptAssembly(managed, maxBytes);
  managed = boundedView.messages;
  bounded = boundedView.bounded;
  if (bounded && maxBytes !== undefined) {
    // Byte bounding actually cut: latch the current pressure so a failed attempt
    // rearms only after another full threshold of growth.
    const postBytes = activeTranscriptBytes(managed);
    if (postBytes > maxBytes) {
      byteLatch = { memberId: params.memberId, maxBytes, activeBytes: postBytes };
    } else if (byteLatch && byteLatch.activeBytes !== activeBytes) {
      byteLatch = refreshTranscriptByteCompactionLatch(byteLatch, params.memberId, maxBytes, postBytes);
    }
  }

  return {
    messages: [system, ...managed],
    ...(compacted ? { compacted } : {}),
    ...(bounded ? { bounded } : {}),
    ...(byteLatch ? { byteLatch } : {}),
  };
}

export { estimateTokens };
