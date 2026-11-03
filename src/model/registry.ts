// 模型运行时装配：把「模型设置」里的分层配置编译成可调用传输（含备用链与故障切换），
// 对应 OpenClaw 的 model selection + params precedence + fallback 流程，
// MIT License — Copyright (c) 2026 OpenClaw Foundation。

import type { LlmEvent, LlmProvider, LlmRequest } from "../provider/types";
import { MockProvider, demoHandler, type MockHandler } from "../provider/mock";
import { OpenAiCompatibleProvider, type OpenAiProviderOptions } from "../provider/openai-compatible";
import { OpenAiResponsesProvider } from "../provider/openai-responses";
import type { LoopRequestOptions } from "../agent/loop/loop";
import { resolveApiKey } from "./secret";
import { resolveModelChain, type ModelChain } from "./refs";
import { buildRequestParams, mergeParamLayers, thinkingParamFor } from "./params";
import type { ProviderConfig, ResolvedModel, ThinkingLevel } from "./types";
import type { Settings } from "../core/settings";

export interface RuntimeDeps {
  settings: Settings;
  mockHandler?: MockHandler;
  /** 解析 `file:` 密钥引用时的相对根目录（工作区目录）。 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 成员级参数层（对应 OpenClaw 的 agents.entries.*）。 */
  memberParams?: Record<string, unknown>;
  memberModelParams?: Record<string, Record<string, unknown>>;
  /** 本轮请求的思考档位（对应 OpenClaw 的 /think 覆盖）。 */
  thinkingLevel?: ThinkingLevel;
}

export interface ModelTransport {
  /** 生效的模型引用与元数据（主模型）。 */
  model: ResolvedModel;
  chain: ModelChain;
  /** 传给 agent loop 的请求选项。 */
  request: LoopRequestOptions;
  provider: LlmProvider;
  /** 实际使用的传输（故障切换后可能与主模型不同）。 */
  activeRef(): string;
}

/** 每次请求的模型设置；`model` 由备用链在故障切换时覆盖。 */
export interface ModelRequest extends LoopRequestOptions {
  model?: string;
}

interface Entry {
  ref: string;
  provider: LlmProvider;
  request: ModelRequest;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * 备用链传输：只有「本次调用还没吐出任何增量」时才切换下一个模型，
 * 已输出内容后失败必须如实上抛，否则会把两段生成拼成一条乱消息。
 */
class FailoverProvider implements LlmProvider {
  readonly id: string;
  private index = 0;

  constructor(
    private readonly entries: Entry[],
    private readonly onFailover?: (from: string, to: string, error: string) => void,
  ) {
    this.id = entries[0]?.provider.id ?? "model";
  }

  activeRef(): string {
    return this.entries[this.index]?.ref ?? "";
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const start = this.index;
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const next = (start + offset) % this.entries.length;
      const entry = this.entries[next];
      if (!entry) continue;
      let emitted = false;
      try {
        for await (const event of entry.provider.stream({
          ...request,
          model: entry.request.model ?? request.model,
          ...(entry.request.params ? { params: entry.request.params } : {}),
          ...(entry.request.headers ? { headers: entry.request.headers } : {}),
          ...(entry.request.baseUrl ? { baseUrl: entry.request.baseUrl } : {}),
          ...(entry.request.timeoutMs !== undefined ? { timeoutMs: entry.request.timeoutMs } : {}),
          ...(entry.request.maxTokens !== undefined ? { maxTokens: entry.request.maxTokens } : {}),
        })) {
          emitted = true;
          yield event;
        }
        this.index = next;
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (emitted || isAbort(err) || offset >= this.entries.length - 1) throw err;
        const following = this.entries[(next + 1) % this.entries.length];
        if (following) {
          this.onFailover?.(entry.ref, following.ref, message);
          this.index = (next + 1) % this.entries.length;
        }
      }
    }
    throw new Error("没有可用的模型传输");
  }
}

/** 编译某条模型引用的请求选项：分层参数 → compat 过滤 → 思考档位 → 上限裁剪。 */
export function buildRequestFor(
  provider: ProviderConfig,
  model: ResolvedModel,
  deps: RuntimeDeps,
): ModelRequest {
  const selection = deps.settings.selection;
  const merged = mergeParamLayers({
    provider: provider.params,
    global: selection.params,
    globalModel: selection.modelParams[model.ref],
    memberModel: deps.memberModelParams?.[model.ref],
    member: deps.memberParams,
  });
  const built = buildRequestParams(merged, model);
  const thinking = deps.thinkingLevel ? thinkingParamFor(model, deps.thinkingLevel) : undefined;
  const headers = { ...model.headers, ...(provider.headers ?? {}) };
  return {
    model: model.id,
    params: { ...built.body, ...(thinking ?? {}) },
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(provider.timeoutSeconds !== undefined ? { timeoutMs: provider.timeoutSeconds * 1000 } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    maxTokens: built.maxTokens,
  };
}

function buildTransportProvider(
  provider: ProviderConfig,
  model: ResolvedModel,
  request: ModelRequest,
  deps: RuntimeDeps,
): LlmProvider {
  if (model.api === "mock") {
    return new MockProvider(deps.mockHandler ?? demoHandler(), provider.id);
  }
  const baseUrl = request.baseUrl ?? provider.baseUrl;
  if (!baseUrl) throw new Error(`供应商「${provider.id}」缺少 baseUrl`);
  const resolved = resolveApiKey(provider.apiKey, provider.id, {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
  });
  if (resolved.error) throw new Error(resolved.error);
  const options: OpenAiProviderOptions = {
    id: provider.id,
    baseUrl,
    apiKey: resolved.apiKey ?? "",
    model: model.id,
    ...(Object.keys(model.headers).length > 0 || Object.keys(provider.headers ?? {}).length > 0
      ? { headers: { ...provider.headers, ...model.headers } }
      : {}),
    ...(provider.authHeader !== undefined ? { authHeader: provider.authHeader } : {}),
    ...(provider.timeoutSeconds !== undefined ? { timeoutMs: provider.timeoutSeconds * 1000 } : {}),
    includeUsage: model.compat.supportsUsageInStreaming !== false,
  };
  if (!options.apiKey && provider.auth !== "none") {
    throw new Error(`供应商「${provider.id}」缺少 API Key，请在模型设置里填写或引用环境变量`);
  }
  return model.api === "openai-responses"
    ? new OpenAiResponsesProvider(options)
    : new OpenAiCompatibleProvider(options);
}

/**
 * 解析成员请求的模型引用并装配传输链：主模型 + 备用模型，参数按层合并，
 * 思考档位与自定义请求头一并落到每次调用上。
 */
export function resolveModelRuntime(
  requestedRef: string | undefined,
  deps: RuntimeDeps,
  onFailover?: (from: string, to: string, error: string) => void,
): ModelTransport {
  const settings = deps.settings;
  const chain = resolveModelChain(settings, requestedRef);
  const entries: Entry[] = [];
  for (const model of [chain.primary, ...chain.fallbacks]) {
    const provider = settings.providers.find((candidate) => candidate.id === model.providerId);
    if (!provider) continue;
    const request = buildRequestFor(provider, model, deps);
    entries.push({ ref: model.ref, provider: buildTransportProvider(provider, model, request, deps), request });
  }
  if (entries.length === 0) {
    throw new Error(`模型「${chain.ref}」没有可用的传输配置`);
  }
  const failover = new FailoverProvider(entries, onFailover);
  return {
    model: chain.primary,
    chain,
    request: entries[0].request,
    provider: failover,
    activeRef: () => failover.activeRef(),
  };
}
