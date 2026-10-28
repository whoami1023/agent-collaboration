/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * - extensions/memory-core/src/memory/tokenize.ts（tokenize/jaccard/prepareSimilarityText，逐字）
 * - extensions/memory-core/src/memory/keyword-query.ts（tokenizeFtsQuery/bm25RankToScore，逐字）
 * - extensions/memory-core/src/memory/manager-search.ts（normalizeSearchTokens/literalSearchMatcher）
 * 适配：normalizeLowercaseStringOrEmpty 用本地小实现替代 @openclaw/normalization-core。
 */

const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff]/;
const CJK_RUN_RE = new RegExp(`${CJK_RE.source}+`, "g");

function normalizeLowercase(text: string): string {
  return text.trim() ? text.toLowerCase() : "";
}

// Only adjacent CJK characters form bigrams: "我喜欢hello你好" must not yield "欢你".
export function tokenize(text: string): Set<string> {
  const lower = normalizeLowercase(text).normalize("NFC");
  // Keep CJK in its existing bigram/unigram lane; word marks stay attached to a base.
  const words = lower.replace(CJK_RUN_RE, " ").match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu) ?? [];
  const tokens = new Set(words);
  const cjkRuns = lower.match(CJK_RUN_RE) ?? [];
  for (const run of cjkRuns) {
    for (let index = 1; index < run.length; index += 1) {
      tokens.add(run.slice(index - 1, index + 1));
    }
  }

  // Preserve insertion order: word tokens, then bigrams, then unigrams.
  for (const run of cjkRuns) {
    for (const char of run) {
      tokens.add(char);
    }
  }
  return tokens;
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionSize += 1;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

export type PreparedSimilarityText = {
  tokens: Set<string>;
  // Set only for token-less text, which compares by literal equality.
  emptyTokenText: string | undefined;
};

// Tokenize once so repeated comparisons against the same text skip re-tokenizing.
export function prepareSimilarityText(text: string): PreparedSimilarityText {
  const tokens = tokenize(text);
  return {
    tokens,
    emptyTokenText: tokens.size === 0 ? normalizeLowercase(text) : undefined,
  };
}

// Distinct text outside the tokenizer's alphabet must not collapse as two empty sets.
export function preparedTextSimilarity(a: PreparedSimilarityText, b: PreparedSimilarityText): number {
  if (a.tokens.size === 0 && b.tokens.size === 0) {
    return a.emptyTokenText === b.emptyTokenText ? 1 : 0;
  }
  return jaccardSimilarity(a.tokens, b.tokens);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function literalSearchMatcher(value: string, whole = false): RegExp {
  const literal = escapeRegExp(value.normalize("NFC"));
  return new RegExp(whole ? `^(?:${literal})$` : literal, "iu");
}

export function tokenizeFtsQuery(raw: string, includeLeadingMarks = false): string[] {
  const pattern = includeLeadingMarks
    ? /[\p{L}\p{M}\p{N}_]+/gu
    : /[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu;
  return (raw.match(pattern) ?? []).map((token) => token.trim()).filter(Boolean);
}

export function normalizeSearchTokens(raw: string): string[] {
  return tokenizeFtsQuery(raw.normalize("NFC"));
}

/** FTS5 bm25 rank（越负越相关）到饱和分数 (0,1) 的官方换算，逐字移植。 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

/** Okapi BM25 → 与 bm25RankToScore(rank<0) 相同的 relevance/(1+relevance) 饱和模型。
 *  适配：本项目用内存倒排索引替代 SQLite FTS5，tf/idf 用标准 Okapi 公式。 */
export function bm25RelevanceToScore(relevance: number): number {
  return relevance / (1 + relevance);
}
