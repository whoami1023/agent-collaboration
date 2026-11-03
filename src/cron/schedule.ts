// Ported from OpenClaw src/cron/schedule.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 同一个库（croner）、同样的有界表达式缓存、同样的 DST 折叠/空洞处理与年份回退兜底。
// 只去掉 on-exit / stream / event 三种事件触发调度：本项目没有宿主 watcher 去 raise 它们。

import { Cron, CronDate } from "croner";
import type { CronSchedule } from "./types";
import {
  asDateTimestampMs,
  coerceFiniteScheduleNumber,
  isFiniteTimestamp,
  pruneMapToMaxSize,
} from "./util";
import { parseAbsoluteTimeMs, parseOffsetlessIsoDateTimeInTimeZone } from "./time";

const CRON_EVAL_CACHE_MAX = 512;
const DAY_MS = 86_400_000;
const cronEvalCache = new Map<string, Cron>();
const cronTimezoneFormatters = new WeakMap<Cron, Intl.DateTimeFormat>();

function resolveCronTimezone(tz?: string): string {
  const trimmed = tz?.trim() ?? "";
  return trimmed || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function resolveCachedCron(expr: string, timezone: string): Cron {
  const key = `${timezone}\u0000${expr}`;
  const cached = cronEvalCache.get(key);
  if (cached) {
    // 命中即移到迭代顺序末尾，让有界缓存表现成 LRU。
    cronEvalCache.delete(key);
    cronEvalCache.set(key, cached);
    return cached;
  }
  // 表达式解析很贵，保留最近提升过的条目。
  pruneMapToMaxSize(cronEvalCache, CRON_EVAL_CACHE_MAX - 1);
  const next = new Cron(expr, { timezone, catch: false });
  cronEvalCache.set(key, next);
  return next;
}

function resolveCronFromSchedule(schedule: CronSchedule): { cron: Cron; timezone: string } | undefined {
  if (schedule.kind !== "cron" || typeof schedule.expr !== "string") {
    throw new Error("定时调度不合法：缺少 expr");
  }
  const expr = schedule.expr.trim();
  if (!expr) return undefined;
  const timezone = resolveCronTimezone(schedule.tz);
  return { cron: resolveCachedCron(expr, timezone), timezone };
}

/** 候选时刻附近是否存在时区偏移变化（决定是否要走 DST 校正）。 */
function hasNearbyCronTimezoneTransition(
  cron: Cron,
  timezone: string,
  nowMs: number,
  candidateMs: number,
): boolean {
  let formatter = cronTimezoneFormatters.get(cron);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    cronTimezoneFormatters.set(cron, formatter);
  }
  const resolved = formatter;
  const readOffset = (instantMs: number) =>
    resolved
      .formatToParts(new Date(instantMs))
      .find((part) => part.type === "timeZoneName")?.value;
  const currentOffset = readOffset(nowMs);
  const candidateOffset = readOffset(candidateMs);
  return (
    currentOffset !== candidateOffset ||
    currentOffset !== readOffset(nowMs - DAY_MS) ||
    candidateOffset !== readOffset(candidateMs - DAY_MS)
  );
}

/** 把某个瞬间在目标时区里的墙上时间投影成一个「假 UTC」毫秒，便于按日历比较。 */
function resolveCronWallTimeMs(instantMs: number, timezone: string): number {
  const local = new CronDate(new Date(instantMs), timezone);
  return Date.UTC(local.year, local.month, local.day, local.hour, local.minute, local.second, local.ms);
}

/** 目标时区里的那段墙上时间，第一次真实出现的时刻。 */
function resolveFirstCronOccurrenceMs(instantMs: number, timezone: string): number | undefined {
  const wallTime = new Date(resolveCronWallTimeMs(instantMs, timezone)).toISOString().slice(0, -1);
  const resolved = parseOffsetlessIsoDateTimeInTimeZone(wallTime, timezone);
  return resolved.ok ? Date.parse(resolved.iso) : undefined;
}

function matchesCronOccurrence(cron: Cron, instant: Date): boolean {
  return cron.match(instant);
}

/** 二分找出 [first,last] 之间的时区偏移切换点（秒级）。 */
function findCronTimezoneTransitionMs(
  firstMs: number,
  lastMs: number,
  timezone: string,
): number | undefined {
  let beforeSeconds = Math.floor(Math.min(firstMs, lastMs) / 1_000);
  let afterSeconds = Math.floor(Math.max(firstMs, lastMs) / 1_000);
  const offsetAt = (seconds: number) =>
    resolveCronWallTimeMs(seconds * 1_000, timezone) - seconds * 1_000;
  const previousOffsetMs = offsetAt(beforeSeconds);
  const nextOffsetMs = offsetAt(afterSeconds);
  if (previousOffsetMs === nextOffsetMs) return undefined;
  while (afterSeconds - beforeSeconds > 1) {
    const middleSeconds = Math.floor((beforeSeconds + afterSeconds) / 2);
    if (offsetAt(middleSeconds) === previousOffsetMs) {
      beforeSeconds = middleSeconds;
    } else {
      afterSeconds = middleSeconds;
    }
  }
  return afterSeconds * 1_000;
}

/** 从切换点出发，找到该点之后第一个真正存在的 cron  occurrence。 */
function resolveCronRunAtTransitionMs(
  cron: Cron,
  transitionMs: number,
  timezone: string,
): number | undefined {
  let transition = new Date(transitionMs);
  // croner 的年份上限给这个搜索画了界：历史时区政策可能让连续若干年的 occurrence 都不存在。
  for (;;) {
    const candidate = matchesCronOccurrence(cron, transition) ? transition : cron.nextRun(transition);
    if (!candidate) return undefined;
    if (matchesCronOccurrence(cron, candidate)) {
      return resolveFirstCronOccurrenceMs(candidate.getTime(), timezone);
    }
    const candidateMs = candidate.getTime();
    const nextTransitionMs = findCronTimezoneTransitionMs(candidateMs - DAY_MS, candidateMs, timezone);
    if (nextTransitionMs === undefined || nextTransitionMs <= transition.getTime()) return undefined;
    transition = new Date(nextTransitionMs);
  }
}

function resolveNextCronOccurrenceMs(
  cron: Cron,
  nowMs: number,
  nextMs: number,
  timezone: string,
): number | undefined {
  if (!matchesCronOccurrence(cron, new Date(nextMs))) {
    // croner 会给一个不存在的本地时间凭空造出瞬间；要框住的是缺口而不是请求本身，
    // 这样跨多次切换的年度任务也能算对。
    const transitionMs = findCronTimezoneTransitionMs(nextMs - DAY_MS, nextMs, timezone);
    return transitionMs === undefined
      ? undefined
      : resolveCronRunAtTransitionMs(cron, transitionMs, timezone);
  }

  const firstOccurrenceMs = resolveFirstCronOccurrenceMs(nextMs, timezone);
  if (firstOccurrenceMs === undefined || firstOccurrenceMs > nowMs) return firstOccurrenceMs;

  const firstCurrentOccurrenceMs = resolveFirstCronOccurrenceMs(nowMs, timezone);
  const inRepeatedInterval =
    firstCurrentOccurrenceMs !== undefined && firstCurrentOccurrenceMs < nowMs;
  const transitionStartMs = inRepeatedInterval ? firstCurrentOccurrenceMs : nowMs;
  const transitionEndMs = inRepeatedInterval ? nowMs : nextMs;
  const overlapMs = inRepeatedInterval ? nowMs - firstCurrentOccurrenceMs : nextMs - firstOccurrenceMs;
  const transitionMs = findCronTimezoneTransitionMs(transitionStartMs, transitionEndMs, timezone);
  if (transitionMs === undefined) return undefined;

  // croner 只折叠固定一小时；按真实偏移变化来定位，半小时制与两小时制的重复时钟各只跑一次。
  return resolveCronRunAtTransitionMs(cron, transitionMs + overlapMs, timezone);
}

function resolveValidatedNextCronOccurrenceMs(
  cron: Cron,
  nowMs: number,
  candidateMs: number,
  timezone: string,
): number | undefined {
  if (
    candidateMs > nowMs &&
    !hasNearbyCronTimezoneTransition(cron, timezone, nowMs, candidateMs)
  ) {
    return candidateMs;
  }
  const normalizedMs = resolveNextCronOccurrenceMs(cron, nowMs, candidateMs, timezone);
  return normalizedMs !== undefined && normalizedMs > nowMs ? normalizedMs : undefined;
}

/** 计算 at/every/cron 三种调度在 now 之后的下一次触发时刻。 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (asDateTimestampMs(nowMs) === undefined) return undefined;

  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    if (atMs === null) return undefined;
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMsRaw = coerceFiniteScheduleNumber(schedule.everyMs);
    if (everyMsRaw === undefined) return undefined;
    const everyMs = Math.floor(everyMsRaw);
    if (everyMs < 1) return undefined;
    const anchorRaw = coerceFiniteScheduleNumber(schedule.anchorMs);
    if (schedule.anchorMs !== undefined && (anchorRaw === undefined || anchorRaw < 0)) {
      return undefined;
    }
    const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
    if (nowMs < anchor) return anchor;
    const steps = Math.floor((nowMs - anchor) / everyMs) + 1;
    return asDateTimestampMs(anchor + steps * everyMs);
  }

  const resolvedCron = resolveCronFromSchedule(schedule);
  if (!resolvedCron) return undefined;
  const { cron, timezone } = resolvedCron;
  const nextMs = cron.nextRun(new Date(nowMs))?.getTime();
  if (nextMs === undefined) return undefined;

  const normalizedNextMs = resolveValidatedNextCronOccurrenceMs(cron, nowMs, nextMs, timezone);
  if (normalizedNextMs !== undefined) return normalizedNextMs;
  if (nextMs > nowMs) return undefined;

  // croner 年份回退 bug 的兜底：某些时区/日期组合（例如 Asia/Shanghai）会让 nextRun
  // 返回一个过去年份的时刻；返回值不在未来时换个基准点重试。
  const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
  const retryMs = cron.nextRun(new Date(nextSecondMs))?.getTime();
  if (retryMs !== undefined) {
    const normalizedRetryMs = resolveValidatedNextCronOccurrenceMs(cron, nowMs, retryMs, timezone);
    if (normalizedRetryMs !== undefined) return normalizedRetryMs;
  }
  // 仍在过去：从「明天 0 点（UTC）」这个更宽的基准再试一次。
  const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
  const retry2Ms = cron.nextRun(new Date(tomorrowMs))?.getTime();
  return retry2Ms !== undefined
    ? resolveValidatedNextCronOccurrenceMs(cron, nowMs, retry2Ms, timezone)
    : undefined;
}

/** 计算 cron 表达式在 now 之前的上一次触发时刻。 */
export function computePreviousRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind !== "cron" || asDateTimestampMs(nowMs) === undefined) return undefined;
  const resolvedCron = resolveCronFromSchedule(schedule);
  if (!resolvedCron) return undefined;
  const { cron, timezone } = resolvedCron;
  let previousMs = cron.previousRuns(1, new Date(nowMs))[0]?.getTime();
  if (
    previousMs !== undefined &&
    previousMs < nowMs &&
    !hasNearbyCronTimezoneTransition(cron, timezone, nowMs, previousMs)
  ) {
    return previousMs;
  }

  const firstCurrentOccurrenceMs = resolveFirstCronOccurrenceMs(nowMs, timezone);
  if (firstCurrentOccurrenceMs !== undefined && firstCurrentOccurrenceMs < nowMs) {
    const transitionMs = findCronTimezoneTransitionMs(firstCurrentOccurrenceMs, nowMs, timezone);
    if (transitionMs !== undefined) {
      const overlapEndMs = transitionMs + nowMs - firstCurrentOccurrenceMs;
      const candidateMs = cron.previousRuns(1, new Date(overlapEndMs))[0]?.getTime();
      if (candidateMs !== undefined) previousMs = candidateMs;
    }
  }
  if (previousMs === undefined) return undefined;

  // croner 的墙上时间递减可能跨过春季空洞；年份上限给回溯走了界，
  // 又不会丢掉合法的历史 occurrence。
  while (
    !matchesCronOccurrence(cron, new Date(previousMs)) ||
    (resolveFirstCronOccurrenceMs(previousMs, timezone) ?? previousMs) >= nowMs
  ) {
    const transitionMs = findCronTimezoneTransitionMs(previousMs - DAY_MS, previousMs, timezone);
    if (transitionMs === undefined) return undefined;
    const beforeTransition = new Date(transitionMs - 1_000);
    const candidate = matchesCronOccurrence(cron, beforeTransition)
      ? beforeTransition
      : cron.previousRuns(1, beforeTransition)[0];
    const candidateMs = candidate?.getTime();
    if (candidateMs === undefined || candidateMs >= previousMs) return undefined;
    previousMs = candidateMs;
  }

  const normalizedPreviousMs = resolveFirstCronOccurrenceMs(previousMs, timezone);
  return normalizedPreviousMs !== undefined && normalizedPreviousMs < nowMs
    ? normalizedPreviousMs
    : undefined;
}

/** 用调度器同一套 croner 规则预校验表达式，让上层能提前拒绝而不是运行期才抛。 */
export function isValidCronExpression(expr: string, timezone?: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  try {
    void new Cron(trimmed, { timezone: resolveCronTimezone(timezone), catch: false });
    return true;
  } catch {
    return false;
  }
}

/** 供错峰计算复用：某次基准触发加上该作业的稳定偏移，仍是未来才要。 */
export function resolveNextCronRunWithOffset(
  schedule: Extract<CronSchedule, { kind: "cron" }>,
  nowMs: number,
  offsetMs: number,
): number | undefined {
  if (offsetMs <= 0) return computeNextRunAtMs(schedule, nowMs);
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const baseNext = computeNextRunAtMs(schedule, cursorMs);
    if (baseNext === undefined) return undefined;
    const shifted = baseNext + offsetMs;
    if (isFiniteTimestamp(shifted) && shifted > nowMs) return shifted;
    cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
  }
  return undefined;
}
