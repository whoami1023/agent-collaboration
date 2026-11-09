// 策展服务：一次 pass = 确定性生命周期迁移 +（可选）一次模型调用的合并建议。
// 结构对应 Hermes `agent/curator.py`，三点刻意的偏离：
// 1. Hermes 由 168h 定时触发，这里改成读时惰性扫描（GET 接口顺手扫一次，最多每小时真跑一次），
//    因为本项目没有常驻调度线程，也不该为一个后台清理任务再起定时器；
// 2. 归档一律先出提案：技能库是全局共享的，一次归档会让所有账号的智能体都读不到它。
//    只有本账号自己的个人技能、且用户显式开了 autoArchive，才允许扫描直接落地；
// 3. 从不删除技能：归档只是「不再注入清单」，正文保留、随时恢复。
// 使用账本全局一份，所以扫描范围限定为「当前账号可见的技能」，判断阈值取当前账号的设置。

import { newId } from "../../core/ids";
import type { CurationSettings, Settings } from "../../core/settings";
import type { UserRole } from "../../core/types";
import type { ModelUsageStore } from "../../model/usage-store";
import {
  resolveModelRuntime,
  type ModelTransport,
  type RuntimeDeps as ModelRuntimeDeps,
} from "../../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../../model/usage-cost";
import type { LlmProvider, LlmRequest } from "../../provider/types";
import type { MemberUsageRecord } from "../../agent/member-runtime";
import type { SkillActor, SkillLibrary, SkillRecord } from "../library";
import type { SkillUsageRecorder } from "./types";
import { idleDaysOf, lastActivityAtOf, planLifecycle, type LifecycleAction } from "./lifecycle";
import {
  CURATION_RULES,
  type CurationEvidence,
  type CurationLog,
  type CurationOutcome,
  type CurationProposal,
  type CurationProposalStatus,
  type CurationSubject,
  type ConsolidationCurationProposal,
  type LifecycleCurationProposal,
  type SkillLifecycleState,
  type SkillUsageRecord,
} from "./types";
import { SkillUsageStore } from "./usage-store";
import {
  CURATOR_SYSTEM_PROMPT,
  buildMergeUserPrompt,
  extractMerges,
  renderCandidate,
  validateMerges,
  type ValidatedMerge,
} from "./prompt";

export interface CurationServiceDeps {
  store: SkillUsageStore;
  skills: SkillLibrary;
  getSettings(): Settings;
  /** 合并建议用同一套模型装配（含备用链与密钥引用解析）。 */
  getModelDeps(): ModelRuntimeDeps;
  /** 工作区属主：决定扫描范围、落地权限与提案归属。 */
  owner: { id: string; name: string; role?: UserRole };
  usage?: ModelUsageStore;
  onUsageRecord?(record: MemberUsageRecord): void;
  onError?(message: string): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单轮流式补全：合并建议不需要工具与多步循环，只要把文本与 usage 收回来。 */
async function completeOnce(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<{ text: string; usage: UsageTotals }> {
  let text = "";
  let usage = emptyUsage();
  for await (const event of provider.stream(request)) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "usage") usage = addUsage(usage, event.usage);
  }
  return { text, usage };
}

export interface SweepOptions {
  /** 面板上的「立即扫描」：忽略间隔闸门；确定性迁移本身是幂等的。 */
  force?: boolean;
  /** 手动扫描时用户点名这一次也要合并建议（覆盖 consolidate 设置）。 */
  consolidate?: boolean;
}

export interface SweepResult {
  log?: CurationLog;
  proposals: CurationProposal[];
  /** 没跑起来的原因（关闭 / 未到间隔），面板据此说明，而不是静默无响应。 */
  skipped?: string;
}

export class CurationService {
  private inFlight: Promise<SweepResult> | null = null;

  constructor(private readonly deps: CurationServiceDeps) {}

  /** 记账入口：群聊循环里唯一会被调到的部分，同步返回、永不抛错。 */
  readonly recordUsage: SkillUsageRecorder = (skillId, kind) => {
    if (!skillId) return;
    if (kind === "use") this.deps.store.recordUse(skillId);
    else this.deps.store.recordView(skillId);
  };

  get curationSettings(): CurationSettings {
    return this.deps.getSettings().curation;
  }

  /**
   * 惰性扫描：读接口顺手调一次。同一账号同一时刻只可能有一个 pass 在跑，
   * 重复调用共享同一个结果，免得两个标签页同时打开面板就扫两遍。
   */
  async sweep(options: SweepOptions = {}): Promise<SweepResult> {
    if (this.inFlight) return this.inFlight;
    const settings = this.curationSettings;
    if (!settings.enabled) {
      return { proposals: [], skipped: "策展已关闭（设置 → 技能策展）" };
    }
    const now = Date.now();
    const lastPassAt = await this.deps.store.lastPassAt(this.deps.owner.id);
    const intervalMs =
      Math.max(CURATION_RULES.minIntervalHours, Math.floor(settings.intervalHours) || 1) *
      3_600_000;
    if (!options.force && now - lastPassAt < intervalMs) {
      return { proposals: [], skipped: "未到策展间隔，下面是现有清单" };
    }
    const run = this.runPass(now, settings, options)
      .then((result) => {
        this.inFlight = null;
        return result;
      })
      .catch((err: unknown): SweepResult => {
        this.inFlight = null;
        this.deps.onError?.(`技能策展失败：${errorMessage(err)}`);
        return { proposals: [], skipped: `策展失败：${errorMessage(err)}` };
      });
    this.inFlight = run;
    return run;
  }

  private async runPass(
    now: number,
    settings: CurationSettings,
    options: SweepOptions,
  ): Promise<SweepResult> {
    const actor = this.actor();
    const visible = this.deps.skills.listForAgent(this.deps.owner.id);
    const byId = new Map(visible.map((skill) => [skill.id, skill] as const));
    const usage = await this.deps.store.usageSnapshot();
    const plan = planLifecycle({
      now,
      skills: visible,
      usage,
      staleAfterDays: settings.staleAfterDays,
      archiveAfterDays: settings.archiveAfterDays,
    });

    const transitions: CurationLog["transitions"] = [];
    const notes: string[] = [];
    let notManageable = 0;
    for (const action of plan.transitions) {
      const skill = byId.get(action.skillId);
      if (!skill) continue;
      if (!this.deps.skills.mayManage(actor, skill.id)) {
        notManageable += 1;
        continue;
      }
      try {
        await this.deps.skills.setLifecycle(actor, skill.id, { state: action.to });
        transitions.push({ skillId: skill.id, skillName: skill.name, from: action.from, to: action.to });
      } catch (err) {
        notes.push(`${skill.name} 状态没改成：${errorMessage(err)}`);
      }
    }
    if (notManageable > 0) notes.push(`${notManageable} 条技能不归本账号管，跳过状态迁移`);

    const created: CurationProposal[] = [];
    let autoArchived = 0;
    for (const action of plan.archiveCandidates) {
      const skill = byId.get(action.skillId);
      if (!skill) continue;
      // 自动归档只对「本账号自己的个人技能」开放；共享技能与别人的技能永远走提案。
      const mayAuto =
        settings.autoArchive && skill.scope === "personal" && skill.ownerId === this.deps.owner.id;
      if (mayAuto && this.deps.skills.mayManage(actor, skill.id)) {
        try {
          await this.deps.skills.setLifecycle(actor, skill.id, { state: "archived" });
          autoArchived += 1;
          transitions.push({ skillId: skill.id, skillName: skill.name, from: action.from, to: "archived" });
          continue;
        } catch (err) {
          notes.push(`${skill.name} 自动归档失败：${errorMessage(err)}`);
        }
      }
      const proposal = await this.proposeLifecycle(
        "archive",
        action.idleDays,
        settings.archiveAfterDays,
        skill,
        "sweep",
      );
      if (proposal) created.push(proposal);
    }

    const consolidate = options.consolidate ?? settings.consolidate;
    const modelRef = settings.modelRef || this.deps.getSettings().selection.defaultModel;
    if (consolidate) {
      const outcome = await this.suggestConsolidations(visible, usage, now, modelRef);
      created.push(...outcome.proposals);
      if (outcome.detail) notes.push(outcome.detail);
    }

    await this.deps.store.addProposals(created);
    await this.deps.store.setLastPassAt(this.deps.owner.id, now);

    const outcome: CurationOutcome =
      transitions.length > 0 ? "transitioned" : created.length > 0 ? "proposed" : "nothing";
    const parts: string[] = [];
    if (transitions.length > 0) {
      const stale = transitions.filter((item) => item.to === "stale").length;
      const revived = transitions.filter((item) => item.to === "active").length;
      if (stale > 0) parts.push(`标记 ${stale} 条闲置`);
      if (revived > 0) parts.push(`${revived} 条又有活动，恢复为正常`);
      if (autoArchived > 0) parts.push(`自动归档 ${autoArchived} 条`);
    }
    if (created.length > 0) parts.push(`产出 ${created.length} 条待确认提案`);
    const detail =
      parts.length > 0
        ? `${parts.join("；")}${notes.length > 0 ? `；${notes.join("；")}` : ""}`
        : `${notes.length > 0 ? notes.join("；") : `扫描 ${visible.length} 条可见技能，没有需要处理的`}。${
            consolidate ? "" : "（合并建议未开启，本次没有模型调用）"
          }`;
    const log = await this.record(outcome, detail, visible.length, transitions, created, modelRef);
    return { log, proposals: created };
  }

  /**
   * 合并建议：把候选清单渲染给模型，让它挑出该收拢成一组的那些。
   * 模型说的话只变成提案，而且来源与承接者都必须能在候选清单里查到（见 validateMerges）。
   */
  private async suggestConsolidations(
    visible: readonly SkillRecord[],
    usage: Map<string, SkillUsageRecord>,
    now: number,
    modelRef: string,
  ): Promise<{ proposals: ConsolidationCurationProposal[]; detail?: string }> {
    const candidates = visible
      .filter((skill) => !skill.builtin && !skill.lifecycle?.pinned)
      .map((skill) => ({
        skill,
        useCount: usage.get(skill.id)?.useCount ?? 0,
        idleDays: idleDaysOf(skill, usage.get(skill.id), now),
      }))
      // 从没被用过的排前面，其次按闲置天数：正在用的技能不该被建议合并掉。
      .sort((a, b) => a.useCount - b.useCount || b.idleDays - a.idleDays)
      .slice(0, CURATION_RULES.maxCandidates);
    if (candidates.length < 2) return { proposals: [], detail: "可比对的候选太少，没有提合并" };

    const index = new Map<string, SkillRecord>();
    for (const item of candidates) index.set(item.skill.name.toLowerCase(), item.skill);

    let transport: ModelTransport;
    try {
      transport = resolveModelRuntime(modelRef, this.deps.getModelDeps());
    } catch (err) {
      return { proposals: [], detail: `合并建议模型不可用：${errorMessage(err)}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CURATION_RULES.reviewTimeoutMs);
    timer.unref();
    let completion: { text: string; usage: UsageTotals };
    try {
      completion = await this.collect(
        transport,
        {
          accountName: this.deps.owner.name,
          candidates: candidates
            .map((item) => renderCandidate(item.skill, usage.get(item.skill.id), now))
            .join("\n"),
        },
        controller.signal,
      );
    } catch (err) {
      return {
        proposals: [],
        detail: controller.signal.aborted
          ? "合并建议超时或被中止"
          : `合并建议调用失败：${errorMessage(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    const merges = extractMerges(completion.text);
    if (!merges) {
      return { proposals: [], detail: "合并建议输出不是可解析的 JSON（缺少 merges 数组）" };
    }
    const { merges: valid, dropped } = validateMerges(merges, index);
    const proposals: ConsolidationCurationProposal[] = [];
    for (const merge of valid) {
      const proposal = await this.proposeConsolidation(merge, index);
      if (proposal) proposals.push(proposal);
    }
    const detail =
      proposals.length === 0
        ? `模型认为没有重复${dropped.length > 0 ? `（丢弃 ${dropped.length} 条：${dropped.join("；")}）` : ""}`
        : `提出 ${proposals.length} 组合并${dropped.length > 0 ? `；丢弃 ${dropped.length} 条不合格建议` : ""}`;
    return { proposals, detail };
  }

  private actor(): SkillActor {
    return { id: this.deps.owner.id, ...(this.deps.owner.role ? { role: this.deps.owner.role } : {}) };
  }

  /** 同一技能同一方向的待批提案只留一条：惰性扫描很频繁，不能堆重复提案。 */
  private async proposeLifecycle(
    kind: "stale" | "archive",
    idleDays: number,
    thresholdDays: number,
    skill: SkillRecord,
    origin: CurationLifecycleOrigin,
  ): Promise<LifecycleCurationProposal | undefined> {
    if (await this.deps.store.hasPendingProposal(kind, skill.id)) return undefined;
    const now = Date.now();
    const usage = await this.deps.store.usageOf(skill.id);
    const useCount = usage?.useCount ?? 0;
    return {
      id: newId("cur"),
      kind,
      status: "pending",
      origin,
      createdAt: now,
      updatedAt: now,
      ownerId: this.deps.owner.id,
      ownerName: this.deps.owner.name,
      skillId: skill.id,
      reason:
        kind === "archive"
          ? `用过 ${useCount} 次，但连续 ${idleDays} 天没有任何活动`
          : `连续 ${idleDays} 天没有活动，先标成闲置（仍可正常使用）`,
      evidence: lifecycleEvidence(skill, usage, idleDays, thresholdDays, kind),
    };
  }

  private async proposeConsolidation(
    merge: ValidatedMerge,
    index: Map<string, SkillRecord>,
  ): Promise<ConsolidationCurationProposal | undefined> {
    const now = Date.now();
    const sources = merge.sources
      .map((source) => index.get(source.name.toLowerCase()))
      .filter((skill): skill is SkillRecord => skill !== undefined);
    if (sources.length === 0) return undefined;
    const subjects: CurationSubject[] = [];
    for (const skill of sources) {
      subjects.push(subjectOf(skill, await this.deps.store.usageOf(skill.id), now));
    }
    return {
      id: newId("cur"),
      kind: "consolidate",
      status: "pending",
      origin: "model",
      createdAt: now,
      updatedAt: now,
      ownerId: this.deps.owner.id,
      ownerName: this.deps.owner.name,
      sourceIds: sources.map((skill) => skill.id),
      target: merge.target,
      reason: merge.reason || `这几条技能做的是同一件事，建议收拢到「${merge.target.name}」下`,
      evidence: {
        subjects: subjects.slice(0, CURATION_RULES.maxEvidenceSubjects),
        thresholdDays: 0,
        detail: `采纳后其余 ${sources.length} 条只归档、不删除，正文保留，随时能恢复`,
      },
    };
  }

  /** 调用模型并把 token 与成本按同一口径入账（合并建议也是真金白银）。 */
  private async collect(
    transport: ModelTransport,
    material: { accountName: string; candidates: string },
    signal: AbortSignal,
  ): Promise<{ text: string; usage: UsageTotals }> {
    const modelsByRef = new Map<string, ModelTransport["model"]>();
    for (const candidate of [transport.chain.primary, ...transport.chain.fallbacks]) {
      modelsByRef.set(candidate.ref, candidate);
    }
    const request: LlmRequest = {
      model: transport.model.id,
      messages: [
        { role: "system", content: CURATOR_SYSTEM_PROMPT },
        { role: "user", content: buildMergeUserPrompt(material) },
      ],
      tools: [],
      ...(transport.request.params ? { params: transport.request.params } : {}),
      ...(transport.request.headers ? { headers: transport.request.headers } : {}),
      ...(transport.request.timeoutMs !== undefined ? { timeoutMs: transport.request.timeoutMs } : {}),
      ...(transport.request.maxTokens !== undefined ? { maxTokens: transport.request.maxTokens } : {}),
      ...(transport.request.baseUrl ? { baseUrl: transport.request.baseUrl } : {}),
      signal,
    };
    const completion = await completeOnce(transport.provider, request);
    const ref = transport.activeRef() || transport.model.ref;
    const model = modelsByRef.get(ref) ?? transport.model;
    const costUsd = calculateUsageCost(model, completion.usage);
    if (this.deps.usage) {
      try {
        await this.deps.usage.record({
          ref,
          providerId: model.providerId,
          modelId: model.id,
          usage: completion.usage,
          costUsd,
        });
      } catch {
        // 用量账本失败不该影响策展本身。
      }
    }
    this.deps.onUsageRecord?.({
      ref,
      providerId: model.providerId,
      modelId: model.id,
      usage: completion.usage,
      costUsd,
    });
    return completion;
  }

  private async record(
    outcome: CurationOutcome,
    detail: string,
    scanned: number,
    transitions: CurationLog["transitions"],
    proposals: readonly CurationProposal[],
    modelRef: string,
  ): Promise<CurationLog> {
    const entry: CurationLog = {
      id: newId("curlog"),
      at: Date.now(),
      ownerId: this.deps.owner.id,
      ownerName: this.deps.owner.name,
      outcome,
      detail,
      scanned,
      transitions,
      proposalIds: proposals.map((proposal) => proposal.id),
      modelRef,
    };
    await this.deps.store.addLog(entry);
    return entry;
  }

  async listProposals(status?: CurationProposalStatus): Promise<CurationProposal[]> {
    return this.deps.store.listProposals(status ? { status } : {});
  }

  async listLog(limit = 30): Promise<CurationLog[]> {
    return this.deps.store.listLog(limit);
  }

  /**
   * 采纳提案：状态类直接改生命周期，合并类先备好承接技能，再逐条归档来源。
   * 任何一条来源不归当前用户管就整组拒绝，不做「归档了一半」的半途状态 ——
   * 这是 Hermes「分阶段写入遇到漂移就拒绝」的口径。
   */
  async applyProposal(user: SkillActor, id: string): Promise<CurationProposal> {
    const proposal = await this.deps.store.getProposal(id);
    if (!proposal) throw new Error("策展提案不存在");
    if (proposal.status === "applied") return proposal;
    if (proposal.status === "dismissed") throw new Error("提案已忽略，不能再生效");
    if (proposal.kind === "consolidate") return this.applyConsolidation(user, proposal);

    const state: SkillLifecycleState = proposal.kind === "archive" ? "archived" : "stale";
    await this.deps.skills.setLifecycle(user, proposal.skillId, { state });
    const updated = await this.deps.store.patchProposal(id, { status: "applied", appliedAt: Date.now() });
    if (!updated) throw new Error("策展提案不存在");
    return updated;
  }

  private async applyConsolidation(
    user: SkillActor,
    proposal: ConsolidationCurationProposal,
  ): Promise<CurationProposal> {
    const sources = proposal.sourceIds
      .map((skillId) => this.deps.skills.findById(skillId))
      .filter((skill): skill is SkillRecord => skill !== undefined);
    if (sources.length !== proposal.sourceIds.length) {
      throw new Error("有来源技能已被删除，这组合并建议已经失效");
    }
    const unmanageable = sources.filter((skill) => !this.deps.skills.mayManage(user, skill.id));
    if (unmanageable.length > 0) {
      throw new Error(`没有权限归档 ${unmanageable.map((skill) => skill.name).join("、")}`);
    }

    let targetId = proposal.target.skillId;
    let targetName = proposal.target.name;
    if (targetId) {
      const existing = this.deps.skills.findById(targetId);
      if (!existing) throw new Error("承接技能已被删除，这组合并建议已经失效");
      targetName = existing.name;
    } else {
      const created = await this.deps.skills.create(user, {
        scope: "personal",
        name: targetName,
        description: proposal.target.description,
        instructions: proposal.target.instructions,
      });
      targetId = created.id;
      targetName = created.name;
    }

    for (const skill of sources) {
      await this.deps.skills.setLifecycle(user, skill.id, {
        state: "archived",
        absorbedInto: targetName,
        absorbedIntoId: targetId,
      });
    }
    const updated = await this.deps.store.patchProposal(proposal.id, {
      status: "applied",
      appliedAt: Date.now(),
      appliedSkillId: targetId,
    });
    if (!updated) throw new Error("策展提案不存在");
    return updated;
  }

  async dismissProposal(id: string, reason?: string): Promise<CurationProposal> {
    const proposal = await this.deps.store.getProposal(id);
    if (!proposal) throw new Error("策展提案不存在");
    if (proposal.status === "applied") throw new Error("提案已生效，不能改为忽略");
    const trimmed = (reason ?? "").trim().slice(0, CURATION_RULES.maxReasonChars);
    const updated = await this.deps.store.patchProposal(id, {
      status: "dismissed",
      ...(trimmed ? { dismissReason: trimmed } : {}),
    });
    if (!updated) throw new Error("策展提案不存在");
    return updated;
  }

  /** 技能卡片上的手动操作：固定、归档、恢复、取消闲置。权限与提案通道共用 setLifecycle。 */
  setSkillLifecycle(
    user: SkillActor,
    skillId: string,
    patch: { state?: SkillLifecycleState; pinned?: boolean },
  ): Promise<SkillRecord> {
    return this.deps.skills.setLifecycle(user, skillId, patch);
  }

  /** 手动发起归档提案（技能卡片上的「提议归档」）：不等扫描，也不直接动状态。 */
  async proposeArchiveNow(user: SkillActor, skillId: string): Promise<CurationProposal> {
    const skill = this.deps.skills.findById(skillId);
    if (!skill) throw new Error("技能不存在");
    if (!this.deps.skills.mayManage(user, skillId)) throw new Error("没有权限归档这条技能");
    const existing = await this.deps.store.listProposals({ status: "pending", kind: "archive" });
    const hit = existing.find(
      (proposal): proposal is LifecycleCurationProposal =>
        proposal.kind === "archive" && proposal.skillId === skillId,
    );
    if (hit) return hit;
    const now = Date.now();
    const usage = await this.deps.store.usageOf(skillId);
    const proposal = await this.proposeLifecycle(
      "archive",
      idleDaysOf(skill, usage, now),
      this.curationSettings.archiveAfterDays,
      skill,
      "manual",
    );
    if (!proposal) throw new Error("这条技能已经在待确认清单里");
    await this.deps.store.addProposals([proposal]);
    return proposal;
  }

  /**
   * 面板用：当前账号看得见的技能（含已归档的）的使用快照，skillId → 账本记录。
   * 已归档的技能不在 `listForAgent` 里，所以这里按「共享 + 本人个人」取，否则卡片徽章会集体消失。
   */
  async usageSnapshot(): Promise<Record<string, SkillUsageRecord>> {
    const known = new Set([
      ...this.deps.skills.listShared().map((skill) => skill.id),
      ...this.deps.skills.listPersonal(this.deps.owner.id).map((skill) => skill.id),
    ]);
    const snapshot = await this.deps.store.usageSnapshot();
    const result: Record<string, SkillUsageRecord> = {};
    for (const [skillId, record] of snapshot) {
      if (known.has(skillId)) result[skillId] = record;
    }
    return result;
  }

  async flush(): Promise<void> {
    await this.deps.store.flush();
  }
}

type CurationLifecycleOrigin = "sweep" | "model" | "manual";

function subjectOf(
  skill: SkillRecord,
  usage: SkillUsageRecord | undefined,
  now: number,
): CurationSubject {
  const lastActivityAt = lastActivityAtOf(skill, usage);
  return {
    skillId: skill.id,
    skillName: skill.name,
    scope: skill.scope,
    useCount: usage?.useCount ?? 0,
    viewCount: usage?.viewCount ?? 0,
    patchCount: usage?.patchCount ?? 0,
    idleDays: idleDaysOf(skill, usage, now),
    lastActivityAt: lastActivityAt > 0 ? lastActivityAt : undefined,
  };
}

function lifecycleEvidence(
  skill: SkillRecord,
  usage: SkillUsageRecord | undefined,
  idleDays: number,
  thresholdDays: number,
  kind: "stale" | "archive",
): CurationEvidence {
  return {
    subjects: [subjectOf(skill, usage, Date.now())],
    thresholdDays,
    detail:
      kind === "archive"
        ? `连续 ${idleDays} 天没活动，超过归档阈值 ${thresholdDays} 天。采纳后这条技能不再出现在智能体清单里，但正文保留、随时能恢复`
        : `连续 ${idleDays} 天没活动，超过闲置阈值 ${thresholdDays} 天。闲置只是标记，技能照常可用`,
  };
}
