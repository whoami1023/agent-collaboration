/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * extensions/memory-core/src/memory/project-ranking.ts —— 逐字移植
 * （INVALID_PROJECT_ANNOTATION_KEY 换为本地 annotations 模块）。
 */

import { INVALID_PROJECT_ANNOTATION_KEY } from "./annotations";

type ProjectRankable = {
  score: number;
  importance?: number;
  projectKey?: string;
};

export function prepareActiveProjectKeys(
  activeProjectKeys: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  return activeProjectKeys?.length ? new Set(activeProjectKeys) : undefined;
}

export function projectScoreMultiplier(
  projectKey: string | null | undefined,
  activeProjectKeys: ReadonlySet<string> | undefined,
): number {
  if (!projectKey || !activeProjectKeys || activeProjectKeys.size === 0) {
    return 1;
  }
  const stored = projectKey
    .split(";")
    .map((key) => key.trim())
    .filter(Boolean);
  return stored.every((key) => activeProjectKeys.has(key)) ? 1.15 : 0.9;
}

/** Chunks with a malformed project annotation never reach retrieval results. */
export function hasValidProjectAnnotation(entry: { projectKey?: string }): boolean {
  return !entry.projectKey
    ?.split(";")
    .map((key) => key.trim())
    .includes(INVALID_PROJECT_ANNOTATION_KEY);
}

export function applyRetrievalRanking<T extends ProjectRankable>(
  results: readonly T[],
  activeProjectKeys?: ReadonlySet<string>,
): T[] {
  return results.filter(hasValidProjectAnnotation).map((entry) => {
    const importance = entry.importance;
    const multiplier =
      importance === null || importance === undefined
        ? 1
        : 0.75 + Math.max(1, Math.min(10, Math.floor(importance))) * 0.05;
    return Object.assign({}, entry, {
      score: entry.score * multiplier * projectScoreMultiplier(entry.projectKey, activeProjectKeys),
    });
  });
}
