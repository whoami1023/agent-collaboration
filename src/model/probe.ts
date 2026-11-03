// 「测试连接」探针：移植自 OpenClaw `src/commands/models/list.probe.ts`
// 与 `src/agents/failover/{classification-rules,message-patterns}.ts` 的状态分类，
// MIT License — Copyright (c) 2026 OpenClaw Foundation；此处只保留本项目用得上的规则。

import type { LlmEvent, LlmProvider, LlmRequest } from "../provider/types";
import { ProviderHttpError } from "../provider/http";
import { MockProvider, demoHandler, type MockHandler } from "../provider/mock";
import { OpenAiCompatibleProvider } from "../provider/openai-compatible";
import { OpenAiResponsesProvider } from "../provider/openai-responses";
import { resolveApiKey, looksMasked } from "./secret";
import { resolveModelChain, ModelResolutionError } from "./refs";
import { buildRequestFor } from "./registry";
import type { Settings } from "../core/settings";
import type { ProviderConfig, ResolvedModel } from "./types";

export const PROBE_PROMPT = "Reply with OK. Do not use tools.";
export const PROBE_TIMEOUT_MS = 20_000;
export const PROBE_MAX_TOKENS = 16;

export type ProbeStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

export type ProbeReasonCode =
  | "missing_credential"
  | "unresolved_ref"
  | "no_model"
  | "not_allowed"
  | "excluded_by_auth_order";

export interface ProbeResult {
  providerId: string;
  ref?: string;
  status: ProbeStatus;
  reasonCode?: ProbeReasonCode;
  /** 面向用户的中文说明；上游错误体已脱敏并截断。 */
  error?: string;
  latencyMs?: number;
  /** 探测到的模型能力摘要，便于确认目录配置是否合理。 */
  model?: { contextWindow: number; maxTokens: number; reasoning: boolean };
}

const PATTERN_TABLE: Array<[RegExp, ProbeStatus]> = [
  [/income|余额|insufficient.*(balance|credit|quota)|billing|payment required|no available credit|out of credit/i, "billing"],
  [/rate.?limit|too many requests|429|tpm|rpm|quota exceeded|throttl/i, "rate_limit"],
  [/invalid (api )?key|api key (not |is )?(invalid|expired|required)|unauthorized|forbidden|authentication|permission denied|401|403|incorrect api key/i, "auth"],
  [/timeout|timed out|deadline exceeded|socket hang up|etimedout|context deadline/i, "timeout"],
  [/unsupported|invalid request|unknown (field|parameter)|unexpected (field|parameter|keyword argument)|not supported|marshal|validationerror|400\b|422\b|bad request|no such model|model_not_found|does not exist/i, "format"],
];

/** HTTP 状态 + 错误文本 → 探针状态：文本更具体的规则优先于状态码。 */
export function classifyProbeError(status: number | undefined, message: string): ProbeStatus {
  const textHit = PATTERN_TABLE.find(([pattern]) => pattern.test(message))?.[1];
  if (textHit) return textHit;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 429) return "rate_limit";
  if (status === 404) return "format";
  if (status !== undefined && status >= 400 && status < 500) return "format";
  if (status !== undefined && status >= 500) return "timeout";
  return "unknown";
}

const SECRET_IN_TEXT_RE = /(sk-[A-Za-z0-9_-]{8,}|api[_-]?key["'\s:=]*[A-Za-z0-9._-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/gi;

/** 错误文本可能回显密钥：探针结果要能安全展示给用户。 */
export function redactProbeText(text: string): string {
  return text.replace(SECRET_IN_TEXT_RE, (match) => `${match.slice(0, 4)}***`);
}

function buildProbeProvider(
  provider: ProviderConfig,
  model: ResolvedModel,
  deps: { settings: Settings; dataDir?: string; env?: NodeJS.ProcessEnv; mockHandler?: MockHandler },
): LlmProvider {
  if (model.api === "mock") return new MockProvider(deps.mockHandler ?? demoHandler(), provider.id);
  const baseUrl = model.baseUrl ?? provider.baseUrl;
  if (!baseUrl) throw new ModelResolutionError(`供应商「${provider.id}」缺少 baseUrl`);
  const resolved = resolveApiKey(provider.apiKey, provider.id, {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
  });
  if (resolved.error) {
    const err = new Error(resolved.error) as Error & { probeReasonCode: ProbeReasonCode };
    err.probeReasonCode = resolved.apiKey ? "unresolved_ref" : "missing_credential";
    throw err;
  }
  const options = {
    id: provider.id,
    baseUrl,
    apiKey: resolved.apiKey ?? "",
    model: model.id,
    ...(Object.keys(provider.headers ?? {}).length > 0 ? { headers: provider.headers } : {}),
    ...(provider.authHeader !== undefined ? { authHeader: provider.authHeader } : {}),
    timeoutMs: Math.min(provider.timeoutSeconds ? provider.timeoutSeconds * 1000 : PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
  };
  return model.api === "openai-responses"
    ? new OpenAiResponsesProvider(options)
    : new OpenAiCompatibleProvider(options);
}

export interface ProbeTargetInput {
  /** `provider`、`provider/model` 或别名；省略时用设置里的默认模型。 */
  ref?: string;
  /** 未保存的临时配置：面板里刚填完表单就能测。 */
  provider?: Partial<ProviderConfig> & { id: string };
}

export interface ProbeDeps {
  settings: Settings;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  mockHandler?: MockHandler;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

async function collectReply(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<{ text: string; stopReason?: string }> {
  let text = "";
  let stopReason: string | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "done") stopReason = event.stopReason;
  }
  return { text, stopReason };
}

/**
 * 用最小成本验证一条模型引用是否真的可用：无工具、禁思考、限制输出，
 * 返回状态与延迟；配置类问题（缺密钥、未登记模型）在发请求前就短路返回。
 */
export async function probeModel(input: ProbeTargetInput, deps: ProbeDeps): Promise<ProbeResult> {
  const settings: Settings = input.provider
    ? {
        ...deps.settings,
        providers: mergeTemporaryProvider(deps.settings, input.provider),
      }
    : deps.settings;

  let chain;
  try {
    chain = resolveModelChain(settings, input.ref ?? settings.selection.defaultModel);
  } catch (err) {
    if (err instanceof ModelResolutionError) {
      const missing = /缺少 API Key/.test(err.message);
      return {
        providerId: input.provider?.id ?? settings.providers[0]?.id ?? "",
        status: missing ? "auth" : "no_model",
        reasonCode: missing ? "missing_credential" : "no_model",
        error: err.message,
      };
    }
    return {
      providerId: input.provider?.id ?? settings.providers[0]?.id ?? "",
      status: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const providerConfig = settings.providers.find((p) => p.id === chain.primary.providerId);
  if (!providerConfig) {
    return { providerId: chain.primary.providerId, ref: chain.ref, status: "no_model", reasonCode: "no_model", error: "供应商不存在" };
  }

  let transport: LlmProvider;
  try {
    transport = buildProbeProvider(providerConfig, chain.primary, {
      settings,
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.mockHandler ? { mockHandler: deps.mockHandler } : {}),
    });
  } catch (err) {
    const coded = err as Error & { probeReasonCode?: ProbeReasonCode };
    return {
      providerId: providerConfig.id,
      ref: chain.ref,
      status: coded.probeReasonCode === "missing_credential" ? "auth" : "unknown",
      reasonCode: coded.probeReasonCode ?? "unresolved_ref",
      error: redactProbeText(coded.message),
    };
  }

  const request = buildRequestFor(providerConfig, chain.primary, {
    settings,
    thinkingLevel: "off",
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref();
  const started = Date.now();
  try {
    const reply = await collectReply(transport, {
      model: chain.primary.id,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      tools: [],
      maxTokens: PROBE_MAX_TOKENS,
      ...(request.params ? { params: request.params } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
      timeoutMs: PROBE_TIMEOUT_MS,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!reply.text.trim() && reply.stopReason === undefined) {
      return {
        providerId: providerConfig.id,
        ref: chain.ref,
        status: "format",
        error: "接口有响应但没有返回文本，请检查接口类型（completions/responses）是否选对",
        latencyMs,
      };
    }
    return {
      providerId: providerConfig.id,
      ref: chain.ref,
      status: "ok",
      latencyMs,
      model: {
        contextWindow: chain.primary.contextWindow,
        maxTokens: chain.primary.maxTokens,
        reasoning: chain.primary.reasoning,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof ProviderHttpError) {
      return {
        providerId: providerConfig.id,
        ref: chain.ref,
        status: classifyProbeError(err.status, err.message),
        error: redactProbeText(err.message),
        latencyMs,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    return {
      providerId: providerConfig.id,
      ref: chain.ref,
      status: aborted ? "timeout" : classifyProbeError(undefined, message),
      error: redactProbeText(aborted ? `探测超时（${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒）` : message),
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 临时配置与已存配置合并：掩码密钥沿用已存值，其余字段以表单为准。 */
function mergeTemporaryProvider(settings: Settings, patch: Partial<ProviderConfig> & { id: string }): ProviderConfig[] {
  const existing = settings.providers.find((p) => p.id === patch.id);
  const next: ProviderConfig = {
    id: patch.id,
    api: patch.api ?? existing?.api ?? "openai-completions",
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : existing?.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(patch.apiKey !== undefined && patch.apiKey.trim() ? { apiKey: patch.apiKey } : existing?.apiKey ? { apiKey: existing.apiKey } : {}),
    ...(patch.auth ?? existing?.auth ? { auth: patch.auth ?? existing?.auth } : {}),
    ...(patch.headers ?? existing?.headers ? { headers: patch.headers ?? existing?.headers } : {}),
    ...(patch.authHeader !== undefined ? { authHeader: patch.authHeader } : {}),
    ...(patch.timeoutSeconds ?? existing?.timeoutSeconds !== undefined
      ? { timeoutSeconds: patch.timeoutSeconds ?? existing?.timeoutSeconds }
      : {}),
    ...(patch.maxTokens ?? existing?.maxTokens !== undefined
      ? { maxTokens: patch.maxTokens ?? existing?.maxTokens }
      : {}),
    models: patch.models && patch.models.length > 0 ? patch.models : existing?.models ?? [],
  };
  const rest = settings.providers.filter((p) => p.id !== patch.id);
  return [next, ...rest];
}
