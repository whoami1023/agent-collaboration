import type { Settings } from "../core/settings";
import { resolveModelChain } from "../model/refs";
import { resolveApiKey } from "../model/secret";

export interface EmbeddingRuntime {
  ref: string;
  providerId: string;
  modelId: string;
  url: string;
  headers: Record<string, string>;
}

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

/**
 * 解析 embedding 运行时：只支持 OpenAI 兼容的 `/embeddings` 端点。
 * 密钥沿用供应商配置（字面量 / env / file 引用），请求头按 provider → model 合并。
 */
export function resolveEmbeddingRuntime(
  settings: Settings,
  ref: string,
  dataDir?: string,
): EmbeddingRuntime | { error: string } {
  let chain;
  try {
    chain = resolveModelChain(settings, ref);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const model = chain.primary;
  const provider = settings.providers.find((candidate) => candidate.id === model.providerId);
  if (!provider) return { error: `供应商「${model.providerId}」不存在` };
  if (provider.api !== "openai-completions" && provider.api !== "openai-responses") {
    return { error: `供应商「${provider.id}」不支持 OpenAI 兼容的 embedding 接口` };
  }
  const baseUrl = model.baseUrl ?? provider.baseUrl;
  if (!baseUrl) return { error: `供应商「${provider.id}」缺少 baseUrl` };
  const secret = resolveApiKey(provider.apiKey, provider.id, {
    ...(dataDir ? { dataDir } : {}),
  });
  if (secret.error) return { error: secret.error };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(provider.headers ?? {}),
    ...(model.headers ?? {}),
  };
  if (secret.apiKey && provider.authHeader !== false) {
    headers.authorization = `Bearer ${secret.apiKey}`;
  }
  return {
    ref: model.ref,
    providerId: provider.id,
    modelId: model.id,
    url: `${baseUrl.replace(/\/+$/, "")}/embeddings`,
    headers,
  };
}

/** 调用 `/embeddings`：一次最多 64 条，返回顺序与输入一致。 */
export async function requestEmbeddings(
  runtime: EmbeddingRuntime,
  inputs: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<EmbeddingResult> {
  if (inputs.length === 0) return { vectors: [], tokens: 0 };
  const response = await fetchImpl(runtime.url, {
    method: "POST",
    headers: runtime.headers,
    body: JSON.stringify({ model: runtime.modelId, input: inputs }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `embedding 请求失败（${response.status}）：${text.slice(0, 240) || response.statusText}`,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | {
        data?: Array<{ embedding?: unknown; index?: number }>;
        usage?: { prompt_tokens?: number };
      }
    | null;
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new Error("embedding 响应格式不正确");
  }
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors: number[][] = [];
  let dim = 0;
  for (const item of ordered) {
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw new Error("embedding 响应缺少向量");
    }
    const vector = item.embedding.map((value) => Number(value));
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error("embedding 向量包含非数值");
    }
    if (dim === 0) dim = vector.length;
    else if (vector.length !== dim) throw new Error("embedding 向量维度不一致");
    vectors.push(vector);
  }
  return {
    vectors,
    tokens: typeof body?.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : 0,
  };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
