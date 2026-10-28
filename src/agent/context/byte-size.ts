// Byte-size parsing for transcript budget config.
// Ported from OpenClaw src/cli/parse-bytes.ts and src/config/byte-size.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation).

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 ** 2,
  m: 1024 ** 2,
  gb: 1024 ** 3,
  g: 1024 ** 3,
  tb: 1024 ** 4,
  t: 1024 ** 4,
};

function invalidByteSize(raw: string, reason?: string): Error {
  const value = raw.trim() ? `"${raw}"` : "empty value";
  const prefix = reason
    ? `Invalid byte size (${reason}): ${value}.`
    : `Invalid byte size: ${value}.`;
  return new Error(`${prefix} Use values like 512kb, 10mb, 1gb, or 500.`);
}

export function parseByteSize(raw: string): number {
  const trimmed = raw.toLowerCase().trim();
  if (!trimmed) {
    throw invalidByteSize(raw, "empty");
  }

  const m = /^(\d+(?:\.\d+)?)([a-z]+)?$/.exec(trimmed);
  if (!m) {
    throw invalidByteSize(raw);
  }

  const value = Number(m[1]);
  if (!Number.isFinite(value)) {
    throw invalidByteSize(raw);
  }

  const unit = (m[2] ?? "b").toLowerCase();
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (!multiplier) {
    throw invalidByteSize(raw, `unknown unit "${unit}"`);
  }

  const bytes = Math.round(value * multiplier);
  // Validate the rounded byte count; fractional inputs may safely round back into range.
  if (!Number.isSafeInteger(bytes)) {
    throw invalidByteSize(raw);
  }
  return bytes;
}

/**
 * Parse an optional byte-size value from config.
 * Accepts non-negative numbers or strings like "2mb".
 */
export function parseNonNegativeByteSize(value: unknown): number | null {
  if (typeof value === "number") {
    const int = Math.floor(value);
    return Number.isSafeInteger(int) && int >= 0 ? int : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      // Bare numbers in config strings are bytes, matching numeric config values.
      const bytes = parseByteSize(trimmed);
      return bytes >= 0 ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Validates byte-size strings accepted by byte-threshold config. */
export function isValidNonNegativeByteSizeString(value: string): boolean {
  return parseNonNegativeByteSize(value) !== null;
}
