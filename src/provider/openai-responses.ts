// OpenAI Responses 传输（`/responses`）：与 Chat Completions 的请求/事件形状不同，
// 结构对应 OpenClaw `api: "openai-responses"` 分支，MIT License — Copyright (c) 2026 OpenClaw Foundation。

import type { LlmEvent, LlmMessage, LlmProvider, LlmRequest, ToolCall } from "./types";
import { applyHeaders, composeSignal, postForStream, readSseLines } from "./http";
import { isEmptyUsage, usageFromOpenAi } from "./openai-usage";
import type { UsageTotals } from "../model/usage-cost";
import type { OpenAiProviderOptions } from "./openai-compatible";
import { buildOpenAiHeaders } from "./openai-compatible";

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  output_index?: number;
  item_id?: string;
  response?: {
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string; code?: string };
  };
  message?: { content?: string };
  error?: { message?: string; code?: string; type?: string };
}

/** Chat 风格消息 → Responses 的 input 项（system 走 instructions，不进 input）。 */
export function toResponsesInput(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        });
      }
      if (message.content.trim()) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: message.content,
      });
      continue;
    }
    const partType = message.role === "user" ? "input_text" : "output_text";
    input.push({
      type: "message",
      role: message.role === "user" ? "user" : "assistant",
      content: [{ type: partType, text: message.content }],
    });
  }
  return input;
}

function usageFromResponses(response: ResponsesEvent["response"]): UsageTotals | undefined {
  const usage = response?.usage;
  if (!usage) return undefined;
  return usageFromOpenAi({
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens },
  });
}

/** 把分层参数里的 Responses 专有键搬到对应字段上。 */
function splitParams(params: Record<string, unknown> | undefined): {
  body: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  text?: Record<string, unknown>;
} {
  const body: Record<string, unknown> = {};
  let reasoning: Record<string, unknown> | undefined;
  let text: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(params ?? {})) {
    switch (key) {
      case "reasoning_effort":
        reasoning = { ...(reasoning ?? {}), effort: value };
        break;
      case "text_verbosity":
        text = { ...(text ?? {}), verbosity: value };
        break;
      case "max_tokens":
        body.max_output_tokens = value;
        break;
      case "stop":
      case "streaming":
        break;
      case "temperature":
      case "top_p":
      case "frequency_penalty":
      case "presence_penalty":
      case "seed":
        body[key] = value;
        break;
      default:
        body[key] = value;
    }
  }
  return { body, ...(reasoning ? { reasoning } : {}), ...(text ? { text } : {}) };
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly id: string;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.id = options.id;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const baseUrl = (request.baseUrl ?? this.options.baseUrl).replace(/\/+$/, "");
    const instructions = request.messages.find((m) => m.role === "system")?.content;
    const split = splitParams(request.params);
    const body: Record<string, unknown> = {
      model: request.model || this.options.model,
      input: toResponsesInput(request.messages),
      stream: true,
      ...split.body,
    };
    if (instructions) body.instructions = instructions;
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
    if (split.reasoning) body.reasoning = split.reasoning;
    if (split.text) body.text = split.text;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      }));
      body.tool_choice = "auto";
    }

    const headers = { ...buildOpenAiHeaders(this.options, request) };
    applyHeaders(headers, request.headers);
    const signal = composeSignal(request.signal, request.timeoutMs ?? this.options.timeoutMs);
    const stream = await postForStream({
      url: `${baseUrl}/responses`,
      headers,
      body,
      signal,
    });

    const calls = new Map<number, ToolCall>();
    const argBuffers = new Map<string, string>();
    let stopReason: string | undefined;
    let usage: UsageTotals | undefined;
    let failure: string | undefined;

    for await (const line of readSseLines(stream)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") break;
      let event: ResponsesEvent;
      try {
        event = JSON.parse(data) as ResponsesEvent;
      } catch {
        continue;
      }
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text", delta: event.delta };
          break;
        case "response.output_item.added": {
          if (event.item?.type === "function_call") {
            const index = event.output_index ?? calls.size;
            const callId = event.item.call_id ?? `call_${index}`;
            argBuffers.set(callId, event.item.arguments ?? "");
            calls.set(index, {
              id: callId,
              name: event.item.name ?? "",
              args: {},
            });
          }
          break;
        }
        case "response.output_item.done": {
          if (event.item?.type === "function_call") {
            const index = event.output_index ?? [...calls.keys()].pop() ?? 0;
            const existing = calls.get(index);
            const callId = event.item.call_id ?? existing?.id ?? `call_${index}`;
            const raw = event.item.arguments ?? argBuffers.get(callId) ?? "";
            calls.set(index, {
              id: callId,
              name: event.item.name ?? existing?.name ?? "",
              args: parseObject(raw),
            });
          }
          break;
        }
        case "response.function_call_arguments.delta":
          if (event.item_id) {
            argBuffers.set(event.item_id, (argBuffers.get(event.item_id) ?? "") + (event.delta ?? ""));
          }
          break;
        case "response.completed":
          usage = usageFromResponses(event.response) ?? usage;
          stopReason = "stop";
          break;
        case "response.failed":
        case "response.incomplete":
          failure =
            event.response?.error?.message ??
            event.response?.status ??
            "Responses 请求未完成";
          stopReason = "error";
          break;
        case "error":
          failure = event.error?.message ?? "模型接口错误";
          stopReason = "error";
          break;
        default:
          break;
      }
    }

    if (failure) throw new Error(`模型接口失败：${failure}`);
    if (calls.size > 0) {
      yield { type: "tool-calls", calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c) };
      stopReason = "tool_calls";
    }
    if (usage && !isEmptyUsage(usage)) yield { type: "usage", usage };
    yield { type: "done", stopReason };
  }
}

function parseObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
