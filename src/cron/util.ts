// Ported helpers from OpenClaw's normalization-core number coercion + infra map-size
// (MIT License — Copyright (c) 2026 OpenClaw Foundation), trimmed to what cron needs.

export const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

/** 只有落在 Date 可表达范围内的整数毫秒才算合法时间戳。 */
export function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= MAX_DATE_TIMESTAMP_MS;
}

export function asDateTimestampMs(value: unknown): number | undefined {
  return isFiniteTimestamp(value) ? value : undefined;
}

/** 严格解析有限数值：字符串、NaN、Infinity 一律拒。 */
export function parseStrictFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 调度字段用的时间数值：非有限、超出 Date 范围或被截断成无效 Date 的都拒。 */
export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  return asDateTimestampMs(parseStrictFiniteNumber(value));
}

export function parseNonNegativeInt(value: unknown): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined) return undefined;
  const floored = Math.floor(parsed);
  return floored >= 0 ? floored : undefined;
}

/** 有界 LRU：命中时把条目移到末尾，超限时从头淘汰。 */
export function pruneMapToMaxSize<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
