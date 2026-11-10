/**
 * 持久工作队列：把「一条消息该唤醒谁」从内存调度变成一条可落盘、可恢复的义务行。
 *
 * 机制参考 OpenRig 的 baton 队列（Apache-2.0）：一行 = 一条义务，状态与迁移日志是唯一事实；
 * 领取由系统记录，不依赖运行者自己写回执；进程中断后 in_progress 回到 pending 等待续跑。
 * 与任务卡的区别：任务卡是交付物，队列行是「谁还欠这次唤醒一个终局」。
 */
import { newId } from "../core/ids";
import type { RoomMessage } from "../core/types";

export const WORK_ITEM_STATES = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "canceled",
] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
export type WorkItemSource = "user" | "member" | "system";

/** 活跃状态：还会被领取或取消；其余是终局。 */
export const ACTIVE_WORK_STATES: readonly WorkItemState[] = ["pending", "in_progress"];

/** 容量与恢复窗口：终局行只留最近这些；超过窗口或多次中断的待办不再自动续跑。 */
export const MAX_WORK_ITEMS = 200;
export const MAX_WORK_RECOVERIES = 3;
export const WORK_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 派生健康度：排队太久、运行太久都不算健康，但都不改状态（事实与判断分开）。 */
export const PENDING_STALL_MS = 10 * 60 * 1000;
export const RUNNING_STALL_MS = 15 * 60 * 1000;
const MAX_TRIGGER_CHARS = 20_000;
const MAX_OUTCOME_TEXT_CHARS = 2_000;
const MAX_ERROR_CHARS = 1_000;

export interface WorkItemTransition {
  at: number;
  from: WorkItemState | null;
  to: WorkItemState;
  by: string;
  note?: string;
}

export interface WorkItemOutcome {
  status: "ok" | "error" | "aborted";
  text?: string;
  error?: string;
}

export interface WorkItem {
  id: string;
  roomId: string;
  createdAt: number;
  updatedAt: number;
  source: WorkItemSource;
  memberId: string;
  memberName: string;
  /** 触发这次唤醒的群聊消息：自包含存储，原消息被清理后仍能续跑。 */
  trigger: RoomMessage;
  state: WorkItemState;
  /** 被领取的次数（含中断后重新领取）。 */
  attempts: number;
  /** 进程中断后恢复的次数；超过上限不再自动续跑，避免崩溃循环。 */
  recoveries: number;
  claimedAt?: number;
  finishedAt?: number;
  outcome?: WorkItemOutcome;
  transitions: WorkItemTransition[];
}

/** 派生视图：状态是事实，derived 是「现在看起来健不健康」的判断。 */
export type WorkDerived =
  | "queued"
  | "working"
  | "unclaimed-stalled"
  | "running-stalled"
  | "finished";

export interface WorkItemHealth extends WorkItem {
  derived: WorkDerived;
  /** 从入队或领取算起的毫秒数（终局项为 0）。 */
  ageMs: number;
}

export interface WorkQueueOptions {
  now?: () => number;
  /** 每次状态变化后触发（房间落盘用它做防抖保存）。 */
  onChange?: () => void;
  maxItems?: number;
  pendingStallMs?: number;
  runningStallMs?: number;
}

function isActive(state: WorkItemState): boolean {
  return state === "pending" || state === "in_progress";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 原消息可能已经被清理：只保留运行真正会读到的字段，缺失项给安全默认值。 */
function normalizeTrigger(value: unknown, roomId: string): RoomMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["id"] !== "string" || typeof raw["text"] !== "string") return null;
  const senderKind =
    raw["senderKind"] === "user" || raw["senderKind"] === "member" || raw["senderKind"] === "system"
      ? raw["senderKind"]
      : "system";
  const kind = raw["kind"] === "announce" || raw["kind"] === "system" ? raw["kind"] : "chat";
  const mentions = Array.isArray(raw["mentions"])
    ? raw["mentions"].filter((item): item is string => typeof item === "string")
    : [];
  const mentionsRaw = Array.isArray(raw["mentionsRaw"])
    ? raw["mentionsRaw"].filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: raw["id"],
    roomId: typeof raw["roomId"] === "string" ? raw["roomId"] : roomId,
    seq: typeof raw["seq"] === "number" ? raw["seq"] : 0,
    ts: typeof raw["ts"] === "number" ? raw["ts"] : 0,
    senderId: typeof raw["senderId"] === "string" ? raw["senderId"] : "unknown",
    senderName: typeof raw["senderName"] === "string" ? raw["senderName"] : "未知",
    senderKind,
    kind,
    text: (raw["text"] as string).slice(0, MAX_TRIGGER_CHARS),
    mentions,
    mentionsRaw,
    ...(typeof raw["runScope"] === "string" ? { runScope: raw["runScope"] as RoomMessage["runScope"] } : {}),
    ...(typeof raw["depthTurn"] === "number" ? { depthTurn: raw["depthTurn"] } : {}),
    ...(typeof raw["chainRootId"] === "string" ? { chainRootId: raw["chainRootId"] } : {}),
  } as RoomMessage;
}

function normalizeTransitions(value: unknown, fallbackAt: number): WorkItemTransition[] {
  if (!Array.isArray(value)) {
    return [{ at: fallbackAt, from: null, to: "pending", by: "system", note: "派发" }];
  }
  const transitions: WorkItemTransition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const to = raw["to"];
    if (!WORK_ITEM_STATES.includes(to as WorkItemState)) continue;
    if (typeof raw["at"] !== "number") continue;
    const from = WORK_ITEM_STATES.includes(raw["from"] as WorkItemState)
      ? (raw["from"] as WorkItemState)
      : null;
    transitions.push({
      at: raw["at"],
      from,
      to: to as WorkItemState,
      by: typeof raw["by"] === "string" ? raw["by"] : "system",
      ...(typeof raw["note"] === "string" ? { note: raw["note"] } : {}),
    });
  }
  return transitions.length > 0
    ? transitions
    : [{ at: fallbackAt, from: null, to: "pending", by: "system", note: "派发" }];
}

export class WorkQueue {
  private items: WorkItem[] = [];
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly maxItems: number;
  private readonly pendingStallMs: number;
  private readonly runningStallMs: number;

  constructor(
    readonly roomId: string,
    options: WorkQueueOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange ?? (() => undefined);
    this.maxItems = options.maxItems ?? MAX_WORK_ITEMS;
    this.pendingStallMs = options.pendingStallMs ?? PENDING_STALL_MS;
    this.runningStallMs = options.runningStallMs ?? RUNNING_STALL_MS;
  }

  /** 从房间状态恢复；坏行直接丢弃，不让一份旧文件挡住整间房。 */
  hydrate(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const restored: WorkItem[] = [];
    for (const entry of raw) {
      const item = this.normalize(entry);
      if (item) restored.push(item);
    }
    restored.sort((a, b) => a.createdAt - b.createdAt);
    this.items = restored;
    this.trim();
  }

  /** 同一成员、同一条触发消息只建一行：重复唤醒不应该产生两笔义务。 */
  enqueue(input: {
    memberId: string;
    memberName: string;
    trigger: RoomMessage;
  }): WorkItem | null {
    const duplicated = this.items.some(
      (item) =>
        isActive(item.state) &&
        item.memberId === input.memberId &&
        item.trigger.id === input.trigger.id,
    );
    if (duplicated) return null;
    const at = this.now();
    const source: WorkItemSource =
      input.trigger.senderKind === "user"
        ? "user"
        : input.trigger.senderKind === "member"
          ? "member"
          : "system";
    const item: WorkItem = {
      id: newId("work"),
      roomId: this.roomId,
      createdAt: at,
      updatedAt: at,
      source,
      memberId: input.memberId,
      memberName: input.memberName,
      trigger: { ...input.trigger, text: input.trigger.text.slice(0, MAX_TRIGGER_CHARS) },
      state: "pending",
      attempts: 0,
      recoveries: 0,
      transitions: [{ at, from: null, to: "pending", by: "system", note: "派发" }],
    };
    this.items.push(item);
    this.trim();
    this.onChange();
    return item;
  }

  claim(id: string): WorkItem | null {
    const item = this.get(id);
    if (!item || item.state !== "pending") return null;
    const at = this.now();
    item.attempts += 1;
    item.claimedAt = at;
    this.transition(item, "in_progress", item.memberId, "开始运行");
    return item;
  }

  complete(id: string, text: string): WorkItem | null {
    const item = this.get(id);
    if (!item || item.state !== "in_progress") return null;
    item.outcome = { status: "ok", text: clip(text, MAX_OUTCOME_TEXT_CHARS) };
    this.finish(item, "done", item.memberId, "运行完成");
    return item;
  }

  fail(id: string, error: string): WorkItem | null {
    const item = this.get(id);
    if (!item || !isActive(item.state)) return null;
    item.outcome = { status: "error", error: clip(error, MAX_ERROR_CHARS) };
    this.finish(item, "failed", "system", "运行失败");
    return item;
  }

  cancel(id: string, note: string): WorkItem | null {
    const item = this.get(id);
    if (!item || !isActive(item.state)) return null;
    item.outcome = { status: "aborted", error: clip(note, MAX_ERROR_CHARS) };
    this.finish(item, "canceled", "system", clip(note, MAX_ERROR_CHARS));
    return item;
  }

  cancelForMember(memberId: string, note: string): number {
    let canceled = 0;
    for (const item of this.items) {
      if (item.memberId === memberId && isActive(item.state)) {
        if (this.cancel(item.id, note)) canceled += 1;
      }
    }
    return canceled;
  }

  cancelOpen(note: string): number {
    let canceled = 0;
    for (const item of this.items) {
      if (isActive(item.state) && this.cancel(item.id, note)) canceled += 1;
    }
    return canceled;
  }

  /** 进程中断：in_progress 回到 pending，恢复次数 +1；由编排器决定续跑还是放弃。 */
  recoverInterrupted(): number {
    let recovered = 0;
    for (const item of this.items) {
      if (item.state !== "in_progress") continue;
      item.recoveries += 1;
      delete item.claimedAt;
      this.transition(item, "pending", "system", "进程中断，等待恢复");
      recovered += 1;
    }
    return recovered;
  }

  pending(): WorkItem[] {
    return this.items
      .filter((item) => item.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): WorkItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  list(): WorkItem[] {
    return [...this.items];
  }

  /** 只读视图：附带派生健康度，不改动持久状态。 */
  health(): WorkItemHealth[] {
    const at = this.now();
    return this.items.map((item) => {
      const since = item.state === "pending" ? item.createdAt : (item.claimedAt ?? item.createdAt);
      const ageMs = isActive(item.state) ? Math.max(0, at - since) : 0;
      let derived: WorkDerived;
      if (!isActive(item.state)) derived = "finished";
      else if (item.state === "pending") {
        derived = ageMs > this.pendingStallMs ? "unclaimed-stalled" : "queued";
      } else {
        derived = ageMs > this.runningStallMs ? "running-stalled" : "working";
      }
      return { ...item, derived, ageMs };
    });
  }

  snapshot(): WorkItem[] {
    return JSON.parse(JSON.stringify(this.items)) as WorkItem[];
  }

  private finish(item: WorkItem, to: WorkItemState, by: string, note: string): void {
    item.finishedAt = this.now();
    this.transition(item, to, by, note);
  }

  private transition(item: WorkItem, to: WorkItemState, by: string, note: string): void {
    const at = this.now();
    item.transitions.push({ at, from: item.state, to, by, note });
    item.state = to;
    item.updatedAt = at;
    this.trim();
    this.onChange();
  }

  private trim(): void {
    const active = this.items.filter((item) => isActive(item.state));
    const terminal = this.items
      .filter((item) => !isActive(item.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-this.maxItems);
    this.items = [...terminal, ...active].sort((a, b) => a.createdAt - b.createdAt);
  }

  private normalize(value: unknown): WorkItem | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const state = raw["state"];
    if (!WORK_ITEM_STATES.includes(state as WorkItemState)) return null;
    const trigger = normalizeTrigger(raw["trigger"], this.roomId);
    if (!trigger) return null;
    if (typeof raw["id"] !== "string" || typeof raw["memberId"] !== "string") return null;
    const createdAt = typeof raw["createdAt"] === "number" ? raw["createdAt"] : 0;
    const outcomeRaw = raw["outcome"];
    let outcome: WorkItemOutcome | undefined;
    if (outcomeRaw && typeof outcomeRaw === "object") {
      const o = outcomeRaw as Record<string, unknown>;
      if (o["status"] === "ok" || o["status"] === "error" || o["status"] === "aborted") {
        outcome = {
          status: o["status"],
          ...(typeof o["text"] === "string" ? { text: o["text"] } : {}),
          ...(typeof o["error"] === "string" ? { error: o["error"] } : {}),
        };
      }
    }
    return {
      id: raw["id"],
      roomId: typeof raw["roomId"] === "string" ? raw["roomId"] : this.roomId,
      createdAt,
      updatedAt: typeof raw["updatedAt"] === "number" ? raw["updatedAt"] : createdAt,
      source:
        raw["source"] === "user" || raw["source"] === "member" || raw["source"] === "system"
          ? raw["source"]
          : "system",
      memberId: raw["memberId"],
      memberName: typeof raw["memberName"] === "string" ? raw["memberName"] : raw["memberId"],
      trigger,
      state: state as WorkItemState,
      attempts: typeof raw["attempts"] === "number" ? Math.max(0, raw["attempts"]) : 0,
      recoveries: typeof raw["recoveries"] === "number" ? Math.max(0, raw["recoveries"]) : 0,
      ...(typeof raw["claimedAt"] === "number" ? { claimedAt: raw["claimedAt"] } : {}),
      ...(typeof raw["finishedAt"] === "number" ? { finishedAt: raw["finishedAt"] } : {}),
      ...(outcome ? { outcome } : {}),
      transitions: normalizeTransitions(raw["transitions"], createdAt),
    };
  }
}
