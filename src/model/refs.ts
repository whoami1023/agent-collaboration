// 模型引用解析、别名、备用链与允许列表：移植自 OpenClaw
// （`src/config/zod-schema.agent-model.ts`、`src/config/defaults.ts:41-52`、
// `ModelProvidersSchema.superRefine` `src/config/zod-schema.core.ts:362-386`），
// MIT License — Copyright (c) 2026 OpenClaw Foundation。

import type { Settings } from "../core/settings";
import { BUILTIN_ALIASES } from "../core/settings";
import { resolveModelDefinition } from "./defaults";
import type { ModelSelection, ProviderConfig, ResolvedModel } from "./types";

export const DEFAULT_MODEL_TOKEN = "default";
/** 别名最多展开这么多次，防止 `a→b→a` 成环。 */
const ALIAS_EXPANSION_LIMIT = 5;

export class ModelResolutionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export interface ModelChain {
  /** 用户请求的原始写法（别名、`provider/model`、`provider` 或 `default`）。 */
  requested: string;
  /** 展开别名后的规范引用。 */
  ref: string;
  primary: ResolvedModel;
  /** 主模型失败后按序尝试的模型（已解析，不含主模型本身）。 */
  fallbacks: ResolvedModel[];
}

/** `provider/model`；没有斜杠时整体当供应商 id。 */
export function splitModelRef(ref: string): { providerId: string; modelId?: string } {
  const index = ref.indexOf("/");
  if (index < 0) return { providerId: ref };
  return { providerId: ref.slice(0, index), modelId: ref.slice(index + 1) };
}

export function formatModelRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** 把别名、`provider` 级引用展开成 `provider/model`。 */
export function expandModelRef(settings: Settings, raw: string): string {
  const selection = settings.selection;
  let ref = raw.trim();
  if (!ref || ref === DEFAULT_MODEL_TOKEN) ref = selection.defaultModel;
  for (let depth = 0; depth < ALIAS_EXPANSION_LIMIT; depth += 1) {
    const aliasHit = selection.aliases[ref] ?? BUILTIN_ALIASES[ref];
    if (!aliasHit || aliasHit === ref) break;
    ref = aliasHit.trim();
    if (ref === DEFAULT_MODEL_TOKEN) ref = selection.defaultModel;
  }
  const { providerId, modelId } = splitModelRef(ref);
  if (modelId) return formatModelRef(providerId, modelId);
  const provider = settings.providers.find((candidate) => candidate.id === providerId);
  if (!provider) return ref;
  const first = provider.models[0];
  return first ? formatModelRef(provider.id, first.id) : ref;
}

/** 允许列表通配：`deepseek/*`、`*`、精确 `deepseek/deepseek-chat`。 */
export function isModelAllowed(selection: Pick<ModelSelection, "allow">, ref: string): boolean {
  if (selection.allow.length === 0) return true;
  return selection.allow.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    if (trimmed === "*") return true;
    if (trimmed.endsWith("/*")) return ref.startsWith(trimmed.slice(0, -1));
    if (!trimmed.includes("/")) return ref === trimmed || ref.startsWith(`${trimmed}/`);
    return ref === trimmed;
  });
}

/** 自定义供应商必须同时声明 baseUrl 与 models（OpenClaw 的 superRefine 规则）。 */
export function assertProviderUsable(provider: ProviderConfig): void {
  if (provider.api === "mock") return;
  if (provider.auth === "none") {
    if (!provider.baseUrl) throw new ModelResolutionError(`本地供应商「${provider.id}」缺少 baseUrl`);
    return;
  }
  if (!provider.baseUrl) {
    throw new ModelResolutionError(`供应商「${provider.id}」缺少 baseUrl，请在模型设置里填写`);
  }
  if (!/^https?:\/\//i.test(provider.baseUrl)) {
    throw new ModelResolutionError(`供应商「${provider.id}」的 baseUrl 必须是 http(s) 地址`);
  }
  if (provider.models.length === 0) {
    throw new ModelResolutionError(`供应商「${provider.id}」还没有模型，请先在模型设置里添加至少一个模型`);
  }
}

function resolveSingle(settings: Settings, ref: string): ResolvedModel {
  const { providerId, modelId } = splitModelRef(ref);
  if (!providerId) {
    // 默认模型被清空（例如删掉了最后一个供应商）时给出可操作的提示，而不是「供应商「」不存在」。
    throw new ModelResolutionError("还没有设置默认模型，请在模型设置里选择一个已登记的模型");
  }
  const provider = settings.providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new ModelResolutionError(`供应商「${providerId}」不存在，请在模型设置里添加或改用其他模型`);
  }
  assertProviderUsable(provider);
  const wanted = modelId ?? provider.models[0]?.id;
  if (!wanted) {
    throw new ModelResolutionError(`供应商「${providerId}」没有可用模型`);
  }
  const definition = provider.models.find((candidate) => candidate.id === wanted);
  if (!definition) {
    const known = provider.models.map((candidate) => candidate.id).join("、") || "（空）";
    throw new ModelResolutionError(
      `模型「${providerId}/${wanted}」未在供应商「${providerId}」登记；已登记：${known}`,
    );
  }
  const model = resolveModelDefinition(provider, definition, formatModelRef(provider.id, wanted));
  if (model.status === "disabled") {
    throw new ModelResolutionError(`模型「${model.ref}」已停用，请在模型设置里重新启用`);
  }
  if (!isModelAllowed(settings.selection, model.ref)) {
    throw new ModelResolutionError(`模型「${model.ref}」不在允许列表里`);
  }
  return model;
}

/**
 * 解析成员请求的模型引用，返回主模型与备用链。
 * 备用模型解析失败只跳过（配置不完整不应该阻塞主链路），主模型失败必须抛错。
 */
export function resolveModelChain(settings: Settings, requested: string | undefined): ModelChain {
  const raw = (requested ?? "").trim() || settings.selection.defaultModel;
  const ref = expandModelRef(settings, raw);
  const primary = resolveSingle(settings, ref);
  const fallbacks: ResolvedModel[] = [];
  for (const candidate of settings.selection.fallbacks) {
    const fallbackRef = expandModelRef(settings, candidate);
    if (fallbackRef === primary.ref) continue;
    try {
      const model = resolveSingle(settings, fallbackRef);
      if (model.ref !== primary.ref && !fallbacks.some((item) => item.ref === model.ref)) {
        fallbacks.push(model);
      }
    } catch {
      // 备用链里的坏引用静默跳过：主模型仍可用时不该因为一条陈旧备用而报错。
    }
  }
  return { requested: raw, ref: primary.ref, primary, fallbacks };
}

/** 设置面板与 `/model` 命令用：列出所有可选引用及其状态。 */
export function listModelRefs(settings: Settings): ResolvedModel[] {
  const result: ResolvedModel[] = [];
  for (const provider of settings.providers) {
    for (const definition of provider.models) {
      const ref = formatModelRef(provider.id, definition.id);
      if (!isModelAllowed(settings.selection, ref)) continue;
      result.push(resolveModelDefinition(provider, definition, ref));
    }
  }
  return result;
}
