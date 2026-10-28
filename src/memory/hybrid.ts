/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * extensions/memory-core/src/memory/hybrid.ts —— 合并/选择算法逐字移植。
 * 适配：源类型收敛为 "memory" | "sessions"；多模态路径降权（isNonTextMediaPath）与
 * provenance/extraPaths 参数不在本项目移植范围，已去除，其余分支保留原语义。
 */

import type { MemorySource, TemporalDecayConfig } from "./temporal-decay";
import { applyTemporalDecayToHybridResults } from "./temporal-decay";
import { applyMMRToHybridResults, type MMRConfig } from "./mmr";
import {
  applyRetrievalRanking,
  hasValidProjectAnnotation,
  prepareActiveProjectKeys,
  projectScoreMultiplier,
} from "./project-ranking";

type ExactPathSpecificity = 0 | 1 | 2 | 3;

export type HybridSearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore: number;
  textScore: number;
  snippet: string;
  source: MemorySource;
  importance?: number;
  triggers?: string;
  projectKey?: string;
};

type RankedHybridResult = HybridSearchResult & {
  eligibilityScore: number;
};

type HybridCandidate = Omit<HybridSearchResult, "score" | "vectorScore" | "textScore"> & {
  id: string;
  exactPathSpecificity?: ExactPathSpecificity;
};

type HybridVectorResult = HybridCandidate & { vectorScore: number };

type HybridKeywordResult = HybridCandidate & {
  textScore: number;
  hasBodyMatch?: boolean;
  rankingScore?: number;
  pathScore?: number;
};

export function scoreExactPathTieForTemporalDecay(contentScore: number): number {
  return (1 + Math.max(0, Math.min(1, contentScore))) / 2;
}

// BM25 keyword scores saturate as relevance / (1 + relevance), and every chunk
// outside the keyword window scores 0, so a fixed text weight mostly rewards
// window membership. Undo the saturation and measure each keyword hit against
// the query's strongest one, which may earn up to the best vector score; no hit
// gains credit. A score of 1 has no finite relevance (unranked filename
// substring match), so it counts as the strongest.
function createKeywordScoreScale(keywordScores: number[], bestVectorScore: number) {
  if (bestVectorScore === 0) {
    return (score: number) => score;
  }
  const relevance = (score: number) => score / (1 - score);
  const strongest = Math.max(0, ...keywordScores.filter((score) => score < 1).map(relevance));
  return (score: number) => {
    if (score <= 0) {
      return score;
    }
    const share = score >= 1 ? 1 : relevance(score) / strongest;
    return Math.min(score, share * bestVectorScore);
  };
}

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  memorySourceMtimes?: ReadonlyMap<string, number | undefined>;
  mmr: MMRConfig;
  temporalDecay: TemporalDecayConfig;
  activeProjectKeys?: readonly string[];
  nowMs?: number;
}): Promise<RankedHybridResult[]> {
  const { mmr: mmrConfig, temporalDecay: temporalDecayConfig } = params;
  const createCandidate = (r: HybridCandidate) => ({
    ...r,
    vectorScore: 0,
    textScore: 0,
    rankingScore: 0,
    pathScore: 0,
    exactPathSpecificity: r.exactPathSpecificity ?? 0,
    hasBodyMatch: false,
    hasVector: false,
    hasKeyword: false,
  });
  const byId = new Map<string, ReturnType<typeof createCandidate>>();

  for (const r of params.vector) {
    byId.set(r.id, {
      ...createCandidate(r),
      vectorScore: r.vectorScore,
      hasVector: true,
    });
  }

  for (const r of params.keyword) {
    const exactPathSpecificity = r.exactPathSpecificity ?? 0;
    const existing = byId.get(r.id) ?? createCandidate(r);
    existing.textScore = r.textScore;
    existing.hasBodyMatch = r.hasBodyMatch ?? r.textScore > 0;
    existing.rankingScore = r.rankingScore ?? r.textScore;
    existing.pathScore = r.pathScore ?? 0;
    existing.exactPathSpecificity = Math.max(
      existing.exactPathSpecificity,
      exactPathSpecificity,
    ) as ExactPathSpecificity;
    existing.hasKeyword = true;
    existing.importance ??= r.importance;
    existing.triggers ??= r.triggers;
    existing.projectKey ??= r.projectKey;
    if (r.snippet && r.snippet.length > 0) {
      existing.snippet = r.snippet;
    }
    byId.set(r.id, existing);
  }

  // Chunks that never reach results must not set the keyword scale either.
  const candidates = Array.from(byId.values()).filter(hasValidProjectAnnotation);
  // Exact specificity already carries path precedence. Keep body scores as
  // the within-tier signal, and use path BM25 only for partial path-only hits.
  const keywordScoreOf = (entry: (typeof candidates)[number]) =>
    entry.textScore > 0 ? entry.rankingScore : entry.exactPathSpecificity > 0 ? 0 : entry.pathScore;
  const scaleKeywordScore = createKeywordScoreScale(
    candidates.map(keywordScoreOf),
    params.vectorWeight > 0 ? Math.max(0, ...candidates.map((entry) => entry.vectorScore)) : 0,
  );
  const merged = candidates.map((entry) => {
    const keywordScore = scaleKeywordScore(keywordScoreOf(entry));
    const contentScore = params.vectorWeight * entry.vectorScore + params.textWeight * keywordScore;
    // LIKE recall has no BM25 confidence. Weight its private ranking signal
    // through the same passes, then restore public confidence before selection.
    const lexicalRank = entry.hasBodyMatch && entry.textScore === 0 ? entry.rankingScore : 0;
    // With decay enabled, reserve the lower half of an exact tier for path
    // identity and the upper half for content relevance. This lets recency beat
    // a stale cap-selected content hit. Otherwise retain the established score.
    const rankingScore =
      entry.exactPathSpecificity > 0
        ? temporalDecayConfig.enabled
          ? scoreExactPathTieForTemporalDecay(contentScore)
          : contentScore > 0
            ? contentScore
            : 1
        : contentScore === 0
          ? lexicalRank
          : contentScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: rankingScore,
      vectorScore: entry.vectorScore,
      textScore: entry.textScore,
      exactPathSpecificity: entry.exactPathSpecificity,
      contentScore,
      lexicalRank,
      snippet: entry.snippet,
      source: entry.source,
      importance: entry.importance,
      triggers: entry.triggers,
      projectKey: entry.projectKey,
    };
  });

  const activeProjects = prepareActiveProjectKeys(params.activeProjectKeys);
  // Eligibility keeps importance and project affinity, but never ages out.
  const weighted = applyRetrievalRanking(merged, activeProjects).map((entry) =>
    Object.assign(entry, {
      eligibilityScore:
        entry.exactPathSpecificity > 0
          ? projectScoreMultiplier(entry.projectKey, activeProjects)
          : entry.contentScore === 0
            ? 0
            : entry.score,
    }),
  );
  const decayed = await applyTemporalDecayToHybridResults({
    results: weighted,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
    sessionSourceMtimes: params.sessionSourceMtimes,
    memorySourceMtimes: params.memorySourceMtimes,
    nowMs: params.nowMs,
  });
  const rankable = decayed.map((entry) => {
    // Exact tiers and recall-only LIKE hits keep their public confidence;
    // their private ranking score still includes every weighting pass.
    const rankingScore = entry.score;
    return Object.assign(entry, {
      rankingScore,
      score:
        entry.exactPathSpecificity > 0
          ? projectScoreMultiplier(entry.projectKey, activeProjects)
          : entry.contentScore === 0
            ? 0
            : entry.score,
    });
  });
  const compareRankingScores = (a: (typeof rankable)[number], b: (typeof rankable)[number]) =>
    b.rankingScore - a.rankingScore ||
    b.lexicalRank - a.lexicalRank ||
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine;
  const nonExact = rankable
    .filter((entry) => entry.exactPathSpecificity === 0)
    .sort((a, b) => b.score - a.score || compareRankingScores(a, b));

  const rerankExactGroup = (entries: typeof rankable) => {
    if (!mmrConfig.enabled) {
      return entries;
    }
    return applyMMRToHybridResults(
      entries.map((entry) => Object.assign(entry, { score: entry.rankingScore })),
      mmrConfig.lambda,
    ).map((entry) =>
      Object.assign(entry, {
        score: projectScoreMultiplier(entry.projectKey, activeProjects),
      }),
    );
  };
  const exact = ([3, 2, 1] as const).flatMap((specificity) => {
    const tier = rankable
      .filter((entry) => entry.exactPathSpecificity === specificity)
      .sort(compareRankingScores);
    if (temporalDecayConfig.enabled) {
      return rerankExactGroup(tier);
    }
    const contentBacked = tier.filter((entry) => entry.contentScore > 0 || entry.lexicalRank > 0);
    const pathOnly = tier.filter((entry) => !(entry.contentScore > 0) && entry.lexicalRank === 0);
    return rerankExactGroup(contentBacked).concat(rerankExactGroup(pathOnly));
  });
  const ranked = [
    ...exact,
    ...(mmrConfig.enabled ? applyMMRToHybridResults(nonExact, mmrConfig.lambda) : nonExact),
  ];

  return ranked.map(
    ({
      exactPathSpecificity: _exactPathSpecificity,
      rankingScore: _rankingScore,
      contentScore: _contentScore,
      lexicalRank: _lexicalRank,
      ...entry
    }) => entry,
  );
}

type HybridResultRange = Pick<HybridSearchResult, "source" | "path" | "startLine" | "endLine">;

function hybridResultRangeKey(entry: HybridResultRange): string {
  return `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`;
}

export function selectHybridSearchResults(params: {
  merged: RankedHybridResult[];
  keyword: HybridResultRange[];
  vectorCandidates: HybridResultRange[];
  maxResults: number;
  minScore: number;
}): HybridSearchResult[] {
  const strict = params.merged.filter((entry) => entry.eligibilityScore >= params.minScore);
  const selected = strict.slice(0, params.maxResults);
  if (params.keyword.length === 0 || selected.length === params.maxResults) {
    return selected.map(({ eligibilityScore: _eligibilityScore, ...entry }) => entry);
  }

  const keywordKeys = new Set(params.keyword.map((entry) => hybridResultRangeKey(entry)));
  const isLexicalCandidate = (entry: RankedHybridResult) =>
    entry.eligibilityScore >= 0 && keywordKeys.has(hybridResultRangeKey(entry));
  if (strict.length === 0) {
    // Preserve the established all-lexical fallback when every weighted score
    // is below the configured threshold.
    return params.merged
      .filter(isLexicalCandidate)
      .slice(0, params.maxResults)
      .map(({ eligibilityScore: _eligibilityScore, ...entry }) => entry);
  }

  // Score completion does not turn a keyword-only candidate into a vector
  // candidate. Preserve its spare-capacity eligibility after enrichment.
  const vectorKeys = new Set(params.vectorCandidates.map(hybridResultRangeKey));
  const seen = new Set(selected.map((entry) => hybridResultRangeKey(entry)));
  for (const entry of params.merged) {
    if (selected.length === params.maxResults) {
      break;
    }
    const key = hybridResultRangeKey(entry);
    if (
      entry.eligibilityScore < params.minScore &&
      (entry.vectorScore === 0 || !vectorKeys.has(key)) &&
      isLexicalCandidate(entry) &&
      !seen.has(key)
    ) {
      seen.add(key);
      selected.push(entry);
    }
  }
  return selected.map(({ eligibilityScore: _eligibilityScore, ...entry }) => entry);
}
