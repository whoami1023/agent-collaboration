// Ported and adapted from OpenClaw src/cron/service/jobs-scheduling.ts + one-shot-schedule.ts
// + timer-runnable.ts + auto-disable.ts + schedule-maintenance.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation).
//
// 这一层只做「什么时候该跑、上一次跑成什么样、还要不要留着这个作业」的纯计算，不碰群聊也不落盘，
// 所以可以单独测。作业定义与运行状态在 OpenClaw 里是同一行的两个 JSON 列，本项目沿用同样的耦合方式：
// TimedCronJob = 定义 + 状态，由 CronService 从 CronStore 组装出来再交给这里。
//
// 有意没有移植的分支：stream / event / on-exit 三种触发（本项目没有宿主 watcher 去 raise 它们）、
// trigger 脚本与 once 语义、pacing（nextCheck 节奏合同）、forcePreservedNextRunAtMs 字段
// （它只是「借用运行保住的那次 occurrence」的落盘痕迹，这里在结算时直接按 occurrence 是否还在未来判断）、
// delivery plan 与 canonical delivery mode（本项目的投递就是「回复有没有落到群里」，归 completion-status 管）。

import { computeNextRunAtMs, computePreviousRunAtMs } from "./schedule";
import { resolveCronStaggerMs, resolveStableCronOffsetMs } from "./stagger";
import { parseAbsoluteTimeMs } from "./time";
import { isFiniteTimestamp, coerceFiniteScheduleNumber } from "./util";
import { isCronWithinActiveHours } from "./active-hours";
import { errorBackoffMs } from "./completion-status";
import { MIN_REFIRE_GAP_MS } from "./timer-constants";
import {
  DEFAULT_AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_AUTO_DISABLE_AFTER_SCHEDULE_ERRORS,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  type CronAutoDisabled,
  type CronJob,
  type CronJobState,
  type CronRunStatus,
  type CronSchedule,
} from "./types";

/** 定义 + 运行状态：调度层的唯一输入形状（对应 OpenClaw 的 CronStoredJob）。 */
export interface TimedCronJob {
  job: CronJob;
  state: CronJobState;
}

/** 时间戳可用且落在未来可调度范围内。 */
export function hasScheduledNextRunAtMs(value: unknown): value is number {
  return isFiniteTimestamp(value) && value > 0;
}

export function isJobEnabled(job: Pick<CronJob, "enabled">): boolean {
  return job.enabled !== false;
}

/** 只有 at / every / cron 三种时间调度会进入定时器（本项目也只有这三种）。 */
export function isTimeScheduledJob(job: Pick<CronJob, "schedule">): boolean {
  return job.schedule.kind === "at" || job.schedule.kind === "every" || job.schedule.kind === "cron";
}

/** 本进程里是否已有这次运行（排队或执行中）；跨进程的活跃判定由调用方补上。 */
export function hasActiveCronRun(timed: TimedCronJob, activeInProcess?: boolean): boolean {
  return (
    typeof timed.state.queuedAtMs === "number" ||
    typeof timed.state.runningAtMs === "number" ||
    activeInProcess === true
  );
}

export function normalizeConsecutiveErrors(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function resolveJobLastRunStatus(timed: TimedCronJob): CronRunStatus | undefined {
  return timed.state.lastRunStatus;
}

/** 上一次运行的结束时刻：与退避计算用同一套时长口径。 */
export function resolveJobLastRunEndedAtMs(timed: TimedCronJob): number | undefined {
  if (!isFiniteTimestamp(timed.state.lastRunAtMs)) return undefined;
  const duration =
    typeof timed.state.lastDurationMs === "number" && Number.isFinite(timed.state.lastDurationMs)
      ? Math.max(0, Math.floor(timed.state.lastDurationMs))
      : 0;
  return timed.state.lastRunAtMs + duration;
}

export function resolveJobErrorBackoffUntilMs(
  timed: TimedCronJob,
  scheduleMs: readonly number[] = DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
): number | undefined {
  if (timed.state.lastRunStatus !== "error") return undefined;
  const ended = resolveJobLastRunEndedAtMs(timed);
  if (ended === undefined) return undefined;
  return ended + errorBackoffMs(normalizeConsecutiveErrors(timed.state.consecutiveErrors), scheduleMs);
}

/** every 调度的对齐基准：显式 anchor 优先，否则退回创建时刻。 */
export function resolveEveryAnchorMs(timed: TimedCronJob, nowMs: number): number | undefined {
  if (timed.job.schedule.kind !== "every") return undefined;
  const coerced = coerceFiniteScheduleNumber(timed.job.schedule.anchorMs);
  if (coerced !== undefined) return Math.max(0, Math.floor(coerced));
  return isFiniteTimestamp(timed.job.createdAtMs) ? Math.max(0, Math.floor(timed.job.createdAtMs)) : nowMs;
}

function hasInvalidExplicitEveryAnchor(schedule: Extract<CronSchedule, { kind: "every" }>): boolean {
  if (schedule.anchorMs === undefined) return false;
  const coerced = coerceFiniteScheduleNumber(schedule.anchorMs);
  return coerced === undefined || coerced < 0;
}

/** 一次性作业在 now 之后还该不该跑：成功过就作废，改到未来时刻则重新武装。 */
export function computeOneShotNextRunAtMs(timed: TimedCronJob): number | undefined {
  if (timed.job.schedule.kind !== "at") return undefined;
  const atMs = parseAbsoluteTimeMs(timed.job.schedule.at);
  if (atMs === null || !Number.isFinite(atMs)) return undefined;
  if (timed.state.lastRunStatus === "ok" && isFiniteTimestamp(timed.state.lastRunAtMs)) {
    return atMs > timed.state.lastRunAtMs ? atMs : undefined;
  }
  return atMs;
}

/**
 * 手动借用一次运行时，那次一次性 occurrence 还值不值得保住（OpenClaw resolveManualOneShotOccurrenceAtMs）。
 * 只有排在将来才会被保住：已经到点或过期的那一次被手动跑掉就算消耗掉了。
 */
export function resolveManualOneShotOccurrenceAtMs(
  timed: TimedCronJob,
  previousNextRunAtMs: number | undefined,
  ownershipAtMs: number,
): number | undefined {
  const occurrenceAtMs = previousNextRunAtMs ?? computeOneShotNextRunAtMs(timed);
  return occurrenceAtMs !== undefined && occurrenceAtMs > ownershipAtMs
    ? occurrenceAtMs
    : undefined;
}

/**
 * 被打断的一次性任务能不能沿用原槽位（OpenClaw resolveOneShotReplacementAtMs）。
 * 比较的是那次运行的开始时刻而不是重启时刻：更新过的一次性任务可能自己都已经过期，
 * 那种情况要让它走正常的补齐，而不是把旧的槽位当成还欠着一次。
 */
export function resolveOneShotReplacementAtMs(
  timed: TimedCronJob,
  runningAtMs: number,
): number | undefined {
  const { job, state } = timed;
  if (job.schedule.kind !== "at" || !isJobEnabled(job)) return undefined;
  const nextRunAtMs = state.nextRunAtMs;
  if (!hasScheduledNextRunAtMs(nextRunAtMs) || nextRunAtMs <= runningAtMs) return undefined;
  return parseAbsoluteTimeMs(job.schedule.at) === nextRunAtMs ? nextRunAtMs : undefined;
}

function computeStaggeredCronPreviousRunAtMs(timed: TimedCronJob, nowMs: number): number | undefined {
  if (timed.job.schedule.kind !== "cron") return undefined;
  const offsetMs = resolveStableCronOffsetMs(
    timed.job.id,
    resolveCronStaggerMs(timed.job.schedule),
  );
  if (offsetMs <= 0) return computePreviousRunAtMs(timed.job.schedule, nowMs);
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const basePrevious = computePreviousRunAtMs(timed.job.schedule, cursorMs);
    if (basePrevious === undefined) return undefined;
    const shifted = basePrevious + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted <= nowMs) return shifted;
    cursorMs = Math.max(0, basePrevious - 1_000);
  }
  return undefined;
}

/** croner 的 previousRuns 是「严格早于」且按秒取整；补探一秒，把正好落在 now 的槽位也算进来。 */
export function computeJobPreviousRunAtOrBeforeMs(
  timed: TimedCronJob,
  nowMs: number,
): number | undefined {
  if (!isJobEnabled(timed.job) || timed.job.schedule.kind !== "cron") return undefined;
  const previous = computeStaggeredCronPreviousRunAtMs(timed, nowMs);
  const probeMs = nowMs + 1_000;
  if (!isFiniteTimestamp(probeMs)) return previous;
  const boundary = computeStaggeredCronPreviousRunAtMs(timed, probeMs);
  if (
    isFiniteTimestamp(boundary) &&
    boundary <= nowMs &&
    (!isFiniteTimestamp(previous) || boundary > previous)
  ) {
    return boundary;
  }
  return previous;
}

/** 下一次触发：every 续算、at 一次性归属、cron 走本作业的稳定错峰偏移。 */
export function computeJobNextRunAtMs(
  timed: TimedCronJob,
  nowMs: number,
  opts?: { preserveEveryAnchor?: boolean },
): number | undefined {
  const { job, state } = timed;
  if (!isJobEnabled(job)) return undefined;

  if (job.schedule.kind === "every") {
    if (hasInvalidExplicitEveryAnchor(job.schedule)) return undefined;
    const everyMsRaw = coerceFiniteScheduleNumber(job.schedule.everyMs);
    if (everyMsRaw === undefined) return undefined;
    const everyMs = Math.floor(everyMsRaw);
    if (everyMs < 1) return undefined;
    const anchorMs = resolveEveryAnchorMs(timed, nowMs) ?? 0;
    // 重试不能变成新的基准，否则 authored 间隔会被一次次推迟的运行悄悄改掉。
    const lastRunAtMs = opts?.preserveEveryAnchor ? undefined : state.lastRunAtMs;
    if (isFiniteTimestamp(lastRunAtMs) && lastRunAtMs >= anchorMs) {
      const nextFromLastRun = Math.floor(lastRunAtMs) + everyMs;
      if (!isFiniteTimestamp(nextFromLastRun)) return undefined;
      if (nextFromLastRun > nowMs) return nextFromLastRun;
    }
    const next = computeNextRunAtMs({ ...job.schedule, everyMs, anchorMs }, nowMs);
    return isFiniteTimestamp(next) ? next : undefined;
  }

  if (job.schedule.kind === "at") return computeOneShotNextRunAtMs(timed);

  const offsetMs = resolveStableCronOffsetMs(job.id, resolveCronStaggerMs(job.schedule));
  const next = shiftedCronNextRun(job, nowMs, offsetMs);
  if (next === undefined) {
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    const retry = shiftedCronNextRun(job, nextSecondMs, offsetMs);
    return isFiniteTimestamp(retry) ? retry : undefined;
  }
  return isFiniteTimestamp(next) ? next : undefined;
}

function shiftedCronNextRun(
  job: CronJob,
  nowMs: number,
  offsetMs: number,
): number | undefined {
  if (job.schedule.kind !== "cron") return undefined;
  if (offsetMs <= 0) return computeNextRunAtMs(job.schedule, nowMs);
  // 游标前移偏移量：本时段还没到的错峰槽位仍然够得着。
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
    if (baseNext === undefined) return undefined;
    const shifted = baseNext + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted > nowMs) return shifted;
    cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
  }
  return undefined;
}

/** 重启补齐：nextRunAtMs 已经越过上次运行，但按日历算确实漏了一个槽位。 */
export function hasMissedCronSlotSinceLastRun(timed: TimedCronJob, nowMs: number): boolean {
  const { state } = timed;
  const lastRunStatus = resolveJobLastRunStatus(timed);
  // 成功与跳过的运行已经把自己覆盖的时段算进去了，不能把那些槽位再变成新的漏跑。
  const coveredThroughMs =
    lastRunStatus === "ok" || lastRunStatus === "skipped"
      ? resolveJobLastRunEndedAtMs(timed)
      : state.lastRunAtMs;
  const lastRunAtMs = coveredThroughMs;
  const nextRunAtMs = state.nextRunAtMs;
  if (
    !isFiniteTimestamp(lastRunAtMs) ||
    (hasScheduledNextRunAtMs(nextRunAtMs) && state.startupCatchupAtMs === nextRunAtMs)
  ) {
    return false;
  }
  let previousRunAtMs: number | undefined;
  try {
    previousRunAtMs = computeJobPreviousRunAtOrBeforeMs(timed, nowMs);
  } catch {
    return false;
  }
  if (previousRunAtMs === undefined || previousRunAtMs <= lastRunAtMs) return false;
  // 刚从「编辑过的调度」算出来的槽位过去不存在，不能算漏跑（OpenClaw #91944）。
  const activatedAtMs = state.scheduleActivatedAtMs;
  if (!isFiniteTimestamp(activatedAtMs)) return true;
  return previousRunAtMs > activatedAtMs;
}

function isErrorBackoffPending(timed: TimedCronJob, nowMs: number): boolean {
  if (timed.job.schedule.kind === "at" || timed.state.lastRunStatus !== "error") return false;
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(timed);
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs;
}

/** 此刻是否该把这份作业交给运行队列（OpenClaw isRunnableJob 的裁剪版）。 */
export function isRunnableJob(params: {
  timed: TimedCronJob;
  nowMs: number;
  forced?: boolean;
  /** 一次性作业已经跑过就不再补跑（启动补齐用 false 之外的口径）。 */
  skipAtIfAlreadyRan?: boolean;
  /** 是否允许用日历回算来认定漏跑（skipMissedJobs 关掉时才是 true）。 */
  allowCronMissedRunByLastRun?: boolean;
  activeInProcess?: boolean;
}): boolean {
  const { timed, nowMs } = params;
  const { state } = timed;
  if (hasActiveCronRun(timed, params.activeInProcess)) return false;
  if (params.forced) return true;
  if (!isJobEnabled(timed.job) || !isTimeScheduledJob(timed.job)) return false;

  const next = state.nextRunAtMs;
  if (hasScheduledNextRunAtMs(next) && nowMs < next) {
    if (!params.allowCronMissedRunByLastRun || timed.job.schedule.kind !== "cron") return false;
    return hasMissedCronSlotSinceLastRun(timed, nowMs);
  }

  const lastRunStatus = resolveJobLastRunStatus(timed);
  if (params.skipAtIfAlreadyRan && timed.job.schedule.kind === "at" && lastRunStatus) {
    // 一次性作业的终态历史属于旧的那一次；只有明确武装过的槽位还能再跑。
    if (hasScheduledNextRunAtMs(next) && state.startupCatchupAtMs === next) {
      return nowMs >= next;
    }
    const atMs = parseAbsoluteTimeMs(timed.job.schedule.at);
    const lastRun = state.lastRunAtMs;
    if (
      hasScheduledNextRunAtMs(next) &&
      atMs === next &&
      (typeof lastRun !== "number" || next > lastRun)
    ) {
      return nowMs >= next;
    }
    if (lastRunStatus === "error" && hasScheduledNextRunAtMs(next)) {
      // 失败重试是运行结束时刻按退避算出来的，槽位到了就跑。
      return nowMs >= next;
    }
    return false;
  }

  if (isErrorBackoffPending(timed, nowMs)) return false;

  if (hasScheduledNextRunAtMs(next) && nowMs >= next) {
    const lastRunAtMs = state.lastRunAtMs;
    const alreadyCompletedDueCronSlot =
      params.allowCronMissedRunByLastRun &&
      timed.job.schedule.kind === "cron" &&
      (lastRunStatus === "ok" || lastRunStatus === "skipped") &&
      isFiniteTimestamp(lastRunAtMs) &&
      lastRunAtMs >= next;
    if (!alreadyCompletedDueCronSlot) return true;
    let latestRunAtMs: number | undefined;
    try {
      latestRunAtMs = computeJobPreviousRunAtOrBeforeMs(timed, nowMs);
    } catch {
      return false;
    }
    const lastEndedAtMs = resolveJobLastRunEndedAtMs(timed) ?? lastRunAtMs;
    return latestRunAtMs !== undefined && latestRunAtMs > (lastEndedAtMs ?? 0);
  }
  return false;
}

/** 此刻是否落在作业的活跃时段内（无配置视为永远活跃）。 */
export function isWithinActiveHours(
  timed: TimedCronJob,
  nowMs: number,
  userTimezone?: string,
): boolean {
  return isCronWithinActiveHours(timed.job.activeHours, nowMs, userTimezone);
}

/** 下一次运行时刻；算不出来（表达式非法、一次性已消耗）时按 OpenClaw 的口径清掉调度字段。 */
export function recomputeJobNextRunAtMs(
  timed: TimedCronJob,
  nowMs: number,
): { changed: boolean; nextRunAtMs?: number; scheduleError?: string } {
  const before = timed.state.nextRunAtMs;
  try {
    let next = computeJobNextRunAtMs(timed, nowMs);
    if (
      timed.job.schedule.kind !== "at" &&
      resolveJobLastRunStatus(timed) === "error" &&
      isFiniteTimestamp(timed.state.lastRunAtMs)
    ) {
      // 退避是地板：自然槽位再早也不能提前重试。
      const floor = resolveJobErrorBackoffUntilMs(timed);
      if (next !== undefined && floor !== undefined) next = Math.max(next, floor);
    }
    const scheduleError =
      next === undefined && isJobEnabled(timed.job) && timed.job.schedule.kind !== "at"
        ? `无法计算下一次触发时间：${describeSchedule(timed.job.schedule)}`
        : undefined;
    timed.state.nextRunAtMs = next;
    // 算出来了就清零错误计数（OpenClaw），但这一轮自己记了错就不能清：否则计数永远凑不满停用阈值。
    let clearedErrorCount = false;
    if (scheduleError === undefined && timed.state.scheduleErrorCount !== 0) {
      timed.state.scheduleErrorCount = 0;
      clearedErrorCount = true;
    }
    return {
      changed: before !== next || clearedErrorCount,
      nextRunAtMs: next,
      scheduleError,
    };
  } catch (err) {
    timed.state.nextRunAtMs = undefined;
    return {
      changed: before !== undefined,
      scheduleError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function describeSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "at") return `一次性，${schedule.at}`;
  if (schedule.kind === "every") return `每 ${Math.round(schedule.everyMs / 1000)} 秒`;
  return `cron「${schedule.expr}」${schedule.tz ? `（${schedule.tz}）` : ""}`;
}

/** 调度连续算不出来的作业要被停用（OpenClaw MAX_SCHEDULE_ERRORS）。 */
export function shouldAutoDisableScheduleErrors(timed: TimedCronJob): boolean {
  return (
    normalizeConsecutiveErrors(timed.state.scheduleErrorCount) >=
    DEFAULT_AUTO_DISABLE_AFTER_SCHEDULE_ERRORS
  );
}

/** 运行连续失败的停用判定：只有周期性作业会中招，一次性作业失败直接停用而不是计数。 */
export function shouldAutoDisableAfterRunFailure(timed: TimedCronJob): boolean {
  const kind = timed.job.schedule.kind;
  if (kind !== "cron" && kind !== "every") return false;
  return (
    normalizeConsecutiveErrors(timed.state.consecutiveErrors) >=
    DEFAULT_AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES
  );
}

export function buildAutoDisabled(
  reason: CronAutoDisabled["reason"],
  atMs: number,
  consecutiveErrors: number,
): CronAutoDisabled {
  return { reason, atMs, consecutiveErrors: normalizeConsecutiveErrors(consecutiveErrors) };
}

/** 重启打断的那次运行之后，最早可以重试的时刻（不消耗原槽位，也不立刻重放）。 */
export function resolveCronRestartRetryAtMs(
  timed: TimedCronJob,
  startedAtMs: number,
  nowMs: number,
): number | undefined {
  const { job } = timed;
  if (!isJobEnabled(job) || job.payload.kind !== "agentTurn") return undefined;
  const delay =
    job.schedule.kind === "at" ? MIN_REFIRE_GAP_MS : errorBackoffMs(normalizeConsecutiveErrors(timed.state.consecutiveErrors));
  return Math.max(nowMs, startedAtMs) + delay;
}

/** 持久化的未来槽位比自然槽位晚一整个周期以上：编辑/回算留下的僵尸时刻，要重算。 */
function isStaleFutureCronSlot(timed: TimedCronJob, nowMs: number): boolean {
  const nextRun = timed.state.nextRunAtMs;
  if (
    timed.job.schedule.kind !== "cron" ||
    !hasScheduledNextRunAtMs(nextRun) ||
    nowMs >= nextRun ||
    typeof timed.state.queuedAtMs === "number" ||
    typeof timed.state.runningAtMs === "number" ||
    timed.state.startupCatchupAtMs === nextRun
  ) {
    return false;
  }
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(timed);
  if (backoffUntilMs !== undefined && nowMs < backoffUntilMs && nextRun <= backoffUntilMs) {
    return false;
  }
  let naturalNext: number | undefined;
  try {
    naturalNext = computeJobNextRunAtMs(timed, nowMs);
  } catch {
    return false;
  }
  if (!isFiniteTimestamp(naturalNext) || naturalNext === nextRun) return false;
  let isScheduledSlot = false;
  try {
    isScheduledSlot = computeJobPreviousRunAtOrBeforeMs(timed, nextRun) === nextRun;
  } catch {
    return false;
  }
  if (isScheduledSlot || nextRun < naturalNext) return false;
  let followingNaturalNext: number | undefined;
  try {
    followingNaturalNext = computeJobNextRunAtMs(timed, naturalNext);
  } catch {
    return false;
  }
  if (!isFiniteTimestamp(followingNaturalNext)) return false;
  const naturalIntervalMs = followingNaturalNext - naturalNext;
  return naturalIntervalMs > 0 && nextRun >= followingNaturalNext + naturalIntervalMs;
}

/** 是否需要定时器维护（缺 nextRun、未来槽位不合法）。 */
export function needsTimerMaintenance(timed: TimedCronJob, nowMs: number): boolean {
  if (!isJobEnabled(timed.job)) {
    return (
      timed.state.nextRunAtMs !== undefined ||
      timed.state.startupCatchupAtMs !== undefined ||
      timed.state.queuedAtMs !== undefined ||
      timed.state.runningAtMs !== undefined
    );
  }
  if (hasActiveCronRun(timed)) return false;
  if (!hasScheduledNextRunAtMs(timed.state.nextRunAtMs)) return true;
  return isStaleFutureCronSlot(timed, nowMs);
}
