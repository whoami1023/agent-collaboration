import type { LlmMessage, LlmProvider, ToolCall, ToolSchema } from "../provider/types";

export interface ToolImpl {
  schema: ToolSchema;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface LoopOptions {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolImpl[];
  maxSteps: number;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (call: ToolCall, result: string) => void;
  pullPending?: () => LlmMessage[];
}

export interface LoopResult {
  text: string;
  steps: number;
  cancelled: boolean;
  error?: string;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: options.system },
    ...options.messages,
  ];
  const toolSchemas = options.tools.map((tool) => tool.schema);
  let lastSignature = "";
  let repeats = 0;
  let text = "";

  for (let step = 0; step < options.maxSteps; step += 1) {
    throwIfAborted(options.signal);
    const pending = options.pullPending?.() ?? [];
    if (pending.length > 0) messages.push(...pending);

    const calls: ToolCall[] = [];
    let stepText = "";
    for await (const event of options.provider.stream({
      model: options.model,
      messages,
      tools: toolSchemas,
      signal: options.signal,
    })) {
      if (event.type === "text") {
        stepText += event.delta;
        options.onDelta?.(event.delta);
      } else if (event.type === "tool-calls") {
        calls.push(...event.calls);
      }
    }

    if (stepText) {
      text += stepText;
      messages.push({ role: "assistant", content: stepText, ...(calls.length ? { toolCalls: calls } : {}) });
    } else if (calls.length) {
      messages.push({ role: "assistant", content: "", toolCalls: calls });
    }

    if (calls.length === 0) {
      return { text: text.trim(), steps: step + 1, cancelled: false };
    }

    const signature = calls.map((call) => `${call.name}:${JSON.stringify(call.args)}`).join("|");
    if (signature === lastSignature) repeats += 1;
    else {
      repeats = 0;
      lastSignature = signature;
    }
    if (repeats >= 2) {
      return {
        text: text.trim(),
        steps: step + 1,
        cancelled: false,
        error: "检测到连续重复的工具调用，已中止本次运行",
      };
    }

    for (const call of calls) {
      throwIfAborted(options.signal);
      options.onToolCall?.(call);
      const tool = options.tools.find((candidate) => candidate.schema.name === call.name);
      let result: string;
      if (!tool) {
        result = `错误：没有名为 ${call.name} 的工具`;
      } else {
        try {
          result = await tool.execute(call.args, options.signal);
        } catch (err) {
          result = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      options.onToolResult?.(call, result);
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  return {
    text: text.trim(),
    steps: options.maxSteps,
    cancelled: false,
    error: `达到最大步数 ${options.maxSteps}，已中止`,
  };
}
