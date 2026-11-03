// Ported from OpenClaw src/cron/stagger.ts + service/jobs-scheduling.ts 的错峰部分
// （MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 整点任务在同一时刻挤爆服务是真实问题，所以默认给「每小时 0 分」这类表达式加 5 分钟抖动，
// 偏移量由 jobId 的 sha256 决定：同一作业每次算出来都一样，重启也不会换时段。

import { createHash } from "node:crypto";
import type { CronSchedule } from "./types";
import { MAX_DATE_TIMESTAMP_MS, parseNonNegativeInt } from "./util";
import { computeNextRunAtMs, resolveNextCronRunWithOffset } from "./schedule";

const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;
const STAGGER_OFFSET_CACHE_MAX = 4096;
const staggerOffsetCache = new Map<string, number>();

function parseCronFields(expr: string): string[] {
  return expr.trim().split(/\s+/).filter(Boolean);
}

const HOUR_LIST_PART = /^(?:\d+|\d+-\d+)(?:\/\d+)?$|^[*?](?:\/\d+)?$/;

function hasRecurringWildcardHour(field: string): boolean {
  const parts = field.split(",");
  return (
    parts.every((part) => HOUR_LIST_PART.test(part)) &&
    parts.some((part) => part.startsWith("*") || part.startsWith("?"))
  );
}

/** 是否每个小时/每天的整点触发（5 段或 6 段写法）。 */
export function isRecurringTopOfHourCronExpr(expr: string): boolean {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === "0" && hasRecurringWildcardHour(hourField ?? "");
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return (
      secondField === "0" && minuteField === "0" && hasRecurringWildcardHour(hourField ?? "")
    );
  }
  return false;
}

/** 显式 stagger 值：保留 0 表示「准点跑」，负数与小数值裁成非负整数。 */
export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const normalized = parseNonNegativeInt(raw);
  if (normalized === undefined) return undefined;
  return normalized <= MAX_DATE_TIMESTAMP_MS ? normalized : undefined;
}

/** 未显式配置时的默认防踩踏抖动窗口。 */
export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

/** 生效的错峰窗口：显式配置优先于默认值。 */
export function resolveCronStaggerMs(schedule: Extract<CronSchedule, { kind: "cron" }>): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) return explicit;
  return resolveDefaultCronStaggerMs(typeof schedule.expr === "string" ? schedule.expr : "") ?? 0;
}

/** jobId → 稳定偏移：哈希确定，因此缓存淘汰不影响未来的调度语义。 */
export function resolveStableCronOffsetMs(jobId: string, staggerMs: number): number {
  if (staggerMs <= 1) return 0;
  const cacheKey = `${staggerMs}:${jobId}`;
  const cached = staggerOffsetCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const digest = createHash("sha256").update(jobId).digest();
  const offset = digest.readUInt32BE(0) % staggerMs;
  if (staggerOffsetCache.size >= STAGGER_OFFSET_CACHE_MAX) {
    const oldest = staggerOffsetCache.keys().next().value;
    if (oldest !== undefined) staggerOffsetCache.delete(oldest);
  }
  staggerOffsetCache.set(cacheKey, offset);
  return offset;
}

/** 调度数学 + 本作业的稳定偏移：cron 类走错峰，其他类型原样计算。 */
export function computeStaggeredNextRunAtMs(
  job: { id: string; schedule: CronSchedule },
  nowMs: number,
): number | undefined {
  if (job.schedule.kind !== "cron") return computeNextRunAtMs(job.schedule, nowMs);
  const offsetMs = resolveStableCronOffsetMs(job.id, resolveCronStaggerMs(job.schedule));
  return resolveNextCronRunWithOffset(job.schedule, nowMs, offsetMs);
}
