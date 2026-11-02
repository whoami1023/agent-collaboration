import type {
  Member,
  MessageKind,
  ResumeHint,
  RoomEvent,
  RoomMessage,
  RoomMode,
  SenderKind,
} from "../core/types";
import { newId } from "../core/ids";
import { resolveMentions } from "./mentions";

export interface AppendInput {
  senderId: string;
  senderName: string;
  senderKind: SenderKind;
  kind?: MessageKind;
  text: string;
  mentions?: string[];
  taskId?: string;
  runId?: string;
  replyTo?: string;
  chainRootId?: string;
  depthTurn?: number;
  resume?: ResumeHint;
}

const MAX_MESSAGES = 2000;

export class RoomBus {
  readonly roomId: string;

  private name: string;
  private messages: RoomMessage[] = [];
  private members = new Map<string, Member>();
  private listeners = new Set<(event: RoomEvent) => void>();
  private seq = 0;
  private mode: RoomMode = "delegate";

  constructor(roomId: string, roomName: string) {
    this.roomId = roomId;
    this.name = roomName;
  }

  get roomName(): string {
    return this.name;
  }

  get roomMode(): RoomMode {
    return this.mode;
  }

  setMode(mode: RoomMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit({ type: "mode", mode });
  }

  rename(roomName: string): void {
    this.name = roomName;
  }

  subscribe(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RoomEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  addMember(member: Member): void {
    this.members.set(member.id, member);
    this.emit({ type: "member", member });
  }

  updateMember(member: Member): void {
    // 已移除成员的迟到状态更新不得让它复活。
    if (!this.members.has(member.id)) return;
    this.members.set(member.id, member);
    this.emit({ type: "member", member: { ...member } });
  }

  /** 移除成员：只摘出花名册，历史消息保留；返回被移除的成员。 */
  removeMember(memberId: string): Member | undefined {
    const member = this.members.get(memberId);
    if (!member) return undefined;
    this.members.delete(memberId);
    this.emit({ type: "member-removed", memberId });
    return member;
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  findMemberByName(name: string): Member | undefined {
    return this.listMembers().find((m) => m.name.toLowerCase() === name.toLowerCase());
  }

  listMembers(): Member[] {
    return [...this.members.values()];
  }

  listMessages(limit = 300): RoomMessage[] {
    return this.messages.slice(-limit);
  }

  /** 清空聊天记录：保留 seq 单调递增，避免旧事件与新一轮消息的序号混淆。 */
  clearMessages(): number {
    const cleared = this.messages.length;
    this.messages = [];
    this.emit({ type: "messages-cleared" });
    return cleared;
  }

  append(input: AppendInput): RoomMessage {
    const resolved = input.mentions
      ? { ids: [...new Set(input.mentions)], names: [] as string[] }
      : resolveMentions(input.text, this.listMembers());
    const message: RoomMessage = {
      id: newId("msg"),
      roomId: this.roomId,
      seq: ++this.seq,
      ts: Date.now(),
      senderId: input.senderId,
      senderName: input.senderName,
      senderKind: input.senderKind,
      kind: input.kind ?? "chat",
      text: input.text,
      mentions: resolved.ids,
      mentionsRaw: resolved.names,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.chainRootId ? { chainRootId: input.chainRootId } : {}),
      ...(input.depthTurn !== undefined ? { depthTurn: input.depthTurn } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.emit({ type: "message", message: { ...message } });
    return message;
  }

  window(maxChars: number): RoomMessage[] {
    const picked: RoomMessage[] = [];
    let used = 0;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      if (!message) continue;
      const cost = message.text.length + 80;
      if (picked.length > 0 && used + cost > maxChars) break;
      picked.unshift(message);
      used += cost;
    }
    return picked;
  }

  snapshot(): { seq: number; messages: RoomMessage[]; mode: RoomMode } {
    return { seq: this.seq, messages: this.messages, mode: this.mode };
  }

  hydrate(state: { seq?: number; messages?: RoomMessage[]; mode?: RoomMode }): void {
    this.messages = state.messages ?? [];
    this.seq = state.seq ?? this.messages.length;
    this.mode = state.mode === "free" ? "free" : "delegate";
  }
}
