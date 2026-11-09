// 技能策展（学习层第三阶段）的数据契约与硬约束。
// 口径对应 Hermes `agent/curator.py` + `tools/skill_usage.py`：生命周期只由「时间 + 使用次数」决定，
// 一次模型调用只用来判断「哪些技能重复、该吸收进哪一条」，absorbed_into 是合并的必填项。
// 本项目偏离：归档永远先出提案（技能库全局共享，一次归档会让所有账号的智能体都读不到它），
// 且「从没被用过」只标记 stale、永不提议归档 —— 零使用是证据缺失，不是没用的证明。

import type { SkillScope } from "../library";

/** 策展的固定口径：阈值、上限与长度都收在这里，纯函数、存储与提示词共用一份。 */
export const CURATION_RULES = {
  /** 距最近活动多少天算「闲置」（stale）。Hermes 同值 14 天。 */
  staleAfterDays: 14,
  /** 距最近活动多少天才允许提议归档。Hermes 同值 30 天。 */
  archiveAfterDays: 30,
  /** 两次策展 pass 的建议间隔（小时）。Hermes 每周一次，同值 168h。 */
  intervalHours: 168,
  /** 间隔下限：比这更频繁的设置一律抬到它，防止每次开面板都重跑。 */
  minIntervalHours: 24,
  /** 惰性扫描的最小墙钟间隔（毫秒）：读接口再频繁，也不在这个窗口内重复扫。 */
  sweepIntervalMs: 3_600_000,
  /** 技能正文喂给合并模型时每段截断长度。 */
  instructionsPreviewChars: 600,
  /** 一次合并建议最多看多少条候选技能（按使用次数升序取最没人用的）。 */
  maxCandidates: 120,
  /** 一次 pass 最多几条合并提案：宁可分批，也不让面板一次涌出几十条待批。 */
  maxConsolidationsPerPass: 8,
  /** 单个合并最多收拢几条来源技能。 */
  maxSourcesPerMerge: 8,
  /** 新建承接技能时正文的长度上限（仍在技能库 20000 字上限之内）。 */
  maxTargetInstructionsChars: 12000,
  maxReasonChars: 160,
  maxEvidenceSubjects: 6,
  maxProposals: 200,
  maxLogEntries: 100,
  /** 合并模型的墙上时钟上限。 */
  reviewTimeoutMs: 60_000,
} as const;

/**
 * 技能生命周期：active 正常可见，stale 只是「闲置」标记（照常能读），
 * archived 不再注入任何智能体的技能清单与提示词，但正文保留、随时能恢复。
 */
export type SkillLifecycleState = "active" | "stale" | "archived";

/** 挂在 SkillRecord 上的生命周期位，跟着技能库一起落盘——归档要能改变智能体读到什么。 */
export interface SkillLifecycle {
  state: SkillLifecycleState;
  /** 固定：跳过一切自动迁移与归档提案，用户手挑的重要技能靠它免死。 */
  pinned?: boolean;
  archivedAt?: number;
  /** 被哪条技能吸收（Hermes 的 absorbed_into=，合并落地时必填）。 */
  absorbedInto?: string;
  absorbedIntoId?: string;
}

/** 单条技能的使用账本，落在 data/skill-usage.json（全局一份，跨账号统计）。 */
export interface SkillUsageRecord {
  skillId: string;
  /** use_skill 命中次数。 */
  useCount: number;
  /** read_skill_file 命中次数：读了附带文件说明真在动手，但不等于整份技能被用起来。 */
  viewCount: number;
  patchCount: number;
  lastUsedAt?: number;
  lastViewedAt?: number;
  lastPatchedAt?: number;
  /** 每次编辑技能正文就自增，配合 lastReusedPatchGeneration 算「改过之后有没有人再用」。 */
  patchGeneration: number;
  lastReusedPatchGeneration: number;
  /** Hermes 眼里唯一真实的效能信号：最近一次编辑之后又被使用过。 */
  reuseAfterPatch: boolean;
}

export type SkillUsageKind = "use" | "view";

/** 运行时只需要这个窄接口：工具层拿它记账，拿不到实现也不会阻塞群聊。 */
export type SkillUsageRecorder = (skillId: string, kind: SkillUsageKind) => void;

export type CurationProposalKind = "stale" | "archive" | "consolidate";

export type CurationProposalStatus = "pending" | "applied" | "dismissed";

/** 提案来源：确定性扫描、合并模型，还是用户在技能卡片上手动发起。 */
export type CurationOrigin = "sweep" | "model" | "manual";

/** 提案针对的一条技能及其判断依据；面板据此解释「为什么提议归档」。 */
export interface CurationSubject {
  skillId: string;
  skillName: string;
  scope: SkillScope;
  useCount: number;
  viewCount: number;
  patchCount: number;
  /** 距最近活动（用 / 读 / 改）多少天；从没活动过则用技能正文最后更新日。 */
  idleDays: number;
  /** 距最近活动的毫秒时间戳；从未活动时缺省。 */
  lastActivityAt?: number;
}

export interface CurationEvidence {
  subjects: CurationSubject[];
  /** 本次判断用的阈值天数（stale=14 / archive=30；合并建议记 0）。 */
  thresholdDays: number;
  /** 一句话口径说明，面板原样显示。 */
  detail: string;
}

interface CurationProposalBase {
  id: string;
  status: CurationProposalStatus;
  origin: CurationOrigin;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  dismissReason?: string;
  /** 落地后回填：合并提案记下承接技能的 ID，面板给出「去哪核对」。 */
  appliedSkillId?: string;
  /** 发起这次策展的账号：账本全局共用，落地时按它校验「谁能管这条技能」。 */
  ownerId: string;
  ownerName: string;
  reason: string;
  evidence: CurationEvidence;
}

/** stale / archive：只动生命周期状态，一条提案针对一条技能。 */
export interface LifecycleCurationProposal extends CurationProposalBase {
  kind: "stale" | "archive";
  skillId: string;
}

/** 合并提案的承接方：优先复用库里已有的一条，没有才按草稿新建个人技能。 */
export interface ConsolidationTarget {
  skillId?: string;
  name: string;
  description?: string;
  instructions?: string;
}

/**
 * consolidate：把若干条重复技能吸收进一条承接技能。
 * 采纳时先确保承接技能存在，再逐条归档来源并写入 absorbedInto —— 永远不删正文。
 */
export interface ConsolidationCurationProposal extends CurationProposalBase {
  kind: "consolidate";
  sourceIds: string[];
  target: ConsolidationTarget;
}

export type CurationProposal = LifecycleCurationProposal | ConsolidationCurationProposal;

/** 状态流转只改基座字段；载荷在提案创建后不再变。 */
export type CurationProposalPatch = Partial<
  Pick<
    CurationProposalBase,
    "status" | "appliedAt" | "dismissReason" | "appliedSkillId" | "updatedAt"
  >
>;

/** 一条已经落地的生命周期迁移，写进流水供面板回溯「这段时间谁被标记/归档了」。 */
export interface CurationTransition {
  skillId: string;
  skillName: string;
  from: SkillLifecycleState;
  to: SkillLifecycleState;
}

export type CurationOutcome = "transitioned" | "proposed" | "nothing" | "skipped" | "failed";

/** 一次策展 pass 的流水账。 */
export interface CurationLog {
  id: string;
  at: number;
  ownerId: string;
  ownerName: string;
  outcome: CurationOutcome;
  detail: string;
  /** 本次覆盖的候选技能条数（归档/固定/内置不计入）。 */
  scanned: number;
  transitions: CurationTransition[];
  proposalIds: string[];
  modelRef: string;
}
