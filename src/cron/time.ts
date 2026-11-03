// Ported from OpenClaw src/shared/iso-time.ts + src/infra/format-time/
// parse-offsetless-zoned-datetime.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// Kept as-is where it matters: an offsetless ISO string is an explicit UTC instant, and a
// wall-clock string must be projected into a named zone before croner's next-run math is trusted.

/** ISO 禁止 -000000 这种写法；在 Number 丢掉符号位之前就把它拒掉。 */
const ISO_ABSOLUTE_RE =
  /^(?!-000000)([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[Tt](?<hour>\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?<offset>[Zz]|[+-]\d{2}:?\d{2})?)?$/;

const GREGORIAN_CYCLE_MS = 146_097 * 86_400_000;

export function isOffsetlessIsoDateTime(raw: string): boolean {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  return match !== null && match.groups?.offset === undefined;
}

/** 无偏移的 ISO 日期/时间一律按 UTC 解释；显式偏移保持不变。 */
export function normalizeUtcIso(raw: string): string {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  return match && match.groups?.offset === undefined
    ? `${raw}${match.groups?.hour === undefined ? "T00:00:00" : ""}Z`
    : raw;
}

/** 按格里高利历投影字段，先不套偏移，避免把墙上时间裁掉。 */
export function getUtcCalendarTimeMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  // 格里高利历每 400 年重复一次；Date 的 setter 会保留 0–99 年，
  // 所以整周期用数值补回去，超出 Date 表达范围的墙上时间也不会被裁。
  const yearInCycle = year % 400;
  const date = new Date(0);
  date.setUTCFullYear(yearInCycle, monthIndex, day);
  return (
    date.setUTCHours(hour, minute, second, millisecond) +
    ((year - yearInCycle) / 400) * GREGORIAN_CYCLE_MS
  );
}

/** 只校验并解析 ISO 日历字段，不应用偏移、不裁剪墙上时间。 */
export function parseIsoCalendarTimeMs(raw: string): number | undefined {
  const match = ISO_ABSOLUTE_RE.exec(raw);
  if (!match) return undefined;

  const [, yearRaw, monthRaw, dayRaw, hourRaw = "0", minuteRaw = "0", secondRaw = "0", fractionRaw] =
    match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = fractionRaw ? Number(fractionRaw.slice(1, 4).padEnd(3, "0")) : 0;
  const hasZeroFraction = !fractionRaw || !/[1-9]/.test(fractionRaw);
  const isEndOfDay = hour === 24 && minute === 0 && second === 0 && hasZeroFraction;

  // 先按作者写下的日历校验（含 24:00 落点），再谈 Date 范围与时区偏移。
  const yearInCycle = year % 400;
  const probe = new Date(
    getUtcCalendarTimeMs(
      yearInCycle,
      month - 1,
      day,
      isEndOfDay ? 0 : hour,
      minute,
      second,
      millisecond,
    ),
  );
  if (
    probe.getUTCFullYear() !== yearInCycle ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== (isEndOfDay ? 0 : hour) ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second ||
    probe.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }
  return getUtcCalendarTimeMs(year, month - 1, day, hour, minute, second, millisecond);
}

export function hasValidIsoCalendarComponents(raw: string): boolean {
  return parseIsoCalendarTimeMs(raw) !== undefined;
}

/** epoch 毫秒或 ISO 字符串 → 绝对时刻；不合法返回 null。 */
export function parseAbsoluteTimeMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 && Number.isFinite(new Date(n).getTime())
      ? n
      : null;
  }
  if (!hasValidIsoCalendarComponents(raw)) return null;
  const parsed = Date.parse(normalizeUtcIso(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

const ZONED_PARSE_FORMATTER_CACHE_MAX = 64;
const zonedParseFormatters = new Map<string, Intl.DateTimeFormat>();

function getZonedWallTimeMs(utcMs: number, formatter: Intl.DateTimeFormat): number {
  const utcDate = new Date(utcMs);
  const parts = formatter.formatToParts(utcDate);
  const numeric = (type: string) =>
    Number.parseInt(parts.find((candidate) => candidate.type === type)?.value ?? "0", 10);
  // Intl 的 era 纪年是正数，ISO 用天文纪年（公元前 1 年 = 0）。
  const eraYear = numeric("year");
  const year = parts.find((part) => part.type === "era")?.value === "BC" ? 1 - eraYear : eraYear;
  return getUtcCalendarTimeMs(
    year,
    numeric("month") - 1,
    numeric("day"),
    numeric("hour"),
    numeric("minute"),
    numeric("second"),
    utcDate.getUTCMilliseconds(),
  );
}

/**
 * 把一个无偏移的墙上时间字符串按指定 IANA 时区解释成真实时刻。
 * 春季拨快导致的不存在时间返回 not-ok；秋季重复时间取第一次出现。
 */
export function parseOffsetlessIsoDateTimeInTimeZone(
  raw: string,
  timeZone: string,
): { ok: true; iso: string } | { ok: false; reason: "invalid-timezone" | "invalid-datetime" } {
  const naiveMs = isOffsetlessIsoDateTime(raw) ? parseIsoCalendarTimeMs(raw) : undefined;
  if (naiveMs === undefined) return { ok: false, reason: "invalid-datetime" };

  let formatter = zonedParseFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        era: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      return { ok: false, reason: "invalid-timezone" };
    }
    if (zonedParseFormatters.size >= ZONED_PARSE_FORMATTER_CACHE_MAX) {
      const oldest = zonedParseFormatters.keys().next().value;
      if (oldest !== undefined) zonedParseFormatters.delete(oldest);
    }
    zonedParseFormatters.set(timeZone, formatter);
  }

  try {
    // 在本地日前后各探一天：半小时级的 DST 折叠要取第一次真实出现，
    // 不存在的春季时间则必须被拒；Date 范围端点上可能只有一侧在范围内。
    const matchingInstants = [-86_400_000, 0, 86_400_000]
      .map((shiftMs) => naiveMs + shiftMs)
      .filter((probeMs) => Number.isFinite(probeMs))
      .map((probeMs) => naiveMs - (getZonedWallTimeMs(probeMs, formatter!) - probeMs))
      .filter(
        (candidateMs) =>
          Number.isFinite(candidateMs) && getZonedWallTimeMs(candidateMs, formatter!) === naiveMs,
      );
    return matchingInstants.length > 0
      ? { ok: true, iso: new Date(Math.min(...matchingInstants)).toISOString() }
      : { ok: false, reason: "invalid-datetime" };
  } catch {
    return { ok: false, reason: "invalid-datetime" };
  }
}
