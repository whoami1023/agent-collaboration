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
  "deepseek/deepseek-flash": {
    name: "DeepSeek Flash",
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
    compat: { thinkingFormat: "deepseek" },
  },
  "deepseek/deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
    cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
    compat: { thinkingFormat: "deepseek" },
  },
};

/** 按模型 id 前缀匹配（取最长前缀），让自定义供应商也能命中。 */
const BY_MODEL: Record<string, CatalogRow> = {
  "deepseek-chat": BY_REF["deepseek/deepseek-chat"],
  "deepseek-reasoner": BY_REF["deepseek/deepseek-reasoner"],
  "deepseek-flash": BY_REF["deepseek/deepseek-flash"],
  "deepseek-v4-pro": BY_REF["deepseek/deepseek-v4-pro"],
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

/**
 * 供应商族 → 模型 id 前缀。目录建议只在同族内挑选：把 `gpt-4o-mini` 这类建议塞给
 * DeepSeek 或自建网关供应商，会得到「模型未在供应商登记」的死胡同。
 */
const PROVIDER_FAMILIES: Array<{ provider: RegExp; prefixes: string[] }> = [
  { provider: /^(openai|azure|azure-openai|chatgpt)$/i, prefixes: ["gpt", "o1", "o3", "o4", "chatgpt"] },
  { provider: /^deepseek$/i, prefixes: ["deepseek"] },
  { provider: /^(qwen|qwen-?ai|dashscope|tongyi|aliyun|alibaba)$/i, prefixes: ["qwen"] },
  { provider: /^(moonshot|moonshot-ai|kimi)$/i, prefixes: ["moonshot", "kimi"] },
  { provider: /^(zhipu|zhipuai|glm|bigmodel|z\.ai)$/i, prefixes: ["glm", "chatglm"] },
  { provider: /^(xai|grok)$/i, prefixes: ["grok"] },
  { provider: /^(meta|llama|together|replicate)$/i, prefixes: ["llama"] },
];

/** 该供应商在目录里属于哪个模型族；认不出来就没有同族建议。 */
function familyPrefixes(providerId: string): string[] | undefined {
  return PROVIDER_FAMILIES.find((family) => family.provider.test(providerId))?.prefixes;
}

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

/** 设置面板的「从内置目录添加模型」候选：只给同族模型，避免选出供应商里并不存在的引用。 */
export function catalogSuggestions(providerId: string): Array<{ ref: string; row: CatalogRow }> {
  const refs = new Set<string>();
  for (const ref of Object.keys(BY_REF)) {
    if (ref.startsWith(`${providerId}/`)) refs.add(ref);
  }
  const prefixes = familyPrefixes(providerId);
  if (prefixes) {
    for (const modelId of Object.keys(BY_MODEL)) {
      if (prefixes.some((prefix) => modelId.toLowerCase().startsWith(prefix.toLowerCase()))) {
        refs.add(`${providerId}/${modelId}`);
      }
    }
  }
  return [...refs]
    .map((ref) => ({ ref, row: findCatalogRow(ref) ?? {} }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}
