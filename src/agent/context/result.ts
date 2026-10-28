// Result and compaction error taxonomy.
// Ported from OpenClaw packages/agent-core/src/harness/types.ts (MIT License —
// Copyright (c) 2026 OpenClaw Foundation), reduced to the compaction variants
// reachable on this seam.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}

export type CompactionErrorKind =
  | "aborted"
  | "summarization_failed"
  | "summary_provider_error"
  | "summary_output_budget"
  | "invalid_summary_output"
  | "invalid_session";

export class CompactionError extends Error {
  constructor(
    readonly kind: CompactionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CompactionError";
  }
}

export class SummaryProviderError extends CompactionError {
  constructor(message: string) {
    super("summary_provider_error", message);
    this.name = "SummaryProviderError";
  }
}

export class SummaryOutputBudgetError extends CompactionError {
  constructor(message: string) {
    super("summary_output_budget", message);
    this.name = "SummaryOutputBudgetError";
  }
}

export class InvalidSummaryOutputError extends CompactionError {
  constructor(message: string) {
    super("invalid_summary_output", message);
    this.name = "InvalidSummaryOutputError";
  }
}
