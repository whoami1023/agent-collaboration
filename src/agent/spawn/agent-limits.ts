// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/config/agent-limits.ts, which is MIT licensed:
// Copyright (c) 2026 OpenClaw Foundation
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED. See the LICENSE file in the original repository for the full text.

import os from "node:os";

/**
 * Ported floor/clamp helper from @openclaw/normalization-core number-coercion.
 * Floors finite values and clamps to at least `min`; non-finite yields undefined.
 */
export function resolveOptionalIntegerOption(value: unknown, opts?: { min?: number }): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  if (opts?.min !== undefined) return Math.max(opts.min, floored);
  return floored;
}

export function resolveIntegerOption(value: unknown, fallback: number, opts?: { min?: number }): number {
  return resolveOptionalIntegerOption(value, opts) ?? fallback;
}

export function resolveNonNegativeIntegerOption(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

export function parseStrictNonNegativeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const MIN_AGENT_MAX_CONCURRENT = 8;
const AGENT_RUNS_PER_CPU = 4;
let defaultAgentMaxConcurrent: number | undefined;

/** Ported: top-level concurrency default scales with available parallelism. */
export function resolveDefaultAgentMaxConcurrent(): number {
  if (defaultAgentMaxConcurrent === undefined) {
    defaultAgentMaxConcurrent = Math.max(
      MIN_AGENT_MAX_CONCURRENT,
      os.availableParallelism() * AGENT_RUNS_PER_CPU,
    );
  }
  return defaultAgentMaxConcurrent;
}

/** Default maximum concurrent child-agent runs per immediate spawning/controller session. */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5;
export const DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES = 60;
// Allow recursive delegation by default while bounding each spawn lineage.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 5;

export function isSubagentSpawnDepthAllowed(
  depth: number,
  maxSpawnDepth = DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
): boolean {
  return depth < maxSpawnDepth;
}

/** Resolves top-level agent concurrency, flooring finite values and clamping to at least one. */
export function resolveAgentMaxConcurrent(maxConcurrent?: number): number {
  return resolveOptionalIntegerOption(maxConcurrent, { min: 1 }) ?? resolveDefaultAgentMaxConcurrent();
}

/** Resolves per-session subagent concurrency, flooring finite values and clamping to at least one. */
export function resolveSubagentMaxConcurrent(maxConcurrent?: number): number {
  return resolveOptionalIntegerOption(maxConcurrent, { min: 1 }) ?? DEFAULT_SUBAGENT_MAX_CONCURRENT;
}
