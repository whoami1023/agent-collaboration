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
  providers: ProviderConfig[];
  activeProviderId: string;
  limits: Limits;
}

export const DEFAULT_SETTINGS: Settings = {
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
    return mergeSettings(DEFAULT_SETTINGS, raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
    throw err;
  }
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
    providers,
    activeProviderId,
    limits: { ...base.limits, ...(patch.limits ?? {}) },
  };
}
