/**
 * 分流调用（移植 Hermes 的 `group_router`）：一次不带工具、低温、短输出的小模型调用，
 * 只回答「这条消息该谁接」。
 *
 * 它必须比正文便宜一个数量级，也必须永远有个兜底：解析失败、模型不可用、超时、被中止，
 * 一律回 `picks: []`，由调用方按 `lead` 交给主智能体——分流只能让答复更准，不能没人答。
 */

import type { Member, RoomMessage } from "../core/types";
import type { ModelUsageStore } from "../model/usage-store";
import {
  resolveModelRuntime,
  type RuntimeDeps as ModelRuntimeDeps,
} from "../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../model/usage-cost";
import type { LlmRequest } from "../provider/types";
import type { MemberUsageRecord } from "./member-runtime";
import { buildRouterMessages, parseRouterPicks, ROUTING_LIMITS } from "../room/routing";

export interface RouteDeps {
  message: RoomMessage;
  candidates: readonly Member[];
  recent: readonly RoomMessage[];
  getModelDeps(): ModelRuntimeDeps;
  /** 分流借用主智能体的模型引用（含备用链）；缺省跟随设置里的默认模型。 */
  modelRef?: string;
  usage?: ModelUsageStore;
  onUsageRecord?(record: MemberUsageRecord): void;
  signal?: AbortSignal;
}

export interface RouteOutcome {
  /** 挑中的成员 ID；空数组表示「没挑出来」，调用方按 lead 回落。 */
  picks: string[];
  /** 为什么是这个结果：给系统提示里那条可核验的分流回执用。 */
  reason: "picked" | "no-pick" | "unavailable" | "failed";
}

export async function routeMembers(deps: RouteDeps): Promise<RouteOutcome> {
  // 调用方已经中止（/stop、换会话）就别再花钱了：once 监听器对已中止的信号不会再触发。
  if (deps.signal?.aborted) return { picks: [], reason: "failed" };
  let transport: ReturnType<typeof resolveModelRuntime>;
  try {
    transport = resolveModelRuntime(deps.modelRef, deps.getModelDeps());
  } catch {
    return { picks: [], reason: "unavailable" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTING_LIMITS.timeoutMs);
  timer.unref();
  const relay = () => controller.abort();
  deps.signal?.addEventListener("once", relay);

  try {
    const request: LlmRequest = {
      model: transport.model.id,
      messages: buildRouterMessages({
        message: deps.message,
        candidates: [...deps.candidates],
        recent: [...deps.recent],
      }),
      tools: [],
      // 分流要的是稳定，不是文采：温度归零、输出封顶，其余参数沿用模型装配的结果。
      params: { ...transport.request.params, temperature: 0 },
      maxTokens: Math.min(
        ROUTING_LIMITS.maxTokens,
        transport.request.maxTokens ?? ROUTING_LIMITS.maxTokens,
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
    await account(transport, deps, usage);
    const picks = parseRouterPicks(text, [...deps.candidates]);
    return picks ? { picks, reason: "picked" } : { picks: [], reason: "no-pick" };
  } catch {
    return { picks: [], reason: "failed" };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("once", relay);
  }
}

/** 分流的花费也要进用量账本：它是房间里的行为，不是免费的。 */
async function account(
  transport: ReturnType<typeof resolveModelRuntime>,
  deps: RouteDeps,
  usage: UsageTotals,
): Promise<void> {
  if (usage.input + usage.output === 0) return;
  const ref = transport.activeRef() || transport.model.ref;
  const model =
    [transport.chain.primary, ...transport.chain.fallbacks].find((c) => c.ref === ref) ??
    transport.model;
  const costUsd = calculateUsageCost(model, usage);
  const record: MemberUsageRecord = {
    ref,
    providerId: model.providerId,
    modelId: model.id,
    usage,
    costUsd,
  };
  try {
    await deps.usage?.record(record);
  } catch {
    // 账本失败不影响分流本身。
  }
  deps.onUsageRecord?.(record);
}
