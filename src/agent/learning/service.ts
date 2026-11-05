// 学习层核心：一次运行交付后的复盘 pass。
// 结构对应 Hermes `agent/background_review.py`——独立于群聊的一次模型调用、只判断该记什么、
// 写入通道只有受控追加的记忆文件；差别在于本项目把「直接落盘」做成可开关的模式，
// 默认 propose（等用户在面板里确认），auto 才直接写。

import type { Settings } from "../../core/settings";
import { newId } from "../../core/ids";
import type { MemorySearchManager } from "../../memory/manager";
import type { ModelUsageStore } from "../../model/usage-store";
import {
  resolveModelRuntime,
  type ModelTransport,
  type RuntimeDeps as ModelRuntimeDeps,
} from "../../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../../model/usage-cost";
import type { LlmProvider, LlmRequest } from "../../provider/types";
import type { MemberUsageRecord } from "../member-runtime";
import { LEARNING_SYSTEM_PROMPT, buildReviewUserPrompt, extractEntries, type ReviewMaterial } from "./prompt";
import { buildDedupeEntries, isDuplicateOf, validateCandidate } from "./filters";
import type { LearningStore } from "./store";
import {
  LEARNING_RULES,
  type LearningRunInput,
  type LearningSettings,
  type MemoryProposal,
  type MemoryTarget,
  type ReviewLog,
  type ReviewOutcome,
} from "./types";

export interface LearningServiceDeps {
  store: LearningStore;
  getSettings(): Settings;
  /** 复盘调用用成员同一套模型装配（含备用链与密钥引用解析）。 */
  getModelDeps(): ModelRuntimeDeps;
  memory?: MemorySearchManager;
  usage?: ModelUsageStore;
  onUsageRecord?(record: MemberUsageRecord): void;
  /** 每次复盘（含没学到东西的）都广播一次，供 SSE 与前端刷新。 */
  onLearned?(payload: { proposals: readonly MemoryProposal[]; log: ReviewLog }): void;
  onError?(message: string): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function memoryPathOf(role: "main" | "sub", memberId: string): string {
  return role === "sub" ? `agents/${memberId}/MEMORY.md` : "MEMORY.md";
}

/** 单轮流式补全：后台复盘不需要工具与多步循环，只要把文本与 usage 收回来。 */
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

export class LearningService {
  /** 成员 → 自上次复盘以来成功运行的次数（内存计数，重启后重新积累）。 */
  private counters = new Map<string, number>();
  private inFlight = new Set<string>();

  constructor(private readonly deps: LearningServiceDeps) {}

  get learningSettings(): LearningSettings {
    return this.deps.getSettings().learning;
  }

  /**
   * 成员运行收尾处的入口：绝不抛错、绝不阻塞群聊。
   * 一切失败都只写进复盘流水，让用户在面板里看到「这轮为什么没学到东西」。
   */
  async afterRun(input: LearningRunInput): Promise<void> {
    try {
      await this.review(input);
    } catch (err) {
      this.deps.onError?.(`复盘失败：${errorMessage(err)}`);
    }
  }

  private async review(input: LearningRunInput): Promise<void> {
    const settings = this.learningSettings;
    if (settings.mode === "off") return;
    if (!this.deps.memory) return;
    if (input.unattended) return;
    if (input.finalText.trim().length < LEARNING_RULES.minFinalTextChars) return;
    if (this.inFlight.has(input.memberId)) return;

    const counter = (this.counters.get(input.memberId) ?? 0) + 1;
    this.counters.set(input.memberId, counter);
    if (counter % Math.max(1, settings.everyNRuns) !== 0) return;

    if ((await this.deps.store.reviewsToday()) >= Math.max(1, settings.dailyCap)) {
      await this.record(input, "skipped", `今天已复盘 ${settings.dailyCap} 次，达到每日上限，本轮跳过`, [], "");
      return;
    }

    this.inFlight.add(input.memberId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LEARNING_RULES.reviewTimeoutMs);
    timer.unref();
    try {
      const target: MemoryTarget = input.memberRole === "sub" ? "member" : "account";
      const relPath = memoryPathOf(input.memberRole, input.memberId);
      const existingMemory = await this.deps.memory
        .readAgentFile(relPath, { full: true })
        .then((file) => file.content)
        .catch(() => "");

      const material: ReviewMaterial = {
        roomName: input.roomName,
        memberName: input.memberName,
        memberRole: input.memberRole,
        target,
        targetFile: relPath,
        triggerText: input.triggerText,
        finalText: input.finalText,
        toolNames: input.toolNames,
        transcript: input.transcript,
        existingMemory,
      };

      let transport: ModelTransport;
      try {
        transport = resolveModelRuntime(settings.modelRef || input.modelRef, this.deps.getModelDeps());
      } catch (err) {
        await this.record(input, "failed", `复盘模型不可用：${errorMessage(err)}`, [], settings.modelRef || input.modelRef);
        return;
      }
      let usage: { text: string; usage: UsageTotals };
      try {
        usage = await this.collect(transport, material, controller.signal);
      } catch (err) {
        await this.record(
          input,
          "failed",
          controller.signal.aborted
            ? "复盘超时或被中止"
            : `复盘调用失败：${errorMessage(err)}`,
          [],
          transport.activeRef() || transport.model.ref,
        );
        return;
      }
      if (controller.signal.aborted) {
        await this.record(input, "failed", "复盘超时或被中止", [], transport.activeRef() || transport.model.ref);
        return;
      }

      const entries = extractEntries(usage.text);
      if (!entries) {
        await this.record(input, "failed", "复盘输出不是可解析的 JSON，本轮不写入", [], transport.activeRef() || transport.model.ref);
        return;
      }

      const pending = await this.deps.store.listProposals({ status: "pending" });
      const corpus = buildDedupeEntries(existingMemory, pending);
      const created: MemoryProposal[] = [];
      const dropped: string[] = [];
      const seen = new Set<string>();
      for (const raw of entries.slice(0, LEARNING_RULES.maxEntriesPerReview)) {
        const validated = validateCandidate(raw);
        if ("reason" in validated) {
          dropped.push(validated.reason);
          continue;
        }
        if (isDuplicateOf(validated.content, [...corpus, ...created.map((item) => item.content)])) {
          dropped.push("与已有记忆或待确认提案重复");
          continue;
        }
        const key = validated.content;
        if (seen.has(key)) continue;
        seen.add(key);
        const now = Date.now();
        created.push({
          id: newId("mem"),
          status: "pending",
          createdAt: now,
          updatedAt: now,
          memberId: input.memberId,
          memberName: input.memberName,
          memberRole: input.memberRole,
          roomId: input.roomId,
          roomName: input.roomName,
          runId: input.runId,
          target,
          content: validated.content,
          triggers: validated.triggers,
          importance: validated.importance,
          rationale: validated.rationale,
        });
      }

      await this.deps.store.addProposals(created);

      const applied: MemoryProposal[] = [];
      if (settings.mode === "auto") {
        for (const proposal of created) {
          try {
            applied.push(await this.applyProposal(proposal.id));
          } catch (err) {
            dropped.push(`写入失败：${errorMessage(err)}`);
          }
        }
      }

      const outcome: ReviewOutcome =
        created.length === 0 ? "nothing" : applied.length > 0 ? "applied" : "proposed";
      const detail =
        created.length === 0
          ? `模型认为本轮没有值得长期记住的事实${dropped.length > 0 ? `（丢弃 ${dropped.length} 条：${dropped.join("；")}）` : ""}`
          : settings.mode === "auto"
            ? `自动写入 ${applied.length}/${created.length} 条${dropped.length > 0 ? `；丢弃 ${dropped.length} 条（${dropped.join("；")}）` : ""}`
            : `产出 ${created.length} 条待确认提案${dropped.length > 0 ? `；丢弃 ${dropped.length} 条（${dropped.join("；")}）` : ""}`;
      await this.record(
        input,
        outcome,
        detail,
        applied.length > 0 ? applied : created,
        transport.activeRef() || transport.model.ref,
      );
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(input.memberId);
    }
  }

  /** 调用模型并把 token 与成本按同一口径入账（复盘也是真金白银）。 */
  private async collect(
    transport: ModelTransport,
    material: ReviewMaterial,
    signal: AbortSignal,
  ): Promise<{ text: string; usage: UsageTotals }> {
    const modelsByRef = new Map<string, ModelTransport["model"]>();
    for (const candidate of [transport.chain.primary, ...transport.chain.fallbacks]) {
      modelsByRef.set(candidate.ref, candidate);
    }
    const request: LlmRequest = {
      model: transport.model.id,
      messages: [
        { role: "system", content: LEARNING_SYSTEM_PROMPT },
        { role: "user", content: buildReviewUserPrompt(material) },
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
        // 用量账本失败不该影响复盘本身。
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
    input: LearningRunInput,
    outcome: ReviewOutcome,
    detail: string,
    proposals: readonly MemoryProposal[],
    modelRef: string,
  ): Promise<void> {
    const entry: ReviewLog = {
      id: newId("rev"),
      at: Date.now(),
      memberId: input.memberId,
      memberName: input.memberName,
      roomId: input.roomId,
      runId: input.runId,
      outcome,
      detail,
      proposalIds: proposals.map((proposal) => proposal.id),
      modelRef,
    };
    await this.deps.store.addLog(entry);
    this.deps.onLearned?.({ proposals, log: entry });
  }

  /** 用户点「写入记忆」：过一遍写入通道，成功后把落盘路径回填进提案。 */
  async applyProposal(id: string): Promise<MemoryProposal> {
    const proposal = await this.deps.store.getProposal(id);
    if (!proposal) throw new Error("提案不存在");
    if (proposal.status === "applied") return proposal;
    if (proposal.status === "dismissed") throw new Error("提案已忽略，不能再生效");
    if (!this.deps.memory) throw new Error("记忆层未启用");
    const path = await this.deps.memory.appendEntry(
      proposal.content,
      { triggers: proposal.triggers, importance: proposal.importance },
      proposal.memberRole === "sub" ? { agentId: proposal.memberId } : undefined,
    );
    const updated = await this.deps.store.patchProposal(id, {
      status: "applied",
      appliedAt: Date.now(),
      appliedPath: path,
    });
    if (!updated) throw new Error("提案不存在");
    return updated;
  }

  async dismissProposal(id: string, reason = "用户忽略"): Promise<MemoryProposal> {
    const proposal = await this.deps.store.getProposal(id);
    if (!proposal) throw new Error("提案不存在");
    if (proposal.status === "applied") throw new Error("已写入记忆的提案不能忽略，请在记忆文件里删除");
    const updated = await this.deps.store.patchProposal(id, { status: "dismissed", dismissReason: reason });
    if (!updated) throw new Error("提案不存在");
    return updated;
  }

  async listProposals(): Promise<MemoryProposal[]> {
    return this.deps.store.listProposals();
  }

  async listLog(limit?: number): Promise<ReviewLog[]> {
    return this.deps.store.listLog(limit);
  }

  /** 关房/关进程前把挂起的账本写入落完。 */
  async flush(): Promise<void> {
    await this.deps.store.flush();
  }

  /** 删掉成员后清掉它的待确认提案，避免留下指向不存在成员的条目。 */
  async dropMember(memberId: string): Promise<number> {
    const pending = await this.deps.store.listProposals({ status: "pending" });
    const owned = pending.filter((proposal) => proposal.memberId === memberId);
    for (const proposal of owned) {
      await this.deps.store.patchProposal(proposal.id, { status: "dismissed", dismissReason: "成员已移除" });
    }
    this.counters.delete(memberId);
    return owned.length;
  }
}
