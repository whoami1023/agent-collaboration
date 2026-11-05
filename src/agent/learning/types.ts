// 学习层（P1：回合后复盘 → 长期记忆；P2：技能自学 → 人工批准后进技能库）的数据契约与硬约束。
// 机制对应 Hermes Agent 的 background review：一次运行交付后，另起一次没有工具的模型调用，
// 只判断「这一轮里有没有值得长期记住的事实、有没有值得沉淀的做法」。
// 记忆可以按设置自动写入，技能永远只产出提案——建技能会改变智能体以后的行为，必须由人拍板。

import type { SkillCategory } from "../../skills/categories";
import type { LearningMode, LearningSettings } from "../../core/settings";

export type { LearningMode, LearningSettings };

/** 学习层的固定口径：上限都收在这里，提示词、校验与存储共用一份，避免两边漂移。 */
export const LEARNING_RULES = {
  /** 单次复盘最多产出几条候选（Hermes 同样按小数目约束，防止把记忆写成流水账）。 */
  maxEntriesPerReview: 3,
  /** 单次复盘最多提议几个技能：技能比记忆更重，一次只沉淀一个做法。 */
  maxSkillsPerReview: 1,
  /** 单条记忆正文长度上限（字符）。 */
  maxContentChars: 200,
  maxTriggerChars: 40,
  maxTriggers: 5,
  maxRationaleChars: 120,
  /** 技能提案字段上限，与技能库的创建校验保持同一口径（名称 48 / 描述 160 / 说明 20000）。 */
  maxSkillNameChars: 48,
  maxSkillDescriptionChars: 160,
  maxSkillInstructionsChars: 8000,
  minSkillInstructionsChars: 40,
  /** 少于这么多字的回复没什么可学的，直接跳过复盘。 */
  minFinalTextChars: 40,
  /** 喂给复盘模型的群聊记录、已有记忆与已有技能长度上限。 */
  transcriptChars: 6000,
  memorySnapshotChars: 3000,
  skillSnapshotChars: 2000,
  /** 复盘模型调用的墙上时钟上限。 */
  reviewTimeoutMs: 60_000,
  maxProposals: 300,
  maxLogEntries: 200,
} as const;

export type ProposalStatus = "pending" | "applied" | "dismissed";

export type ProposalKind = "memory" | "skill";

/** 记忆写入目标：主智能体写账号级 MEMORY.md，子成员写自己的 agents/<id>/MEMORY.md。 */
export type MemoryTarget = "account" | "member";

interface ProposalBase {
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
  /** 复盘模型给出的依据（引用本轮原话的短摘录），只用于展示，不写进记忆或技能。 */
  rationale: string;
  appliedAt?: number;
  /** 落地位置：记忆是相对路径，技能是「技能库/<技能名>」，供面板给出「去哪核对」。 */
  appliedPath?: string;
  /** 技能提案落地后回填的技能 ID 与名称。 */
  appliedSkillId?: string;
  appliedSkillName?: string;
  dismissReason?: string;
}

export interface MemoryProposal extends ProposalBase {
  kind: "memory";
  target: MemoryTarget;
  content: string;
  triggers: string[];
  importance: number;
}

/** 技能提案的载荷：采纳后按这份草稿创建一条账号级个人技能。 */
export interface SkillDraft {
  /** 小写短横线 slug，创建时仍会过技能库的同一套校验。 */
  name: string;
  description: string;
  /** SKILL.md 正文（Markdown 步骤）。 */
  instructions: string;
  category: SkillCategory;
  triggers: string[];
}

export interface SkillProposal extends ProposalBase {
  kind: "skill";
  skill: SkillDraft;
}

/** 学习面板与 API 里流通的提案：按 kind 区分落地通道。 */
export type LearningProposal = MemoryProposal | SkillProposal;

/** 状态流转只改基座字段；载荷在提案创建后不再变。 */
export type ProposalPatch = Partial<Omit<ProposalBase, "id" | "createdAt">>;

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
