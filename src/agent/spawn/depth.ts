// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/subagents/spawn/subagent-depth-policy.ts, MIT licensed (Copyright (c) 2026 OpenClaw Foundation).

import { resolveNonNegativeIntegerOption } from "./agent-limits";

export interface DepthEntry {
  depth?: unknown;
  spawnedBy?: unknown;
}

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = /^\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : undefined;
    return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Ported getSubagentDepthFromEntryLookup: prefers the stored depth, otherwise
 * follows the spawnedBy lineage chain one parent at a time. The visited set
 * guards against malformed parent cycles.
 */
export function getDepthFromEntryLookup(
  memberKey: string | undefined | null,
  resolveEntry: (memberKey: string) => DepthEntry | undefined,
): number {
  const raw = (memberKey ?? "").trim();
  if (!raw) return 0;

  const visited = new Set<string>();

  const depthFromStore = (key: string): number | undefined => {
    const normalizedKey = key.trim();
    if (!normalizedKey || visited.has(normalizedKey)) return undefined;
    visited.add(normalizedKey);

    const entry = resolveEntry(normalizedKey);
    const storedDepth = normalizeSpawnDepth(entry?.depth);
    if (storedDepth !== undefined) return storedDepth;

    // 只有 spawnedBy 承载血缘；其它指向父级的链接不参与深度计算。
    const parentKey = typeof entry?.spawnedBy === "string" ? entry.spawnedBy.trim() : "";
    if (!parentKey) return undefined;

    return (depthFromStore(parentKey) ?? 0) + 1;
  };

  return depthFromStore(raw) ?? 0;
}

/** Ported classification: a session is a subagent iff lineage depth > 0. */
export function isSubagentFromEntry(
  entry: DepthEntry | null | undefined,
): boolean {
  const depth = normalizeSpawnDepth(entry?.depth);
  return depth === undefined
    ? typeof entry?.spawnedBy === "string" && entry.spawnedBy.trim() !== ""
    : depth > 0;
}

/** 与 OpenClaw resolveNonNegativeIntegerOption 一致地收敛深度输入。 */
export function clampDepth(depth: number): number {
  return resolveNonNegativeIntegerOption(depth, 0);
}
