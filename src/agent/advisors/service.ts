/**
 * 顾问扇出服务（Hermes `moa_loop.py` 的群聊版）。
 *
 * 与上游的三处刻意不同，都是为这套架构改的：
 * 1. **执行成员自己就是聚合方**——不再额外花一次「合成」调用，建议块直接作为一条用户消息
 *    递进它本轮的上下文；上游那段「综合参考意见」的活儿本来就要由它来干。
 * 2. **顾问是在册成员**，不是凭空造的 preset 槽位：槽位只决定它从哪个角度（稳妥/发散/挑刺）看问题。
 * 3. **一律不注册工具**：顾问没有执行能力，也就没有把「说了」当成「做了'」的机会。
 *
 * 失败必须安静且诚实：单个顾问失败就在建议块里留一条 `[未产出：原因]`，全失败就整块不注入，
 * 执行成员照常干活——参谋只能让这一轮更好，不能让它更贵或更慢地卡住。
 */

import type { Member, RoomMessage } from "../../core/types";
import type { Settings } from "../../core/settings";
import type { ModelUsageStore } from "../../model/usage-store";
import { resolveModelRuntime, type RuntimeDeps as ModelRuntimeDeps } from "../../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../../model/usage-cost";
import type { LlmRequest } from "../../provider/types";
import type { MemberUsageRecord } from "../member-runtime";
import { buildAdvisoryView } from "./advisory-view";
import { advisorCacheKey, wantsFanOut } from "./cadence";
import { MAX_ADVISOR_WORKERS, pickAdvisors } from "./fanout";
import {
  ADVISOR_SYSTEM_PROMPT,
  ADVISOR_SLOTS,
  advisorBrief,
  advisorHeading,
  AGGREGATOR_INSTRUCTION,
  type AdvisorSlot,
} from "./prompts";

export const ADVISOR_LIMITS = {
  /** 一次参谋输出的上限：建议是路标，不是论文。 */
  maxOutputTokens: 700,
  /** 单个顾问调用的墙上时钟上限。 */
  timeoutMs: 45_000,
  /** 回合缓存条数上限，超了就整张清掉（缓存只是省钱，丢了不影响正确性）。 */
  cacheMax: 64,
} as const;

export interface AdvisorRequest {
  /** 动手的成员：它就是聚合方。 */
  acting: Member;
  /** 房间花名册。 */
  members: readonly Member[];
  /** 顾问视角的材料来源：房间最近的消息。 */
  messages: readonly RoomMessage[];
  /** 这次要干的事，写在建议材料的最前面。 */
  taskText: string;
  roomId: string;
  /** 用户回合标识：`user_turn` 节奏按它去重与缓存。 */
  turnKey: string;
  getModelDeps(): ModelRuntimeDeps;
  signal?: AbortSignal;
}

export interface AdvisorEntry {
  advisor: Member;
  slot: AdvisorSlot;
  text?: string;
  error?: string;
}

export interface AdvisorOutcome {
  /** 递给执行成员的建议块；没有建议时为 undefined（本轮没有参谋）。 */
  guidance?: string;
  /** 群里那句可核验的说明；`silent` 降级策略下不播。 */
  note?: string;
  entries: AdvisorEntry[];
  reason: AdvisorReason;
}

export type AdvisorReason =
  | "disabled"
  | "cadence"
  | "no-advisors"
  | "cached"
  | "all-failed"
  | "ok";

export interface AdvisorServiceDeps {
  getSettings(): Settings;
  usage?: ModelUsageStore;
  /** 顾问的花费也要进同一本账：它是房间里真实发生的一次调用。 */
  onUsageRecord?(record: MemberUsageRecord): void;
}

export class AdvisorService {
  private readonly runOrdinals = new Map<string, number>();
  private readonly cache = new Map<string, string>();

  constructor(private readonly deps: AdvisorServiceDeps) {}

  /** 供 /status 一类只读展示：当前配置下一次会问几位顾问。 */
  get configuredCount(): number {
    const advisors = this.deps.getSettings().advisors;
    return advisors.enabled ? advisors.maxAdvisors : 0;
  }

  async run(request: AdvisorRequest): Promise<AdvisorOutcome> {
    const settings = this.deps.getSettings().advisors;
    if (!settings.enabled) return { entries: [], reason: "disabled" };

    const ordinal = this.bumpOrdinal(request.acting.id);
    if (!wantsFanOut(settings, ordinal)) return { entries: [], reason: "cadence" };

    const advisors = pickAdvisors(request.acting, request.members, settings.maxAdvisors);
    if (advisors.length === 0) return { entries: [], reason: "no-advisors" };

    const slots = advisors.map((_, index) => ADVISOR_SLOTS[index % ADVISOR_SLOTS.length]);
    const key = advisorCacheKey({
      roomId: request.roomId,
      turnKey: request.turnKey,
      actingId: request.acting.id,
      advisorIds: advisors.map((advisor) => advisor.id),
    });
    if (settings.cadence === "user_turn") {
      const cached = this.cache.get(key);
      if (cached) {
        return {
          guidance: cached,
          entries: advisors.map((advisor, index) => ({ advisor, slot: slots[index] })),
          reason: "cached",
        };
      }
    }

    const view = buildAdvisoryView({
      messages: request.messages,
      taskLine: `当前任务（来自 ${
        request.acting.role === "main" ? "主智能体" : `主执行成员 @${request.acting.name}`
      }）：\n${request.taskText}`,
    });

    const entries = await gather({
      advisors,
      slots,
      view,
      modelRef: settings.modelRef ?? request.acting.modelRef,
      getModelDeps: request.getModelDeps,
      ...(request.signal ? { signal: request.signal } : {}),
      onUsage: (record) => this.account(record),
    });

    const ok = entries.filter((entry) => entry.text);
    if (ok.length === 0) {
      // 全失败：整块不注入，执行成员按自己的判断干活（Hermes 的 all-failed → 跳过合成）。
      const loud = settings.degraded === "loud";
      return {
        entries,
        reason: "all-failed",
        ...(loud
          ? {
              note:
                `想请 ${advisors.length} 位顾问出建议，一个都没回（模型不可用、超时或本轮被中止），` +
                `本轮不采纳参谋意见，直接按主执行成员的判断干活。`,
            }
          : {}),
      };
    }

    const guidance = renderGuidance(entries);
    if (settings.cadence === "user_turn") {
      if (this.cache.size > ADVISOR_LIMITS.cacheMax) this.cache.clear();
      this.cache.set(key, guidance);
    }
    const failed = entries.length - ok.length;
    return {
      guidance,
      entries,
      reason: "ok",
      ...(failed > 0 && settings.degraded === "loud"
        ? { note: `${ok.length} 位顾问出了建议，${failed} 位没回（已在建议块里标注）。` }
        : {}),
    };
  }

  private bumpOrdinal(memberId: string): number {
    const next = (this.runOrdinals.get(memberId) ?? 0) + 1;
    if (this.runOrdinals.size > 200) this.runOrdinals.clear();
    this.runOrdinals.set(memberId, next);
    return next;
  }

  private account(record: MemberUsageRecord): void {
    try {
      void this.deps.usage?.record(record);
    } catch {
      // 记账失败不影响本轮建议。
    }
    this.deps.onUsageRecord?.(record);
  }

  /** 换房间或新会话时丢弃回合缓存：旧回合的建议不该再被复用。 */
  clearCache(): void {
    this.cache.clear();
  }
}

/** 建议块：带标签、1 起编号，失败位也留在块里，让执行成员知道谁没说话。 */
export function renderGuidance(entries: readonly AdvisorEntry[]): string {
  const body = entries
    .map((entry, index) => {
      const heading = advisorHeading(index + 1, entry.slot, entry.advisor);
      const text = entry.text?.trim() || `[未产出：${entry.error ?? "没有回复"}]`;
      return `${heading}：\n${text}`;
    })
    .join("\n\n");
  return `${AGGREGATOR_INSTRUCTION}\n\n${body}`;
}

interface GatherParams {
  advisors: Member[];
  slots: AdvisorSlot[];
  view: string;
  modelRef: string | undefined;
  getModelDeps(): ModelRuntimeDeps;
  signal?: AbortSignal;
  onUsage(record: MemberUsageRecord): void;
}

/** 并发问顾问：并行发起、按花名册顺序回填（Hermes 的 `min(8, total)` 并发 + 保序输出）。 */
async function gather(params: GatherParams): Promise<AdvisorEntry[]> {
  const results: AdvisorEntry[] = new Array(params.advisors.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= params.advisors.length) return;
      const advisor = params.advisors[index];
      const slot = params.slots[index];
      const entry: AdvisorEntry = { advisor, slot };
      results[index] = entry;
      try {
        const text = await askAdvisor({
          advisor,
          slot,
          view: params.view,
          modelRef: params.modelRef,
          getModelDeps: params.getModelDeps,
          ...(params.signal ? { signal: params.signal } : {}),
          onUsage: params.onUsage,
        });
        if (text) entry.text = text;
        else entry.error = "没有回复";
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(MAX_ADVISOR_WORKERS, params.advisors.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

interface AskParams {
  advisor: Member;
  slot: AdvisorSlot;
  view: string;
  modelRef: string | undefined;
  getModelDeps(): ModelRuntimeDeps;
  signal?: AbortSignal;
  onUsage(record: MemberUsageRecord): void;
}

/** 一次顾问调用：不带工具、限长输出、槽位温度；失败上抛，由调用方标成 `[未产出]`。 */
async function askAdvisor(params: AskParams): Promise<string> {
  // 已中止的信号不会再触发 once 监听器：先退出，免得为一条没人要的建议花钱。
  if (params.signal?.aborted) throw new Error("本轮已中止");
  const transport = resolveModelRuntime(params.modelRef, params.getModelDeps());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADVISOR_LIMITS.timeoutMs);
  timer.unref();
  const relay = () => controller.abort();
  params.signal?.addEventListener("once", relay);
  try {
    const request: LlmRequest = {
      model: transport.model.id,
      messages: [
        {
          role: "system",
          content: `${ADVISOR_SYSTEM_PROMPT}\n\n你的参谋视角（来自这名成员的职责档案）：\n${advisorBrief(
            params.advisor,
          )}\n你这一位的角度：${params.slot.label}。`,
        },
        { role: "user", content: params.view },
      ],
      // 顾问不许执行，所以一个工具都不给——契约写在提示词里，能力上也不给路。
      tools: [],
      params: { ...transport.request.params, temperature: params.slot.temperature },
      maxTokens: Math.min(
        ADVISOR_LIMITS.maxOutputTokens,
        transport.request.maxTokens ?? ADVISOR_LIMITS.maxOutputTokens,
      ),
      ...(transport.request.headers ? { headers: transport.request.headers } : {}),
      ...(transport.request.baseUrl ? { baseUrl: transport.request.baseUrl } : {}),
      signal: controller.signal,
    };
    let text = "";
    let usage = emptyUsage();
    for await (const event of transport.provider.stream(request)) {
      if (event.type === "text") text += event.delta;
      else if (event.type === "usage") usage = addUsage(usage, event.usage);
    }
    await chargeUsage(transport, usage, params.onUsage);
    return text.trim();
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("once", relay);
  }
}

async function chargeUsage(
  transport: ReturnType<typeof resolveModelRuntime>,
  usage: UsageTotals,
  onUsage: (record: MemberUsageRecord) => void,
): Promise<void> {
  if (usage.input + usage.output === 0) return;
  const ref = transport.activeRef() || transport.model.ref;
  const model =
    [transport.chain.primary, ...transport.chain.fallbacks].find((c) => c.ref === ref) ??
    transport.model;
  onUsage({
    ref,
    providerId: model.providerId,
    modelId: model.id,
    usage,
    costUsd: calculateUsageCost(model, usage),
  });
}
