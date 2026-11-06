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

export const SETTINGS_VERSION = 5;

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

export type LearningMode = "off" | "propose" | "auto";

/** 一次运行结束后要不要复盘、学到的记忆条目是直接落盘还是等用户确认（对应 Hermes 的 background review）。 */
export interface LearningSettings {
  mode: LearningMode;
  /** 每 N 次成功运行复盘一次；1 表示每次运行后都复盘。 */
  everyNRuns: number;
  /** 每天最多复盘几次，防止后台调用把成本跑飞。 */
  dailyCap: number;
  /** 复盘专用模型引用；留空跟随成员自己用的模型。 */
  modelRef?: string;
}

export const LEARNING_MODES: readonly LearningMode[] = ["off", "propose", "auto"];

export const DEFAULT_LEARNING: LearningSettings = {
  mode: "propose",
  everyNRuns: 2,
  dailyCap: 20,
};

/** 顾问扇出的开销节奏：每次用户回合一次 / 每次动手都问 / 每 N 次动手问一次。 */
export type AdvisorCadence = "user_turn" | "per_iteration" | "every_n";

export const ADVISOR_CADENCES: readonly AdvisorCadence[] = [
  "user_turn",
  "per_iteration",
  "every_n",
];

export const ADVISOR_CADENCE_LABELS: Record<AdvisorCadence, string> = {
  user_turn: "每个用户回合一次",
  per_iteration: "每次运行都问",
  every_n: "每 N 次运行问一次",
};

/** 顾问调用整体失败时在群里说到什么程度：讲一句，还是只悄悄留个失败标记。 */
export type AdvisorDegraded = "loud" | "silent";

/**
 * 顾问扇出（移植 Hermes 的 Mixture-of-Agents 循环）：动手的成员在执行前先拿几份
 * 「只出主意、不执行」的参谋意见。默认关闭——开了就是每次运行多几次模型调用，得由用户自己决定。
 */
export interface AdvisorSettings {
  enabled: boolean;
  /** 一次请几位顾问（1–3，默认 2）；再多就是三个人的活五个人参谋。 */
  maxAdvisors: number;
  cadence: AdvisorCadence;
  /** cadence 为 every_n 时的间隔（2–8）。 */
  everyN: number;
  /** 顾问全失败时是否在群里说明。 */
  degraded: AdvisorDegraded;
  /** 顾问统一使用的模型引用；留空跟随动手成员自己的模型。 */
  modelRef?: string;
}

export const DEFAULT_ADVISORS: AdvisorSettings = {
  enabled: false,
  maxAdvisors: 2,
  cadence: "user_turn",
  everyN: 3,
  degraded: "loud",
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
  learning: { ...DEFAULT_LEARNING },
  advisors: { ...DEFAULT_ADVISORS },
};

export interface Settings {
  /** 配置结构版本：用于把旧默认值迁移到新默认值，用户显式改过的值保持不动。 */
  settingsVersion: number;
  providers: ProviderConfig[];
  selection: ModelSelection;
  limits: Limits;
  /** 学习层（回合后复盘）的开关与节流；旧设置缺失时按默认值补齐。 */
  learning: LearningSettings;
  /** 顾问扇出（动手前先问参谋）的开关与节流；默认关闭，旧设置缺失时补默认值。 */
  advisors: AdvisorSettings;
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
  learning: LearningSettings;
  advisors: AdvisorSettings;
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
    learning: structuredClone(settings.learning),
    advisors: structuredClone(settings.advisors),
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
  learning?: Partial<LearningSettings>;
  advisors?: Partial<AdvisorSettings>;
}

/**
 * 各版本的出厂默认限额。迁移只认「存的值 == 该版本的默认值」，
 * 命中才升级到当前默认，用户显式改过的数值一律保持不动。
 */
const LEGACY_LIMIT_DEFAULTS: ReadonlyArray<{ since: number; maxStepsPerRun: number; runTimeoutMs: number }> = [
  { since: 1, maxStepsPerRun: 12, runTimeoutMs: 120_000 },
  { since: 2, maxStepsPerRun: 24, runTimeoutMs: 180_000 },
  { since: 3, maxStepsPerRun: 48, runTimeoutMs: 420_000 },
];

/**
 * 逐级迁移历史默认值：只有「存的值 == 那一版的默认值」才升级，用户显式改过的数值保持不动。
 * v1 默认 12 步 / 120 秒，v2 默认 24 步 / 180 秒，v3-v4 默认 48 步 / 420 秒，
 * v4 把单 `model` 字符串的 provider 升级为模型目录，并把 `activeProviderId` 升级为 `selection.defaultModel`，
 * v5 把单次运行步数默认值收回 24 步（48 步跑满要几十次工具调用，多数任务在 24 步内就该收尾）。
 */
function migrateSettings(raw: Partial<Settings>): Partial<Settings> {
  const legacy = raw as LegacySettings;
  const version = typeof legacy.settingsVersion === "number" ? legacy.settingsVersion : 1;
  if (version >= SETTINGS_VERSION) return raw;

  const limits: Limits = { ...DEFAULT_LIMITS, ...(legacy.limits ?? {}) };
  const stored = legacy.limits;
  for (const tier of LEGACY_LIMIT_DEFAULTS) {
    if (version < tier.since) break;
    if (stored?.maxStepsPerRun === tier.maxStepsPerRun) limits.maxStepsPerRun = DEFAULT_LIMITS.maxStepsPerRun;
    if (stored?.runTimeoutMs === tier.runTimeoutMs) limits.runTimeoutMs = DEFAULT_LIMITS.runTimeoutMs;
  }

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

  return {
    ...legacy,
    settingsVersion: SETTINGS_VERSION,
    providers,
    selection,
    limits,
    // 老文件没有 learning 字段：一律补出厂默认；存坏的字段退回默认而不是让加载失败。
    learning: (() => {
      try {
        return { ...DEFAULT_LEARNING, ...sanitizeLearning(legacy.learning ?? {}) };
      } catch {
        return { ...DEFAULT_LEARNING };
      }
    })(),
    // 顾问扇出同理：老文件没有这个字段，补默认（默认关闭，不会凭空多花钱）。
    advisors: (() => {
      try {
        return { ...DEFAULT_ADVISORS, ...sanitizeAdvisors(legacy.advisors ?? {}) };
      } catch {
        return { ...DEFAULT_ADVISORS };
      }
    })(),
  };
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
  learning?: Partial<LearningSettings>;
  advisors?: Partial<AdvisorSettings>;
}

/**
 * 校验学习层设置：`mode` 只认三种，频率与每日上限按整数与区间收口，
 * `modelRef` 空串视为「跟随成员模型」。
 */
export function sanitizeLearning(input: unknown): Partial<LearningSettings> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("learning 必须是对象");
  const record = input as Record<string, unknown>;
  const known = ["mode", "everyNRuns", "dailyCap", "modelRef"];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw new Error(`未知的学习层字段 ${key}`);
  }
  const result: Partial<LearningSettings> = {};
  if (record.mode !== undefined) {
    if (typeof record.mode !== "string" || !LEARNING_MODES.includes(record.mode as LearningMode)) {
      throw new Error(`复盘模式只能是 ${LEARNING_MODES.join(" / ")}`);
    }
    result.mode = record.mode as LearningMode;
  }
  if (record.everyNRuns !== undefined) {
    if (typeof record.everyNRuns !== "number" || !Number.isInteger(record.everyNRuns) ||
      record.everyNRuns < 1 || record.everyNRuns > 20) {
      throw new Error("复盘频率需在 1–20 次运行之间（整数）");
    }
    result.everyNRuns = record.everyNRuns;
  }
  if (record.dailyCap !== undefined) {
    if (typeof record.dailyCap !== "number" || !Number.isInteger(record.dailyCap) ||
      record.dailyCap < 1 || record.dailyCap > 200) {
      throw new Error("每日复盘上限需在 1–200 次之间（整数）");
    }
    result.dailyCap = record.dailyCap;
  }
  if (record.modelRef !== undefined) {
    if (typeof record.modelRef !== "string") throw new Error("复盘模型引用必须是字符串");
    const ref = record.modelRef.trim();
    result.modelRef = ref || undefined;
  }
  return result;
}

/**
 * 校验顾问扇出设置：开关只认真假，顾问数与间隔按整数与区间收口，
 * 节奏与降级策略只认枚举值，`modelRef` 空串视为「跟随动手成员的模型」。
 */
export function sanitizeAdvisors(input: unknown): Partial<AdvisorSettings> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("advisors 必须是对象");
  }
  const record = input as Record<string, unknown>;
  const known = ["enabled", "maxAdvisors", "cadence", "everyN", "degraded", "modelRef"];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw new Error(`未知的顾问扇出字段 ${key}`);
  }
  const result: Partial<AdvisorSettings> = {};
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") throw new Error("顾问扇出开关必须是布尔值");
    result.enabled = record.enabled;
  }
  if (record.maxAdvisors !== undefined) {
    if (
      typeof record.maxAdvisors !== "number" ||
      !Number.isInteger(record.maxAdvisors) ||
      record.maxAdvisors < 1 ||
      record.maxAdvisors > 3
    ) {
      throw new Error("顾问人数需在 1–3 位之间（整数）");
    }
    result.maxAdvisors = record.maxAdvisors;
  }
  if (record.cadence !== undefined) {
    if (typeof record.cadence !== "string" || !ADVISOR_CADENCES.includes(record.cadence as AdvisorCadence)) {
      throw new Error(`顾问询问节奏只能是 ${ADVISOR_CADENCES.join(" / ")}`);
    }
    result.cadence = record.cadence as AdvisorCadence;
  }
  if (record.everyN !== undefined) {
    if (
      typeof record.everyN !== "number" ||
      !Number.isInteger(record.everyN) ||
      record.everyN < 2 ||
      record.everyN > 8
    ) {
      throw new Error("every_n 节奏的间隔需在 2–8 次运行之间（整数）");
    }
    result.everyN = record.everyN;
  }
  if (record.degraded !== undefined) {
    if (record.degraded !== "loud" && record.degraded !== "silent") {
      throw new Error("顾问失败的处理方式只能是 loud 或 silent");
    }
    result.degraded = record.degraded;
  }
  if (record.modelRef !== undefined) {
    if (typeof record.modelRef !== "string") throw new Error("顾问模型引用必须是字符串");
    const ref = record.modelRef.trim();
    result.modelRef = ref || undefined;
  }
  return result;
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
    learning: {
      ...DEFAULT_LEARNING,
      ...base.learning,
      ...(patch.learning ?? {}),
    },
    advisors: {
      ...DEFAULT_ADVISORS,
      ...base.advisors,
      ...(patch.advisors ?? {}),
    },
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
