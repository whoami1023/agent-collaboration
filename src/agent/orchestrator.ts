import type { Limits, Member, RoomMessage } from "../core/types";
import { DEFAULT_PROVIDER_ID, SYSTEM_ID, USER_ID } from "../core/types";
import type { Settings } from "../core/settings";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import { decideWakes } from "../room/wake";
import type { SkillLibrary } from "../skills/library";
import type { MemorySearchManager } from "../memory/manager";
import { MemberRuntime } from "./member-runtime";
import type { SpawnInput } from "./tools";
import type { MockHandler } from "../provider/mock";
import { resolveSpawnAdmission, countChildren } from "./spawn/spawn-plan";
import { reserveChildAdmissionSlot, LEAF_SPAWN_REJECT_ERROR } from "./spawn/child-admission";
import { normalizeMemberName } from "./spawn/task-name";
import { buildSubagentSpawnEnvelope } from "./spawn/system-prompt";

export interface OrchestratorDeps {
  bus: RoomBus;
  board: Workboard;
  getSettings(): Settings;
  skills: SkillLibrary;
  ownerId: string;
  mockHandler?: MockHandler;
  memory?: MemorySearchManager;
}

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
  private pendingReleases = new Map<string, () => void>();
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

  /** 待启动槽位在子成员跑完时释放；若始终未被唤醒（取消/回合熔断），60 秒后兜底回收。 */
  private holdAdmissionSlot(memberId: string, release: () => void): void {
    this.pendingReleases.set(memberId, release);
    const timer = setTimeout(release, 60_000);
    timer.unref();
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
        skills: deps.skills,
        ownerId: deps.ownerId,
        memory: deps.memory,
        spawn: (parent, input, trigger) => this.spawn(parent, input, trigger),
        onFinished: () => this.pendingReleases.get(member.id)?.(),
      });
      this.runtimes.set(member.id, runtime);
    }
    return runtime;
  }

  private async spawn(parent: Member, input: SpawnInput, trigger: RoomMessage): Promise<string> {
    const { bus, board } = this.deps;
    const limits: Limits = this.deps.getSettings().limits;
    if (parent.role !== "main" && parent.controlScope !== "children") {
      return LEAF_SPAWN_REJECT_ERROR;
    }

    const normalized = normalizeMemberName(input.name);
    if (normalized.error || !normalized.name) return `错误：${normalized.error ?? "成员名不合法"}`;
    const name = normalized.name;
    if (bus.findMemberByName(name)) return `错误：成员 @${name} 已存在，请直接 @ 它派活`;

    // Ported resolveSpawnAdmission + reserveChildAdmissionSlot：先准入检查，
    // 再占住待启动槽位，防止同一 tick 的并发派发同时通过活跃子成员计数。
    const admission = reserveChildAdmissionSlot({
      controllerKey: parent.id,
      resolveAdmission: (pendingChildren) =>
        resolveSpawnAdmission({
          callerDepth: parent.depth,
          limits,
          activeChildren: countChildren(bus.listMembers(), parent.id),
          additionalActiveChildren: pendingChildren,
        }),
    });
    if (!admission.ok) return `错误：${admission.error}`;

    const member: Member = {
      id: newId("m"),
      roomId: bus.roomId,
      name,
      role: "sub",
      status: "idle",
      depth: admission.childSessionPatch.depth,
      spawnedBy: parent.id,
      controlScope: admission.childSessionPatch.controlScope,
      contextMode: input.contextMode ?? "isolated",
      systemPrompt: input.systemPrompt ?? "",
      providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    bus.addMember(member);

    // Ported buildSubagentSpawnEnvelope：任务包进子成员信封，回执说明完成模式。
    const envelope = buildSubagentSpawnEnvelope({
      completionMode: "announce",
      spawnMode: "session",
      task: input.task,
      requesterName: parent.name,
      childName: member.name,
      label: input.task.slice(0, 60),
      childDepth: member.depth,
      maxSpawnDepth: admission.maxSpawnDepth,
    });

    const card = board.create({
      title: input.task.slice(0, 60),
      detail: input.task,
      createdBy: parent.id,
      ownerId: member.id,
    });

    const release = this.pendingReleases.get(member.id);
    if (release) release();
    this.holdAdmissionSlot(member.id, () => {
      admission.release();
      this.pendingReleases.delete(member.id);
    });

    bus.append({
      senderId: parent.id,
      senderName: parent.name,
      senderKind: "member",
      kind: "chat",
      text: `@${member.name} ${envelope.message}`,
      taskId: card.id,
      chainRootId: trigger.chainRootId ?? trigger.id,
      depthTurn: (trigger.depthTurn ?? 0) + 1,
    });

    return `已创建成员 @${member.name}（${member.id}，深度 ${member.depth}，${
      member.controlScope === "children" ? "可再下派" : "末端执行"
    }），任务卡 ${card.id} 已生成并派发。${envelope.acceptedNote}`;
  }
}
