// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/subagents/spawn/subagent-spawn.types.ts, MIT licensed (Copyright (c) 2026 OpenClaw Foundation).

// Shared spawn mode enums used by the spawn tool, orchestrator, and announce
// delivery code. Keep these narrow so tool schemas and persisted rows agree.
export const SPAWN_MODES = ["run", "session"] as const;
export type SpawnMemberMode = (typeof SPAWN_MODES)[number];

/** Prompt context relationship between the parent session and spawned child. */
export const SPAWN_CONTEXT_MODES = ["isolated", "fork"] as const;
export type SpawnMemberContextMode = (typeof SPAWN_CONTEXT_MODES)[number];

/** Completion delivery semantics, ported from SubagentCompletionMode. */
export const COMPLETION_MODES = ["collector", "quiet", "thread-direct", "announce"] as const;
export type MemberCompletionMode = (typeof COMPLETION_MODES)[number];
