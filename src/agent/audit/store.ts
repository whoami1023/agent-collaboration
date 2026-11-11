/**
 * 审计账本：只保留可解释的结构化结论与每任务进度，随房间落盘。
 * 与活动日志分开存，避免审计记录被高频工具增量挤掉。
 */
import {
  AUDIT_LIMITS,
  isAuditVerdict,
  type AuditCriterionResult,
  type AuditRecord,
  type AuditSnapshot,
  type AuditState,
} from "./types";

export class AuditStore {
  private records: AuditRecord[] = [];
  private states = new Map<string, AuditState>();

  constructor(
    readonly roomId: string,
    private readonly maxRecords: number = AUDIT_LIMITS.maxRecords,
  ) {}

  hydrate(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const snapshot = raw as Partial<AuditSnapshot>;
    if (Array.isArray(snapshot.records)) {
      for (const entry of snapshot.records) {
        const record = sanitizeRecord(entry);
        if (record) this.records.push(record);
      }
      this.records.sort((a, b) => a.at - b.at);
      this.trim();
    }
    if (snapshot.states && typeof snapshot.states === "object") {
      for (const [taskId, value] of Object.entries(snapshot.states)) {
        const state = sanitizeState(taskId, value);
        if (state) this.states.set(taskId, state);
      }
    }
  }

  snapshot(): AuditSnapshot {
    return {
      records: JSON.parse(JSON.stringify(this.records)) as AuditRecord[],
      states: Object.fromEntries(
        [...this.states.entries()].map(([taskId, state]) => [taskId, { ...state }]),
      ),
    };
  }

  list(): AuditRecord[] {
    return [...this.records];
  }

  latestForTask(taskId: string): AuditRecord | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index]?.taskId === taskId) return this.records[index];
    }
    return undefined;
  }

  hasState(taskId: string, hash: string): boolean {
    return this.states.get(taskId)?.lastHash === hash;
  }

  stateOf(taskId: string): AuditState | undefined {
    const state = this.states.get(taskId);
    return state ? { ...state } : undefined;
  }

  setState(taskId: string, state: AuditState): void {
    this.states.set(taskId, { ...state });
  }

  add(record: AuditRecord): void {
    const existing = this.records.findIndex((item) => item.id === record.id);
    if (existing >= 0) this.records[existing] = record;
    else this.records.push(record);
    this.records.sort((a, b) => a.at - b.at);
    this.trim();
  }

  clear(): number {
    const removed = this.records.length;
    this.records = [];
    this.states.clear();
    return removed;
  }

  private trim(): void {
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function sanitizeCriterion(value: unknown, index: number): AuditCriterionResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isAuditVerdict(record["verdict"])) return null;
  return {
    id: typeof record["id"] === "number" ? record["id"] : index + 1,
    criterion: text(record["criterion"], 300),
    verdict: record["verdict"],
    evidence: text(record["evidence"], AUDIT_LIMITS.maxCriterionEvidence),
    ...(typeof record["fixHint"] === "string" && record["fixHint"].trim()
      ? { fixHint: text(record["fixHint"], AUDIT_LIMITS.maxFixHint) }
      : {}),
  };
}

function sanitizeRecord(value: unknown): AuditRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["taskId"] !== "string") return null;
  if (typeof record["memberId"] !== "string" || typeof record["at"] !== "number") return null;
  if (!isAuditVerdict(record["verdict"])) return null;
  const criteria = Array.isArray(record["criteria"])
    ? record["criteria"]
        .map((item, index) => sanitizeCriterion(item, index))
        .filter((item): item is AuditCriterionResult => item !== null)
    : [];
  const summary = record["summary"] as Record<string, unknown> | undefined;
  const action = record["action"];
  const sources = record["sources"] as Record<string, unknown> | undefined;
  return {
    id: record["id"],
    roomId: typeof record["roomId"] === "string" ? record["roomId"] : "",
    taskId: record["taskId"],
    taskTitle: text(record["taskTitle"], 200),
    memberId: record["memberId"],
    memberName: text(record["memberName"], 80) || "成员",
    ...(typeof record["runId"] === "string" ? { runId: record["runId"] } : {}),
    at: record["at"],
    verdict: record["verdict"],
    summary: {
      passed: numberOr(summary?.["passed"], 0),
      failed: numberOr(summary?.["failed"], 0),
      unsure: numberOr(summary?.["unsure"], 0),
      total: numberOr(summary?.["total"], criteria.length),
    },
    criteria,
    stateHash: typeof record["stateHash"] === "string" ? record["stateHash"] : "",
    sources: {
      messages: numberOr(sources?.["messages"], 0),
      tools: numberOr(sources?.["tools"], 0),
      files: Array.isArray(sources?.["files"])
        ? sources["files"].filter((item): item is string => typeof item === "string").slice(0, 20)
        : [],
    },
    action: action === "nudge" || action === "escalate" ? action : "none",
    interventionCount: numberOr(record["interventionCount"], 0),
    maxInterventions: numberOr(record["maxInterventions"], AUDIT_LIMITS.maxConsecutiveNudges),
    taskSolved: record["taskSolved"] === true,
    modelRef: typeof record["modelRef"] === "string" ? record["modelRef"] : "",
    ...(typeof record["fixHint"] === "string" && record["fixHint"].trim()
      ? { fixHint: text(record["fixHint"], AUDIT_LIMITS.maxFixHint) }
      : {}),
  };
}

function sanitizeState(taskId: string, value: unknown): AuditState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    taskId,
    bestPassed: numberOr(record["bestPassed"], -1),
    nudges: numberOr(record["nudges"], 0),
    totalNudges: numberOr(record["totalNudges"], 0),
    noProgress: numberOr(record["noProgress"], 0),
    ...(typeof record["lastHash"] === "string" ? { lastHash: record["lastHash"] } : {}),
    ...(typeof record["lastAuditedAt"] === "number"
      ? { lastAuditedAt: record["lastAuditedAt"] }
      : {}),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
