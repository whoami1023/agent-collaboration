/**
 * 整轮预算（对应 AutoGen 的 TokenUsage / Timeout / MaxMessage 组合终止）：
 * 一条用户消息可能扇出给多个成员、每个成员又能接力唤醒别人，单次运行的限额管不住总量。
 * 这里按任务链（根消息 id）共享 token、墙钟时间和运行次数三个闸门，
 * 任何一项到顶就停止继续唤醒，已完成的内容保留。
 */

import type { Limits } from "../core/types";

export type TurnStopReason = "tokens" | "time" | "runs";

export interface TurnBudgetView {
  chainId: string;
  startedAt: number;
  runs: number;
  tokens: number;
  stop?: TurnStopReason;
}

interface TurnBudgetEntry {
  startedAt: number;
  runs: number;
  tokens: number;
  stop?: TurnStopReason;
  notified: Set<TurnStopReason>;
}

const MAX_TRACKED_TURNS = 50;

export class TurnBudgetBook {
  private readonly entries = new Map<string, TurnBudgetEntry>();
  private readonly getLimits: () => Limits;
  private readonly now: () => number;

  constructor(getLimits: () => Limits, now: () => number = () => Date.now()) {
    this.getLimits = getLimits;
    this.now = now;
  }

  /** 用户新消息开始时建账；同一条链重复调用保持原起点。 */
  begin(chainId: string): void {
    if (this.entries.has(chainId)) return;
    this.entries.set(chainId, {
      startedAt: this.now(),
      runs: 0,
      tokens: 0,
      notified: new Set(),
    });
    this.trim();
  }

  /** 成员消息或重启后第一次见到的链：补一份起点，后续仍按同一套闸门。 */
  ensure(chainId: string): void {
    this.begin(chainId);
  }

  /** 模型调用结束后累加 token；返回刚刚触发的停止原因（若本次才到顶）。 */
  addTokens(chainId: string, tokens: number): TurnStopReason | null {
    if (!Number.isFinite(tokens) || tokens <= 0) return null;
    const entry = this.entry(chainId);
    entry.tokens += Math.floor(tokens);
    const reason = this.stopReason(chainId);
    return reason && reason !== "runs" ? reason : null;
  }

  /** 运行开始前的闸门：返回 false 时调用方不应开这一轮。 */
  beginRun(chainId: string): { allowed: boolean; reason?: TurnStopReason } {
    const reason = this.stopReason(chainId);
    if (reason) return { allowed: false, reason };
    const entry = this.entry(chainId);
    const limit = Math.max(1, this.getLimits().turnMaxRuns);
    if (entry.runs >= limit) {
      entry.stop = "runs";
      return { allowed: false, reason: "runs" };
    }
    entry.runs += 1;
    return { allowed: true };
  }

  stopReason(chainId: string): TurnStopReason | null {
    const entry = this.entries.get(chainId);
    if (!entry) return null;
    if (entry.stop) return entry.stop;
    const limits = this.getLimits();
    if (this.now() - entry.startedAt >= Math.max(1_000, limits.turnTimeoutMs)) {
      entry.stop = "time";
      return entry.stop;
    }
    if (entry.tokens >= Math.max(1, limits.turnTokenBudget)) {
      entry.stop = "tokens";
      return entry.stop;
    }
    return null;
  }

  /** 同一个链的同一个停止原因只提醒一次，避免每个被拦下的唤醒都刷一条系统消息。 */
  markNotified(chainId: string, reason: TurnStopReason): boolean {
    const entry = this.entry(chainId);
    if (entry.notified.has(reason)) return false;
    entry.notified.add(reason);
    return true;
  }

  view(chainId: string): TurnBudgetView {
    const entry = this.entry(chainId);
    return {
      chainId,
      startedAt: entry.startedAt,
      runs: entry.runs,
      tokens: entry.tokens,
      ...(entry.stop ? { stop: entry.stop } : {}),
    };
  }

  clear(): void {
    this.entries.clear();
  }

  private entry(chainId: string): TurnBudgetEntry {
    let entry = this.entries.get(chainId);
    if (!entry) {
      this.begin(chainId);
      entry = this.entries.get(chainId)!;
    }
    return entry;
  }

  private trim(): void {
    if (this.entries.size <= MAX_TRACKED_TURNS) return;
    const oldest = [...this.entries.entries()]
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .slice(0, this.entries.size - MAX_TRACKED_TURNS);
    for (const [chainId] of oldest) this.entries.delete(chainId);
  }
}
