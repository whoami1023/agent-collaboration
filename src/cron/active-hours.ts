// Ported from OpenClaw src/cron/active-hours.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 按墙上时间比较，因此跨夜窗口（22:00–06:00）与 DST 的两次出现都保持正确。

import type { CronActiveHours } from "./types";

const START_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export function assertCronActiveHours(active: CronActiveHours): void {
  if (!START_RE.test(active.start) || !END_RE.test(active.end)) {
    throw new Error("活跃时段需要 HH:MM 的起止，24:00 只允许作为结束");
  }
  const tz = active.timezone;
  if (tz !== undefined && tz !== "user" && tz !== "local") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    } catch {
      throw new Error("活跃时段 timezone 只能是 user、local 或 IANA 时区名");
    }
  }
}

/** 此刻是否落在活跃时段内；无时段配置视为永远活跃。 */
export function isCronWithinActiveHours(
  active: CronActiveHours | undefined,
  nowMs: number,
  userTimezone?: string,
): boolean {
  if (!active) return true;
  const timezone = active.timezone;
  const timeZone =
    !timezone || timezone === "user"
      ? userTimezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
      : timezone === "local"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : timezone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const minute =
    Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value);
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinutes(active.start);
  const end = toMinutes(active.end);
  if (start === end) return false;
  return end > start ? minute >= start && minute < end : minute >= start || minute < end;
}
