/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * - extensions/active-memory/trigger-recall.ts（规则确定性 lane-1 召回：
 *   prepareTriggerScorer/selectStrongTriggerMatches/buildTriggerRecallContext，
 *   常量 TRIGGER_CANDIDATE_LIMIT=24 / TRIGGER_INJECTION_LIMIT=3 /
 *   MAX_TRIGGER_CONTEXT_CHARS=1800 / STRONG_TRIGGER_MATCH_SCORE=0.65 逐项对应）
 * - extensions/active-memory/prompt.ts（escapeXml/buildPromptPrefix）
 * - extensions/active-memory/types.ts（active_memory_plugin 标签）
 * 适配：
 * - native provider/candidate 双通道收敛为单一 MemorySearchManager 词法通道
 *   （lexicalOnly、minScore 0、sources ["memory"]，与 legacy 通道参数一致）；
 * - provenance originClass 资格判定不在移植范围，策展条目以「source=memory 且
 *   带 trigger 注释」为自动注入资格条件（scoreTrigger 本就要求 triggers）。
 */

import { stripMemoryAnnotationCarriers } from "./annotations";
import type { MemorySearchManager, MemorySearchResult } from "./manager";
import { truncateUtf16Safe } from "../agent/context/utf16-slice";

const TRIGGER_CANDIDATE_LIMIT = 24;
const TRIGGER_INJECTION_LIMIT = 3;
const MAX_TRIGGER_CONTEXT_CHARS = 1800;
// 0.65 measured on a 20-trigger/50-unrelated synthetic corpus: zero false
// positives down to 0.60, while 0.72 rejected legitimate paraphrases.
const STRONG_TRIGGER_MATCH_SCORE = 0.65;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";

export interface TriggerRecallHit {
  path: string;
  startLine: number;
  excerpt: string;
  score: number;
  citation: string;
  triggers: string;
  projectKeys?: string[];
}

function normalizeWords(value: string): string[] {
  return (value.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length > 1);
}

function splitTriggerPhrases(value: string): string[] {
  return value
    .split(/[\n;|]+/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function prepareTriggerScorer(message: string): (hit: TriggerRecallHit) => number {
  let messageWordSet: Set<string> | undefined;
  const scorePhrase = (phrase: string): number => {
    const triggerWords = [...new Set(normalizeWords(phrase))];
    if (triggerWords.length === 0) {
      return 0;
    }
    const words = (messageWordSet ??= new Set(normalizeWords(message)));
    if (triggerWords.length === 1) {
      return words.has(triggerWords[0] ?? "") ? 0.85 : 0;
    }
    const overlap = triggerWords.filter((word) => words.has(word)).length;
    if (overlap === 0) {
      return 0;
    }
    const coverage = overlap / triggerWords.length;
    return coverage * 0.8 + Math.min(1, overlap / 2) * 0.2;
  };
  return (hit) => {
    if (!hit.triggers) {
      return 0;
    }
    const triggerScore = Math.max(0, ...splitTriggerPhrases(hit.triggers).map(scorePhrase));
    const relevance = Math.max(0, Math.min(1, hit.score ?? 0));
    return triggerScore * 0.8 + relevance * 0.2;
  };
}

function isEligibleMemoryEntry(hit: TriggerRecallHit, activeProjectKeys: readonly string[] = []): boolean {
  return !hit.projectKeys || hit.projectKeys.every((key) => activeProjectKeys.includes(key));
}

export function toTriggerRecallHits(entries: readonly MemorySearchResult[]): TriggerRecallHit[] {
  const byKey = new Map<string, TriggerRecallHit>();
  for (const entry of entries) {
    if (entry.source !== "memory" || !entry.triggers) continue;
    const projectKeys = entry.projectKey
      ? [
          ...new Set(
            entry.projectKey
              .split(";")
              .map((key) => key.trim())
              .filter(Boolean),
          ),
        ]
      : undefined;
    // A project annotation without a usable key never matches the active set.
    if (entry.projectKey && projectKeys?.length === 0) continue;
    const hit: TriggerRecallHit = {
      path: entry.path,
      startLine: entry.startLine,
      excerpt: stripMemoryAnnotationCarriers(entry.snippet).replace(/\s+/gu, " ").trim(),
      score: entry.score,
      citation: `${entry.path}#L${String(entry.startLine)}`,
      triggers: entry.triggers,
      ...(projectKeys ? { projectKeys } : {}),
    };
    const key = `${hit.path}:${hit.startLine}`;
    const existing = byKey.get(key);
    // The scored retrieval copy of a chunk replaces its unscored candidate.
    if (!existing || hit.score > existing.score) {
      byKey.set(key, hit);
    }
  }
  return [...byKey.values()];
}

export function selectStrongTriggerMatches(
  message: string,
  hits: TriggerRecallHit[],
  activeProjectKeys: readonly string[] = [],
): Array<TriggerRecallHit & { matchScore: number }> {
  const scoreTriggerMatch = prepareTriggerScorer(message);
  return hits
    .filter((hit) => isEligibleMemoryEntry(hit, activeProjectKeys))
    .map((hit) => Object.assign({}, hit, { matchScore: scoreTriggerMatch(hit) }))
    .filter((hit) => hit.matchScore >= STRONG_TRIGGER_MATCH_SCORE)
    .toSorted(
      (left, right) =>
        right.matchScore - left.matchScore ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine,
    )
    .slice(0, TRIGGER_INJECTION_LIMIT);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildPromptPrefix(summary: string): string {
  return [ACTIVE_MEMORY_CONTEXT_HEADER, ACTIVE_MEMORY_OPEN_TAG, summary, ACTIVE_MEMORY_CLOSE_TAG].join("\n");
}

export function buildTriggerRecallContext(
  matches: Array<TriggerRecallHit & { matchScore: number }>,
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const summary = matches
    .map((hit) => `- ${hit.excerpt.trim()} (Source: ${hit.citation})`)
    .join("\n");
  return buildPromptPrefix(escapeXml(truncateUtf16Safe(summary, MAX_TRIGGER_CONTEXT_CHARS)));
}

export async function resolveTriggerRecall(params: {
  manager: MemorySearchManager;
  message: string;
  activeProjectKeys?: string[];
  signal?: AbortSignal;
  /** 子成员 ID：只召回共享记忆与该成员自己的记忆文件。 */
  agentId?: string;
}): Promise<{ context?: string; hasStrongHit: boolean; injectedCount: number }> {
  params.signal?.throwIfAborted();
  // Lane-1 runs on every eligible inbound message; it must stay
  // deterministic and local, so query embedding is disabled.
  const retrieved = await params.manager
    .search(params.message, {
      maxResults: TRIGGER_CANDIDATE_LIMIT,
      minScore: 0,
      sources: ["memory"],
      lexicalOnly: true,
      activeProjectKeys: [...(params.activeProjectKeys ?? [])],
      signal: params.signal,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    })
    .catch(() => []);
  const candidates = toTriggerRecallHits(retrieved);
  const matches = selectStrongTriggerMatches(params.message, candidates, params.activeProjectKeys ?? []);
  const context = buildTriggerRecallContext(matches);
  return {
    ...(context ? { context } : {}),
    hasStrongHit: matches.length > 0,
    injectedCount: matches.length,
  };
}

export { MAX_TRIGGER_CONTEXT_CHARS };
