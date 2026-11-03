import type { UsageTotals } from "../model/usage-cost";

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
  /** 生效的输出上限（已由模型上限裁剪）。 */
  maxTokens?: number;
  /** 分层合并后的采样参数，直接并入请求体。 */
  params?: Record<string, unknown>;
  /** provider 与模型级自定义请求头。 */
  headers?: Record<string, string>;
  /** 单次请求的墙上时钟上限。 */
  timeoutMs?: number;
  /** 模型级 baseUrl 覆盖（同一网关挂多个上游）。 */
  baseUrl?: string;
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool-calls"; calls: ToolCall[] }
  | { type: "usage"; usage: UsageTotals }
  | { type: "done"; stopReason?: string };

export interface LlmProvider {
  readonly id: string;
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}
