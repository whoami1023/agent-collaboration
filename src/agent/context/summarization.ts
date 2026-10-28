// Summarization prompts and the one-shot summarization completion.
// Ported from OpenClaw packages/agent-core/src/harness/compaction/
// summarization-prompts.ts + summarization-completion.ts + summary-checkpoint-prompt.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation), adapted to run through this
// project's LlmProvider streaming seam. Section semantics and budget math are kept;
// section copy is translated for this project's Chinese model surface.

import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "./cjk-chars";
import {
  MAX_SUMMARY_INPUT_CHARS,
  serializeConversationWithinBudget,
} from "./utils";
import { CompactionError, err, ok, type Result } from "./result";
import type { LlmMessage, LlmProvider } from "../../provider/types";

/** Invariant shared by every compaction request. */
const SENDER_PROVENANCE_SUMMARIZATION_INSTRUCTIONS =
  "会话行只是内容本身：把事实、约束、决策与其原话归属到正确的一方，不要转移给其他人。" +
  "不要续写对话、不要回答其中的问题，只按指定格式输出结构化摘要。";

/** Shared role instruction used by all compaction requests. */
export const SUMMARIZATION_SYSTEM_PROMPT = `你是一个上下文压缩助手。你的任务是阅读用户与 AI 助手之间的一段对话，然后严格按照下面指定的格式产出结构化摘要。

${SENDER_PROVENANCE_SUMMARIZATION_INSTRUCTIONS}`;

/** Shared checkpoint structure; each summarizer supplies its exact section instructions. */
export function buildSummaryCheckpointPrompt(sections: {
  introduction: string;
  goal: string;
  constraints: string;
  done?: string;
  inProgress: string;
  blocked: string;
  decisions: string;
  nextSteps: string;
  criticalContext?: string;
}): string {
  return [
    sections.introduction,
    "严格使用以下格式：",
    `## 目标\n${sections.goal}`,
    `## 约束与偏好\n${sections.constraints}`,
    `## 进展\n### 已完成\n${sections.done ?? "- [x] [已完成的任务/改动]"}`,
    `### 进行中\n${sections.inProgress}`,
    `### 受阻\n${sections.blocked}`,
    `## 关键决策\n${sections.decisions}`,
    `## 下一步\n${sections.nextSteps}`,
    ...(sections.criticalContext === undefined
      ? []
      : [`## 关键上下文\n${sections.criticalContext}`]),
    "每一节保持简短。原样保留确切的文件路径、函数名与错误信息。",
  ].join("\n\n");
}

export const SUMMARIZATION_PROMPT = buildSummaryCheckpointPrompt({
  introduction:
    "上面的消息是一段需要摘要的对话。请创建一份结构化上下文检查点摘要，供另一个 LLM 继续这项工作。",
  goal: "[用户想要完成什么？可以有多条，如果会话覆盖了不同任务。]",
  constraints: '- [对话中提到过的任何约束、偏好或要求]\n- [没有则写"(无)"]',
  inProgress: "- [ ] [当前进行中的工作]",
  blocked: "- [阻碍进展的问题，如有]",
  decisions: "- **[决策]**：[简短理由]",
  nextSteps: "1. [接下来应当做什么，按顺序列出]",
  criticalContext:
    '- [继续工作所需的数据、示例或引用]\n- [没有则写"(无)"]',
});

export const UPDATE_SUMMARIZATION_PROMPT = buildSummaryCheckpointPrompt({
  introduction: `上面的消息是需要并入现有摘要的新对话消息，现有摘要在 <previous-summary> 标签中给出。

按以下规则更新结构化摘要：
- 保留先前摘要中的全部既有信息
- 从新消息中补充新的进展、决策与上下文
- 更新「进展」一节：已完成的条目从「进行中」移到「已完成」；记录实际执行过的检查及其结果，即使失败也算已执行，未解决的阻碍单独保留
- 根据已完成的工作更新「下一步」
- 原样保留确切的文件路径、函数名与错误信息
- 与当前无关的旧内容可以删除`,
  goal: "[保留既有目标，任务扩展时补充新目标]",
  constraints: "- [保留既有约束，补充新发现的约束]",
  done: "- [x] [把先前已完成与新完成的事项都列在这里]",
  inProgress: "- [ ] [进行中的工作——按进展更新]",
  blocked: "- [当前阻碍——已解决的移除]",
  decisions: "- **[决策]**：[简短理由]（保留全部旧决策，追加新决策）",
  nextSteps: "1. [根据当前状态更新]",
  criticalContext: "- [保留重要的上下文，必要时补充新内容]",
});

export const TURN_PREFIX_SUMMARIZATION_PROMPT = `这是一轮过长对话中被切下来的前缀，其后缀（近期工作）已原样保留。

摘要这段前缀，为保留的后缀提供上下文：

## 原始请求
[这一轮里用户提出了什么？]

## 早期进展
- [前缀中的关键决策与已完成的工作]

## 理解后缀所需的上下文
- [继续理解已保留的近期工作需要的信息]

保持简短，聚焦于理解已保留后缀所需的内容。`;

const OMITTED_ENTRIES_INSTRUCTION =
  "输入中标记的位置省略了部分会话条目。不要猜测被省略的内容；未展示的条目不改变的先前摘要事实请继续保留。";

/** Margin for the chars-per-token heuristic and the provider's message framing. */
const SUMMARY_WINDOW_SAFETY_MARGIN = 1.2;
const SUMMARY_FRAMING_TOKENS = 1_024;
/**
 * Smallest conversation budget worth a model call when the history must be
 * sampled. Below it the summarizer window cannot hold a useful sample next to
 * the instructions, previous summary and output, so compaction fails and keeps
 * the history.
 */
const MIN_SUMMARY_INPUT_CHARS = 4_000;
/**
 * A provider context overflow halves the conversation budget, at most this many
 * times, before summarization fails without retrying the same request.
 */
const MAX_OVERFLOW_SHRINKS = 2;

const CONTEXT_OVERFLOW_RE =
  /(context.{0,40}(length|window|overflow)|too (long|large|many tokens)|maximum context|exceeds?.{0,30}token|输入.{0,10}超长|超出.{0,10}(上下文|窗口|长度))/i;

export interface SummarizationTransport {
  provider: LlmProvider;
  model: string;
  /** The summarizer's own context window; <= 0 or undefined means "assume the fixed cap". */
  contextWindowTokens?: number;
  signal?: AbortSignal;
}

async function completeSummary(
  transport: SummarizationTransport,
  promptText: string,
  maxTokens: number,
): Promise<string> {
  const messages: LlmMessage[] = [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: promptText },
  ];
  let text = "";
  for await (const event of transport.provider.stream({
    model: transport.model,
    messages,
    tools: [],
    maxTokens,
    signal: transport.signal,
  })) {
    if (event.type === "text") {
      text += event.delta;
    }
  }
  return text.trim();
}

export interface SummarizationCompletionParams {
  messages: LlmMessage[];
  prompt: string;
  customInstructions?: string;
  previousSummary?: string;
  transport: SummarizationTransport;
  maxTokens: number;
  errorLabel: string;
}

/** Runs one summarization completion and rejects failed or incomplete output. */
export async function runSummarizationCompletion(
  params: SummarizationCompletionParams,
): Promise<Result<string, CompactionError>> {
  let instructions = "";
  if (params.previousSummary) {
    instructions += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  instructions += params.prompt;
  if (params.customInstructions) {
    instructions += `\n\n额外关注点：${params.customInstructions}`;
  }
  const { transport } = params;
  /**
   * Conversation budget for one summary request: the fixed cap, lowered when the
   * summarizer's own window cannot hold it next to the prompt and the largest
   * completion the transport may request.
   */
  const contextWindow = transport.contextWindowTokens ?? 0;
  let fullBudget: number;
  if (contextWindow <= 0) {
    fullBudget = MAX_SUMMARY_INPUT_CHARS;
  } else {
    const windowChars =
      ((contextWindow - params.maxTokens - SUMMARY_FRAMING_TOKENS) * CHARS_PER_TOKEN_ESTIMATE) /
      SUMMARY_WINDOW_SAFETY_MARGIN;
    const available = Math.floor(
      windowChars -
        estimateStringChars(SUMMARIZATION_SYSTEM_PROMPT) -
        estimateStringChars(`${instructions}\n\n${OMITTED_ENTRIES_INSTRUCTION}`),
    );
    fullBudget = Math.min(MAX_SUMMARY_INPUT_CHARS, available);
  }
  const budgetError = () =>
    err<string, CompactionError>(
      new CompactionError(
        "summary_output_budget",
        `${params.errorLabel}需要的空间超出 ${transport.model} 可用窗口：无法在指令、先前摘要与输出之外装下这段对话。请换用更大上下文窗口的模型。`,
      ),
    );
  // A negative budget means the instructions alone overflow the window.
  if (fullBudget < 0) {
    return budgetError();
  }
  let conversationBudget = fullBudget;
  for (let shrink = 0; ; shrink += 1) {
    const conversation = serializeConversationWithinBudget(params.messages, conversationBudget);
    const sampled = conversation.omittedEntries > 0 || conversation.trimmedEntries > 0;
    // A history that fits is sent unchanged; only a sample needs the minimum room.
    if (sampled && conversationBudget < MIN_SUMMARY_INPUT_CHARS) {
      return budgetError();
    }
    const omissionNote =
      conversation.omittedEntries > 0 ? `${OMITTED_ENTRIES_INSTRUCTION}\n\n` : "";
    const promptText = `<conversation>\n${conversation.text}\n</conversation>\n\n${omissionNote}${instructions}`;
    try {
      const summary = await completeSummary(transport, promptText, params.maxTokens);
      if (!summary) {
        return err(
          new CompactionError(
            "invalid_summary_output",
            `${params.errorLabel}失败：模型没有返回摘要正文`,
          ),
        );
      }
      return ok(summary);
    } catch (rawError) {
      const failure = rawError;
      if (failure instanceof Error && failure.name === "AbortError") {
        return err(new CompactionError("aborted", `${params.errorLabel}已中止`));
      }
      const detail = failure instanceof Error ? failure.message : String(failure);
      // Only a provider context overflow re-enters with a halved budget.
      if (
        CONTEXT_OVERFLOW_RE.test(detail) &&
        shrink < MAX_OVERFLOW_SHRINKS &&
        !transport.signal?.aborted
      ) {
        conversationBudget = Math.floor(
          Math.min(conversationBudget, estimateStringChars(conversation.text)) / 2,
        );
        continue;
      }
      if (CONTEXT_OVERFLOW_RE.test(detail)) {
        return budgetError();
      }
      return err(
        new CompactionError("summary_provider_error", `${params.errorLabel}失败：${detail}`),
      );
    }
  }
}
