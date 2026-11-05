// 学习层（P1：回合后复盘 → 长期记忆）的数据契约与硬约束。
// 机制对应 Hermes Agent 的 background review：一次运行交付后，另起一次没有工具的模型调用，
// 只判断「这一轮里有没有值得长期记住的事实」，写入通道只有受控追加的记忆文件。

import type { LearningMode, LearningSettings } from "../../core/settings";

export type { LearningMode, LearningSettings };

/** 学习层的固定口径：上限都收在这里，提示词、校验与存储共用一份，避免两边漂移。 */
export const LEARNING_RULES = {
  /** 单次复盘最多产出几条候选（Hermes 同样按小数目约束，防止把记忆写成流水账）。 */
  maxEntriesPerReview: 3,
  /** 单条记忆正文长度上限（字符）。 */
  maxContentChars: 200,
  maxTriggerChars: 40,
  maxTriggers: 5,
  maxRationaleChars: 120,
  /** 少于这么多字的回复没什么可学的，直接跳过复盘。 */
  minFinalTextChars: 40,
  /** 喂给复盘模型的群聊记录与已有记忆长度上限。 */
  transcriptChars: 6000,
  memorySnapshotChars: 3000,
  /** 复盘模型调用的墙上时钟上限。 */
  reviewTimeoutMs: 60_000,
  maxProposals: 300,
  maxLogEntries: 200,
} as const;

export type ProposalStatus = "pending" | "applied" | "dismissed";

/** 记忆写入目标：主智能体写账号级 MEMORY.md，子成员写自己的 agents/<id>/MEMORY.md。 */
export type MemoryTarget = "account" | "member";

export interface MemoryProposal {
  id: string;
  status: ProposalStatus;
  createdAt: number;
  updatedAt: number;
  memberId: string;
  memberName: string;
  memberRole: "main" | "sub";
  roomId: string;
  roomName: string;
  runId: string;
  target: MemoryTarget;
  content: string;
  triggers: string[];
  importance: number;
  /** 复盘模型给出的依据（引用本轮原话的短摘录），只用于展示，不写进记忆文件。 */
  rationale: string;
  appliedAt?: number;
  /** 实际写入的相对路径（apply 之后回填，供面板给出「去哪核对」）。 */
  appliedPath?: string;
  dismissReason?: string;
}

export type ReviewOutcome = "proposed" | "applied" | "nothing" | "skipped" | "failed";

/** 一次复盘的流水账：面板据此解释「为什么没学到东西」。 */
export interface ReviewLog {
  id: string;
  at: number;
  memberId: string;
  memberName: string;
  roomId: string;
  runId: string;
  outcome: ReviewOutcome;
  detail: string;
  proposalIds: string[];
  modelRef: string;
}

/** 成员运行结束后交给复盘的素材。 */
export interface LearningRunInput {
  memberId: string;
  memberName: string;
  memberRole: "main" | "sub";
  /** 成员自己选的模型；学习设置没指定复盘模型时跟随它。 */
  modelRef: string;
  roomId: string;
  roomName: string;
  runId: string;
  triggerText: string;
  finalText: string;
  /** 本轮实际调用过的工具名（去重后），帮助复盘判断这是「动手」还是「空谈」。 */
  toolNames: string[];
  /** 本轮读到的群聊记录窗口（已经是渲染好的文本）。 */
  transcript: string;
  /** 定时任务唤醒的无人值守运行：与 Hermes 一致，跳过复盘。 */
  unattended: boolean;
}

/** 运行时只依赖这个窄接口，便于测试里塞假实现。 */
export interface LearningHost {
  afterRun(input: LearningRunInput): Promise<void>;
}
