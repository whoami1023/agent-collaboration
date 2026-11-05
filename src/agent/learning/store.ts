// 学习层的落盘账本：待确认的记忆 / 技能提案 + 复盘流水，落在各账号工作区的 learning.json。
// 读写口径与 ModelUsageStore 一致（懒加载 + 写链 + 延迟落盘），删号随工作区目录一起清掉。
// P1 的老账本没有 kind 字段：加载时统一补成 memory，旧提案照常展示与采纳。

import { readJson, writeJsonAtomic } from "../../store/persist";
import { isSkillCategory } from "../../skills/categories";
import {
  LEARNING_RULES,
  type LearningProposal,
  type ProposalKind,
  type ProposalPatch,
  type ProposalStatus,
  type ReviewLog,
} from "./types";

interface LearningData {
  proposals: LearningProposal[];
  log: ReviewLog[];
}

const EMPTY: LearningData = { proposals: [], log: [] };

function textOf(record: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof record[key] === "string" ? (record[key] as string) : fallback;
}

function stringArrayOf(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isStatus(value: unknown): value is ProposalStatus {
  return value === "pending" || value === "applied" || value === "dismissed";
}

type ProposalBaseRecord = Omit<LearningProposal, "kind" | "target" | "content" | "triggers" | "importance" | "skill">;

function baseOf(record: Record<string, unknown>): ProposalBaseRecord | undefined {
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (!isStatus(record.status)) return undefined;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return undefined;
  const appliedAt = finiteOr(record.appliedAt, NaN);
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: finiteOr(record.updatedAt, record.createdAt),
    memberId: textOf(record, "memberId"),
    memberName: textOf(record, "memberName"),
    memberRole: record.memberRole === "sub" ? "sub" : "main",
    roomId: textOf(record, "roomId"),
    roomName: textOf(record, "roomName"),
    runId: textOf(record, "runId"),
    rationale: textOf(record, "rationale"),
    ...(Number.isFinite(appliedAt) ? { appliedAt } : {}),
    ...(typeof record.appliedPath === "string" ? { appliedPath: record.appliedPath } : {}),
    ...(typeof record.appliedSkillId === "string" ? { appliedSkillId: record.appliedSkillId } : {}),
    ...(typeof record.appliedSkillName === "string" ? { appliedSkillName: record.appliedSkillName } : {}),
    ...(typeof record.dismissReason === "string" ? { dismissReason: record.dismissReason } : {}),
  };
}

/**
 * 把磁盘上的一条记录还原成联合提案：
 * - `kind: "skill"` 或带 `skill` 载荷的按技能提案校验；
 * - 其余（含 P1 没有 kind 的老记录）按记忆提案校验，字段不合法就整条丢弃。
 */
export function normalizeProposal(value: unknown): LearningProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const base = baseOf(record);
  if (!base) return undefined;

  if (record.kind === "skill" || record.skill !== undefined) {
    const raw = record.skill;
    if (!raw || typeof raw !== "object") return undefined;
    const skill = raw as Record<string, unknown>;
    if (
      typeof skill.name !== "string" ||
      typeof skill.description !== "string" ||
      typeof skill.instructions !== "string"
    ) {
      return undefined;
    }
    return {
      ...base,
      kind: "skill",
      skill: {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        category: isSkillCategory(skill.category) ? skill.category : "other",
        triggers: stringArrayOf(skill, "triggers"),
      },
    };
  }

  if (typeof record.content !== "string") return undefined;
  const importance = Math.max(
    1,
    Math.min(10, Math.floor(finiteOr(record.importance, 5))),
  );
  return {
    ...base,
    kind: "memory",
    target: record.target === "member" ? "member" : "account",
    content: record.content,
    triggers: stringArrayOf(record, "triggers"),
    importance,
  };
}

function isLog(value: unknown): value is ReviewLog {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.at === "number" && typeof record.outcome === "string";
}

/** UTC 自然日键：每日复盘上限按它统计。 */
export function dayKeyOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class LearningStore {
  private data: LearningData = { proposals: [], log: [] };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      try {
        const parsed = await readJson<Partial<LearningData> | null>(this.file, null);
        const proposals = parsed && Array.isArray(parsed.proposals) ? parsed.proposals : [];
        const log = parsed && Array.isArray(parsed.log) ? parsed.log : [];
        this.data = {
          proposals: proposals
            .map(normalizeProposal)
            .filter((proposal): proposal is LearningProposal => proposal !== undefined),
          log: log.filter(isLog),
        };
      } catch (err) {
        this.onError(`学习账本读取失败：${err instanceof Error ? err.message : String(err)}`);
        this.data = structuredClone(EMPTY);
      }
      this.loaded = true;
    })();
    await this.loadPromise;
  }

  async listProposals(
    filter: { status?: ProposalStatus; kind?: ProposalKind } = {},
  ): Promise<LearningProposal[]> {
    await this.ensureLoaded();
    const all = this.data.proposals.filter(
      (proposal) =>
        (filter.status === undefined || proposal.status === filter.status) &&
        (filter.kind === undefined || proposal.kind === filter.kind),
    );
    return [...all].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getProposal(id: string): Promise<LearningProposal | undefined> {
    await this.ensureLoaded();
    return this.data.proposals.find((proposal) => proposal.id === id);
  }

  async addProposals(proposals: readonly LearningProposal[]): Promise<void> {
    if (proposals.length === 0) return;
    await this.ensureLoaded();
    this.data.proposals = [...proposals, ...this.data.proposals].slice(0, LEARNING_RULES.maxProposals);
    this.schedulePersist();
  }

  async patchProposal(id: string, patch: ProposalPatch): Promise<LearningProposal | undefined> {
    await this.ensureLoaded();
    const current = this.data.proposals.find((proposal) => proposal.id === id);
    if (!current) return undefined;
    Object.assign(current, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return current;
  }

  async addLog(entry: ReviewLog): Promise<void> {
    await this.ensureLoaded();
    this.data.log = [entry, ...this.data.log].slice(0, LEARNING_RULES.maxLogEntries);
    this.schedulePersist();
  }

  async listLog(limit = 50): Promise<ReviewLog[]> {
    await this.ensureLoaded();
    return this.data.log.slice(0, Math.max(1, Math.min(LEARNING_RULES.maxLogEntries, limit)));
  }

  /** 今天（UTC）已经复盘过几次：用于每日成本上限。 */
  async reviewsToday(at = Date.now()): Promise<number> {
    await this.ensureLoaded();
    const day = dayKeyOf(at);
    return this.data.log.filter((entry) => dayKeyOf(entry.at) === day).length;
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(() =>
      writeJsonAtomic(this.file, this.data).catch((err: unknown) =>
        this.onError(`学习账本写入失败：${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  }

  /** 工作区关闭前把挂起的写入落完。 */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}
