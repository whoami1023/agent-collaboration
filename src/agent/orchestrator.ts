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
import type { MockHandler } from "../provider/mock";
import { resolveSpawnAdmission, countChildren } from "./spawn/spawn-plan";
import { reserveChildAdmissionSlot } from "./spawn/child-admission";
import { normalizeMemberName } from "./spawn/task-name";

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

  /**
   * 用户在「新建成员」面板直接创建子智能体：名字 + 功能描述。
   * 与 spawn 共用准入规则（成员数上限、命名与重名校验），但不派发任务，
   * 只生成成员与其默认档案（agents/<id>/SOUL.md、IDENTITY.md），等主智能体或用户 @ 它。
   */
  async createMember(input: { name: string; description: string }): Promise<Member> {
    const { bus } = this.deps;
    const limits: Limits = this.deps.getSettings().limits;
    const main = bus.listMembers().find((member) => member.role === "main");
    if (!main) throw new Error("主智能体尚未就绪，请刷新后重试");

    const normalized = normalizeMemberName(input.name);
    if (normalized.error || !normalized.name) throw new Error(normalized.error ?? "成员名不合法");
    const name = normalized.name;
    if (bus.findMemberByName(name)) throw new Error(`成员 @${name} 已存在，请换一个名字`);

    const description = input.description.trim();
    if (!description) throw new Error("请填写成员的功能描述，创建时会据此生成它的智能体文件");
    if (description.length > 800) throw new Error("功能描述最多 800 字");

    const admission = reserveChildAdmissionSlot({
      controllerKey: main.id,
      resolveAdmission: (pendingChildren) =>
        resolveSpawnAdmission({
          callerDepth: main.depth,
          limits,
          activeChildren: countChildren(bus.listMembers(), main.id),
          additionalActiveChildren: pendingChildren,
        }),
    });
    if (!admission.ok) throw new Error(admission.error);

    try {
      const member: Member = {
        id: newId("m"),
        roomId: bus.roomId,
        name,
        role: "sub",
        status: "idle",
        depth: admission.childSessionPatch.depth,
        spawnedBy: main.id,
        controlScope: admission.childSessionPatch.controlScope,
        contextMode: "isolated",
        systemPrompt: "",
        brief: description,
        providerId: DEFAULT_PROVIDER_ID,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      bus.addMember(member);
      await this.deps.memory?.ensureMemberProfile(member, main.name);
      bus.append({
        senderId: SYSTEM_ID,
        senderName: "系统",
        senderKind: "system",
        kind: "system",
        text: `已创建成员 @${member.name}：${description}`,
      });
      return member;
    } finally {
      // 用户建成员不占并发槽位，准入名额立即归还。
      admission.release();
    }
  }

  /**
   * 用户从成员列表移除一个智能体：先取消它的运行并摘出花名册，
   * 名下任务改为未指派，档案目录一并删除；历史消息保留。
   */
  async removeMember(memberId: string): Promise<Member> {
    const { bus, board } = this.deps;
    const member = bus.getMember(memberId);
    if (!member) throw new Error("成员不存在");
    if (member.role === "main") throw new Error("主智能体不能移除");

    this.runtimes.get(memberId)?.cancel();
    this.runtimes.delete(memberId);
    this.pendingReleases.get(memberId)?.();
    this.pendingReleases.delete(memberId);

    for (const task of board.list()) {
      if (task.ownerId === memberId) board.update(task.id, { ownerId: null });
    }

    bus.removeMember(memberId);
    await this.deps.memory?.removeMemberProfile(memberId);
    bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: `已移除成员 @${member.name}，其名下任务改为未指派，历史消息保留。`,
    });
    return member;
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
        onFinished: () => this.pendingReleases.get(member.id)?.(),
      });
      this.runtimes.set(member.id, runtime);
    }
    return runtime;
  }
}
