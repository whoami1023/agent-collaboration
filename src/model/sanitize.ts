// 模型设置补丁的服务端校验：与 `sanitizeLimits` 同一套风格——
// 未知字段与越界值直接抛错，由路由回 400，界面拿中文提示。

import {
  COST_FIELDS,
  MODEL_INPUT_KINDS,
  MODEL_STATUSES,
  PROVIDER_APIS,
  THINKING_FORMATS,
  THINKING_LEVELS,
  type ModelDefinition,
  type ModelCost,
  type ModelInputKind,
  type ModelSelection,
  type ModelStatus,
  type PricingTier,
  type ProviderApi,
  type ProviderAuthMode,
  type ProviderConfig,
  type ThinkingLevel,
  type ThinkingFormat,
} from "./types";
import { sanitizeParams } from "./params";

export const MODEL_LIMITS = {
  providersPerUser: 20,
  modelsPerProvider: 60,
  idMax: 40,
  nameMax: 80,
  baseUrlMax: 300,
  headerCount: 20,
  headerValueMax: 500,
  timeoutSeconds: { min: 1, max: 3600 },
  contextWindow: { min: 512, max: 10_000_000 },
  maxTokens: { min: 1, max: 1_000_000 },
  costRate: { min: 0, max: 100_000 },
  tiersPerModel: 8,
  aliases: 40,
  fallbacks: 5,
  modelParamsEntries: 50,
  allowPatterns: 40,
  refMax: 160,
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

class ModelPatchError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ModelPatchError";
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelPatchError(`${label}必须是对象`);
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string, label: string, max: number): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ModelPatchError(`${label}必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new ModelPatchError(`${label}长度不能超过 ${max}`);
  return trimmed;
}

function optionalInt(
  record: Record<string, unknown>,
  key: string,
  label: string,
  range: { min: number; max: number },
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ModelPatchError(`${label}必须是整数`);
  }
  if (value < range.min || value > range.max) {
    throw new ModelPatchError(`${label}需在 ${range.min}–${range.max} 之间`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string, label: string, range: { min: number; max: number }): number | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelPatchError(`${label}必须是数字`);
  }
  if (value < range.min || value > range.max) {
    throw new ModelPatchError(`${label}需在 ${range.min}–${range.max} 之间`);
  }
  return value;
}

function optionalBool(record: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ModelPatchError(`${label}必须是布尔值`);
  return value;
}

function sanitizeHeaders(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireObject(value, label);
  const keys = Object.keys(record);
  if (keys.length === 0) return {};
  if (keys.length > MODEL_LIMITS.headerCount) {
    throw new ModelPatchError(`${label}最多 ${MODEL_LIMITS.headerCount} 项`);
  }
  const headers: Record<string, string> = {};
  for (const key of keys) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/.test(key)) {
      throw new ModelPatchError(`请求头名称不合法：${key}`);
    }
    const raw = record[key];
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      throw new ModelPatchError(`请求头 ${key} 的值必须是字符串`);
    }
    const text = (raw ?? "").toString();
    if (text.length > MODEL_LIMITS.headerValueMax) {
      throw new ModelPatchError(`请求头 ${key} 的值过长（最多 ${MODEL_LIMITS.headerValueMax} 字符）`);
    }
    if (/[\r\n]/.test(text)) throw new ModelPatchError(`请求头 ${key} 的值不能包含换行`);
    headers[key] = text;
  }
  return headers;
}

function sanitizeCost(value: unknown, label: string): ModelDefinition["cost"] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireObject(value, label);
  const unknown = Object.keys(record).filter((key) => !COST_FIELDS.includes(key as never));
  if (unknown.length > 0) throw new ModelPatchError(`${label}含未知字段：${unknown.join("、")}`);
  const cost: Record<string, number> = {};
  for (const field of COST_FIELDS) {
    const parsed = optionalNumber(record, field, `${label}·${field}`, MODEL_LIMITS.costRate);
    if (parsed !== undefined) cost[field] = parsed;
  }
  return Object.keys(cost).length > 0 ? (cost as ModelDefinition["cost"]) : undefined;
}

function sanitizeTiers(value: unknown, label: string): PricingTier[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ModelPatchError(`${label}必须是数组`);
  if (value.length > MODEL_LIMITS.tiersPerModel) {
    throw new ModelPatchError(`${label}最多 ${MODEL_LIMITS.tiersPerModel} 档`);
  }
  if (value.length === 0) return [];
  return value.map((entry, index) => {
    const record = requireObject(entry, `${label}[${index}]`);
    const partial = sanitizeCost(
      Object.fromEntries(COST_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]])),
      `${label}[${index}]`,
    ) ?? {};
    const cost: ModelCost = {
      input: partial.input ?? 0,
      output: partial.output ?? 0,
      cacheRead: partial.cacheRead ?? 0,
      cacheWrite: partial.cacheWrite ?? 0,
    };
    const cap = optionalInt(record, "upToPromptTokens", `${label}[${index}]·起始 token 上限`, {
      min: 1,
      max: MODEL_LIMITS.contextWindow.max,
    });
    const unknown = Object.keys(record).filter((key) => ![...COST_FIELDS, "upToPromptTokens"].includes(key));
    if (unknown.length > 0) throw new ModelPatchError(`${label}[${index}] 含未知字段：${unknown.join("、")}`);
    return { ...cost, ...(cap !== undefined ? { upToPromptTokens: cap } : {}) };
  });
}

function sanitizeInputKinds(value: unknown, label: string): ModelInputKind[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new ModelPatchError(`${label}必须是非空数组`);
  const kinds: ModelInputKind[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !MODEL_INPUT_KINDS.includes(item as ModelInputKind)) {
      throw new ModelPatchError(`${label}只支持 ${MODEL_INPUT_KINDS.join("、")}`);
    }
    if (!kinds.includes(item as ModelInputKind)) kinds.push(item as ModelInputKind);
  }
  return kinds;
}

function sanitizeThinkingLevelMap(value: unknown, label: string): ModelDefinition["thinkingLevelMap"] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireObject(value, label);
  const map: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!THINKING_LEVELS.includes(key as ThinkingLevel)) {
      throw new ModelPatchError(`${label}只支持档位 ${THINKING_LEVELS.join("、")}`);
    }
    if (raw === null) {
      map[key] = null;
      continue;
    }
    if (typeof raw !== "string" || !raw.trim() || raw.length > 40) {
      throw new ModelPatchError(`${label}·${key} 需要非空字符串或 null`);
    }
    map[key] = raw.trim();
  }
  return Object.keys(map).length > 0 ? (map as ModelDefinition["thinkingLevelMap"]) : undefined;
}

function sanitizeCompat(value: unknown, label: string): ModelDefinition["compat"] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireObject(value, label);
  const unknown = Object.keys(record).filter(
    (key) => !["supportsTemperature", "supportsUsageInStreaming", "supportsTools", "thinkingFormat"].includes(key),
  );
  if (unknown.length > 0) throw new ModelPatchError(`${label}含未知字段：${unknown.join("、")}`);
  const compat: Record<string, unknown> = {};
  const temperature = optionalBool(record, "supportsTemperature", `${label}·支持 temperature`);
  if (temperature !== undefined) compat.supportsTemperature = temperature;
  const usage = optionalBool(record, "supportsUsageInStreaming", `${label}·流式 usage`);
  if (usage !== undefined) compat.supportsUsageInStreaming = usage;
  const tools = optionalBool(record, "supportsTools", `${label}·工具调用`);
  if (tools !== undefined) compat.supportsTools = tools;
  const format = optionalString(record, "thinkingFormat", `${label}·思考格式`, 32);
  if (format !== undefined) {
    if (!THINKING_FORMATS.includes(format as ThinkingFormat)) {
      throw new ModelPatchError(`${label}·思考格式只支持 ${THINKING_FORMATS.join("、")}`);
    }
    compat.thinkingFormat = format;
  }
  return Object.keys(compat).length > 0 ? (compat as ModelDefinition["compat"]) : undefined;
}

function sanitizeModel(value: unknown, index: number): ModelDefinition {
  const record = requireObject(value, `模型 ${index}`);
  const id = optionalString(record, "id", `模型 ${index}·id`, MODEL_LIMITS.idMax);
  if (!id) throw new ModelPatchError(`模型 ${index} 缺少 id`);
  if (!ID_RE.test(id)) throw new ModelPatchError(`模型 id 不合法：${id}`);
  const known = [
    "id",
    "name",
    "api",
    "baseUrl",
    "contextWindow",
    "contextTokens",
    "maxTokens",
    "reasoning",
    "input",
    "cost",
    "tiers",
    "thinkingLevelMap",
    "compat",
    "params",
    "headers",
    "status",
  ];
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new ModelPatchError(`模型 ${id} 含未知字段：${unknown.join("、")}`);

  const api = optionalString(record, "api", `模型 ${id}·接口类型`, 32);
  if (api !== undefined && !PROVIDER_APIS.includes(api as ProviderApi)) {
    throw new ModelPatchError(`模型 ${id} 的接口类型只支持 ${PROVIDER_APIS.join("、")}`);
  }
  const status = optionalString(record, "status", `模型 ${id}·状态`, 20);
  if (status !== undefined && !MODEL_STATUSES.includes(status as ModelStatus)) {
    throw new ModelPatchError(`模型 ${id} 的状态只支持 ${MODEL_STATUSES.join("、")}`);
  }
  const contextWindow = optionalInt(record, "contextWindow", `模型 ${id}·上下文窗口`, MODEL_LIMITS.contextWindow);
  const maxTokens = optionalInt(record, "maxTokens", `模型 ${id}·最大输出`, MODEL_LIMITS.maxTokens);
  const contextTokens = optionalInt(record, "contextTokens", `模型 ${id}·可用窗口`, MODEL_LIMITS.contextWindow);
  if (contextWindow !== undefined && contextTokens !== undefined && contextTokens > contextWindow) {
    throw new ModelPatchError(`模型 ${id} 的可用窗口不能大于上下文窗口`);
  }

  const model: ModelDefinition = { id };
  const name = optionalString(record, "name", `模型 ${id}·名称`, MODEL_LIMITS.nameMax);
  if (name) model.name = name;
  if (api) model.api = api as ProviderApi;
  const baseUrl = optionalString(record, "baseUrl", `模型 ${id}·baseUrl`, MODEL_LIMITS.baseUrlMax);
  if (baseUrl) {
    if (!/^https?:\/\//i.test(baseUrl)) throw new ModelPatchError(`模型 ${id} 的 baseUrl 必须是 http(s) 地址`);
    model.baseUrl = baseUrl;
  }
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (contextTokens !== undefined) model.contextTokens = contextTokens;
  if (maxTokens !== undefined) model.maxTokens = maxTokens;
  const reasoning = optionalBool(record, "reasoning", `模型 ${id}·推理模型`);
  if (reasoning !== undefined) model.reasoning = reasoning;
  const input = sanitizeInputKinds(record["input"], `模型 ${id}·输入模态`);
  if (input) model.input = input;
  const cost = sanitizeCost(record["cost"], `模型 ${id}·单价`);
  if (cost) model.cost = cost;
  const tiers = sanitizeTiers(record["tiers"], `模型 ${id}·分段计价`);
  if (tiers && tiers.length > 0) model.tiers = tiers;
  const thinkingLevelMap = sanitizeThinkingLevelMap(record["thinkingLevelMap"], `模型 ${id}·思考档位表`);
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  const compat = sanitizeCompat(record["compat"], `模型 ${id}·兼容性`);
  if (compat) model.compat = compat;
  const headers = sanitizeHeaders(record["headers"], `模型 ${id}·请求头`);
  if (headers && Object.keys(headers).length > 0) model.headers = headers;
  const params = record["params"];
  if (params !== undefined) model.params = sanitizeParams(params, `模型 ${id}·参数`);
  if (status) model.status = status as ModelStatus;
  return model;
}

function sanitizeModels(value: unknown, providerId: string): ModelDefinition[] {
  if (!Array.isArray(value)) throw new ModelPatchError(`供应商 ${providerId} 的 models 必须是数组`);
  if (value.length > MODEL_LIMITS.modelsPerProvider) {
    throw new ModelPatchError(`供应商 ${providerId} 最多登记 ${MODEL_LIMITS.modelsPerProvider} 个模型`);
  }
  const models = value.map(sanitizeModel);
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new ModelPatchError(`供应商 ${providerId} 里模型 ${model.id} 重复`);
    seen.add(model.id);
  }
  return models;
}

/** 校验一条 provider 补丁；返回可安全并入设置的规范化对象。 */
export function sanitizeProviderPatch(value: unknown): ProviderConfig {
  const record = requireObject(value, "供应商配置");
  const id = optionalString(record, "id", "供应商 id", MODEL_LIMITS.idMax);
  if (!id) throw new ModelPatchError("供应商缺少 id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id)) {
    throw new ModelPatchError("供应商 id 只能包含字母、数字、点、下划线和连字符，长度不超过 40");
  }
  const known = [
    "id",
    "api",
    "kind",
    "baseUrl",
    "apiKey",
    "auth",
    "authHeader",
    "headers",
    "timeoutSeconds",
    "maxTokens",
    "params",
    "models",
  ];
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new ModelPatchError(`供应商 ${id} 含未知字段：${unknown.join("、")}`);

  const api = optionalString(record, "api", `供应商 ${id}·接口类型`, 32) ?? "openai-completions";
  if (!PROVIDER_APIS.includes(api as ProviderApi)) {
    throw new ModelPatchError(`供应商 ${id} 的接口类型只支持 ${PROVIDER_APIS.join("、")}`);
  }
  const provider: ProviderConfig = { id, api: api as ProviderApi, models: [] };
  const baseUrl = optionalString(record, "baseUrl", `供应商 ${id}·baseUrl`, MODEL_LIMITS.baseUrlMax);
  if (baseUrl) {
    if (!/^https?:\/\//i.test(baseUrl)) throw new ModelPatchError(`供应商 ${id} 的 baseUrl 必须是 http(s) 地址`);
    provider.baseUrl = baseUrl;
  }
  const apiKey = record["apiKey"];
  if (apiKey !== undefined && apiKey !== null) {
    if (typeof apiKey !== "string") throw new ModelPatchError(`供应商 ${id} 的 apiKey 必须是字符串`);
    if (apiKey.length > MODEL_LIMITS.baseUrlMax * 2) throw new ModelPatchError(`供应商 ${id} 的 apiKey 过长`);
    if (/[\r\n]/.test(apiKey)) throw new ModelPatchError(`供应商 ${id} 的 apiKey 不能包含换行`);
    const trimmed = apiKey.trim();
    if (trimmed) provider.apiKey = trimmed;
  }
  const auth = optionalString(record, "auth", `供应商 ${id}·鉴权方式`, 16);
  if (auth !== undefined) {
    if (auth !== "api-key" && auth !== "none") {
      throw new ModelPatchError(`供应商 ${id} 的鉴权方式只支持 api-key、none`);
    }
    provider.auth = auth as ProviderAuthMode;
  }
  const authHeader = optionalBool(record, "authHeader", `供应商 ${id}·Bearer 头`);
  if (authHeader !== undefined) provider.authHeader = authHeader;
  const headers = sanitizeHeaders(record["headers"], `供应商 ${id}·请求头`);
  if (headers && Object.keys(headers).length > 0) provider.headers = headers;
  const timeoutSeconds = optionalInt(record, "timeoutSeconds", `供应商 ${id}·超时秒数`, MODEL_LIMITS.timeoutSeconds);
  if (timeoutSeconds !== undefined) provider.timeoutSeconds = timeoutSeconds;
  const maxTokens = optionalInt(record, "maxTokens", `供应商 ${id}·最大输出`, MODEL_LIMITS.maxTokens);
  if (maxTokens !== undefined) provider.maxTokens = maxTokens;
  if (record["params"] !== undefined) provider.params = sanitizeParams(record["params"], `供应商 ${id}·参数`);
  if (record["models"] !== undefined) provider.models = sanitizeModels(record["models"], id);
  return provider;
}

export function sanitizeProvidersPatch(value: unknown): ProviderConfig[] {
  if (!Array.isArray(value)) throw new ModelPatchError("providers 必须是数组");
  if (value.length > MODEL_LIMITS.providersPerUser) {
    throw new ModelPatchError(`最多 ${MODEL_LIMITS.providersPerUser} 个供应商`);
  }
  return value.map(sanitizeProviderPatch);
}

/** 校验选择层（默认模型、别名、备用链、参数分层、允许列表）。 */
export function sanitizeSelectionPatch(
  value: unknown,
  existing: ModelSelection,
): Partial<ModelSelection> {
  const record = requireObject(value, "selection");
  const known = ["defaultModel", "aliases", "fallbacks", "modelParams", "params", "allow"];
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new ModelPatchError(`selection 含未知字段：${unknown.join("、")}`);
  const patch: Partial<ModelSelection> = {};

  const defaultModel = optionalString(record, "defaultModel", "默认模型", MODEL_LIMITS.refMax);
  if (defaultModel) patch.defaultModel = defaultModel;

  if (record["aliases"] !== undefined) {
    const source = requireObject(record["aliases"], "别名");
    const entries = Object.entries(source);
    if (entries.length > MODEL_LIMITS.aliases) {
      throw new ModelPatchError(`别名最多 ${MODEL_LIMITS.aliases} 个`);
    }
    const aliases: Record<string, string> = { ...existing.aliases };
    for (const [key, raw] of entries) {
      if (!ALIAS_RE.test(key)) throw new ModelPatchError(`别名 ${key} 不合法（小写字母、数字、点、下划线、连字符）`);
      if (raw === null || raw === "") {
        delete aliases[key];
        continue;
      }
      if (typeof raw !== "string" || !raw.trim() || raw.length > MODEL_LIMITS.refMax) {
        throw new ModelPatchError(`别名 ${key} 的目标必须是 ${MODEL_LIMITS.refMax} 字符内的模型引用`);
      }
      aliases[key] = raw.trim();
    }
    patch.aliases = aliases;
  }

  if (record["fallbacks"] !== undefined) {
    if (!Array.isArray(record["fallbacks"])) throw new ModelPatchError("备用模型必须是数组");
    if (record["fallbacks"].length > MODEL_LIMITS.fallbacks) {
      throw new ModelPatchError(`备用模型最多 ${MODEL_LIMITS.fallbacks} 个`);
    }
    const refs: string[] = [];
    for (const item of record["fallbacks"]) {
      if (typeof item !== "string" || !item.trim() || item.length > MODEL_LIMITS.refMax) {
        throw new ModelPatchError("备用模型需要合法的模型引用");
      }
      if (!refs.includes(item.trim())) refs.push(item.trim());
    }
    patch.fallbacks = refs;
  }

  if (record["allow"] !== undefined) {
    if (!Array.isArray(record["allow"])) throw new ModelPatchError("允许列表必须是数组");
    if (record["allow"].length > MODEL_LIMITS.allowPatterns) {
      throw new ModelPatchError(`允许列表最多 ${MODEL_LIMITS.allowPatterns} 条`);
    }
    const patterns: string[] = [];
    for (const item of record["allow"]) {
      if (typeof item !== "string" || !item.trim() || item.length > MODEL_LIMITS.refMax) {
        throw new ModelPatchError("允许列表需要合法的引用通配（如 deepseek/*）");
      }
      patterns.push(item.trim());
    }
    patch.allow = patterns;
  }

  if (record["params"] !== undefined) {
    patch.params = { ...existing.params, ...sanitizeParams(record["params"], "全局默认参数") };
  }

  if (record["modelParams"] !== undefined) {
    const source = requireObject(record["modelParams"], "按模型参数");
    const entries = Object.entries(source);
    if (entries.length > MODEL_LIMITS.modelParamsEntries) {
      throw new ModelPatchError(`按模型参数最多 ${MODEL_LIMITS.modelParamsEntries} 条`);
    }
    const modelParams: Record<string, Record<string, unknown>> = { ...existing.modelParams };
    for (const [ref, raw] of entries) {
      if (!ref.trim() || ref.length > MODEL_LIMITS.refMax) throw new ModelPatchError(`参数覆盖的引用 ${ref} 不合法`);
      if (raw === null) {
        delete modelParams[ref];
        continue;
      }
      modelParams[ref] = sanitizeParams(raw, `模型 ${ref}·参数`);
    }
    patch.modelParams = modelParams;
  }

  return patch;
}
