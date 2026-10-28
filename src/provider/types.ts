export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool-calls"; calls: ToolCall[] }
  | { type: "done"; stopReason?: string };

export interface LlmProvider {
  readonly id: string;
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}
