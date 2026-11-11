/**
 * 服务端活动日志：把消息与 run 事件整理成一份可落盘、可回放的执行轨迹。
 *
 * 参考 AgentGUI 的 orphan feed / subagent sidecar：中断的回合也要留下记录，
 * 刷新或重启后执行视图不能只剩聊天文本。事件在这里统一生成并裁剪，
 * 前端只消费快照与 SSE，不再自己推导工具轨迹。
 */
import { newId } from "../core/ids";
import type { AgentEvent, RoomMessage } from "../core/types";

export type ActivityKind =
  | "user"
  | "start"
  | "thinking"
  | "tool"
  | "tool-result"
  | "final"
  | "error"
  | "aborted"
  | "message";

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "user",
  "start",
  "thinking",
  "tool",
  "tool-result",
  "final",
  "error",
  "aborted",
  "message",
];

export interface ActivityEvent {
  id: string;
  memberId: string;
  memberName: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  at: number;
  runId?: string;
  ok?: boolean;
}

export const MAX_ACTIVITY_EVENTS = 500;
export const MAX_ACTIVITY_BYTES = 128 * 1024;
const MAX_DETAIL = 280;
const MAX_SEED_MESSAGES = 300;

export interface ActivityStoreOptions {
  now?: () => number;
  onChange?: (event: ActivityEvent) => void;
  maxEvents?: number;
  maxBytes?: number;
}

function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function bytesOf(event: ActivityEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function abortTitle(reason: "timeout" | "cancelled" | "silent" | "removed" | undefined): string {
  switch (reason) {
    case "timeout":
      return "整轮超时，已中止";
    case "silent":
      return "会话已清除，运行中止";
    case "removed":
      return "成员被移除，运行中止";
    default:
      return "运行已取消";
  }
}

export class ActivityStore {
  private events: ActivityEvent[] = [];
  private readonly now: () => number;
  private readonly onChange: (event: ActivityEvent) => void;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(
    readonly roomId: string,
    options: ActivityStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange ?? (() => undefined);
    this.maxEvents = options.maxEvents ?? MAX_ACTIVITY_EVENTS;
    this.maxBytes = options.maxBytes ?? MAX_ACTIVITY_BYTES;
  }

  hydrate(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const restored: ActivityEvent[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      if (typeof value["id"] !== "string" || typeof value["memberId"] !== "string") continue;
      if (!ACTIVITY_KINDS.includes(value["kind"] as ActivityKind)) continue;
      if (typeof value["at"] !== "number") continue;
      restored.push({
        id: value["id"],
        memberId: value["memberId"],
        memberName: typeof value["memberName"] === "string" ? value["memberName"] : "成员",
        kind: value["kind"] as ActivityKind,
        title: typeof value["title"] === "string" ? value["title"] : "",
        ...(typeof value["detail"] === "string" ? { detail: value["detail"] } : {}),
        at: value["at"],
        ...(typeof value["runId"] === "string" ? { runId: value["runId"] } : {}),
        ...(typeof value["ok"] === "boolean" ? { ok: value["ok"] } : {}),
      });
    }
    restored.sort((a, b) => a.at - b.at);
    this.events = restored;
    this.trim();
  }

  /**
   * 用房间历史播种消息类活动；已有同 id 的不重复加。
   * 只在开房时调用，用来给旧会话补出「用户消息 / 成员发言」锚点。
   */
  seedMessages(
    messages: readonly RoomMessage[],
    names: ReadonlyMap<string, string>,
    limit = MAX_SEED_MESSAGES,
  ): number {
    const before = this.events.length;
    const existing = new Set(this.events.map((event) => event.id));
    for (const message of messages.slice(-limit)) {
      const event = this.messageEvent(message, names);
      if (!event || existing.has(event.id)) continue;
      existing.add(event.id);
      this.events.push(event);
    }
    this.events.sort((a, b) => a.at - b.at);
    this.trim();
    return this.events.length - before;
  }

  /** 记录一条群聊消息；系统提示不进入执行轨迹。 */
  recordMessage(message: RoomMessage, names?: ReadonlyMap<string, string>): ActivityEvent | null {
    const event = this.messageEvent(message, names);
    if (!event) return null;
    if (this.events.some((item) => item.id === event.id)) return null;
    this.push(event);
    return event;
  }

  /** 记录 run 事件；delta 太密不单独存，运行卡里的实时文本已经够用。 */
  recordRunEvent(event: AgentEvent, memberName: string): ActivityEvent | null {
    if (event.type === "reasoning") {
      return this.upsertThinking(event.memberId, memberName, event.text, event.runId);
    }
    const mapped = this.mapRunEvent(event, memberName);
    if (!mapped) return null;
    this.push(mapped);
    return mapped;
  }

  /** 进程中断的待办补一条中止标记：恢复后能看出「这里断过一次」。 */
  recordInterruption(input: {
    memberId: string;
    memberName: string;
    triggerText: string;
  }): ActivityEvent {
    const event: ActivityEvent = {
      id: newId("act"),
      memberId: input.memberId,
      memberName: input.memberName,
      kind: "aborted",
      title: "进程中断，等待恢复",
      detail: clip(`「${input.triggerText}」触发的运行在服务关闭时中断`),
      at: this.now(),
    };
    this.push(event);
    return event;
  }

  clear(): number {
    const removed = this.events.length;
    this.events = [];
    return removed;
  }

  list(): ActivityEvent[] {
    return [...this.events];
  }

  snapshot(): ActivityEvent[] {
    return JSON.parse(JSON.stringify(this.events)) as ActivityEvent[];
  }

  private push(event: ActivityEvent): void {
    this.events.push(event);
    this.trim();
    this.onChange(event);
  }

  /**
   * 推理是流式的：同一轮只保留一条「思考」事件，后续增量更新它的摘要，
   * 避免把整段思维链按增量写满活动日志。
   */
  private upsertThinking(
    memberId: string,
    memberName: string,
    text: string,
    runId: string,
  ): ActivityEvent {
    const id = `thinking_${runId}`;
    const detail = clip(text);
    const existing = this.events.find((event) => event.id === id);
    if (existing) {
      existing.detail = detail;
      this.trim();
      this.onChange(existing);
      return existing;
    }
    const event: ActivityEvent = {
      id,
      memberId,
      memberName,
      kind: "thinking",
      title: "思考",
      ...(detail ? { detail } : {}),
      at: this.now(),
      runId,
    };
    this.push(event);
    return event;
  }

  private trim(): void {
    this.events.sort((a, b) => a.at - b.at);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    let total = this.events.reduce((sum, event) => sum + bytesOf(event), 0);
    let start = 0;
    while (start < this.events.length - 1 && total > this.maxBytes) {
      total -= bytesOf(this.events[start]!);
      start += 1;
    }
    if (start > 0) this.events = this.events.slice(start);
  }

  private messageEvent(
    message: RoomMessage,
    names?: ReadonlyMap<string, string>,
  ): ActivityEvent | null {
    if (message.senderKind === "system" || message.kind === "system") return null;
    const isUser = message.senderKind === "user";
    return {
      id: `msg_${message.id}`,
      memberId: isUser ? "user" : message.senderId,
      memberName: isUser ? "用户" : (names?.get(message.senderId) ?? message.senderName),
      kind: isUser ? "user" : "message",
      title: isUser ? "用户消息" : "发言",
      detail: clip(message.text),
      at: message.ts,
    };
  }

  private mapRunEvent(event: AgentEvent, memberName: string): ActivityEvent | null {
    const base = {
      id: newId("act"),
      memberId: event.memberId,
      memberName,
      at: this.now(),
      runId: event.runId,
    };
    if (event.type === "run-start") {
      return { ...base, kind: "start", title: "开始运行" };
    }
    if (event.type === "tool") {
      let args = "";
      try {
        args = clip(JSON.stringify(event.args), 220);
      } catch {
        args = "";
      }
      return {
        ...base,
        kind: "tool",
        title: `调用 ${event.name}`,
        ...(args && args !== "{}" ? { detail: args } : {}),
      };
    }
    if (event.type === "tool-result") {
      return {
        ...base,
        kind: "tool-result",
        title: `${event.name} ${event.ok ? "返回" : "报错"}`,
        detail: clip(event.content),
        ok: event.ok,
      };
    }
    if (event.type === "run-final") {
      return { ...base, kind: "final", title: "交付完成", detail: clip(event.text) };
    }
    if (event.type === "run-error") {
      return { ...base, kind: "error", title: "运行失败", detail: clip(event.error) };
    }
    if (event.type === "run-aborted") {
      return { ...base, kind: "aborted", title: abortTitle(event.reason) };
    }
    return null;
  }
}
