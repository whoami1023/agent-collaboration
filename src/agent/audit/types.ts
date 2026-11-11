/**
 * 持续审计：围绕任务卡的验收条款，对成员每轮交付做一次有证据的独立核对。
 *
 * 对应 AgentGUI 的 manager audit：验收条款 → 证据 → 通过/失败/存疑 → 有界催办。
 * 审计只读证据，不替成员改任务状态；催办与升级都有硬上限，避免来回空转。
 */

export type AuditVerdict = "pass" | "fail" | "unsure";

export interface AuditCriterionResult {
  id: number;
  criterion: string;
  verdict: AuditVerdict;
  evidence: string;
  /** 失败/存疑时的可执行修复建议。 */
  fixHint?: string;
}

export interface AuditSummary {
  passed: number;
  failed: number;
  unsure: number;
  total: number;
}

export type AuditAction = "none" | "nudge" | "escalate";

export interface AuditRecord {
  id: string;
  roomId: string;
  taskId: string;
  taskTitle: string;
  memberId: string;
  memberName: string;
  runId?: string;
  at: number;
  verdict: AuditVerdict;
  summary: AuditSummary;
  criteria: AuditCriterionResult[];
  /** 证据指纹：同一状态不重复审计、不重复催办。 */
  stateHash: string;
  sources: { messages: number; tools: number; files: string[] };
  action: AuditAction;
  /** 本次审计后累计的连续催办次数（改进后清零）。 */
  interventionCount: number;
  maxInterventions: number;
  /** 验收条款全部通过。 */
  taskSolved: boolean;
  modelRef: string;
  /** 最需要补的一项（失败/存疑优先）。 */
  fixHint?: string;
}

export interface AuditState {
  taskId: string;
  /** 历次审计中通过条款数的最高值，用来判断有没有进展。 */
  bestPassed: number;
  /** 最近一次「改进」之后用掉的连续催办次数。 */
  nudges: number;
  /** 该任务累计催办次数的硬上限计数。 */
  totalNudges: number;
  /** 连续没有进展的审计次数。 */
  noProgress: number;
  lastHash?: string;
  lastAuditedAt?: number;
}

export interface AuditSnapshot {
  records: AuditRecord[];
  states: Record<string, AuditState>;
}

export interface AuditRunInput {
  memberId: string;
  runId?: string;
  /** 触发消息携带的任务卡；缺省时按成员名下未完成任务自动选择。 */
  taskId?: string;
}

/** 编排器只需要这两个能力，审计服务本身不反向依赖编排器实现。 */
export interface AuditHost {
  afterRun(input: AuditRunInput): void | Promise<void>;
}

export const AUDIT_LIMITS = {
  /** 每个任务最多保留的审计记录（按任务再各留最近若干条）。 */
  maxRecords: 80,
  maxCriteria: 8,
  maxEvidenceChars: 9_000,
  maxFixHint: 240,
  maxCriterionEvidence: 400,
  /** 连续催办上限：改进后清零，但累计催办也有硬上限。 */
  maxConsecutiveNudges: 2,
  maxTotalNudges: 6,
  /** 连续无进展达到该次数就直接升级人工，不再催办。 */
  maxNoProgress: 2,
  auditTimeoutMs: 60_000,
} as const;

export function isAuditVerdict(value: unknown): value is AuditVerdict {
  return value === "pass" || value === "fail" || value === "unsure";
}

export function summarizeCriteria(criteria: readonly AuditCriterionResult[]): AuditSummary {
  return {
    passed: criteria.filter((item) => item.verdict === "pass").length,
    failed: criteria.filter((item) => item.verdict === "fail").length,
    unsure: criteria.filter((item) => item.verdict === "unsure").length,
    total: criteria.length,
  };
}

export function overallVerdict(summary: AuditSummary): AuditVerdict {
  if (summary.total === 0) return "unsure";
  if (summary.failed > 0) return "fail";
  if (summary.unsure > 0) return "unsure";
  return "pass";
}
