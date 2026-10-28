// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/spawn-plan.ts (resolveSpawnAdmission 部分),
// MIT licensed (Copyright (c) 2026 OpenClaw Foundation).

import type { Member } from "../../core/types";
import { DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT, DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "./agent-limits";
import { resolveChildAdmission, type ChildAdmissionCap } from "./child-admission";
import { resolveSubagentCapabilities } from "./capabilities";

export interface SpawnAdmissionLimits {
  maxSpawnDepth?: number;
  maxChildrenPerAgent?: number;
}

export type SpawnAdmission =
  | { ok: true; maxSpawnDepth: number; childSessionPatch: { depth: number; controlScope: "children" | "none" } }
  | { ok: false; governingCap?: ChildAdmissionCap; error: string };

/**
 * Ported resolveSpawnAdmission (subagent branch): caller depth vs spawn-depth
 * cap, then active-children cap for the controller session, then the child's
 * capability patch (persisted depth + control scope).
 */
export function resolveSpawnAdmission(params: {
  callerDepth: number;
  limits: SpawnAdmissionLimits;
  activeChildren: number;
  additionalActiveChildren?: number;
}): SpawnAdmission {
  const maxSpawnDepth = params.limits.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const childAdmission = resolveChildAdmission({
    callerDepth: params.callerDepth,
    maxSpawnDepth,
    collect: false,
    activeChildren: params.activeChildren + (params.additionalActiveChildren ?? 0),
    maxActiveChildren: params.limits.maxChildrenPerAgent ?? DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  });
  if (!childAdmission.ok) {
    return childAdmission;
  }
  const capabilities = resolveSubagentCapabilities({ depth: params.callerDepth + 1, maxSpawnDepth });
  return {
    ok: true,
    maxSpawnDepth,
    childSessionPatch: {
      depth: capabilities.depth,
      controlScope: capabilities.role === "leaf" ? "none" : "children",
    },
  };
}

/** 活跃子成员口径：存在且未取消（注册表 active-runs 在本项目中的等价物）。 */
export function countChildren(busMembers: Member[], parentId: string): number {
  return busMembers.filter((member) => member.spawnedBy === parentId && member.status !== "cancelled")
    .length;
}
