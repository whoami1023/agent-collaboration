import type { UsageTotals } from "../model/usage-cost";

interface OpenAiUsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * 把 OpenAI 风格的 usage 折算成我们的四类计数：`prompt_tokens` 含缓存命中，
 * 所以 input = prompt - cached，cached 单列为 cacheRead（对应 OpenClaw 的成本口径）。
 */
export function usageFromOpenAi(usage: OpenAiUsagePayload | undefined): UsageTotals | undefined {
  if (!usage) return undefined;
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const prompt = num(usage.prompt_tokens);
  const cached = num(usage.prompt_tokens_details?.cached_tokens);
  const cacheWrite = num(
    usage.prompt_tokens_details?.cache_write_tokens ??
      usage.prompt_tokens_details?.cache_creation_input_tokens,
  );
  return {
    input: Math.max(0, prompt - cached),
    output: num(usage.completion_tokens),
    cacheRead: cached,
    cacheWrite,
  };
}

export function isEmptyUsage(usage: UsageTotals): boolean {
  return (
    usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0
  );
}
