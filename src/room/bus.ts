import type {
  Member,
  MessageKind,
  RoomEvent,
  RoomMessage,
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
}

const MAX_MESSAGES = 2000;

export class RoomBus {
  readonly roomId: string;

  private name: string;
  private messages: RoomMessage[] = [];
  private members = new Map<string, Member>();
  private listeners = new Set<(event: RoomEvent) => void>();
  private seq = 0;

  constructor(roomId: string, roomName: string) {
    this.roomId = roomId;
    this.name = roomName;
  }

  get roomName(): string {
    return this.name;
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
    this.members.set(member.id, member);
    this.emit({ type: "member", member: { ...member } });
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

  snapshot(): { seq: number; messages: RoomMessage[] } {
    return { seq: this.seq, messages: this.messages };
  }

  hydrate(state: { seq?: number; messages?: RoomMessage[] }): void {
    this.messages = state.messages ?? [];
    this.seq = state.seq ?? this.messages.length;
  }
}
