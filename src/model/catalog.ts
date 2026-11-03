// Built-in model catalog: the middle layer between what the user authored and the
// generic defaults (OpenClaw seeds this from plugin manifests; we ship a static
// table of OpenAI-compatible endpoints so a fresh install already knows DeepSeek's
// window and per-million prices). 单价单位 USD / 百万 token，只是默认值，用户可在模型设置里覆盖。

import type { ModelDefinition } from "./types";

type CatalogRow = Partial<Omit<ModelDefinition, "id">>;

/** 精确匹配 `provider/model` 引用。 */
const BY_REF: Record<string, CatalogRow> = {
  "deepseek/deepseek-chat": {
    name: "DeepSeek Chat",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
    compat: { thinkingFormat: "deepseek" },
  },
  "deepseek/deepseek-reasoner": {
    name: "DeepSeek Reasoner",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
    compat: { thinkingFormat: "deepseek", supportsTemperature: false },
  },
};

/** 按模型 id 前缀匹配（取最长前缀），让自定义供应商也能命中。 */
const BY_MODEL: Record<string, CatalogRow> = {
  "deepseek-chat": BY_REF["deepseek/deepseek-chat"],
  "deepseek-reasoner": BY_REF["deepseek/deepseek-reasoner"],
  "gpt-5.1": {
    name: "GPT-5.1",
    contextWindow: 400_000,
    maxTokens: 32_768,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.125 },
    api: "openai-responses",
    compat: { supportsTemperature: false },
  },
  "gpt-5-mini": {
    name: "GPT-5 mini",
    contextWindow: 400_000,
    maxTokens: 32_768,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.25, output: 2, cacheRead: 0.025 },
    api: "openai-responses",
    compat: { supportsTemperature: false },
  },
  "gpt-4.1-mini": {
    name: "GPT-4.1 mini",
    contextWindow: 1_047_576,
    maxTokens: 32_768,
    input: ["text", "image"],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1 },
  },
  "gpt-4o-mini": {
    name: "GPT-4o mini",
    contextWindow: 128_000,
    maxTokens: 16_384,
    input: ["text", "image", "audio"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
  },
  "gpt-4o": {
    name: "GPT-4o",
    contextWindow: 128_000,
    maxTokens: 16_384,
    input: ["text", "image", "audio"],
    cost: { input: 2.5, output: 10, cacheRead: 1.25 },
  },
  "o4-mini": {
    name: "o4-mini",
    contextWindow: 200_000,
    maxTokens: 100_000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.1, output: 4.4, cacheRead: 0.45 },
    api: "openai-responses",
    compat: { supportsTemperature: false },
  },
  "o3-mini": {
    name: "o3-mini",
    contextWindow: 200_000,
    maxTokens: 100_000,
    reasoning: true,
    cost: { input: 1.1, output: 4.4, cacheRead: 0.55 },
    compat: { supportsTemperature: false },
  },
  "qwen3": {
    name: "Qwen3",
    contextWindow: 131_072,
    maxTokens: 8_192,
    reasoning: true,
    input: ["text"],
    thinkingLevelMap: { off: null },
    compat: { thinkingFormat: "qwen" },
  },
  "qwen-plus": {
    name: "Qwen Plus",
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0.4, output: 1.2 },
  },
  "kimi-k2": {
    name: "Kimi K2",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
    cost: { input: 0.6, output: 2.5, cacheRead: 0.15 },
  },
  "glm-4": {
    name: "GLM-4",
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0.6, output: 0.6 },
  },
  "moonshot-v1": {
    name: "Moonshot v1",
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 2, output: 2 },
  },
  "grok-4": {
    name: "Grok 4",
    contextWindow: 256_000,
    maxTokens: 32_768,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.75 },
  },
  "llama-3.3": {
    name: "Llama 3.3 70B",
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0.61, output: 0.61 },
  },
  "deepseek-r1": {
    name: "DeepSeek R1",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
    cost: { input: 0, output: 0 },
    compat: { thinkingFormat: "deepseek" },
  },
  "qwen2.5": {
    name: "Qwen2.5",
    contextWindow: 32_768,
    maxTokens: 8_192,
    cost: { input: 0, output: 0 },
    compat: { thinkingFormat: "qwen" },
  },
};

/** 目录查找：先精确 `provider/model`，再按最长模型 id 前缀。 */
export function findCatalogRow(ref: string): CatalogRow | undefined {
  const exact = BY_REF[ref];
  if (exact) return exact;
  const modelId = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  let bestKey: string | undefined;
  for (const key of Object.keys(BY_MODEL)) {
    if (modelId === key || modelId.startsWith(`${key}-`) || modelId.startsWith(`${key}.`)) {
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? BY_MODEL[bestKey] : undefined;
}

/** 设置面板的「从目录快速填充」候选：按 provider id 归组展示。 */
export function catalogSuggestions(providerId: string): Array<{ ref: string; row: CatalogRow }> {
  const refs = new Set<string>();
  for (const ref of Object.keys(BY_REF)) {
    if (ref.startsWith(`${providerId}/`)) refs.add(ref);
  }
  for (const modelId of Object.keys(BY_MODEL)) {
    refs.add(`${providerId}/${modelId}`);
  }
  return [...refs]
    .map((ref) => ({ ref, row: findCatalogRow(ref) ?? {} }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}
