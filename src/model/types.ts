// Ported model-settings vocabulary from OpenClaw (`src/config/zod-schema.core.ts`,
// `packages/llm-core/src/model-data.ts`, `packages/llm-core/src/types.ts`),
// MIT License — Copyright (c) 2026 OpenClaw Foundation; trimmed to the transports
// this runtime actually drives (OpenAI Chat Completions, OpenAI Responses, mock).

/** 传输形态：对应 provider 实际调用的接口，取代旧的两态 `kind`。 */
export type ProviderApi = "mock" | "openai-completions" | "openai-responses";
export const PROVIDER_APIS: readonly ProviderApi[] = ["mock", "openai-completions", "openai-responses"];

/** 推理强度档位；`max` 是部分厂商的极高档，`off` 表示关闭思考。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 厂商把思考档位塞进请求体的不同写法。 */
export type ThinkingFormat = "openai" | "deepseek" | "qwen" | "zai" | "together" | "openrouter";
export const THINKING_FORMATS: readonly ThinkingFormat[] = [
  "openai",
  "deepseek",
  "qwen",
  "zai",
  "together",
  "openrouter",
];

export type ModelInputKind = "text" | "image" | "video" | "audio";
export const MODEL_INPUT_KINDS: readonly ModelInputKind[] = ["text", "image", "video", "audio"];

export type ModelStatus = "available" | "preview" | "deprecated" | "disabled";
export const MODEL_STATUSES: readonly ModelStatus[] = ["available", "preview", "deprecated", "disabled"];

/** `api-key` 用 apiKey（可为引用）；`none` 走免鉴权本地服务。 */
export type ProviderAuthMode = "api-key" | "none";

/** USD / 百万 token 单价。 */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type CostField = (typeof COST_FIELDS)[number];

/**
 * 分段计价：按 prompt 侧 token 数（input + cacheRead + cacheWrite）选档，
 * `upToPromptTokens` 升序，最后一档省略表示上不封顶。跨档不混合计费。
 */
export interface PricingTier extends ModelCost {
  upToPromptTokens?: number;
}

export interface ModelCompat {
  /** 部分推理模型（如 GPT-5 系）会拒绝 temperature。 */
  supportsTemperature?: boolean;
  /** 流式响应里是否回 usage 统计；默认 true。 */
  supportsUsageInStreaming?: boolean;
  supportsTools?: boolean;
  thinkingFormat?: ThinkingFormat;
}

/** 目录里的一条模型；未写的字段由默认值层补齐（见 defaults.ts）。 */
export interface ModelDefinition {
  id: string;
  name?: string;
  /** 覆盖 provider 级传输形态。 */
  api?: ProviderApi;
  /** 覆盖 provider 级 baseUrl（同一网关挂多个上游时用）。 */
  baseUrl?: string;
  contextWindow?: number;
  /** 实际参与预算计算的窗口：可小于 contextWindow 留出安全边际。 */
  contextTokens?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ModelInputKind[];
  cost?: Partial<ModelCost>;
  tiers?: PricingTier[];
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  thinkingDefault?: ThinkingLevel;
  compat?: ModelCompat;
  /** 该模型的额外请求参数（第四层参数合并的最高优先级之一）。 */
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  status?: ModelStatus;
}

export interface ProviderConfig {
  id: string;
  api: ProviderApi;
  baseUrl?: string;
  /** 字面量、`${ENV}`、`$ENV`、`env:NAME`、`file:PATH`；见 secret.ts。 */
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  /** 强制以 `Authorization: Bearer <key>` 发送密钥（部分网关要求）。 */
  authHeader?: boolean;
  /** 单次请求的墙上时钟上限；缺省沿用传输层的看门狗。 */
  timeoutSeconds?: number;
  /** provider 级输出上限，与模型的 contextWindow 取较小值。 */
  maxTokens?: number;
  /** provider 级默认参数（低于模型级与成员级）。 */
  params?: Record<string, unknown>;
  models: ModelDefinition[];
}

/** 生效后的模型：目录行与默认值合并的结果，供运行时直接使用。 */
export interface ResolvedModel {
  providerId: string;
  id: string;
  ref: string;
  name: string;
  api: ProviderApi;
  /** 模型级 baseUrl 覆盖；缺省沿用 provider 的 baseUrl。 */
  baseUrl?: string;
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
  reasoning: boolean;
  input: ModelInputKind[];
  cost: ModelCost;
  tiers?: PricingTier[];
  compat: ModelCompat;
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>;
  params: Record<string, unknown>;
  headers: Record<string, string>;
  status: ModelStatus;
}

export interface ModelSelection {
  /** `provider/model`、`provider` 或别名。 */
  defaultModel: string;
  /** 别名 → `provider/model`。 */
  aliases: Record<string, string>;
  /** 默认模型失败后按序尝试的备用引用。 */
  fallbacks: string[];
  /** 引用 → 该模型的采样参数覆盖（第二层）。 */
  modelParams: Record<string, Record<string, unknown>>;
  /** 全局默认采样参数（第一层）。 */
  params: Record<string, unknown>;
  /** 允许使用的引用通配（如 `deepseek/*`）；空数组表示不限制。 */
  allow: string[];
}
