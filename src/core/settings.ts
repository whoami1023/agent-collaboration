import { readFile } from "node:fs/promises";
import {
  DEFAULT_LIMITS,
  LIMIT_FIELDS,
  type LimitCountKey,
  type Limits,
} from "./types";
import { writeJsonAtomic } from "../store/persist";

export type ProviderKind = "mock" | "openai";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  apiKey?: string;
}

export interface Settings {
  /** 配置结构版本：用于把旧默认值迁移到新默认值，用户显式改过的值保持不动。 */
  settingsVersion: number;
  providers: ProviderConfig[];
  activeProviderId: string;
  limits: Limits;
}

export const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  providers: [
    { id: "demo", kind: "mock", model: "mock" },
    {
      id: "deepseek",
      kind: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    },
  ],
  activeProviderId: "demo",
  limits: { ...DEFAULT_LIMITS },
};

export interface MaskedProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  hasApiKey: boolean;
}

export interface MaskedSettings {
  providers: MaskedProviderConfig[];
  activeProviderId: string;
  limits: Limits;
}

export function maskSettings(settings: Settings): MaskedSettings {
  return {
    providers: settings.providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      model: p.model,
      hasApiKey: Boolean(p.apiKey),
    })),
    activeProviderId: settings.activeProviderId,
    limits: settings.limits,
  };
}

export async function loadSettings(file: string): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<Settings>;
    const migrated = migrateSettings(raw);
    const settings = mergeSettings(DEFAULT_SETTINGS, migrated);
    if (migrated !== raw) await saveSettings(file, settings);
    return settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
    throw err;
  }
}

/**
 * 逐级迁移历史默认值：只有「存的值 == 那一版的默认值」才升级，用户显式改过的数值保持不动。
 * v1 默认 12 步 / 120 秒，v2 默认 24 步 / 180 秒，v3 默认 48 步 / 420 秒。
 */
function migrateSettings(raw: Partial<Settings>): Partial<Settings> {
  const version = typeof raw.settingsVersion === "number" ? raw.settingsVersion : 1;
  if (version >= SETTINGS_VERSION) return raw;
  const limits: Limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) };
  const stored = raw.limits;
  if (stored?.maxStepsPerRun === 12) limits.maxStepsPerRun = DEFAULT_LIMITS.maxStepsPerRun;
  else if (version >= 2 && stored?.maxStepsPerRun === 24) limits.maxStepsPerRun = DEFAULT_LIMITS.maxStepsPerRun;
  if (stored?.runTimeoutMs === 120_000) limits.runTimeoutMs = DEFAULT_LIMITS.runTimeoutMs;
  else if (version >= 2 && stored?.runTimeoutMs === 180_000) limits.runTimeoutMs = DEFAULT_LIMITS.runTimeoutMs;
  return { ...raw, settingsVersion: SETTINGS_VERSION, limits };
}

/**
 * 校验并归一化来自 `PUT /api/settings` 的 limits 补丁（存储单位）：
 * 未知字段、非整数与越界值都会抛错，由路由回 400；未出现的字段保持原值。
 */
export function sanitizeLimits(input: unknown): Partial<Limits> {
  if (input === null || typeof input !== "object") throw new Error("limits 必须是对象");
  const record = input as Record<string, unknown>;
  const known = new Set<string>(LIMIT_FIELDS.map((field) => field.key));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`未知的限额字段 ${key}`);
  }
  const result: Partial<Record<LimitCountKey, number>> = {};
  for (const field of LIMIT_FIELDS) {
    const value = record[field.key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${field.label}必须是整数（${field.displayUnit}）`);
    }
    if (value < field.min || value > field.max) {
      throw new Error(
        `${field.label}需在 ${field.min / (field.displayDivisor ?? 1)}–${field.max / (field.displayDivisor ?? 1)} ${field.displayUnit}之间`,
      );
    }
    result[field.key] = value;
  }
  return result as Partial<Limits>;
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await writeJsonAtomic(file, settings);
}

interface SettingsPatch {
  providers?: Array<Partial<ProviderConfig> & { id: string }>;
  activeProviderId?: string;
  limits?: Partial<Limits>;
}

export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const providers = base.providers.map((existing) => {
    const incoming = patch.providers?.find((p) => p.id === existing.id);
    if (!incoming) return existing;
    const merged: ProviderConfig = { ...existing, ...incoming } as ProviderConfig;
    if (!incoming.apiKey) delete merged.apiKey;
    return merged;
  });
  for (const incoming of patch.providers ?? []) {
    if (!providers.some((p) => p.id === incoming.id)) {
      providers.push(incoming as ProviderConfig);
    }
  }
  const activeProviderId =
    patch.activeProviderId && providers.some((p) => p.id === patch.activeProviderId)
      ? patch.activeProviderId
      : base.activeProviderId;
  return {
    settingsVersion: base.settingsVersion,
    providers,
    activeProviderId,
    limits: { ...base.limits, ...(patch.limits ?? {}) },
  };
}
