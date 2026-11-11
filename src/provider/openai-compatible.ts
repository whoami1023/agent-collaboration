import type { LlmEvent, LlmMessage, LlmProvider, LlmRequest, ToolCall } from "./types";
import { applyHeaders, composeSignal, postForStream, readSseLines } from "./http";
import { isEmptyUsage, usageFromOpenAi } from "./openai-usage";
import type { UsageTotals } from "../model/usage-cost";

export interface OpenAiProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 自定义请求头（provider 与模型级合并后传入）。 */
  headers?: Record<string, string>;
  /** 强制 `Authorization: Bearer`；某些网关要求把密钥放在别的头里时关掉。 */
  authHeader?: boolean;
  /** 单次请求的墙上时钟上限。 */
  timeoutMs?: number;
  /** 关闭后不再请求 stream_options.include_usage（少数网关会因此报错）。 */
  includeUsage?: boolean;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** DeepSeek 等推理模型：思考过程单独下发，不属于正文。 */
      reasoning_content?: string | null;
      /** 部分 OpenAI 兼容实现用 reasoning 字段。 */
      reasoning?: string | null;
      tool_calls?: OpenAiToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/** 这些字段由传输层自己拼装，用户参数不得覆盖。 */
const RESERVED_BODY_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "max_tokens",
  "stream_options",
]);

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildOpenAiHeaders(
  options: OpenAiProviderOptions,
  request: LlmRequest,
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  applyHeaders(headers, options.headers);
  applyHeaders(headers, request.headers);
  if (options.authHeader === false) {
    const keyName = Object.keys(headers).find((name) => name.toLowerCase() === "authorization");
    if (keyName) delete headers[keyName];
  }
  return headers;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.id = options.id;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const baseUrl = (request.baseUrl ?? this.options.baseUrl).replace(/\/+$/, "");
    const url = `${baseUrl}/chat/completions`;
    const toolDefs = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const body: Record<string, unknown> = {
      model: request.model || this.options.model,
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
    };
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (RESERVED_BODY_KEYS.has(key) || value === undefined) continue;
      body[key] = value;
    }
    if (toolDefs.length > 0) {
      body.tools = toolDefs;
      body.tool_choice = "auto";
    }
    const maxTokens = request.maxTokens ?? (body.max_tokens as number | undefined);
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    else delete body.max_tokens;
    if (this.options.includeUsage !== false) body.stream_options = { include_usage: true };

    const signal = composeSignal(request.signal, request.timeoutMs ?? this.options.timeoutMs);
    const stream = await postForStream({
      url,
      headers: buildOpenAiHeaders(this.options, request),
      body,
      signal,
    });

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | undefined;
    let usage: UsageTotals | undefined;
    for await (const line of readSseLines(stream)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") break;
      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      const parsedUsage = usageFromOpenAi(chunk.usage);
      if (parsedUsage && !isEmptyUsage(parsedUsage)) usage = parsedUsage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        yield { type: "reasoning", delta: reasoning };
      }
      const content = choice.delta?.content;
      if (typeof content === "string" && content) yield { type: "text", delta: content };
      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = delta.index ?? 0;
        const current = pending.get(index) ?? { id: delta.id ?? `call_${index}`, name: "", args: "" };
        if (delta.id) current.id = delta.id;
        if (delta.function?.name) current.name += delta.function.name;
        if (delta.function?.arguments) current.args += delta.function.arguments;
        pending.set(index, current);
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }

    if (pending.size > 0) {
      const calls: ToolCall[] = [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => ({ id: value.id, name: value.name, args: parseArgs(value.args) }));
      yield { type: "tool-calls", calls };
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "done", stopReason };
  }
}
