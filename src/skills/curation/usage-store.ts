// 技能使用账本的落盘：谁被用过几次、最近一次活动、上次策展 pass 时间，加上策展提案与流水。
// 读写口径与 LearningStore / ModelUsageStore 一致（懒加载 + 写链 + 延迟落盘 + flush 收尾）。
// 只有一份、放在全局 data/ 下：「这条技能有没有人用」是跨账号的问题，
// 而账号级技能清单与设置只决定「这次扫描覆盖哪些技能」。

import { readJson, writeJsonAtomic } from "../../store/persist";
import {
  CURATION_RULES,
  type CurationLog,
  type CurationProposal,
  type CurationProposalKind,
  type CurationProposalPatch,
  type CurationProposalStatus,
  type SkillUsageRecord,
} from "./types";

interface SkillUsageData {
  usage: Record<string, SkillUsageRecord>;
  proposals: CurationProposal[];
  log: CurationLog[];
  /** 账号 → 上次策展 pass 的时间戳（间隔闸门按它算）。 */
  lastPassAt: Record<string, number>;
}

function emptyData(): SkillUsageData {
  return { usage: {}, proposals: [], log: [], lastPassAt: {} };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalStamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 老账本或手改过的坏数据按缺省补齐：使用次数只影响判断，不值得为它整条丢弃。 */
export function normalizeUsage(value: unknown, skillId: string): SkillUsageRecord {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const patchGeneration = Math.max(0, Math.floor(finiteOr(record.patchGeneration, 0)));
  return {
    skillId,
    useCount: Math.max(0, Math.floor(finiteOr(record.useCount, 0))),
    viewCount: Math.max(0, Math.floor(finiteOr(record.viewCount, 0))),
    patchCount: Math.max(0, Math.floor(finiteOr(record.patchCount, 0))),
    lastUsedAt: optionalStamp(record.lastUsedAt),
    lastViewedAt: optionalStamp(record.lastViewedAt),
    lastPatchedAt: optionalStamp(record.lastPatchedAt),
    patchGeneration,
    lastReusedPatchGeneration: Math.min(
      patchGeneration,
      Math.max(0, Math.floor(finiteOr(record.lastReusedPatchGeneration, 0))),
    ),
    reuseAfterPatch: record.reuseAfterPatch === true,
  };
}

function isStatus(value: unknown): value is CurationProposalStatus {
  return value === "pending" || value === "applied" || value === "dismissed";
}

function subjectRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

/**
 * 提案从磁盘还原：基座字段必须齐全，载荷按 kind 分支校验。
 * 任一条必填字段坏了就整条丢弃（与学习账本同一口径）——宁可少一条待批，也不要半条提案。
 */
export function normalizeCurationProposal(value: unknown): CurationProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return undefined;
  if (!isStatus(record.status)) return undefined;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return undefined;
  const kind = record.kind;
  if (kind !== "stale" && kind !== "archive" && kind !== "consolidate") return undefined;
  const ownerId = nonEmptyString(record.ownerId);
  if (!ownerId) return undefined;

  const evidenceRaw = record.evidence;
  const evidenceRecord =
    evidenceRaw && typeof evidenceRaw === "object" ? (evidenceRaw as Record<string, unknown>) : {};
  const appliedAt = finiteOr(record.appliedAt, NaN);
  const dismissReason = nonEmptyString(record.dismissReason);
  const appliedSkillId = nonEmptyString(record.appliedSkillId);
  const base = {
    id: record.id,
    status: record.status,
    origin:
      record.origin === "model" || record.origin === "manual"
        ? (record.origin as CurationProposal["origin"])
        : ("sweep" as const),
    createdAt: record.createdAt,
    updatedAt: finiteOr(record.updatedAt, record.createdAt),
    ...(Number.isFinite(appliedAt) ? { appliedAt } : {}),
    ...(dismissReason ? { dismissReason } : {}),
    ...(appliedSkillId ? { appliedSkillId } : {}),
    ownerId,
    ownerName: nonEmptyString(record.ownerName) ?? "",
    reason: nonEmptyString(record.reason) ?? "",
    evidence: {
      subjects: subjectRecords(evidenceRecord.subjects)
      .flatMap((item) => {
        const skillId = nonEmptyString(item.skillId);
        const skillName = nonEmptyString(item.skillName);
        if (!skillId || !skillName) return [];
        const lastActivityAt = optionalStamp(item.lastActivityAt);
        return [
          {
            skillId,
            skillName,
            scope: item.scope === "shared" ? ("shared" as const) : ("personal" as const),
            useCount: Math.max(0, Math.floor(finiteOr(item.useCount, 0))),
            viewCount: Math.max(0, Math.floor(finiteOr(item.viewCount, 0))),
            patchCount: Math.max(0, Math.floor(finiteOr(item.patchCount, 0))),
            idleDays: Math.max(0, Math.floor(finiteOr(item.idleDays, 0))),
            ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
          },
        ];
      })
      .slice(0, CURATION_RULES.maxEvidenceSubjects),
      thresholdDays: Math.max(0, Math.floor(finiteOr(evidenceRecord.thresholdDays, 0))),
      detail: nonEmptyString(evidenceRecord.detail) ?? "",
    },
  };

  if (kind === "consolidate") {
    const targetRaw = record.target;
    if (!targetRaw || typeof targetRaw !== "object") return undefined;
    const target = targetRaw as Record<string, unknown>;
    const name = nonEmptyString(target.name);
    if (!name) return undefined;
    const skillIds = (Array.isArray(record.sourceIds) ? record.sourceIds : []).filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
    if (skillIds.length === 0) return undefined;
    const targetId = nonEmptyString(target.skillId);
    const description = nonEmptyString(target.description);
    const instructions = nonEmptyString(target.instructions);
    return {
      ...base,
      kind: "consolidate",
      sourceIds: skillIds,
      target: {
        ...(targetId ? { skillId: targetId } : {}),
        name,
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
      },
    };
  }

  const skillId = nonEmptyString(record.skillId);
  if (!skillId) return undefined;
  return { ...base, kind, skillId };
}

function isLogEntry(value: unknown): value is CurationLog {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    typeof record.outcome === "string"
  );
}

export class SkillUsageStore {
  private data: SkillUsageData = emptyData();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** 账本读取失败一律降级成空账本：宁可这次什么都没学到，也不要拖垮技能库与群聊。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      try {
        const parsed = await readJson<Partial<SkillUsageData> | null>(this.file, null);
        const usageSource = parsed?.usage && typeof parsed.usage === "object" ? parsed.usage : {};
        const usage: Record<string, SkillUsageRecord> = {};
        for (const [skillId, value] of Object.entries(usageSource)) {
          usage[skillId] = normalizeUsage(value, skillId);
        }
        const proposals = Array.isArray(parsed?.proposals) ? parsed?.proposals : [];
        const log = Array.isArray(parsed?.log) ? parsed?.log : [];
        const lastPassSource =
          parsed?.lastPassAt && typeof parsed.lastPassAt === "object" ? parsed.lastPassAt : {};
        const lastPassAt: Record<string, number> = {};
        for (const [ownerId, at] of Object.entries(lastPassSource)) {
          const stamp = optionalStamp(at);
          if (stamp !== undefined) lastPassAt[ownerId] = stamp;
        }
        this.data = {
          usage,
          proposals: proposals
            .map(normalizeCurationProposal)
            .filter((proposal): proposal is CurationProposal => proposal !== undefined),
          log: log.filter(isLogEntry),
          lastPassAt,
        };
      } catch (err) {
        this.onError(`技能使用账本读取失败：${err instanceof Error ? err.message : String(err)}`);
        this.data = emptyData();
      }
      this.loaded = true;
    })();
    await this.loadPromise;
  }

  /**
   * 记账入口：同步返回、异步落盘。
   * 工具层在群聊循环里调用，绝不能因为等一次磁盘读写而卡住正在说话的智能体。
   */
  private mutateUsage(skillId: string, apply: (entry: SkillUsageRecord) => void): void {
    if (!skillId) return;
    void this.ensureLoaded()
      .then(() => {
        const entry = this.data.usage[skillId] ?? emptyUsage(skillId);
        apply(entry);
        this.data.usage[skillId] = entry;
        this.schedulePersist();
      })
      .catch((err: unknown) =>
        this.onError(`技能使用记账失败：${err instanceof Error ? err.message : String(err)}`),
      );
  }

  /**
   * use_skill 命中。除了加次数，还要算 Hermes 唯一认的效能信号：
   * 「上一次编辑之后又被用过」才说明这次编辑是有用的改动，而不是白改。
   */
  recordUse(skillId: string): void {
    this.mutateUsage(skillId, (entry) => {
      entry.useCount += 1;
      entry.lastUsedAt = Date.now();
      if (entry.patchGeneration > entry.lastReusedPatchGeneration) {
        entry.reuseAfterPatch = true;
        entry.lastReusedPatchGeneration = entry.patchGeneration;
      }
    });
  }

  /** read_skill_file 命中：读了附带文件只算「动过手」，不计入 useCount。 */
  recordView(skillId: string): void {
    this.mutateUsage(skillId, (entry) => {
      entry.viewCount += 1;
      entry.lastViewedAt = Date.now();
    });
  }

  /** 技能正文被编辑：代数 +1，等下一次使用来判定这次编辑到底有没有用。 */
  recordPatch(skillId: string): void {
    this.mutateUsage(skillId, (entry) => {
      entry.patchCount += 1;
      entry.lastPatchedAt = Date.now();
      entry.patchGeneration += 1;
    });
  }

  /** 技能被真删（不是归档）时清掉它的账，避免同名重建继承旧次数。 */
  async forgetSkill(skillId: string): Promise<void> {
    await this.ensureLoaded();
    if (!(skillId in this.data.usage)) return;
    delete this.data.usage[skillId];
    this.schedulePersist();
  }

  async usageOf(skillId: string): Promise<SkillUsageRecord | undefined> {
    await this.ensureLoaded();
    return this.data.usage[skillId];
  }

  /** 全量快照：策展 pass 一次拿完，避免对几百条技能逐条 await。 */
  async usageSnapshot(): Promise<Map<string, SkillUsageRecord>> {
    await this.ensureLoaded();
    return new Map(
      Object.entries(this.data.usage).map(([skillId, entry]) => [skillId, { ...entry }]),
    );
  }

  async listProposals(
    filter: { status?: CurationProposalStatus; kind?: CurationProposalKind } = {},
  ): Promise<CurationProposal[]> {
    await this.ensureLoaded();
    const all = this.data.proposals.filter(
      (proposal) =>
        (filter.status === undefined || proposal.status === filter.status) &&
        (filter.kind === undefined || proposal.kind === filter.kind),
    );
    return [...all].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getProposal(id: string): Promise<CurationProposal | undefined> {
    await this.ensureLoaded();
    return this.data.proposals.find((proposal) => proposal.id === id);
  }

  async addProposals(proposals: readonly CurationProposal[]): Promise<void> {
    if (proposals.length === 0) return;
    await this.ensureLoaded();
    this.data.proposals = [...proposals, ...this.data.proposals].slice(
      0,
      CURATION_RULES.maxProposals,
    );
    this.schedulePersist();
  }

  async patchProposal(
    id: string,
    patch: CurationProposalPatch,
  ): Promise<CurationProposal | undefined> {
    await this.ensureLoaded();
    const current = this.data.proposals.find((proposal) => proposal.id === id);
    if (!current) return undefined;
    Object.assign(current, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return current;
  }

  /** 同一技能同一方向的待批提案只留一条：扫描每小时都可能跑，不能堆出几十条重复。 */
  async hasPendingProposal(kind: CurationProposalKind, skillId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.data.proposals.some(
      (proposal) =>
        proposal.status === "pending" &&
        proposal.kind === kind &&
        (proposal.kind === "consolidate"
          ? proposal.sourceIds.includes(skillId)
          : proposal.skillId === skillId),
    );
  }

  async addLog(entry: CurationLog): Promise<void> {
    await this.ensureLoaded();
    this.data.log = [entry, ...this.data.log].slice(0, CURATION_RULES.maxLogEntries);
    this.schedulePersist();
  }

  async listLog(limit = 50): Promise<CurationLog[]> {
    await this.ensureLoaded();
    return this.data.log.slice(0, Math.max(1, Math.min(CURATION_RULES.maxLogEntries, limit)));
  }

  async lastPassAt(ownerId: string): Promise<number> {
    await this.ensureLoaded();
    return this.data.lastPassAt[ownerId] ?? 0;
  }

  async setLastPassAt(ownerId: string, at: number): Promise<void> {
    await this.ensureLoaded();
    this.data.lastPassAt[ownerId] = at;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(() =>
      writeJsonAtomic(this.file, this.data).catch((err: unknown) =>
        this.onError(`技能使用账本写入失败：${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  }

  /** 服务关闭前把挂起的写入落完。 */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}

export function emptyUsage(skillId: string): SkillUsageRecord {
  return {
    skillId,
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    patchGeneration: 0,
    lastReusedPatchGeneration: 0,
    reuseAfterPatch: false,
  };
}
