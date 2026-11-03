// Model default precedence ported from OpenClaw (`src/config/defaults.ts:249-313`,
// `src/agents/defaults.ts:9`), MIT License — Copyright (c) 2026 OpenClaw Foundation.
// Layering: 用户显式书写 > 内置目录行 > 通用默认值；用户显式写过的值永不被默认值覆盖。

import {
  type ModelCost,
  type ModelDefinition,
  type ModelInputKind,
  type ProviderConfig,
  type ResolvedModel,
  type ThinkingLevel,
  type ThinkingFormat,
  type ModelCompat,
  type ProviderApi,
  type PricingTier,
} from "./types";
import { findCatalogRow } from "./catalog";

export const DEFAULT_MODEL_MAX_TOKENS = 8192;
export const DEFAULT_MODEL_INPUT: readonly ModelInputKind[] = ["text"];
export const DEFAULT_CONTEXT_TOKENS = 200_000;
export const DEFAULT_MODEL_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function costOf(partial: Partial<ModelCost> | undefined): ModelCost {
  return {
    input: typeof partial?.input === "number" && partial.input >= 0 ? partial.input : DEFAULT_MODEL_COST.input,
    output:
      typeof partial?.output === "number" && partial.output >= 0 ? partial.output : DEFAULT_MODEL_COST.output,
    cacheRead:
      typeof partial?.cacheRead === "number" && partial.cacheRead >= 0
        ? partial.cacheRead
        : DEFAULT_MODEL_COST.cacheRead,
    cacheWrite:
      typeof partial?.cacheWrite === "number" && partial.cacheWrite >= 0
        ? partial.cacheWrite
        : DEFAULT_MODEL_COST.cacheWrite,
  };
}

function normalizeTiers(tiers: PricingTier[] | undefined): PricingTier[] | undefined {
  if (!tiers || tiers.length === 0) return undefined;
  const sorted = [...tiers].sort(
    (a, b) => (a.upToPromptTokens ?? Number.POSITIVE_INFINITY) - (b.upToPromptTokens ?? Number.POSITIVE_INFINITY),
  );
  return sorted.map((tier) => {
    const cap = positiveInt(tier.upToPromptTokens);
    return {
      ...costOf(tier),
      ...(cap === undefined ? {} : { upToPromptTokens: cap }),
    };
  });
}

function boolOf(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCompat(authored: ModelCompat | undefined, row: ModelCompat | undefined): ModelCompat {
  const thinkingFormat =
    (authored?.thinkingFormat as ThinkingFormat | undefined) ?? row?.thinkingFormat;
  return {
    supportsTemperature: boolOf(authored?.supportsTemperature, boolOf(row?.supportsTemperature, true)),
    supportsUsageInStreaming: boolOf(
      authored?.supportsUsageInStreaming,
      boolOf(row?.supportsUsageInStreaming, true),
    ),
    ...(authored?.supportsTools ?? row?.supportsTools) !== undefined
      ? { supportsTools: boolOf(authored?.supportsTools, boolOf(row?.supportsTools, true)) }
      : {},
    ...(thinkingFormat ? { thinkingFormat } : {}),
  };
}

function normalizeInput(authored: ModelInputKind[] | undefined, row: ModelInputKind[] | undefined): ModelInputKind[] {
  const source = authored?.length ? authored : row?.length ? row : [...DEFAULT_MODEL_INPUT];
  const seen = new Set<ModelInputKind>();
  for (const kind of source) {
    if (kind === "text" || kind === "image" || kind === "video" || kind === "audio") seen.add(kind);
  }
  if (seen.size === 0) return [...DEFAULT_MODEL_INPUT];
  return [...seen];
}

function normalizeThinkingLevelMap(
  authored: ModelDefinition["thinkingLevelMap"] | undefined,
  row: ModelDefinition["thinkingLevelMap"] | undefined,
): Partial<Record<ThinkingLevel, string | null>> {
  const merged: Partial<Record<ThinkingLevel, string | null>> = { ...(row ?? {}), ...(authored ?? {}) };
  return Object.keys(merged).length > 0 ? merged : {};
}

function positiveIntFrom(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    const parsed = positiveInt(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * 把一条目录条目与 provider、内置目录行、通用默认值合成运行时可用的模型描述。
 * `ref` 用 `provider/model` 形式，供别名、通配 allowlist 与参数分层查找。
 */
export function resolveModelDefinition(
  provider: ProviderConfig,
  model: ModelDefinition,
  ref: string,
): ResolvedModel {
  const row = findCatalogRow(ref) ?? findCatalogRow(model.id);
  const contextWindow = positiveIntFrom(model.contextWindow, row?.contextWindow) ?? DEFAULT_CONTEXT_TOKENS;
  const contextTokens = Math.min(
    positiveIntFrom(model.contextTokens, row?.contextTokens) ?? contextWindow,
    contextWindow,
  );
  // OpenClaw: maxTokens = min(provider.maxTokens ?? 8192, contextWindow)
  const providerCap = positiveInt(provider.maxTokens) ?? DEFAULT_MODEL_MAX_TOKENS;
  const maxTokens = Math.min(
    positiveIntFrom(model.maxTokens, row?.maxTokens) ?? providerCap,
    providerCap,
    contextWindow,
  );
  const api: ProviderApi = model.api ?? row?.api ?? provider.api;
  const tiers = normalizeTiers(model.tiers ?? row?.tiers);
  return {
    providerId: provider.id,
    id: model.id,
    ref,
    name: model.name?.trim() || row?.name || model.id,
    api,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    contextWindow,
    contextTokens,
    maxTokens,
    reasoning: boolOf(model.reasoning, boolOf(row?.reasoning, false)),
    input: normalizeInput(model.input, row?.input),
    cost: costOf(model.cost ?? row?.cost),
    ...(tiers ? { tiers } : {}),
    compat: normalizeCompat(model.compat, row?.compat),
    thinkingLevelMap: normalizeThinkingLevelMap(model.thinkingLevelMap, row?.thinkingLevelMap),
    params: { ...(row?.params ?? {}), ...(model.params ?? {}) },
    headers: { ...(row?.headers ?? {}), ...(model.headers ?? {}) },
    status: model.status ?? row?.status ?? "available",
  };
}

/** 取 provider 下某个模型 id 的生效描述；未登记返回 undefined。 */
export function resolveProviderModel(provider: ProviderConfig, modelId: string): ResolvedModel | undefined {
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model) return undefined;
  return resolveModelDefinition(provider, model, `${provider.id}/${model.id}`);
}
