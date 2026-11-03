// 采样参数分层合并：移植自 OpenClaw `src/agents/model-extra-params.ts:47-112`，
// MIT License — Copyright (c) 2026 OpenClaw Foundation。
// 优先级从低到高：供应商默认 → 全局默认 → 全局按模型 → 成员按模型 → 成员默认。

import type { ResolvedModel, ThinkingLevel } from "./types";

/** 界面上允许书写的采样参数键（camel 与 snake 两种写法都收）。 */
const CANONICAL_KEYS: Record<string, string> = {
  temperature: "temperature",
  top_p: "top_p",
  topP: "top_p",
  frequency_penalty: "frequency_penalty",
  frequencyPenalty: "frequency_penalty",
  presence_penalty: "presence_penalty",
  presencePenalty: "presence_penalty",
  seed: "seed",
  stop: "stop",
  response_format: "response_format",
  responseFormat: "response_format",
  max_tokens: "max_tokens",
  maxTokens: "max_tokens",
  streaming: "streaming",
  parallel_tool_calls: "parallel_tool_calls",
  parallelToolCalls: "parallel_tool_calls",
  service_tier: "service_tier",
  serviceTier: "service_tier",
  text_verbosity: "text_verbosity",
  textVerbosity: "text_verbosity",
  reasoning_effort: "reasoning_effort",
  reasoningEffort: "reasoning_effort",
};

export const PARAM_NUMBER_RANGES: Record<string, { min: number; max: number; integer?: boolean }> = {
  temperature: { min: 0, max: 2 },
  top_p: { min: 0, max: 1 },
  frequency_penalty: { min: -2, max: 2 },
  presence_penalty: { min: -2, max: 2 },
  seed: { min: 0, max: 2 ** 31 - 1, integer: true },
  max_tokens: { min: 1, max: 1_000_000, integer: true },
};

export const PARAM_LABELS: Record<string, string> = {
  temperature: "温度",
  top_p: "Top-P",
  frequency_penalty: "频率惩罚",
  presence_penalty: "存在惩罚",
  seed: "随机种子",
  stop: "停止序列",
  response_format: "响应格式",
  max_tokens: "最大输出 token",
  streaming: "流式输出",
  parallel_tool_calls: "并行工具调用",
  service_tier: "服务等级",
  text_verbosity: "文本详略",
  reasoning_effort: "推理强度",
};

const RESPONSE_FORMAT_TYPES = new Set(["text", "json_object", "json_schema"]);
const SERVICE_TIERS = new Set(["default", "priority"]);
const TEXT_VERBOSITY = new Set(["low", "medium", "high"]);

export class ParamValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ParamValidationError";
  }
}

function canonicalKey(key: string): string | undefined {
  return CANONICAL_KEYS[key];
}

/** 校验单值并归一化：数值范围、stop 数组、response_format 结构等。 */
export function normalizeParamValue(key: string, value: unknown): unknown {
  if (value === null) return null;
  const range = PARAM_NUMBER_RANGES[key];
  if (range) {
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) value = Number(value);
    if (typeof value !== "number") throw new ParamValidationError(`${PARAM_LABELS[key] ?? key}必须是数字`);
    if (range.integer && !Number.isInteger(value)) {
      throw new ParamValidationError(`${PARAM_LABELS[key]}必须是整数`);
    }
    if (value < range.min || value > range.max) {
      throw new ParamValidationError(`${PARAM_LABELS[key]}需在 ${range.min}–${range.max} 之间`);
    }
    return value;
  }
  switch (key) {
    case "stop":
      if (typeof value === "string") {
        if (!value) throw new ParamValidationError("停止序列不能为空字符串");
        return value;
      }
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 8 &&
        value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512)
      ) {
        return value;
      }
      throw new ParamValidationError("停止序列需要 1–8 个非空字符串");
    case "response_format": {
      if (typeof value === "string") {
        if (!RESPONSE_FORMAT_TYPES.has(value)) {
          throw new ParamValidationError(`响应格式只能是 ${[...RESPONSE_FORMAT_TYPES].join("、")}`);
        }
        return { type: value };
      }
      if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
        const type = (value as { type: string }).type;
        if (!RESPONSE_FORMAT_TYPES.has(type)) {
          throw new ParamValidationError(`响应格式只能是 ${[...RESPONSE_FORMAT_TYPES].join("、")}`);
        }
        return value;
      }
      throw new ParamValidationError("响应格式需要 {type} 结构");
    }
    case "streaming":
      if (typeof value !== "boolean") throw new ParamValidationError("流式输出需要布尔值");
      return value;
    case "parallel_tool_calls":
      if (typeof value !== "boolean") throw new ParamValidationError("并行工具调用需要布尔值");
      return value;
    case "service_tier":
      if (typeof value !== "string" || !SERVICE_TIERS.has(value)) {
        throw new ParamValidationError("服务等级只能是 default、priority");
      }
      return value;
    case "text_verbosity":
      if (typeof value !== "string" || !TEXT_VERBOSITY.has(value)) {
        throw new ParamValidationError("文本详略只能是 low、medium、high");
      }
      return value;
    case "reasoning_effort":
      if (value !== null && typeof value !== "string") {
        throw new ParamValidationError("推理强度需要字符串或 null");
      }
      return value;
    default:
      throw new ParamValidationError(`不支持的采样参数 ${key}`);
  }
}

/** 校验并归一化一整组参数补丁（键支持 camel/snake），返回 snake 规范键。 */
export function sanitizeParams(input: unknown, layer: string): Record<string, unknown> {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object") {
    throw new ParamValidationError(`${layer}必须是对象`);
  }
  const record = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const canonical = canonicalKey(key);
    if (!canonical) {
      throw new ParamValidationError(
        `${layer}里参数 ${key} 不受支持；可用：${Object.keys(PARAM_LABELS).join("、")}`,
      );
    }
    if (value === undefined) continue;
    result[canonical] = normalizeParamValue(canonical, value);
  }
  return result;
}

export interface ParamLayers {
  provider?: Record<string, unknown>;
  global?: Record<string, unknown>;
  globalModel?: Record<string, unknown>;
  memberModel?: Record<string, unknown>;
  member?: Record<string, unknown>;
}

/** 逐层覆盖：后一层出现的键覆盖前一层，null 表示显式删除该键。 */
export function mergeParamLayers(layers: ParamLayers): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const layer of [layers.provider, layers.global, layers.globalModel, layers.memberModel, layers.member]) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
}

/** 各厂商推理强度字面量的缺省映射（thinkingLevelMap 未登记时）。 */
const DEFAULT_EFFORT_BY_LEVEL: Record<ThinkingLevel, string> = {
  off: "minimal",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "max",
};

/**
 * 把内部思考档位翻译成该模型请求体里的思考参数（对应 OpenClaw 的 thinking format）。
 * `thinkingLevelMap` 里写 null 表示该档位不下发思考参数。
 */
export function thinkingParamFor(
  model: ResolvedModel,
  level: ThinkingLevel,
): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  const mapped = model.thinkingLevelMap[level];
  const effort = mapped === undefined ? DEFAULT_EFFORT_BY_LEVEL[level] : mapped;
  if (effort === null) return undefined;
  switch (model.compat.thinkingFormat ?? "openai") {
    case "deepseek":
      return { thinking: { type: level === "off" ? "disabled" : "enabled" } };
    case "qwen":
    case "zai":
    case "together":
      return { enable_thinking: level !== "off" };
    default:
      return { reasoning_effort: effort };
  }
}

export interface BuiltRequestParams {
  /** 直接并入请求体的字段（已按 compat 过滤）。 */
  body: Record<string, unknown>;
  /** 该次运行是否使用流式传输。 */
  streaming: boolean;
  /** 生效的输出上限（已按模型上限裁剪）。 */
  maxTokens: number;
}

/** 把合并后的参数编译成请求体字段：模型 compat 与上限在这里生效。 */
export function buildRequestParams(merged: Record<string, unknown>, model: ResolvedModel): BuiltRequestParams {
  const body: Record<string, unknown> = {};
  let streaming = true;
  let maxTokens = model.maxTokens;

  for (const [key, raw] of Object.entries(merged)) {
    switch (key) {
      case "streaming":
        streaming = raw !== false;
        break;
      case "max_tokens": {
        const wanted = typeof raw === "number" ? Math.floor(raw) : NaN;
        maxTokens = Number.isFinite(wanted) ? Math.min(wanted, model.maxTokens) : model.maxTokens;
        break;
      }
      case "temperature":
        // GPT-5 系等推理模型会直接拒绝 temperature：按 compat 丢弃而不是把请求送去报错。
        if (model.compat.supportsTemperature === false) break;
        body.temperature = raw;
        break;
      case "parallel_tool_calls":
        if (model.compat.supportsTools === false) break;
        body.parallel_tool_calls = raw;
        break;
      default:
        body[key] = raw;
    }
  }

  if (model.api === "mock") {
    return { body: {}, streaming: true, maxTokens: model.maxTokens };
  }
  return { body, streaming, maxTokens };
}
