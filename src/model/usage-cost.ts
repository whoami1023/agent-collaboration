// 用量与成本核算：移植自 OpenClaw `packages/llm-core/src/usage-cost.ts:93-114`，
// MIT License — Copyright (c) 2026 OpenClaw Foundation。
// 单价单位是 USD / 百万 token；分段计价按 prompt 侧 token 选档，跨档不混合。

import type { ModelCost, PricingTier, ResolvedModel } from "./types";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  return {
    input: a.input + count(b.input),
    output: a.output + count(b.output),
    cacheRead: a.cacheRead + count(b.cacheRead),
    cacheWrite: a.cacheWrite + count(b.cacheWrite),
  };
}

export function promptTokensOf(usage: UsageTotals): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** 分段计价：用 prompt 侧总 token 选档，取第一个 `upToPromptTokens` 不小于它的档位。 */
export function tierForPromptTokens(tiers: PricingTier[], promptTokens: number): ModelCost {
  const sorted = [...tiers].sort(
    (a, b) => (a.upToPromptTokens ?? Number.POSITIVE_INFINITY) - (b.upToPromptTokens ?? Number.POSITIVE_INFINITY),
  );
  for (const tier of sorted) {
    if (tier.upToPromptTokens === undefined || promptTokens <= tier.upToPromptTokens) return tier;
  }
  return sorted[sorted.length - 1] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * 未显式标注 cache 写入价的模型按 2× 输入价计（对应 OpenClaw 的 1 小时缓存写入规则）。
 * 只读缓存命中才有 cacheRead 价，写入价缺省走这条倍率。
 */
export function effectiveCost(model: Pick<ResolvedModel, "cost" | "tiers">, promptTokens: number): ModelCost {
  const base = model.tiers && model.tiers.length > 0 ? tierForPromptTokens(model.tiers, promptTokens) : model.cost;
  return {
    input: base.input,
    output: base.output,
    cacheRead: base.cacheRead,
    cacheWrite: base.cacheWrite > 0 ? base.cacheWrite : base.input * 2,
  };
}

/** 一次调用的成本（USD）；单价为 0 的本地/演示模型自然得到 0。 */
export function calculateUsageCost(model: Pick<ResolvedModel, "cost" | "tiers">, usage: UsageTotals): number {
  const cost = effectiveCost(model, promptTokensOf(usage));
  const perMillion = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
  return (
    perMillion(usage.input, cost.input) +
    perMillion(usage.output, cost.output) +
    perMillion(usage.cacheRead, cost.cacheRead) +
    perMillion(usage.cacheWrite, cost.cacheWrite)
  );
}

export function formatUsd(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
