// Hardened agent loop, structurally ported from OpenClaw
// packages/agent-core/src/agent-loop.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation):
// streamed assistant response with repetition guard, steering checkpoints (queued messages are
// committed before each provider call and between sequential tool groups), plain-text tool-call
// repair, per-tool retry with backoff, repeated-tool loop guard, and stop-reason mapping.
// Adapted to this project's LlmProvider/LlmMessage seam.

import type { LlmMessage, LlmProvider, ToolCall, ToolSchema } from "../../provider/types";
import type { UsageTotals } from "../../model/usage-cost";
import {
  applyContextBudget,
  type ContextBudgetConfig,
} from "../context/budget";
import { BOUNDED_CONTEXT_NOTICE, type TranscriptByteCompactionLatch } from "../context/bounded-context";
import { RepetitionWatch } from "./repetition-guard";
import { retryAsync, type RetryOptions } from "./retry";
import {
  detectToolCallShapedText,
  parseJsonToolCallPayload,
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
  type PlainTextToolCallNameMatcher,
} from "./tool-call-repair";

export interface ToolImpl {
  schema: ToolSchema;
  /** 必须独占执行（与同一批其它工具串行）的工具。 */
  executionMode?: "sequential";
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface LoopRetryConfig {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number | "full";
}

/** 每次请求都要带上的模型设置（已由分层参数合并算出）。 */
export interface LoopRequestOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  baseUrl?: string;
  maxTokens?: number;
}

export interface LoopOptions {
  provider: LlmProvider;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolImpl[];
  maxSteps: number;
  signal: AbortSignal;
  /** 模型调用了本轮没挂载的工具（运行姿态收窄）时的回执；不传则按「没有名为 X 的工具」回复。 */
  toolUnavailable?: (name: string) => string;
  /** 模型设置里合并出的请求参数（采样、请求头、超时、输出上限）。 */
  request?: LoopRequestOptions;
  /** 上游回流的 token 统计，每个模型调用一次（用于用量与成本记账）。 */
  onUsage?: (usage: UsageTotals) => void;
  onDelta?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (call: ToolCall, result: string) => void;
  /** 模型以文本形式输出工具调用、被修复为原生调用时触发。 */
  onRepair?: (info: { toolNames: string[] }) => void;
  /** 拉取排队中的 steering 消息；每个检查点调用一次并清空。 */
  pullPending?: () => LlmMessage[];
  retry?: LoopRetryConfig;
  /** 移植自 OpenClaw 的 token 预算与压缩配置；未设置则不做上下文治理。 */
  budget?: ContextBudgetConfig;
  /** 压缩/截断归属的成员 id（latch 键）。 */
  budgetOwnerId?: string;
  /** 跨请求保留的字节压缩失败闩（对应 OpenClaw transcriptByteCompactionLatch）。 */
  byteCompactionState?: { latch?: TranscriptByteCompactionLatch };
  onContextApplied?: (
    info:
      | { kind: "compacted"; tokensBefore: number; replacedMessages: number; qualityDegraded: boolean }
      | { kind: "bounded"; omittedMessages: number },
  ) => void;
}

export type LoopErrorCode =
  | "provider_error"
  | "repeated_tool_error"
  | "max_steps_reached"
  | "repetition_detected";

export interface LoopResult {
  text: string;
  steps: number;
  cancelled: boolean;
  error?: string;
  errorCode?: LoopErrorCode;
  /** 工具步数用尽，但已切换到无工具收尾并生成了总结；不算运行失败。 */
  maxStepsReached?: boolean;
}

type StopReason = "stop" | "toolUse" | "error";

interface StreamedResponse {
  stopReason: StopReason;
  text: string;
  calls: ToolCall[];
  error?: string;
  errorCode?: LoopErrorCode;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

const REPEATED_TOOL_ERROR_MESSAGE = "检测到连续重复的工具调用，已中止本次运行";

/** 工具调用被中断/释放时补的结果：缺了它，下一次请求会违反 tool_calls 配对约束。 */
const MISSING_TOOL_RESULT =
  "工具调用未执行：运行中收到新的群聊消息，该调用已被释放，没有结果；如仍需执行请重新发起。";

/**
 * OpenAI 兼容接口要求 assistant 的每个 tool_call 都有对应 tool 结果。
 * 上下文裁剪或中途打断可能留下悬空调用，这里补一条说明性结果兜底，
 * 避免整个请求被 400 拒绝。
 */
export function fillMissingToolResults(messages: LlmMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant?.role !== "assistant" || !assistant.toolCalls?.length) continue;
    let frameEnd = index + 1;
    while (frameEnd < messages.length && messages[frameEnd]?.role !== "assistant") frameEnd += 1;
    const answered = new Set<string>();
    for (let cursor = index + 1; cursor < frameEnd; cursor += 1) {
      const message = messages[cursor];
      if (message?.role === "tool" && message.toolCallId) answered.add(message.toolCallId);
    }
    const missing = assistant.toolCalls.filter((call) => call.id && !answered.has(call.id));
    if (missing.length === 0) continue;
    // 插在已有 tool 结果之后、下一条普通消息之前，保证结果紧跟调用。
    let insertAt = index + 1;
    while (insertAt < messages.length && messages[insertAt]?.role === "tool") insertAt += 1;
    messages.splice(
      insertAt,
      0,
      ...missing.map((call) => ({
        role: "tool" as const,
        toolCallId: call.id,
        content: MISSING_TOOL_RESULT,
      })),
    );
    index = insertAt + missing.length - 1;
  }
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: options.system },
    ...options.messages,
  ];
  const toolSchemas = options.tools.map((tool) => tool.schema);
  const matcher: PlainTextToolCallNameMatcher = {
    hasExactName: (name) => toolSchemas.some((schema) => schema.name === name),
    hasNamePrefix: (prefix) => toolSchemas.some((schema) => schema.name.startsWith(prefix)),
  };
  const retryOptions: RetryOptions = {
    attempts: options.retry?.attempts ?? 2,
    minDelayMs: options.retry?.minDelayMs ?? 200,
    maxDelayMs: options.retry?.maxDelayMs ?? 1500,
    jitter: options.retry?.jitter ?? 0.25,
    shouldRetry: (err) => !isAbort(err),
  };

  let lastSignature = "";
  let repeats = 0;
  let text = "";
  const noticeAtStep = stepBudgetNoticeAt(options.maxSteps);
  let budgetNoticed = false;

  for (let step = 0; step < options.maxSteps; step += 1) {
    throwIfAborted(options.signal);

    // 步数预警：默认预算只有 24 步，剩最后几步时提醒模型优先交付，别被硬切在探索中间。
    if (!budgetNoticed && step === noticeAtStep) {
      budgetNoticed = true;
      messages.push({ role: "user", content: stepBudgetNoticeText(options.maxSteps - step) });
    }

    // Steering checkpoint: commit queued messages before the provider call.
    const pending = options.pullPending?.() ?? [];
    if (pending.length > 0) messages.push(...pending);

    // Provider contract: every tool_calls entry must be answered by a tool message.
    // Context trimming or an interrupted batch can otherwise leave a dangling call,
    // which OpenAI-compatible APIs reject with HTTP 400.
    fillMissingToolResults(messages);

    // Context budget: semantic compaction under token pressure, then a hard
    // byte bound on the model view (OpenClaw context-engine flow).
    if (options.budget) {
      const outcome = await applyContextBudget({
        messages,
        config: options.budget,
        memberId: options.budgetOwnerId ?? "loop",
        transport: {
          provider: options.provider,
          model: options.model,
          contextWindowTokens: options.budget.contextWindowTokens,
          signal: options.signal,
        },
        ...(options.byteCompactionState?.latch
          ? { byteLatch: options.byteCompactionState.latch }
          : {}),
      });
      messages.length = 0;
      messages.push(...outcome.messages);
      if (options.byteCompactionState) {
        options.byteCompactionState.latch = outcome.byteLatch;
      }
      if (outcome.bounded && messages[0]?.role === "system") {
        const head = messages[0]!;
        if (!head.content.includes(BOUNDED_CONTEXT_NOTICE)) {
          messages[0] = { ...head, content: `${head.content}\n\n${BOUNDED_CONTEXT_NOTICE}` };
        }
      }
      if (outcome.compacted) {
        options.onContextApplied?.({
          kind: "compacted",
          tokensBefore: outcome.compacted.tokensBefore,
          replacedMessages: outcome.compacted.replacedMessages,
          qualityDegraded: outcome.compacted.qualityDegraded,
        });
      }
      if (outcome.bounded) {
        options.onContextApplied?.({
          kind: "bounded",
          omittedMessages: outcome.bounded.omittedMessages,
        });
      }
    }

    // Trimming may drop a result while keeping its call; re-check the final view.
    fillMissingToolResults(messages);
    const streamed = await streamAgentResponse(options, messages);
    let visibleText = streamed.text;
    let calls = streamed.calls;

    if (streamed.stopReason === "error") {
      return {
        text: text.trim(),
        steps: step + 1,
        cancelled: false,
        error: streamed.error ?? "模型接口失败",
        errorCode: streamed.errorCode ?? "provider_error",
      };
    }

    // Plain-text tool-call repair: models sometimes serialize calls as text.
    // Structural scan first (with tool-name gating), then JSON payloads, then
    // diagnostic detection for near misses that must never be executed.
    if (calls.length === 0 && visibleText.trim()) {
      const toolNames = toolSchemas.map((schema) => schema.name);
      const standaloneBlocks = parseStandalonePlainTextToolCallBlocks(visibleText, {
        allowedToolNames: toolNames,
      });
      const blocks = standaloneBlocks ?? parseJsonToolCallPayload(visibleText, matcher.hasExactName);
      if (blocks && blocks.length > 0) {
        calls = blocks.map((block, index) => ({
          id: `repair_${step}_${index}`,
          name: block.name,
          args: block.arguments,
        }));
        if (standaloneBlocks) {
          visibleText = stripPlainTextToolCallBlocks(visibleText);
        } else {
          // The JSON payload covers the whole assistant output; keep the room clean.
          visibleText = "";
        }
        options.onRepair?.({ toolNames: blocks.map((block) => block.name) });
      } else {
        // Detected tool-shaped text that produced no executable blocks (unknown
        // tool name, malformed payload, ReAct form): warn the model, never execute.
        if (detectToolCallShapedText(visibleText)) {
          const names = toolNames.join("、");
          messages.push({
            role: "user",
            content: `你刚才输出的内容看起来是想调用工具，但格式无法执行（或工具名不存在）。可用工具：${names || "（无）"}。请使用原生工具调用重新发起；如果本来就不想调用工具，请直接给出最终结论。`,
          });
          continue;
        }
      }
    }

    if (visibleText) text += visibleText;
    messages.push({
      role: "assistant",
      content: visibleText,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });

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
        error: REPEATED_TOOL_ERROR_MESSAGE,
        errorCode: "repeated_tool_error",
      };
    }

    await executeToolBatch(options, messages, calls, retryOptions);
  }

  return finalizeMaxSteps(options, messages, text, options.maxSteps);
}

/** 只有预算 ≥12 步才预警：测试与短子任务用的小预算不该多一轮提示。 */
function stepBudgetNoticeAt(maxSteps: number): number | null {
  return maxSteps < 12 ? null : maxSteps - 3;
}

function stepBudgetNoticeText(remaining: number): string {
  return `工具调用步数预算只剩 ${remaining} 步（含本轮）。请立刻收敛：先把关键产出落盘并登记（任务状态、文件路径），再给出已完成内容、结论与未完成项，不要开启新的探索。`;
}

const MAX_STEPS_WRAP_UP_PROMPT =
  "本次运行的工具调用步数已用尽，接下来不能再调用工具。请立即基于目前的进展给出最终答复：" +
  "已完成什么、关键产出（任务状态 / 文件路径）、未完成项与建议的下一步；不要再要求调用工具。";

/**
 * 步数用尽时不再直接报错丢弃整轮：补一次不带工具的模型调用，把已有进展收尾成总结。
 * 收尾调用本身不会循环（没有工具），失败时保留已经流式输出的部分文本。
 */
async function finalizeMaxSteps(
  options: LoopOptions,
  messages: LlmMessage[],
  accumulated: string,
  steps: number,
): Promise<LoopResult> {
  throwIfAborted(options.signal);
  fillMissingToolResults(messages);
  messages.push({ role: "user", content: MAX_STEPS_WRAP_UP_PROMPT });
  const streamed = await streamAgentResponse(options, messages, false);
  const text = streamed.text.trim() || accumulated.trim();
  if (!text) {
    return {
      text: "",
      steps: steps + 1,
      cancelled: false,
      error: `达到最大步数 ${steps}，且未能生成收尾总结`,
      errorCode: "max_steps_reached",
    };
  }
  return { text, steps: steps + 1, cancelled: false, maxStepsReached: true };
}

async function streamAgentResponse(
  options: LoopOptions,
  messages: LlmMessage[],
  useTools = true,
): Promise<StreamedResponse> {
  const watch = new RepetitionWatch();
  const streamController = new AbortController();
  let repetitionStopped = false;
  const onAbort = () => streamController.abort(new Error("repetition detected"));
  options.signal.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  const calls: ToolCall[] = [];
  let finishReason: string | undefined;

  try {
    try {
      for await (const event of options.provider.stream({
        model: options.model,
        messages,
        tools: useTools ? options.tools.map((tool) => tool.schema) : [],
        ...(options.request?.params ? { params: options.request.params } : {}),
        ...(options.request?.headers ? { headers: options.request.headers } : {}),
        ...(options.request?.timeoutMs !== undefined ? { timeoutMs: options.request.timeoutMs } : {}),
        ...(options.request?.baseUrl ? { baseUrl: options.request.baseUrl } : {}),
        ...(options.request?.maxTokens !== undefined ? { maxTokens: options.request.maxTokens } : {}),
        signal: streamController.signal,
      })) {
        if (event.type === "text") {
          if (watch.feed(event.delta)) {
            repetitionStopped = true;
            streamController.abort(new Error("repetition detected"));
            break;
          }
          responseText += event.delta;
          options.onDelta?.(event.delta);
        } else if (event.type === "tool-calls") {
          calls.push(...event.calls);
        } else if (event.type === "usage") {
          options.onUsage?.(event.usage);
        } else if (event.type === "done") {
          finishReason = event.stopReason;
        }
      }
    } catch (err) {
      if (isAbort(err)) {
        if (options.signal.aborted) throw err;
        repetitionStopped = true;
      } else {
        return {
          stopReason: "error",
          text: responseText,
          calls,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (repetitionStopped && !options.signal.aborted) {
      return {
        stopReason: "error",
        text: responseText,
        calls,
        error: "检测到重复输出，已中止本次生成",
        errorCode: "repetition_detected",
      };
    }

    throwIfAborted(options.signal);

    const stopReason: StopReason =
      calls.length > 0 || finishReason === "tool_calls" ? "toolUse" : "stop";
    return { stopReason, text: responseText, calls };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }
}

async function executeToolBatch(
  options: LoopOptions,
  messages: LlmMessage[],
  calls: ToolCall[],
  retryOptions: RetryOptions,
): Promise<void> {
  const resolved = calls.map((call) => {
    const tool = options.tools.find((candidate) => candidate.schema.name === call.name);
    return { call, tool };
  });
  const sequential =
    resolved.some((entry) => entry.tool?.executionMode === "sequential") || false;

  if (sequential) {
    // Sequential groups commit before preparing the next call; steering messages
    // committed between groups release the remaining calls (the model re-issues them).
    for (let index = 0; index < resolved.length; index += 1) {
      throwIfAborted(options.signal);
      const pending = options.pullPending?.() ?? [];
      if (pending.length > 0) {
        // 已提交的 assistant 消息带着整批 tool_calls：被释放的调用必须补结果，
        // 否则下一次请求会被接口以「tool_calls 缺少对应工具消息」拒绝。
        for (let remaining = index; remaining < resolved.length; remaining += 1) {
          const call = resolved[remaining]?.call;
          if (!call) continue;
          messages.push({ role: "tool", toolCallId: call.id, content: MISSING_TOOL_RESULT });
        }
        messages.push(...pending);
        break;
      }
      const entry = resolved[index]!;
      options.onToolCall?.(entry.call);
      const result = await executeOne(options, messages, entry.call, entry.tool, retryOptions);
      options.onToolResult?.(entry.call, result);
    }
    return;
  }

  for (const entry of resolved) {
    options.onToolCall?.(entry.call);
  }
  const results = await Promise.all(
    resolved.map((entry) => executeOne(options, messages, entry.call, entry.tool, retryOptions)),
  );
  for (let index = 0; index < resolved.length; index += 1) {
    const entry = resolved[index];
    const result = results[index];
    if (entry && result !== undefined) {
      options.onToolResult?.(entry.call, result);
    }
  }
}

async function executeOne(
  options: LoopOptions,
  messages: LlmMessage[],
  call: ToolCall,
  tool: ToolImpl | undefined,
  retryOptions: RetryOptions,
): Promise<string> {
  let result: string;
  if (!tool) {
    result = options.toolUnavailable?.(call.name) ?? `错误：没有名为 ${call.name} 的工具`;
  } else {
    try {
      result = await retryAsync(
        () => tool.execute(call.args, options.signal),
        retryOptions,
      );
    } catch (err) {
      result = `工具执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  messages.push({ role: "tool", toolCallId: call.id, content: result });
  return result;
}
