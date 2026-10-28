import type { LlmEvent, LlmMessage, LlmProvider, LlmRequest, ToolCall } from "./types";

export interface OpenAiProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
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
      tool_calls?: OpenAiToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

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

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.id = options.id;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
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
    if (toolDefs.length > 0) {
      body.tools = toolDefs;
      body.tool_choice = "auto";
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`模型接口 ${response.status}：${detail.slice(0, 400)}`);
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | undefined;
    for await (const line of readSseLines(response.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") break;
      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
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
    yield { type: "done", stopReason };
  }
}
