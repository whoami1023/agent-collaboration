import { readFile } from "node:fs/promises";
import { DEFAULT_LIMITS, type Limits } from "./types";
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

export const SETTINGS_VERSION = 2;

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

/** v1 没有版本号；当时的默认预算是 12 步 / 120 秒，只迁移这两个旧默认值。 */
function migrateSettings(raw: Partial<Settings>): Partial<Settings> {
  const version = typeof raw.settingsVersion === "number" ? raw.settingsVersion : 1;
  if (version >= SETTINGS_VERSION) return raw;
  const limits: Limits = { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) };
  if (raw.limits?.maxStepsPerRun === 12) limits.maxStepsPerRun = DEFAULT_LIMITS.maxStepsPerRun;
  if (raw.limits?.runTimeoutMs === 120_000) limits.runTimeoutMs = DEFAULT_LIMITS.runTimeoutMs;
  return { ...raw, settingsVersion: SETTINGS_VERSION, limits };
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
