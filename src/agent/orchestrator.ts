import type { Limits, Member, RoomMessage, RoomMode, RoomRoutingMode, RunScopeKind } from "../core/types";
import { DEFAULT_MODEL_REF, ROOM_ROUTING_LABELS, SYSTEM_ID, USER_ID } from "../core/types";
import type { Settings } from "../core/settings";
import type { ModelUsageStore } from "../model/usage-store";
import type { MemberUsageRecord } from "./member-runtime";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import {
  MAX_WORK_RECOVERIES,
  WORK_RECOVERY_WINDOW_MS,
  WorkQueue,
  type WorkItem,
} from "../room/work-queue";
import type { QuestionStore } from "../room/questions";
import type { Workboard } from "../workboard/board";
import { decideWakes } from "../room/wake";
import {
  ROUTING_LIMITS,
  ROUTING_SWITCH_NOTICES,
  rotateBy,
  routingCandidates,
  routingNeeded,
} from "../room/routing";
import { routeMembers } from "./route-service";
import type { SkillLibrary } from "../skills/library";
import { selectSkillsForText } from "../skills/matching";
import type { MemberProfileHints } from "../memory/bootstrap-files";
import type { MemorySearchManager } from "../memory/manager";
import type { RecallLedger } from "../memory/recall-ledger";
import type { WorkspaceFiles } from "../files/workspace-files";
import type { ToolOutputStore } from "./content/offload";
import type { RunJournalStore } from "./run-journal";
import type { MissionStore } from "./mission-ledger";
import { TurnBudgetBook, type TurnStopReason } from "../room/turn-budget";
import { promptTokensOf } from "../model/usage-cost";
import { MemberRuntime } from "./member-runtime";
import { AdvisorService } from "./advisors/service";
import type { LearningHost } from "./learning/types";
import type { SkillUsageRecorder } from "../skills/curation/types";
import { CRON_SENDER_ID } from "../cron/types";
import type { CronTurnOutcome } from "../cron/types";
import type { CronService } from "../cron/service";
import type { MockHandler } from "../provider/mock";
import type { AuditHost } from "./audit/types";
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
  files?: WorkspaceFiles;
  /** 解析 `file:` 密钥引用的工作区目录。 */
  dataDir?: string;
  usage?: ModelUsageStore;
  onUsageRecord?(record: MemberUsageRecord): void;
  /** 学习层：成员一轮交付后触发后台复盘（工作区在建模时注入）。 */
  learning?: LearningHost;
  /** 策展层：技能使用记账回调，工具被真正调用时打点（工作区在建模时注入）。 */
  skillUsage?: SkillUsageRecorder;
  /** 记忆召回留痕：主动注入与后续引用都落进这个工作区级账本。 */
  recallLedger?: RecallLedger;
  /** 工具输出存档：大结果落盘后由 output_search / output_read 取回。 */
  toolOutputs?: ToolOutputStore;
  /** 持久工作队列：唤醒先落一条义务行，运行收尾再结算；不传时用房间内内存队列。 */
  workQueue?: WorkQueue;
  /** 结构化提问：成员把需要用户决定的点做成卡片，答案回来再唤醒它。 */
  questions?: QuestionStore;
  /** 运行日志：进程中断后按断点续跑；不传时每次唤醒都从头开始。 */
  journals?: RunJournalStore;
  /** 任务台账：按用户任务链统计任务卡进展与停滞，注入主智能体。 */
  missions?: MissionStore;
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
    modelRef: DEFAULT_MODEL_REF,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  bus.addMember(member);
  return member;
}

/** 自由交流模式下，最后一次成员报告后等待这么久再唤醒主智能体收集，避免打断讨论。 */
const FREE_COLLECT_QUIET_MS = 1200;

export class Orchestrator {
  private runtimes = new Map<string, MemberRuntime>();
  private pendingReleases = new Map<string, () => void>();
  private seen = new Set<string>();
  private notices = new Set<string>();
  private queue: Array<() => void> = [];
  private active = 0;
  private stopped = false;
  /** /stop 与 /clear 的屏障：停止前已入队的消息不再唤醒成员。 */
  private stoppedThroughSeq = 0;
  /** 自由交流模式的汇总定时器与最后一次成员报告。 */
  private collectorTimer: NodeJS.Timeout | null = null;
  private collectorDue: RoomMessage | null = null;
  /** 已经发过分流调用的消息 ID：同一条消息只问一次，重启/重放也不重复花钱。 */
  private readonly routed = new Set<string>();
  /** 定时任务调度器：宿主需要编排器，所以由工作区在两边都建好之后回灌。 */
  private cronService?: CronService;
  /** 顾问扇出：动手之前先问参谋；每房间一个实例，回合缓存因此不会跨房间串。 */
  private readonly advisors: AdvisorService;
  /** 持久工作队列：一条义务一行，进程重启后仍能续跑。 */
  private readonly workQueue: WorkQueue;
  /** 整轮预算：按用户任务链共享 token / 时间 / 运行次数。 */
  private readonly turnBudget: TurnBudgetBook;
  /** 正在运行的成员属于哪条任务链：用量回调据此记到正确的整轮预算上。 */
  private readonly chainByMember = new Map<string, string>();
  /** 已经排进运行槽的队列行：同一行不会被并发调度两次。 */
  private readonly scheduledWork = new Set<string>();
  /** 持续审计：成员一轮交付后核对任务验收，由工作区在两边都建好后回灌。 */
  private auditHost?: AuditHost;

  constructor(private readonly deps: OrchestratorDeps) {
    this.workQueue = deps.workQueue ?? new WorkQueue(deps.bus.roomId);
    this.turnBudget = new TurnBudgetBook(() => deps.getSettings().limits);
    this.advisors = new AdvisorService({
      getSettings: deps.getSettings,
      ...(deps.usage ? { usage: deps.usage } : {}),
      onUsageRecord: (record) => this.deps.bus.emit({ type: "model-usage", usage: record }),
    });
    deps.bus.subscribe((event) => {
      if (event.type === "messages-cleared") {
        this.turnBudget.clear();
        return;
      }
      if (event.type !== "message" || event.message.senderKind === "system") return;
      queueMicrotask(() => {
        if (!this.stopped) this.dispatch(event.message);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.clearCollector();
    for (const runtime of this.runtimes.values()) runtime.cancel();
  }

  get activeRuns(): number {
    return this.active;
  }

  sendUserMessage(text: string, runScope?: RunScopeKind): RoomMessage {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("消息不能为空");
    return this.deps.bus.append({
      senderId: USER_ID,
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: trimmed,
      depthTurn: 0,
      ...(runScope ? { runScope } : {}),
    });
  }

  cancelMember(memberId: string): boolean {
    this.workQueue.cancelForMember(memberId, "成员运行已取消");
    return this.runtimes.get(memberId)?.cancel() ?? false;
  }

  /** 工作区建好调度器之后回灌：成员工具通过它读写本账号的定时任务。 */
  setCron(cron: CronService): void {
    this.cronService = cron;
  }

  /** 工作区建好审计服务之后回灌：运行收尾时用它核对任务验收。 */
  setAudit(host: AuditHost): void {
    this.auditHost = host;
  }

  /**
   * 审计催办：落一条系统消息并唤醒成员。系统消息不进执行轨迹、不触发自动派发，
   * 只借 wake 走既有的队列/运行槽，因此不会绕过停止与取消闸门。
   */
  requestAuditNudge(memberId: string, text: string, taskId: string): boolean {
    if (this.stopped) return false;
    const member = this.deps.bus.getMember(memberId);
    if (!member || member.status === "cancelled") return false;
    const message = this.deps.bus.append({
      senderId: SYSTEM_ID,
      senderName: "审计",
      senderKind: "system",
      kind: "system",
      text,
      mentions: [memberId],
      taskId,
      depthTurn: 0,
    });
    this.wake(memberId, message);
    return true;
  }

  /**
   * 定时任务的群聊入口（OpenClaw cron → agent session 投递的本项目等价物）：
   * 把无人值守指令作为系统消息发进群，唤醒目标成员，并观测它这一轮的终局事件作为运行结果。
   * 指令本身不来自用户，所以走 senderKind=system —— 不会被常规的唤醒规则二次广播。
   */
  async runScheduledTurn(params: {
    text: string;
    targetMemberId?: string;
    timeoutMs?: number;
  }): Promise<CronTurnOutcome> {
    const bus = this.deps.bus;
    const requested = params.targetMemberId ? bus.getMember(params.targetMemberId) : undefined;
    const target = requested ?? bus.listMembers().find((member) => member.role === "main");
    if (!target) return { status: "no-target", text: "", error: "作战室里没有可唤醒的成员" };
    if (target.status === "cancelled") {
      return { status: "no-target", text: "", memberId: target.id, error: `成员 @${target.name} 已取消运行` };
    }
    const message = bus.append({
      senderId: CRON_SENDER_ID,
      senderName: "定时任务",
      senderKind: "system",
      kind: "system",
      text: params.text,
      mentions: [target.id],
      depthTurn: 0,
    });
    const timeoutMs =
      params.timeoutMs && params.timeoutMs > 0
        ? params.timeoutMs
        : this.deps.getSettings().limits.runTimeoutMs + 30_000;
    return await this.observeScheduledRun(target.id, message, timeoutMs);
  }

  /** 观测被唤醒成员的终局事件：已经在跑的运行会被 steering 接住，其收尾同样算这次投递的结果。 */
  private observeScheduledRun(
    memberId: string,
    trigger: RoomMessage,
    timeoutMs: number,
  ): Promise<CronTurnOutcome> {
    const startedRuns = new Set<string>();
    const wasRunning = this.runtimes.get(memberId)?.isRunning === true;
    return new Promise<CronTurnOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CronTurnOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(outcome);
      };
      const unsubscribe = this.deps.bus.subscribe((event) => {
        if (settled || event.type !== "run") return;
        const run = event.event;
        if (run.memberId !== memberId) return;
        if (run.type === "run-start") {
          startedRuns.add(run.runId);
          return;
        }
        if (run.type === "run-final") {
          if (!wasRunning && !startedRuns.has(run.runId)) return;
          finish({ status: "ok", text: run.text, memberId });
          return;
        }
        if (run.type === "run-error") {
          finish({ status: "error", text: "", memberId, error: run.error });
          return;
        }
        if (run.type === "run-aborted") {
          finish({ status: "aborted", text: "", memberId, error: "本次运行被中止" });
        }
      });
      const timer = setTimeout(() => {
        finish({
          status: "timeout",
          text: "",
          memberId,
          error: `本次定时运行超过 ${Math.round(timeoutMs / 1000)} 秒没有回音`,
        });
      }, timeoutMs);
      this.wake(memberId, trigger);
    });
  }

  /** 切换作战室的任务完成模式；模式随群聊状态持久化，下一条消息与下一次运行立即生效。 */
  setRoomMode(mode: RoomMode): RoomMode {
    const bus = this.deps.bus;
    if (bus.roomMode === mode) return mode;
    bus.setMode(mode);
    this.clearCollector();
    bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text:
        mode === "free"
          ? "已切换到「自由交流」模式：成员之间可以直接 @ 对方讨论，讨论安静下来后由主智能体统一收集并总结。"
          : "已切换到「委派」模式：主智能体负责拆解与分派，成员只对分内任务汇报，跨成员协调经过主智能体。",
    });
    return mode;
  }

  /**
   * 切换房间的取人方式（移植 Hermes 的 ROUTING_MODES）；随房间状态持久化，下一条消息立即生效。
   * 只改「一条没点名的消息交给谁」，显式 @ 与成员之间的汇报链路一律不动。
   */
  setRoomRouting(routing: RoomRoutingMode): RoomRoutingMode {
    const bus = this.deps.bus;
    if (bus.roomRouting === routing) return routing;
    bus.setRouting(routing);
    bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: `取人方式已改为「${ROOM_ROUTING_LABELS[routing]}」：${ROUTING_SWITCH_NOTICES[routing]}`,
    });
    return routing;
  }

  /**
   * 时间旅行：从某条运行的检查点另起一轮。保留检查点之前的完整历史，换一条新指令继续；
   * 原运行日志不删不改，新分支有自己的 runId 与队列行。
   */
  forkFromCheckpoint(
    sourceRunId: string,
    step: number,
    instruction: string,
  ): { runId: string; messageId: string } {
    const journals = this.deps.journals;
    if (!journals) throw new Error("运行日志未接入，暂时不能从检查点继续");
    const source = journals.load(sourceRunId);
    if (!source) throw new Error("找不到这条运行日志，可能已被清理");
    const member = this.deps.bus.getMember(source.memberId);
    if (!member || member.status === "cancelled") {
      throw new Error("原运行所属成员已不在房间里，无法从检查点继续");
    }
    if (this.runtimeFor(member).isRunning) {
      throw new Error(`@${member.name} 正在运行，等这一轮结束后再从检查点继续`);
    }
    if (!Number.isFinite(step) || step < 0) throw new Error("检查点步数不合法");
    const note = instruction.trim();
    if (!note) throw new Error("请写清楚从检查点继续后要做什么");
    const forked = journals.fork(sourceRunId, step, note);
    if (!forked) throw new Error("创建分支日志失败，请稍后重试");
    // 用系统消息承载入口，避免这条消息再触发一次普通分流；分支历史里已经有用户指令。
    const message = this.deps.bus.append({
      senderId: SYSTEM_ID,
      senderName: "时间旅行",
      senderKind: "system",
      kind: "system",
      text: `@${member.name}：从第 ${forked.steps} 步的检查点另起一轮。${note}`,
      depthTurn: 0,
    });
    this.wake(member.id, message, undefined, forked.runId);
    return { runId: forked.runId, messageId: message.id };
  }

  /** 清空聊天记录前中止所有在跑的成员：静默取消，且丢弃它们排队中的 steer。 */
  cancelAllRuns(): number {
    return this.stopRuns(true, "会话已清除");
  }

  /** /stop：中止所有在跑的成员，保留「本次运行已取消」提示。 */
  stopAllRuns(): number {
    return this.stopRuns(false, "用户停止");
  }

  private stopRuns(silent: boolean, queueNote: string): number {
    // 停止前已入队的消息（含刚发出、尚未派发的）不再唤醒成员；之后的新消息序号更高，不受影响。
    this.stoppedThroughSeq = this.deps.bus.snapshot().seq;
    this.clearCollector();
    let cancelled = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.cancel(silent ? { silent: true } : {})) cancelled += 1;
    }
    // 停下来的义务不能留在队列里假装还会执行：明确取消，终局理由随行保留。
    this.workQueue.cancelOpen(queueNote);
    return cancelled;
  }

  /**
   * 用户在「新建成员」面板直接创建子智能体：名字 + 功能描述（可来自模板库）。
   * 与 spawn 共用准入规则（成员数上限、命名与重名校验），但不派发任务，
   * 只生成成员与其默认档案（agents/<id>/SOUL.md、IDENTITY.md），并把它的职责与技能记入
   * 主智能体的成员能力档案 TEAM.md，等主智能体或用户 @ 它。
   */
  async createMember(input: {
    name: string;
    description: string;
    /** 模板引用的技能白名单；该用户当前用不了的技能名会被忽略。 */
    skillNames?: string[];
    /** 模板带入的角色设定（工作方式、气质、Emoji），写进成员档案文件。 */
    profile?: MemberProfileHints;
    /** 来源模板；用于成员列表显示「来自模板」。 */
    template?: { key: string; title: string };
  }): Promise<Member> {
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
      const usable = this.deps.skills
        .listForAgent(this.deps.ownerId)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          category: skill.category,
        }));
      const allowed = new Set(usable.map((skill) => skill.name));
      // 模板里的技能可能已被删除或属于别人：只带过去当前可用的，剩下的不阻塞创建。
      const explicit = (input.skillNames ?? [])
        .map((name) => name.trim().toLowerCase())
        .filter((name, index, all) => allowed.has(name) && all.indexOf(name) === index);
      // 新建成员只给了一句功能描述时，按描述挑几个对口技能，而不是把整个技能库塞给它：
      // 技能越多，智能体越容易在无关的说明书上浪费上下文，也越容易误用工具。
      const autoSkillNames =
        explicit.length === 0 && !input.template
          ? selectSkillsForText(description, usable)
          : [];
      const skillNames = explicit.length > 0 ? explicit : autoSkillNames;
      const autoChose = explicit.length === 0 && !input.template;
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
        ...(skillNames.length > 0 ? { skillNames } : {}),
        ...(input.template
          ? { templateKey: input.template.key, templateTitle: input.template.title }
          : {}),
        modelRef: DEFAULT_MODEL_REF,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      bus.addMember(member);
      await this.deps.memory?.ensureMemberProfile(member, main.name, {
        ...input.profile,
        sourceTemplate: input.template?.title ?? input.profile?.sourceTemplate,
      });
      // 把新成员的能力与技能写进主智能体的 TEAM.md，主智能体分派前就知道它能做什么。
      await this.deps.memory?.syncTeamFile();
      bus.append({
        senderId: SYSTEM_ID,
        senderName: "系统",
        senderKind: "system",
        kind: "system",
        text: `${
          input.template
            ? `已按模板「${input.template.title}」创建成员 @${member.name}${
                skillNames.length > 0 ? `，可用技能 ${skillNames.length} 个` : ""
              }。`
            : autoChose && skillNames.length === 0
              ? `已创建成员 @${member.name}：${description}\n描述里没匹配到对口技能，暂时不限技能（可用技能 ${usable.length} 个）；想收紧到某几个，在成员的「智能体文件 · 技能」里勾选。`
              : `已创建成员 @${member.name}：${description}\n按功能描述启用了 ${skillNames.length} 个技能：${skillNames.join("、")}。可在成员的「智能体文件 · 技能」里增减。`
        }\n它的职责与可用技能已写入主智能体工作区根部的 TEAM.md，分派任务前先看那份成员能力档案。`,
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
    this.workQueue.cancelForMember(memberId, "成员已移除");

    for (const task of board.list()) {
      if (task.ownerId === memberId) board.update(task.id, { ownerId: null });
    }

    bus.removeMember(memberId);
    await this.deps.memory?.removeMemberProfile(memberId);
    await this.deps.memory?.syncTeamFile();
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
    if (message.seq <= this.stoppedThroughSeq) return;
    const chainId = message.chainRootId ?? message.id;
    // 用户消息开一条新的任务链；成员消息沿 chainRootId 继续同一份台账。
    if (message.senderKind === "user" && !message.chainRootId) {
      this.turnBudget.begin(chainId);
      this.deps.missions?.begin(message);
    } else {
      const stopped = this.turnBudget.stopReason(chainId);
      if (stopped) {
        this.notifyTurnBudget(chainId, stopped);
        return;
      }
    }
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
    const bus = this.deps.bus;
    const mode = bus.roomMode;
    const routing = bus.roomRouting;
    const members = bus.listMembers();
    const candidates = routingCandidates(message, members);
    // 分流要等一次小模型调用才有结果，这一条先不唤醒任何人：routeAndWake 里要么派给挑中的人，
    // 要么回落到主智能体。旁路条件（已 @、成员或系统消息、计划轮、可选的人太少）由 routingNeeded 判定。
    if (routingNeeded(message, routing, candidates)) {
      void this.routeAndWake(message, candidates);
    } else {
      const { wakes } = decideWakes(message, members, mode, {
        routing,
        // 只有开了分流（或自由交流）才需要「谁还没开口」：同级互相接话的提质规则用它。
        unspoken: routing === "lead" && mode !== "free" ? undefined : this.unspokenMemberIds(members),
      });
      for (const memberId of wakes) this.wake(memberId, message);
    }
    // 自由交流：成员报告不逐条唤醒主智能体，等讨论安静后统一收集（OpenClaw collector 语义）。
    if (mode === "free" && message.kind === "announce" && message.senderKind === "member") {
      const sender = this.deps.bus.getMember(message.senderId);
      if (sender?.role === "sub") this.scheduleCollector(message);
    }
  }

  /** 本轮（最近一条用户消息之后）还没开过口的子成员：分流把「被点名但没发言」的人拉进下一轮。 */
  private unspokenMemberIds(members: Member[]): string[] {
    const { spoken } = this.deps.bus.discussionState();
    return members
      .filter((member) => member.role === "sub" && member.status !== "cancelled" && !spoken.has(member.id))
      .map((member) => member.id);
  }

  /**
   * 分流调用（移植 Hermes 的 `group_router`）：这条没点名的消息该谁接。
   * 调用回来时群况可能已经变了，所以唤醒前重新核对：房间还开着分流、消息没被 /stop 抹掉、
   * 用户没有接着发更新的一条、挑中的人还在册——任何一条不成立就不越权。
   * 挑不出来（解析失败、模型不可用、超时）一律回落到主智能体：分流只能让答复更准，不能没人答。
   */
  private async routeAndWake(message: RoomMessage, candidates: Member[]): Promise<void> {
    if (this.routed.has(message.id)) return;
    this.routed.add(message.id);
    if (this.routed.size > 500) this.routed.clear();
    const bus = this.deps.bus;
    const main = bus.listMembers().find((member) => member.role === "main");
    let picks: string[] = [];
    let fellBack = false;
    if (!this.stopped) {
      try {
        const outcome = await routeMembers({
          message,
          candidates,
          recent: bus.listMessages(ROUTING_LIMITS.recentMessages + 1),
          getModelDeps: () => this.modelRuntimeDeps(),
          // 分流借用主智能体的模型引用：它只做判断，不该比正文更贵。
          ...(main ? { modelRef: main.modelRef } : {}),
          ...(this.deps.usage ? { usage: this.deps.usage } : {}),
          onUsageRecord: (record) => bus.emit({ type: "model-usage", usage: record }),
        });
        picks = outcome.picks;
        fellBack = outcome.reason !== "picked";
      } catch {
        picks = [];
        fellBack = true;
      }
    }
    if (this.stopped || message.seq <= this.stoppedThroughSeq) return;
    if (bus.roomRouting !== "auto") return;
    // 用户又发了更新的一条：让最新那条决定，旧的不再补刀。
    if (bus.discussionState().sinceSeq > message.seq) return;
    const live = new Set(
      bus
        .listMembers()
        .filter((member) => member.status !== "cancelled")
        .map((member) => member.id),
    );
    const chosen = picks.filter((id) => live.has(id));
    if (chosen.length > 0) {
      for (const memberId of rotateBy(chosen, message.seq)) this.wake(memberId, message);
      return;
    }
    if (fellBack) {
      // 回落提示一个房间只播一次：模型一直不通时每问一条都提示一遍只是刷屏。
      const key = "routing-fallback";
      if (!this.notices.has(key)) {
        this.notices.add(key);
        bus.append({
          senderId: SYSTEM_ID,
          senderName: "系统",
          senderKind: "system",
          kind: "system",
          text: "分流没挑出人（模型不可用、超时或答复不合格式），这条消息按「主智能体」处理。",
        });
      }
    }
    if (main) this.wake(main.id, message);
  }

  private scheduleCollector(trigger: RoomMessage): void {
    this.collectorDue = trigger;
    if (this.collectorTimer) clearTimeout(this.collectorTimer);
    this.collectorTimer = setTimeout(() => {
      this.collectorTimer = null;
      this.fireCollector();
    }, FREE_COLLECT_QUIET_MS);
    this.collectorTimer.unref();
  }

  /** 安静窗口到期：还有成员在跑/排队就继续等，全部安静后唤醒主智能体做综合总结。 */
  private fireCollector(): void {
    const trigger = this.collectorDue;
    this.collectorDue = null;
    if (!trigger || this.stopped || trigger.seq <= this.stoppedThroughSeq) return;
    if (this.deps.bus.roomMode !== "free") return;
    const busy =
      this.queue.length > 0 ||
      [...this.runtimes.values()].some((runtime) => runtime.isRunning && runtime.member.role === "sub");
    if (busy) {
      this.scheduleCollector(trigger);
      return;
    }
    const main = this.deps.bus.listMembers().find((member) => member.role === "main");
    if (!main || main.status === "cancelled") return;
    this.wake(
      main.id,
      trigger,
      "自由交流模式：群里的讨论已安静下来。请收集所有成员的最新结论，给用户一个综合总结。",
    );
  }

  private clearCollector(): void {
    if (this.collectorTimer) clearTimeout(this.collectorTimer);
    this.collectorTimer = null;
    this.collectorDue = null;
  }

  /** 整轮预算到顶只提醒一次：被拦下的每个唤醒都刷一条只会淹没群聊。 */
  private notifyTurnBudget(chainId: string, reason: TurnStopReason): void {
    if (!this.turnBudget.markNotified(chainId, reason)) return;
    const limits = this.deps.getSettings().limits;
    const view = this.turnBudget.view(chainId);
    const text =
      reason === "tokens"
        ? `本消息的整轮 token 预算已用尽（已用 ${view.tokens} / 上限 ${limits.turnTokenBudget}），已停止继续唤醒成员。已完成的内容保留；发「继续」或新消息可另开一轮。`
        : reason === "time"
          ? `本消息已达到整轮时长上限（${Math.round(limits.turnTimeoutMs / 60_000)} 分钟），已停止继续唤醒成员。已完成的内容保留；发「继续」或新消息可另开一轮。`
          : `本消息已运行 ${view.runs} 次成员任务，达到单条消息的运行次数上限（${limits.turnMaxRuns}），已停止继续派发。已完成的内容保留；发「继续」或新消息可另开一轮。`;
    this.deps.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text,
    });
  }

  private wake(
    memberId: string,
    trigger: RoomMessage,
    steerNote?: string,
    resumeRunId?: string,
  ): void {
    const member = this.deps.bus.getMember(memberId);
    if (!member || member.status === "cancelled") return;
    const chainId = trigger.chainRootId ?? trigger.id;
    const stopped = this.turnBudget.stopReason(chainId);
    if (stopped) {
      this.notifyTurnBudget(chainId, stopped);
      return;
    }
    const key = `${trigger.id}:${memberId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.clear();

    const runtime = this.runtimeFor(member);
    if (runtime.isRunning) {
      runtime.steer(trigger, steerNote);
      return;
    }
    const item = this.workQueue.enqueue({
      memberId,
      memberName: member.name,
      trigger,
    });
    // 同一条触发消息已经在队列里：这条唤醒是重复的，不再开一轮。
    if (!item) return;
    // 时间旅行：先挂上分支日志，再排运行；runWorkItem 会把它当作断点续跑。
    if (resumeRunId) this.workQueue.attachRun(item.id, resumeRunId);
    this.scheduleWorkItem(runtime, member.id, trigger, item.id);
  }

  private scheduleWorkItem(
    runtime: MemberRuntime,
    memberId: string,
    trigger: RoomMessage,
    itemId: string,
  ): void {
    if (this.stopped || this.scheduledWork.has(itemId)) return;
    this.scheduledWork.add(itemId);
    this.schedule(() => this.runWorkItem(runtime, memberId, trigger, itemId));
  }

  /**
   * 一次唤醒的执行包装：先领取队列行，再按运行终局写回队列。
   * 关停导致的中止不结算——行留在 in_progress，由下次启动的 recoverInterrupted 接回。
   */
  private async runWorkItem(
    runtime: MemberRuntime,
    memberId: string,
    trigger: RoomMessage,
    itemId: string,
  ): Promise<void> {
    if (this.stopped || !this.workQueue.claim(itemId)) {
      this.scheduledWork.delete(itemId);
      return;
    }
    const chainId = trigger.chainRootId ?? trigger.id;
    const gate = this.turnBudget.beginRun(chainId);
    if (!gate.allowed) {
      this.workQueue.cancel(itemId, "整轮预算已用尽");
      this.notifyTurnBudget(chainId, gate.reason ?? "runs");
      this.scheduledWork.delete(itemId);
      this.drainMemberWork(memberId);
      return;
    }
    this.chainByMember.set(memberId, chainId);
    const observed: {
      runId?: string;
      terminal?:
        | { status: "ok"; text: string }
        | { status: "error"; error: string }
        | { status: "aborted"; reason?: "timeout" | "cancelled" | "silent" | "removed" };
    } = {};
    let missionObserved = false;
    // 必须在终局事件同步回调里记账：成员交付消息的派发是微任务，晚一步主智能体就会拿到旧台账。
    const observeMission = () => {
      if (missionObserved) return;
      missionObserved = true;
      this.deps.missions?.observe({
        chainRootId: trigger.chainRootId ?? trigger.id,
        tasks: this.deps.board.list(),
      });
    };
    const unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.type !== "run" || event.event.memberId !== memberId) return;
      const run = event.event;
      observed.runId = run.runId;
      if (run.type === "run-final") observed.terminal = { status: "ok", text: run.text };
      else if (run.type === "run-error") observed.terminal = { status: "error", error: run.error };
      else if (run.type === "run-aborted") {
        observed.terminal = { status: "aborted", ...(run.reason ? { reason: run.reason } : {}) };
      }
      if (observed.terminal) observeMission();
    });
    // 断点续跑：上次中断的运行日志还在且没有终局，就沿用它，把已完成的调用原样放回上下文。
    const prior = this.workQueue.get(itemId);
    const loaded =
      prior?.runId && this.deps.journals
        ? this.deps.journals.load(prior.runId)
        : null;
    const resumeRunId = loaded && !loaded.done ? prior?.runId : undefined;
    const runId = resumeRunId ?? newId("run");
    this.workQueue.attachRun(itemId, runId);
    try {
      await runtime.run(trigger, {
        runId,
        workItemId: itemId,
        ...(resumeRunId ? { resumeRunId } : {}),
      });
    } catch (err) {
      observed.terminal = { status: "error", error: err instanceof Error ? err.message : String(err) };
    } finally {
      unsubscribe();
      this.scheduledWork.delete(itemId);
      if (this.chainByMember.get(memberId) === chainId) this.chainByMember.delete(memberId);
    }
    observeMission();
    const budgetStop = this.turnBudget.stopReason(chainId);
    if (budgetStop) this.notifyTurnBudget(chainId, budgetStop);
    if (this.stopped) return;
    const terminal = observed.terminal;
    if (!terminal) {
      const member = this.deps.bus.getMember(memberId);
      if (!member || member.status === "cancelled") {
        this.workQueue.cancel(itemId, "成员已不可用，未产生终局");
      } else {
        this.workQueue.fail(itemId, "运行结束但没有终局事件");
      }
    } else if (terminal.status === "ok") {
      this.workQueue.complete(itemId, terminal.text);
    } else if (terminal.status === "error") {
      this.workQueue.fail(itemId, terminal.error);
    } else if (terminal.reason === "timeout") {
      this.workQueue.fail(itemId, "整轮运行超时被中止");
    } else if (terminal.reason === "removed") {
      this.workQueue.cancel(itemId, "成员已移除");
    } else if (terminal.reason === "silent") {
      this.workQueue.cancel(itemId, "会话已清除");
    } else {
      this.workQueue.cancel(itemId, "运行已取消");
    }
    // 只审「正常收尾」的一轮；中止/超时由续跑入口处理，不把半截工作当审计证据。
    if (!this.stopped && terminal?.status === "ok") {
      this.auditHost?.afterRun({
        memberId,
        ...(observed.runId ? { runId: observed.runId } : {}),
        ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
      });
    }
    this.drainMemberWork(memberId);
  }

  /**
   * 启动恢复：把落盘的 pending 行重新排进运行槽位。
   * 超过恢复窗口、多次中断、成员不在册的一律明确结算，不静默丢。
   * 同一成员一次只恢复一条，后续由 drainMemberWork 接着排。
   */
  resumeQueue(): number {
    if (this.stopped) return 0;
    const now = Date.now();
    let started = 0;
    const resumedMembers = new Set<string>();
    for (const item of this.workQueue.pending()) {
      if (resumedMembers.has(item.memberId)) continue;
      const member = this.deps.bus.getMember(item.memberId);
      if (!member || member.status === "cancelled") {
        this.workQueue.cancel(item.id, member ? "成员已取消" : "成员已不在册");
        continue;
      }
      if (item.recoveries >= MAX_WORK_RECOVERIES) {
        this.workQueue.fail(item.id, `已中断恢复 ${item.recoveries} 次，停止自动续跑`);
        continue;
      }
      if (now - item.createdAt > WORK_RECOVERY_WINDOW_MS) {
        this.workQueue.fail(item.id, "超过 24 小时恢复窗口，未再自动续跑");
        continue;
      }
      const runtime = this.runtimeFor(member);
      if (runtime.isRunning) continue;
      resumedMembers.add(item.memberId);
      this.scheduleWorkItem(runtime, member.id, item.trigger, item.id);
      started += 1;
    }
    return started;
  }

  /** 运行收尾后接着排同一成员的下一条待办；一次只开一条，避免 steer 吞掉后排的终局。 */
  private drainMemberWork(memberId: string): void {
    if (this.stopped) return;
    const runtime = this.runtimes.get(memberId);
    if (!runtime || runtime.isRunning) return;
    const next = this.workQueue
      .pending()
      .find((item: WorkItem) => item.memberId === memberId && !this.scheduledWork.has(item.id));
    if (!next) return;
    const member = this.deps.bus.getMember(memberId);
    if (!member || member.status === "cancelled") return;
    this.scheduleWorkItem(runtime, memberId, next.trigger, next.id);
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

  /** 模型装配依赖：成员运行与分流调用共用同一套（含 mock、密钥引用与工作区目录）。 */
  private modelRuntimeDeps() {
    const deps = this.deps;
    return {
      settings: deps.getSettings(),
      ...(deps.mockHandler ? { mockHandler: deps.mockHandler } : {}),
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    };
  }

  private runtimeFor(member: Member): MemberRuntime {
    let runtime = this.runtimes.get(member.id);
    if (!runtime) {
      const deps = this.deps;
      runtime = new MemberRuntime(member, {
        bus: deps.bus,
        board: deps.board,
        getModelDeps: () => this.modelRuntimeDeps(),
        getLimits: () => deps.getSettings().limits,
        skills: deps.skills,
        ownerId: deps.ownerId,
        getCron: () => this.cronService,
        ...(deps.memory ? { memory: deps.memory } : {}),
        ...(deps.files ? { files: deps.files } : {}),
        ...(deps.usage ? { usage: deps.usage } : {}),
        onUsageRecord: (record) => {
          const chainId = this.chainByMember.get(member.id);
          if (chainId) {
            this.turnBudget.addTokens(chainId, promptTokensOf(record.usage) + record.usage.output);
          }
          this.deps.onUsageRecord?.(record);
        },
        ...(deps.learning ? { learning: deps.learning } : {}),
        ...(deps.skillUsage ? { skillUsage: deps.skillUsage } : {}),
        ...(deps.recallLedger ? { recallLedger: deps.recallLedger } : {}),
        ...(deps.toolOutputs ? { toolOutputs: deps.toolOutputs } : {}),
        ...(deps.questions ? { questions: deps.questions } : {}),
        ...(deps.journals ? { journals: deps.journals } : {}),
        ...(deps.missions ? { missions: deps.missions } : {}),
        advisors: this.advisors,
        onFinished: () => this.pendingReleases.get(member.id)?.(),
      });
      this.runtimes.set(member.id, runtime);
    }
    return runtime;
  }
}
