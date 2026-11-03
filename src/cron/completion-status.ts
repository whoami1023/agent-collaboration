// Ported and adapted from OpenClaw src/cron/completion-status.ts and
// src/cron/service/jobs-scheduling.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 本项目的「投递」不是 IM channel，而是这条运行的回复有没有落到群里；
// 静默（NO_REPLY）算投递被抑制，仍算成功——与原语义一致。

import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  type CronJobState,
  type CronRunStatus,
} from "./types";
import { isFiniteTimestamp } from "./util";

export type CronDeliveryStatus = "delivered" | "not-delivered" | "not-requested";
export type CronCompletionStatus = "succeeded" | "failed" | "unknown";

export interface CronCompletionInput {
  status?: CronRunStatus;
  deliveryStatus?: CronDeliveryStatus;
  /** 静默/被抑制的原因；有它时「未投递」也算完成。 */
  deliverySuppressionReason?: string;
  /** 本次运行是否要求必须投递（命令类任务不要求）。 */
  requiredDelivery?: boolean;
}

export function resolveCronCompletionStatus(params: CronCompletionInput): CronCompletionStatus {
  if (params.status === "error" || params.status === "skipped") return "failed";
  if (params.status !== "ok") return "unknown";
  const required = params.requiredDelivery ?? params.deliveryStatus !== "not-requested";
  if (!required || params.deliveryStatus === "delivered" || params.deliveryStatus === "not-requested") {
    return "succeeded";
  }
  if (params.deliveryStatus === "not-delivered") {
    return params.deliverySuppressionReason !== undefined ? "succeeded" : "failed";
  }
  return "unknown";
}

/** 一次运行结束后的连续计数：错误与跳过互为反向，成功清零。 */
export function applyOutcomeStreaks(
  state: Pick<CronJobState, "consecutiveErrors" | "consecutiveSkipped">,
  status: CronRunStatus,
): Pick<CronJobState, "consecutiveErrors" | "consecutiveSkipped"> {
  if (status === "error") {
    return {
      consecutiveErrors: state.consecutiveErrors + 1,
      consecutiveSkipped: 0,
    };
  }
  if (status === "skipped") {
    return {
      consecutiveErrors: 0,
      consecutiveSkipped: state.consecutiveSkipped + 1,
    };
  }
  return { consecutiveErrors: 0, consecutiveSkipped: 0 };
}

/** 连续错误次数（从 1 开始）对应的重试间隔。 */
export function errorBackoffMs(
  consecutiveErrors: number,
  scheduleMs: readonly number[] = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number {
  const idx = Math.min(Math.max(0, consecutiveErrors - 1), scheduleMs.length - 1);
  return scheduleMs[idx] ?? 0;
}

/** 上一次运行以错误收尾时，下一次允许重试的最早时刻。 */
export function resolveErrorBackoffUntilMs(
  state: CronJobState,
  scheduleMs: readonly number[] = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number | undefined {
  if (state.lastRunStatus !== "error") return undefined;
  if (!isFiniteTimestamp(state.lastRunAtMs)) return undefined;
  const duration =
    typeof state.lastDurationMs === "number" && Number.isFinite(state.lastDurationMs)
      ? Math.max(0, Math.floor(state.lastDurationMs))
      : 0;
  const consecutive =
    typeof state.consecutiveErrors === "number" && Number.isFinite(state.consecutiveErrors)
      ? Math.max(0, Math.floor(state.consecutiveErrors))
      : 0;
  return state.lastRunAtMs + duration + errorBackoffMs(consecutive, scheduleMs);
}
