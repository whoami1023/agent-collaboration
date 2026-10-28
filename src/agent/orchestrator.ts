import type { Limits, Member, RoomMessage } from "../core/types";
import { DEFAULT_PROVIDER_ID, SYSTEM_ID, USER_ID } from "../core/types";
import type { Settings } from "../core/settings";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import { decideWakes } from "../room/wake";
import { MemberRuntime } from "./member-runtime";
import type { SpawnInput } from "./tools";
import type { MockHandler } from "../provider/mock";

export interface OrchestratorDeps {
  bus: RoomBus;
  board: Workboard;
  getSettings(): Settings;
  mockHandler?: MockHandler;
}

const RESERVED_NAMES = new Set(["用户", "系统"]);
const NAME_RE = /^[\p{L}\p{N}_-]{1,12}$/u;

export function ensureMainMember(bus: RoomBus, name = "主智能体"): Member {
  const existing = bus.listMembers().find((member) => member.role === "main");
  if (existing) return existing;
  const member: Member = {
    id: "m_main",
    roomId: bus.roomId,
    name,
    role: "main",
    status: "idle",
    depth: 0,
    spawnedBy: null,
    controlScope: "children",
    contextMode: "isolated",
    systemPrompt: "",
    providerId: DEFAULT_PROVIDER_ID,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  bus.addMember(member);
  return member;
}

export class Orchestrator {
  private runtimes = new Map<string, MemberRuntime>();
  private seen = new Set<string>();
  private notices = new Set<string>();
  private queue: Array<() => void> = [];
  private active = 0;
  private stopped = false;

  constructor(private readonly deps: OrchestratorDeps) {
    deps.bus.subscribe((event) => {
      if (event.type !== "message" || event.message.senderKind === "system") return;
      queueMicrotask(() => {
        if (!this.stopped) this.dispatch(event.message);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    for (const runtime of this.runtimes.values()) runtime.cancel();
  }

  get activeRuns(): number {
    return this.active;
  }

  sendUserMessage(text: string): RoomMessage {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("消息不能为空");
    return this.deps.bus.append({
      senderId: USER_ID,
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: trimmed,
      depthTurn: 0,
    });
  }

  cancelMember(memberId: string): boolean {
    return this.runtimes.get(memberId)?.cancel() ?? false;
  }

  private dispatch(message: RoomMessage): void {
    const limits = this.deps.getSettings().limits;
    const depthTurn = message.depthTurn ?? 0;
    if (depthTurn > limits.maxTurnsPerUserMessage) {
      const chain = message.chainRootId ?? message.id;
      if (!this.notices.has(chain)) {
        this.notices.add(chain);
        this.deps.bus.append({
          senderId: SYSTEM_ID,
          senderName: "系统",
          senderKind: "system",
          kind: "system",
          text: `本轮对话已达 ${limits.maxTurnsPerUserMessage} 回合上限，为防止成员互相唤醒的死循环，已暂停本轮唤醒。请调整任务或重新发消息。`,
        });
      }
      return;
    }
    const { wakes } = decideWakes(message, this.deps.bus.listMembers());
    for (const memberId of wakes) this.wake(memberId, message);
  }

  private wake(memberId: string, trigger: RoomMessage): void {
    const member = this.deps.bus.getMember(memberId);
    if (!member || member.status === "cancelled") return;
    const key = `${trigger.id}:${memberId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.clear();

    const runtime = this.runtimeFor(member);
    if (runtime.isRunning) {
      runtime.steer(trigger);
      return;
    }
    this.schedule(() => runtime.run(trigger));
  }

  private schedule(run: () => Promise<void>): void {
    const start = () => {
      this.active += 1;
      void run().finally(() => {
        this.active -= 1;
        this.drain();
      });
    };
    if (this.active < this.deps.getSettings().limits.maxConcurrent) start();
    else this.queue.push(start);
  }

  private drain(): void {
    const max = this.deps.getSettings().limits.maxConcurrent;
    while (this.active < max && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }

  private runtimeFor(member: Member): MemberRuntime {
    let runtime = this.runtimes.get(member.id);
    if (!runtime) {
      const deps = this.deps;
      runtime = new MemberRuntime(member, {
        bus: deps.bus,
        board: deps.board,
        getProviderDeps: () => ({
          settings: deps.getSettings(),
          ...(deps.mockHandler ? { mockHandler: deps.mockHandler } : {}),
        }),
        getLimits: () => deps.getSettings().limits,
        spawn: (parent, input, trigger) => this.spawn(parent, input, trigger),
      });
      this.runtimes.set(member.id, runtime);
    }
    return runtime;
  }

  private async spawn(parent: Member, input: SpawnInput, trigger: RoomMessage): Promise<string> {
    const { bus, board } = this.deps;
    const limits: Limits = this.deps.getSettings().limits;
    if (parent.role !== "main") return "错误：只有主智能体可以创建成员";

    const name = input.name.replace(/^@+/, "").trim();
    if (!NAME_RE.test(name)) return "错误：成员名只能是 1-12 个中英文、数字、下划线或短横线";
    if (RESERVED_NAMES.has(name)) return `错误：${name} 是保留名称`;
    if (bus.findMemberByName(name)) return `错误：成员 @${name} 已存在，请直接 @ 它派活`;
    if (parent.depth + 1 >= limits.maxSpawnDepth) {
      return `错误：嵌套深度已达上限 ${limits.maxSpawnDepth}`;
    }
    const children = bus
      .listMembers()
      .filter((member) => member.spawnedBy === parent.id && member.status !== "cancelled");
    if (children.length >= limits.maxChildrenPerAgent) {
      return `错误：@${parent.name} 的直接成员已达上限 ${limits.maxChildrenPerAgent}`;
    }

    const member: Member = {
      id: newId("m"),
      roomId: bus.roomId,
      name,
      role: "sub",
      status: "idle",
      depth: parent.depth + 1,
      spawnedBy: parent.id,
      controlScope: "none",
      contextMode: input.contextMode ?? "isolated",
      systemPrompt: input.systemPrompt ?? "",
      providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    bus.addMember(member);

    const card = board.create({
      title: input.task.slice(0, 60),
      detail: input.task,
      createdBy: parent.id,
      ownerId: member.id,
    });

    bus.append({
      senderId: parent.id,
      senderName: parent.name,
      senderKind: "member",
      kind: "chat",
      text: `@${member.name} ${input.task}`,
      taskId: card.id,
      chainRootId: trigger.chainRootId ?? trigger.id,
      depthTurn: (trigger.depthTurn ?? 0) + 1,
    });

    return `已创建成员 @${member.name}（${member.id}），任务卡 ${card.id} 已生成并派发`;
  }
}
