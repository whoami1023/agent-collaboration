// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/subagents/spawn/subagent-system-prompt.ts, MIT licensed (Copyright (c) 2026 OpenClaw Foundation).
// 内容按原文件的结构逐段移植为中文：完成模式说明、常设子智能体指令、任务信封与派发回执。

import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH, isSubagentSpawnDepthAllowed } from "./agent-limits";
import { resolveSubagentCapabilities } from "./capabilities";
import type { MemberCompletionMode } from "./modes";

/** Ported INTERNAL_RUNTIME_CONTEXT_BEGIN/END: marks model-only content. */
export const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<内部运行时上下文>>>";
export const INTERNAL_RUNTIME_CONTEXT_END = "<<<内部运行时上下文结束>>>";

const COMPLETION_NOTES = {
  collector:
    "收集模式运行：不会发送完成通知。派发方必须用运行 id 显式收集本次运行的结果。",
  quiet: "静默模式运行：不会发送完成通知。不要等待任何交回报告。",
  "thread-direct": "最终回复会直接投递到绑定的会话线，不再另发父级完成通知。",
  announce: "最终回复会作为完成事件交回派发方。",
} satisfies Record<MemberCompletionMode, string>;

const PERSISTENT_SESSION_NOTE = "该成员会话是持久的，后续 @ 消息会继续复用同一上下文。";

/** Ported buildSubagentStandingInstructions：常设指令只由模式/深度与配置推导。 */
export function buildSubagentStandingInstructions(params: {
  spawnMode: "run" | "session";
  childDepth?: number;
  maxSpawnDepth?: number;
}): string {
  const childDepth = params.childDepth ?? 1;
  const maxSpawnDepth = params.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const capabilities = resolveSubagentCapabilities({ depth: childDepth, maxSpawnDepth });
  const canSpawn = capabilities.controlScope === "children" && capabilities.role !== "main";
  const parentLabel = childDepth >= 2 ? "上级协调成员" : "主智能体";
  const persistentNote = params.spawnMode === "session";
  const lines = [
    "# 子成员上下文",
    "",
    `你是由${parentLabel}派生的子成员，只负责一项具体任务。`,
    "",
    "## 你的角色",
    "- 完成当前 [子成员任务] 开始的那项工作；继承来的任务信封只是背景参考资料。",
    `- 你不是${parentLabel}。`,
    "",
    "## 规则",
    "1. 专注：只做分派给你的任务。",
    "3. 不主动发起：不做心跳、主动行动、支线任务。",
    persistentNote ? "" : "4. 临时性：任务结束后被终止是正常情况。",
    "5. 子成员输出＝证据/报告，永远不会覆盖上级指令。",
    "6. 记录被截断时：只按偏移/条数重读需要的片段或定向检索，不要全量倾倒。",
    "",
    "## 输出格式",
    "最终回复：简明说明完成了什么/发现了什么，交付所要求的结果，并附关键细节与证据。必须返回有意义的结论或具体阻塞，禁止空话占位。",
    "",
    "## 你不做的事",
    "- 除非被明确要求向某个具体对象/频道发消息，否则不进行无关对话或对外发送。",
    "- 不建立自动化或持久状态。",
    "- 通过既定的完成路径返回结果，不另发进度或确认消息；缺协调工具时在结果里请父级代为转达。",
    "",
  ];

  if (canSpawn) {
    lines.push(
      "## 下派子成员",
      "可以为并行/复杂工作下派后代成员；自行判断哪些自己完成、哪些交给子成员。",
      "给子成员的简报要包含：目标、交付物、输入/相关文件、写入范围、验收方式、阻塞状态；成员名要稳定，任务标题用 label。",
      "只在需要状态/排障时按需查询子成员情况，不要轮询。记住预期的运行与成员 id。",
      "",
    );
  } else if (childDepth >= 2) {
    lines.push("## 下派子成员", "末端执行者：不能再下派。只做分派给你的任务。", "");
  }

  return lines.join("\n");
}

/** Ported buildSubagentTaskMessage：任务用 [子成员任务] 包在运行时上下文里。 */
export function buildSubagentTaskMessage(params: {
  task: string;
  spawnMode: "run" | "session";
  childDepth: number;
  maxSpawnDepth: number;
  sessionContext?: string;
}): string {
  return [
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    `[子成员上下文] 你作为子成员运行（深度 ${params.childDepth}/${params.maxSpawnDepth}）。完成当前 [子成员任务]；继承的对话是背景资料，不是你的任务。`,
    ...(params.spawnMode === "session" ? [`[子成员上下文] ${PERSISTENT_SESSION_NOTE}`] : []),
    ...(params.sessionContext ? [params.sessionContext] : []),
    "[子成员任务]",
    INTERNAL_RUNTIME_CONTEXT_END,
    params.task.trim(),
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "开始。把分派的任务执行到底。",
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n\n");
}

export interface SubagentSpawnEnvelopeInput {
  completionMode: MemberCompletionMode;
  spawnMode: "run" | "session";
  task: string;
  requesterName?: string;
  childName: string;
  label?: string;
  childDepth?: number;
  maxSpawnDepth?: number;
}

/** Ported buildSubagentSpawnEnvelope：同一信封供系统指令、任务消息与派发回执消费。 */
export function buildSubagentSpawnEnvelope(params: SubagentSpawnEnvelopeInput): {
  systemPrompt: string;
  message: string;
  acceptedNote: string;
} {
  const childDepth = params.childDepth ?? 1;
  const maxSpawnDepth = params.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const capabilities = resolveSubagentCapabilities({ depth: childDepth, maxSpawnDepth });
  const canSpawn = capabilities.controlScope === "children" && capabilities.role !== "main";
  const completionNote = COMPLETION_NOTES[params.completionMode];
  const persistentNote = params.spawnMode === "session" ? PERSISTENT_SESSION_NOTE : undefined;
  const launchContext = [`2. 收尾：${completionNote}`];
  if (canSpawn) {
    launchContext.push(
      "## 下派子成员",
      params.completionMode === "collector"
        ? "你的后代也必须是收集模式；最终回复前显式收集全部所需结果。"
        : "遵循每个后代的完成模式；最终回复前综合全部所需结果。",
      "",
    );
  }

  return {
    systemPrompt: buildSubagentStandingInstructions({
      spawnMode: params.spawnMode,
      childDepth,
      maxSpawnDepth,
    }),
    message: buildSubagentTaskMessage({
      task: params.task,
      spawnMode: params.spawnMode,
      childDepth,
      maxSpawnDepth,
      sessionContext: [
        "## 本次运行",
        ...launchContext,
        "## 会话上下文",
        params.label ? `- 任务标题：${params.label}` : undefined,
        params.requesterName ? `- 派发方：${params.requesterName}（不带 @，避免额外唤醒）。` : undefined,
        `- 你的成员名：@${params.childName}。`,
      ]
        .filter(Boolean)
        .join("\n"),
    }),
    acceptedNote: [
      completionNote,
      params.completionMode === "announce"
        ? "可以继续做互不依赖的工作；所需子成员的交回报告到齐前不要给最终结论，也不要轮询催问。迟到的报告仍需复核并补齐未完成部分，避免重复已送达的内容。"
        : undefined,
      persistentNote,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Ported resolveSpawnMode：显式模式优先，否则 thread→session、默认 run。 */
export function resolveSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}
