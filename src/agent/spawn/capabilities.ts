// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/subagents/spawn/subagent-capabilities.ts (resolveSubagentCapabilities),
// MIT licensed (Copyright (c) 2026 OpenClaw Foundation).

import {
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  isSubagentSpawnDepthAllowed,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "./agent-limits";

export type SubagentRole = "main" | "orchestrator" | "leaf";
export type SubagentControlScope = "children" | "none";

function normalizeSubagentRole(value: unknown): SubagentRole | undefined {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed === "main" || trimmed === "orchestrator" || trimmed === "leaf"
    ? (trimmed as SubagentRole)
    : undefined;
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed === "children" || trimmed === "none" ? (trimmed as SubagentControlScope) : undefined;
}

/**
 * Ported verbatim: depth 0 → main; within the spawn-depth cap → orchestrator
 * (may delegate descendants); at/over the cap → leaf (cannot spawn).
 * Leaf loses the children control scope.
 */
export function resolveSubagentCapabilities(params: { depth: number; maxSpawnDepth?: number }): {
  depth: number;
  role: SubagentRole;
  controlScope: SubagentControlScope;
} {
  const depth = resolveNonNegativeIntegerOption(params.depth, 0);
  const maxSpawnDepth = resolveIntegerOption(params.maxSpawnDepth, DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH, {
    min: 1,
  });
  const role: SubagentRole =
    depth <= 0
      ? "main"
      : isSubagentSpawnDepthAllowed(depth, maxSpawnDepth)
        ? "orchestrator"
        : "leaf";
  const controlScope: SubagentControlScope = role === "leaf" ? "none" : "children";
  return { depth, role, controlScope };
}

export { normalizeSubagentRole, normalizeSubagentControlScope };
