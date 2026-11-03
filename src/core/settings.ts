// 模型与运行设置：v4 起 provider 携带模型目录、选择层（默认模型/别名/备用/参数分层），
// 结构与取值优先级移植自 OpenClaw（`src/config/zod-schema.core.ts`、`src/config/defaults.ts`），
// MIT License — Copyright (c) 2026 OpenClaw Foundation。

import { readFile } from "node:fs/promises";
import {
  DEFAULT_LIMITS,
  LIMIT_FIELDS,
  type LimitCountKey,
  type Limits,
} from "./types";
import { writeJsonAtomic } from "../store/persist";
import {
  PROVIDER_APIS,
  type ModelDefinition,
  type ModelSelection,
  type ProviderApi,
  type ProviderConfig,
} from "../model/types";
import { looksMasked, preserveSecretOnPatch, secretPreview } from "../model/secret";

export type { ModelDefinition, ModelSelection, ProviderApi, ProviderConfig } from "../model/types";

export const SETTINGS_VERSION = 4;

/**
 * 内置别名（对应 OpenClaw `src/config/defaults.ts` 的 alias 表），
 * 只在引用的供应商存在时才可解析，否则给出「未登记」的明确报错。
 */
export const BUILTIN_ALIASES: Record<string, string> = {
  deepseek: "deepseek/deepseek-chat",
  "deepseek-think": "deepseek/deepseek-reasoner",
  gpt: "openai/gpt-4o-mini",
  "gpt-mini": "openai/gpt-4o-mini",
  o: "openai/o4-mini",
  qwen: "qwen/qwen3",
};

const DEFAULT_SELECTION: ModelSelection = {
  defaultModel: "demo/mock",
  aliases: { ...BUILTIN_ALIASES },
  fallbacks: [],
  modelParams: {},
  params: {},
  allow: [],
};

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  providers: [
    { id: "demo", api: "mock", models: [{ id: "mock", name: "演示模型" }] },
    {
      id: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    },
    {
      id: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    },
  ],
  selection: DEFAULT_SELECTION,
  limits: { ...DEFAULT_LIMITS },
};

export interface Settings {
  /** 配置结构版本：用于把旧默认值迁移到新默认值，用户显式改过的值保持不动。 */
  settingsVersion: number;
  providers: ProviderConfig[];
  selection: ModelSelection;
  limits: Limits;
}

/** 每次返回一份全新的默认设置：DEFAULT_SETTINGS 是共享常量，调用方不要直接改它。 */
export function defaultSettings(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}

export interface MaskedModelDefinition {
  id: string;
  name: string;
  api?: ProviderApi;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  status: string;
}

export interface MaskedProviderConfig {
  id: string;
  api: ProviderApi;
  baseUrl?: string;
  auth: "api-key" | "none";
  hasApiKey: boolean;
  /** 密钥来源说明（字面量只露末 4 位，引用露来源），供面板展示。 */
  apiKeyHint?: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  maxTokens?: number;
  models: MaskedModelDefinition[];
}

export interface MaskedSettings {
  providers: MaskedProviderConfig[];
  selection: ModelSelection;
  limits: Limits;
}

function maskModel(model: ModelDefinition): MaskedModelDefinition {
  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    ...(model.api ? { api: model.api } : {}),
    contextWindow: model.contextWindow ?? 0,
    maxTokens: model.maxTokens ?? 0,
    reasoning: model.reasoning === true,
    input: model.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(model.cost ?? {}) },
    status: model.status ?? "available",
  };
}

/** 永不回传明文密钥：掩码成占位符，另附来源提示。 */
export function maskSettings(settings: Settings): MaskedSettings {
  return {
    providers: settings.providers.map((p) => {
      const preview = secretPreview(p.apiKey);
      return {
        id: p.id,
        api: p.api,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        auth: p.auth ?? "api-key",
        hasApiKey: preview.hasSecret,
        ...(preview.hint ? { apiKeyHint: preview.hint } : {}),
        ...(p.headers ? { headers: p.headers } : {}),
        ...(p.timeoutSeconds !== undefined ? { timeoutSeconds: p.timeoutSeconds } : {}),
        ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
        models: p.models.map(maskModel),
      };
    }),
    selection: structuredClone(settings.selection),
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

interface LegacyProvider {
  id: string;
  kind?: string;
  api?: ProviderApi;
  baseUrl?: string;
  model?: string;
  models?: ModelDefinition[];
  apiKey?: string;
  auth?: "api-key" | "none";
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  maxTokens?: number;
  params?: Record<string, unknown>;
}

interface LegacySettings {
  settingsVersion?: number;
  providers?: LegacyProvider[];
  activeProviderId?: string;
  defaultModel?: string;
  selection?: Partial<ModelSelection>;
  limits?: Partial<Limits>;
}

/**
 * 逐级迁移历史默认值：只有「存的值 == 那一版的默认值」才升级，用户显式改过的数值保持不动。
 * v1 默认 12 步 / 120 秒，v2 默认 24 步 / 180 秒，v3 默认 48 步 / 420 秒，
 * v4 把单 `model` 字符串的 provider 升级为模型目录，并把 `activeProviderId` 升级为 `selection.defaultModel`。
 */
function migrateSettings(raw: Partial<Settings>): Partial<Settings> {
  const legacy = raw as LegacySettings;
  const version = typeof legacy.settingsVersion === "number" ? legacy.settingsVersion : 1;
  if (version >= SETTINGS_VERSION) return raw;

  const limits: Limits = { ...DEFAULT_LIMITS, ...(legacy.limits ?? {}) };
  const stored = legacy.limits;
  if (stored?.maxStepsPerRun === 12) limits.maxStepsPerRun = DEFAULT_LIMITS.maxStepsPerRun;
  else if (version >= 2 && stored?.maxStepsPerRun === 24) limits.maxStepsPerRun = DEFAULT_LIMITS.maxStepsPerRun;
  if (stored?.runTimeoutMs === 120_000) limits.runTimeoutMs = DEFAULT_LIMITS.runTimeoutMs;
  else if (version >= 2 && stored?.runTimeoutMs === 180_000) limits.runTimeoutMs = DEFAULT_LIMITS.runTimeoutMs;

  const providers = (legacy.providers ?? []).map((entry): ProviderConfig => {
    const api: ProviderApi =
      entry.api ?? (entry.kind === "mock" ? "mock" : "openai-completions");
    const models: ModelDefinition[] =
      entry.models && entry.models.length > 0
        ? entry.models
        : entry.model
          ? [{ id: entry.model }]
          : [];
    return {
      id: entry.id,
      api,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
      ...(entry.auth ? { auth: entry.auth } : {}),
      ...(entry.headers ? { headers: entry.headers } : {}),
      ...(entry.timeoutSeconds !== undefined ? { timeoutSeconds: entry.timeoutSeconds } : {}),
      ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
      ...(entry.params ? { params: entry.params } : {}),
      models,
    };
  });

  const defaultModel =
    legacy.selection?.defaultModel ??
    legacy.defaultModel ??
    (() => {
      const active =
        providers.find((p) => p.id === legacy.activeProviderId) ?? providers[0];
      if (!active) return DEFAULT_SELECTION.defaultModel;
      const modelId = active.models[0]?.id;
      return modelId ? `${active.id}/${modelId}` : active.id;
    })();

  const selection: ModelSelection = {
    ...DEFAULT_SELECTION,
    ...(legacy.selection ?? {}),
    defaultModel,
    aliases: { ...BUILTIN_ALIASES, ...(legacy.selection?.aliases ?? {}) },
  };

  return { ...legacy, settingsVersion: SETTINGS_VERSION, providers, selection, limits };
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
  selection?: Partial<ModelSelection>;
  limits?: Partial<Limits>;
}

function normalizeApi(value: unknown, fallback: ProviderApi): ProviderApi {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !PROVIDER_APIS.includes(value as ProviderApi)) {
    throw new Error(`未知的接口类型 ${String(value)}，可选值：${PROVIDER_APIS.join("、")}`);
  }
  return value as ProviderApi;
}

/** 头里的掩码占位符要丢弃，否则会作为字面量发给上游。 */
function mergeHeaders(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return existing;
  const merged: Record<string, string> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value !== "string") throw new Error(`请求头 ${key} 必须是字符串`);
    if (looksMasked(value)) delete merged[key];
    else if (value.trim()) merged[key] = value;
    else delete merged[key];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeProvider(existing: ProviderConfig, incoming: Partial<ProviderConfig>): ProviderConfig {
  const apiKey = preserveSecretOnPatch(existing.apiKey, incoming.apiKey);
  const headers = mergeHeaders(existing.headers, incoming.headers);
  const merged: ProviderConfig = {
    id: existing.id,
    api: normalizeApi(incoming.api, existing.api),
    ...(incoming.baseUrl !== undefined
      ? incoming.baseUrl
        ? { baseUrl: incoming.baseUrl }
        : {}
      : existing.baseUrl
        ? { baseUrl: existing.baseUrl }
        : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(incoming.auth !== undefined ? { auth: incoming.auth } : existing.auth ? { auth: existing.auth } : {}),
    ...(incoming.authHeader !== undefined ? { authHeader: incoming.authHeader } : {}),
    ...(headers ? { headers } : {}),
    ...(incoming.timeoutSeconds !== undefined
      ? { timeoutSeconds: incoming.timeoutSeconds }
      : existing.timeoutSeconds !== undefined
        ? { timeoutSeconds: existing.timeoutSeconds }
        : {}),
    ...(incoming.maxTokens !== undefined
      ? { maxTokens: incoming.maxTokens }
      : existing.maxTokens !== undefined
        ? { maxTokens: existing.maxTokens }
        : {}),
    ...(incoming.params !== undefined ? { params: incoming.params } : existing.params ? { params: existing.params } : {}),
    models: incoming.models ? incoming.models : existing.models,
  };
  if (incoming.api === "mock") delete merged.apiKey;
  return merged;
}

export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const providers = base.providers.map((existing) => {
    const incoming = patch.providers?.find((p) => p.id === existing.id);
    if (!incoming) return existing;
    return mergeProvider(existing, incoming);
  });
  for (const incoming of patch.providers ?? []) {
    if (providers.some((p) => p.id === incoming.id)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(incoming.id)) {
      throw new Error("供应商 id 只能包含字母、数字、点、下划线和连字符，长度不超过 40");
    }
    providers.push(
      mergeProvider(
        { id: incoming.id, api: normalizeApi(incoming.api, "openai-completions"), models: [] },
        incoming,
      ),
    );
  }

  const selection: ModelSelection = {
    defaultModel: patch.selection?.defaultModel ?? base.selection.defaultModel,
    aliases: { ...base.selection.aliases, ...(patch.selection?.aliases ?? {}) },
    fallbacks: patch.selection?.fallbacks ?? base.selection.fallbacks,
    modelParams: { ...base.selection.modelParams, ...(patch.selection?.modelParams ?? {}) },
    params: { ...base.selection.params, ...(patch.selection?.params ?? {}) },
    allow: patch.selection?.allow ?? base.selection.allow,
  };

  return {
    settingsVersion: base.settingsVersion,
    providers,
    selection,
    limits: { ...base.limits, ...(patch.limits ?? {}) },
  };
}

/** 清除某个供应商已保存的密钥（面板上的「清除密钥」；留空提交不会清除）。 */
export function clearProviderKey(settings: Settings, providerId: string): Settings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => {
      if (provider.id !== providerId) return provider;
      const { apiKey: _apiKey, ...rest } = provider;
      return rest;
    }),
  };
}

/** 删除供应商：默认模型指向它时回落到仍然存在的第一个模型引用。 */
export function removeProvider(settings: Settings, providerId: string): Settings {
  const providers = settings.providers.filter((p) => p.id !== providerId);
  if (providers.length === settings.providers.length) return settings;
  const defaultModel = settings.selection.defaultModel.startsWith(`${providerId}/`)
    ? (providers[0]?.models[0] ? `${providers[0].id}/${providers[0].models[0].id}` : providers[0]?.id ?? "")
    : settings.selection.defaultModel;
  return {
    ...settings,
    providers,
    selection: {
      ...settings.selection,
      defaultModel,
      aliases: Object.fromEntries(
        Object.entries(settings.selection.aliases).filter(
          ([, ref]) => !ref.startsWith(`${providerId}/`) && ref !== providerId,
        ),
      ),
      fallbacks: settings.selection.fallbacks.filter(
        (ref) => !ref.startsWith(`${providerId}/`) && ref !== providerId,
      ),
    },
  };
}
