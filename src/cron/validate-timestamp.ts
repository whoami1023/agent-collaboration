// Ported from OpenClaw src/cron/validate-timestamp.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 语义照搬：一次性任务留 1 分钟宽限（创建与校验之间的竞态不该误伤刚提交的任务），
// 再拦下打错年份的遥远未来；非法格式在 normalize 那层已经拒绝，这里保留同样口径的兜底文案。
// OpenClaw 在 gateway 的 add/patch 两条入口调用它（那两层知道「现在几点」），本项目的对应位置是
// CronService.createJob 与 updateJob。

import { parseAbsoluteTimeMs } from "./time";
import type { CronSchedule } from "./types";

const ONE_MINUTE_MS = 60_000;
const TEN_YEARS_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

export type CronTimestampValidation = { ok: true } | { ok: false; message: string };

/** 一次性任务的时间戳是否还能用：不能是过去（1 分钟宽限内除外），也不能是十年以后。 */
export function validateCronScheduleTimestamp(
  schedule: CronSchedule,
  nowMs: number = Date.now(),
): CronTimestampValidation {
  if (schedule.kind !== "at") return { ok: true };
  const raw = typeof schedule.at === "string" ? schedule.at.trim() : "";
  const atMs = raw ? parseAbsoluteTimeMs(raw) : null;
  if (atMs === null || !Number.isFinite(atMs)) {
    return {
      ok: false,
      message: `一次性任务的时间格式不合法：${String(schedule.at)}（要 ISO 时间或毫秒数）`,
    };
  }
  const reference = Number.isFinite(nowMs) ? nowMs : Date.now();
  const diffMs = atMs - reference;
  if (diffMs < -ONE_MINUTE_MS) {
    return {
      ok: false,
      message:
        `一次性任务的时间已经过去了：${new Date(atMs).toISOString()}` +
        `（${Math.floor(-diffMs / ONE_MINUTE_MS)} 分钟前），当前时间 ${new Date(reference).toISOString()}。请填一个未来的时刻`,
    };
  }
  if (diffMs > TEN_YEARS_MS) {
    return {
      ok: false,
      message:
        `一次性任务的时间太远：${new Date(atMs).toISOString()}` +
        `（约 ${Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000))} 年后），最多允许 10 年`,
    };
  }
  return { ok: true };
}
