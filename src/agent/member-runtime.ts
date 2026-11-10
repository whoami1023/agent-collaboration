import type { AgentEvent, Limits, Member, ResumeHint, RoomMessage } from "../core/types";
import { SYSTEM_ID } from "../core/types";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { LlmMessage } from "../provider/types";
import {
  resolveModelRuntime,
  type ModelTransport,
  type RuntimeDeps as ModelRuntimeDeps,
} from "../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../model/usage-cost";
import type { ModelUsageStore } from "../model/usage-store";
import type { SkillLibrary } from "../skills/library";
import { selectSkillsForMember } from "../skills/selection";
import type { SkillUsageRecorder } from "../skills/curation/types";
import type { MemorySearchManager } from "../memory/manager";
import type { WorkspaceFiles } from "../files/workspace-files";
import { resolveTriggerRecall, type TriggerRecallHit } from "../memory/recall";
import { findCitedRecallHits, type RecallLedger } from "../memory/recall-ledger";
import { runAgentLoop } from "./loop";
import type { LearningHost } from "./learning/types";
import type { AdvisorService } from "./advisors/service";
import { CRON_SENDER_ID } from "../cron/types";
import type { CronService } from "../cron/service";
import { resolveSilentReply } from "../cron/run-prompt";
import { DEFAULT_COMPACTION_SETTINGS } from "./context/compaction";
import { resolveMaxActiveTranscriptBytes, type TranscriptByteCompactionLatch } from "./context/bounded-context";
import type { ContextBudgetConfig } from "./context/budget";
import { buildTools } from "./tools";
import { EvidenceLedger } from "./evidence";
import { applyToolResultPolicy } from "./content/policy";
import { scopeToolUnavailable } from "./run-scope";
import { isPassText } from "../room/routing";
import { buildInstruction, buildSystemPrompt, formatRoomWindow } from "./prompts";

export interface MemberUsageRecord {
  ref: string;
  providerId: string;
  modelId: string;
  usage: UsageTotals;
  costUsd: number;
}

export interface RuntimeDeps {
  bus: RoomBus;
  board: Workboard;
  /** 模型设置解析所需的当前设置（含 mock handler 与工作区目录）。 */
  getModelDeps(): ModelRuntimeDeps;
  getLimits(): Limits;
  skills: SkillLibrary;
  ownerId: string;
  /** 本账号的定时任务调度器；成员用它给自己和用户建任务。 */
  getCron?(): CronService | undefined;
  memory?: MemorySearchManager;
  files?: WorkspaceFiles;
  /** 用量账本；未提供时只不发事件，不落盘。 */
  usage?: ModelUsageStore;
  /** 学习层：一轮成功交付之后的后台复盘（P1 只写长期记忆）。 */
  learning?: LearningHost;
  /** 顾问扇出：动手之前先问参谋（默认关闭，见设置里的 advisors）。 */
  advisors?: AdvisorService;
  /** 技能使用记账（策展的输入）：由工作区注入全局使用账本，缺省不记。 */
  skillUsage?: SkillUsageRecorder;
  /** 记忆召回留痕：主动注入过什么、交付时引用了没有；缺省不记。 */
  recallLedger?: RecallLedger;
  onFinished?(memberId: string): void;
  /** 每次运行结束后回报本程各模型的 token 与成本，供 SSE 与账本消费。 */
  onUsageRecord?(record: MemberUsageRecord): void;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export class MemberRuntime {
  private controller: AbortController | null = null;
  private pending: LlmMessage[] = [];
  private running = false;
  /** 清空聊天记录引起的中止不写「已取消」系统消息，避免刚清空的会话又冒出一条。 */
  private silentAbort = false;
  /** 跨运行保留的字节压缩失败闩（OpenClaw transcriptByteCompactionLatch 的本项目等价物）。 */
  private readonly byteCompactionState: { latch?: TranscriptByteCompactionLatch } = {};

  constructor(
    readonly member: Member,
    private readonly deps: RuntimeDeps,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  steer(message: RoomMessage, instruction?: string): void {
    this.pending.push({
      role: "user",
      content:
        `${instruction ? `${instruction}\n\n` : ""}` +
        `运行中收到一条新群聊消息（#${message.seq}，来自 ${
          message.senderKind === "user" ? "用户" : `@${message.senderName}`
        }）：\n${message.text}`,
    });
  }

  cancel(options: { silent?: boolean } = {}): boolean {
    if (!this.controller) return false;
    this.silentAbort = options.silent === true;
    // 中止即停止本轮：丢弃排队中的 steer，防止取消后又开一轮。
    this.pending = [];
    this.controller.abort();
    return true;
  }

  async run(trigger: RoomMessage): Promise<void> {
    if (this.running) {
      this.steer(trigger);
      return;
    }
    this.running = true;
    try {
      let current = trigger;
      for (let round = 0; round < 3; round += 1) {
        await this.runOnce(current);
        if (this.pending.length === 0 || this.member.status === "cancelled") break;
        const drained = this.pending.splice(0, this.pending.length);
        current = {
          ...trigger,
          text: drained.map((message) => message.content).join("\n---\n"),
        };
      }
    } finally {
      this.running = false;
      this.controller = null;
      if (this.member.status === "running") this.setStatus("idle");
      this.deps.onFinished?.(this.member.id);
    }
  }

  private async runOnce(trigger: RoomMessage): Promise<void> {
    const { bus, board } = this.deps;
    const limits = this.deps.getLimits();
    const runId = newId("run");
    const controller = new AbortController();
    this.controller = controller;
    /** 区分「跑满整轮超时」与「用户手动取消」：前者要给出可继续的恢复入口。 */
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.runTimeoutMs);
    timeout.unref();

    this.setStatus("running");
    this.emit({ type: "run-start", runId, memberId: this.member.id });

    // 运行中止或报错时也要把已产生的 token 用量入账，所以记账函数声明在 try 外。
    let flushUsage: () => void = () => {};
    /** 本轮真实调用过的工具名：复盘素材用它区分「动手做过」与「只是说了说」。 */
    const usedTools = new Set<string>();
    // 交付闸门的证据台账：本轮真实写出/跑成的事实，续跑时从未完成的任务卡上重新装回。
    const evidence = new EvidenceLedger();
    evidence.seed(board.list());

    try {
      const taskTitles = new Map<string, string>();
      for (const task of board.list()) {
        if (task.ownerId && task.status !== "done" && task.status !== "failed") {
          taskTitles.set(task.ownerId, `${task.title}（${task.status}）`);
        }
      }
      // 运行时缓存的成员对象可能在面板里被改过（如技能白名单），每次运行都取总线上的最新值。
      const member = bus.getMember(this.member.id) ?? this.member;
      const parent = member.spawnedBy ? bus.getMember(member.spawnedBy) : undefined;
      const skills = selectSkillsForMember(
        this.deps.skills.listForAgent(this.deps.ownerId),
        member.skillNames,
      );
      // 运行姿态（本轮工具集收窄）由触发消息带下来；同一轮里成员自己发的消息也继承这个姿态。
      const runScope = trigger.runScope;
      const tools = buildTools(member, {
        bus,
        board,
        skills: this.deps.skills,
        runScope,
        userId: this.deps.ownerId,
        evidence,
        getCron: () => this.deps.getCron?.(),
        ...(this.deps.memory ? { memory: this.deps.memory } : {}),
        ...(this.deps.recallLedger ? { recallLedger: this.deps.recallLedger } : {}),
        ...(this.deps.files ? { files: this.deps.files } : {}),
        ...(this.deps.skillUsage ? { skillUsage: this.deps.skillUsage } : {}),
      });
      // 主智能体要按成员能力档案决定把活派给谁：每次运行前同步 TEAM.md 再读进来，
      // 保证新建、移除成员或改技能授权后下一轮就看到最新值（读失败则不注入，fail-open）。
      let teamFile: string | undefined;
      if (member.role === "main" && this.deps.memory) {
        await this.deps.memory.syncTeamFile().catch(() => undefined);
        teamFile = await this.deps.memory.readTeamFile();
      }
      const system = buildSystemPrompt({
        roomName: bus.roomName,
        member,
        members: bus.listMembers(),
        parentName: parent?.name ?? null,
        taskTitles,
        mode: bus.roomMode,
        limits,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
        })),
        ...(teamFile ? { teamFile } : {}),
        availableTools: new Set(tools.map((tool) => tool.schema.name)),
        nowMs: Date.now(),
      });
      // Lane-1 触发召回（移植 active-memory）：在主模型请求前跑，失败即不注入（fail-open）。
      let recallContext: string | undefined;
      let recalledHits: TriggerRecallHit[] = [];
      if (this.deps.memory) {
        const recall = await resolveTriggerRecall({
          manager: this.deps.memory,
          message: trigger.text,
          signal: controller.signal,
          ...(member.role === "sub" ? { agentId: member.id } : {}),
        }).catch(() => undefined);
        recallContext = recall?.context;
        recalledHits = recall?.matches ?? [];
        // 先记「主动注入了什么」；是否被引用等交付时再从正文里核对。
        if (this.deps.recallLedger && recalledHits.length > 0) {
          this.deps.recallLedger.record(
            this.deps.recallLedger.volunteeredEvents(
              { roomId: bus.roomId, agentId: member.id, runId },
              trigger.text,
              recalledHits,
            ),
          );
        }
      }
      const windowMessages = bus.window(limits.maxRoomWindowChars);
      const window = formatRoomWindow(windowMessages);
      const messages: LlmMessage[] = [
        {
          role: "user",
          content:
            `${recallContext ? `${recallContext}\n\n` : ""}` +
            `${window ? `群聊最近记录：\n${window}\n\n` : ""}${buildInstruction(member, trigger, bus.roomMode, bus.roomRouting)}`,
        },
      ];
      // 顾问扇出（Hermes 的 MoA 群聊版）：动手之前先请几位在册成员出建议。
      // 建议块作为**独立的一条用户消息**进本轮上下文，系统提示词一个字节都不动，前缀缓存照旧命中。
      const guidance = await this.collectAdvice(member, trigger, windowMessages, controller);
      if (guidance) messages.push({ role: "user", content: guidance });
      const transport = resolveModelRuntime(
        member.modelRef,
        {
          ...this.deps.getModelDeps(),
          ...(member.thinkingLevel ? { thinkingLevel: member.thinkingLevel } : {}),
        },
        (from, to, error) =>
          this.notice(`模型 ${from} 调用失败（${error}），本轮改用备用模型 ${to}`),
      );
      const modelsByRef = new Map<string, ModelTransport["model"]>();
      for (const candidate of [transport.chain.primary, ...transport.chain.fallbacks]) {
        modelsByRef.set(candidate.ref, candidate);
      }
      const usageByRef = new Map<string, { usage: UsageTotals; costUsd: number }>();
      const collectUsage = (usage: UsageTotals): void => {
        const ref = transport.activeRef() || transport.model.ref;
        const model = modelsByRef.get(ref) ?? transport.model;
        const previous = usageByRef.get(ref) ?? { usage: emptyUsage(), costUsd: 0 };
        usageByRef.set(ref, {
          usage: addUsage(previous.usage, usage),
          costUsd: previous.costUsd + calculateUsageCost(model, usage),
        });
      };
      flushUsage = (): void => {
        for (const [ref, entry] of usageByRef) {
          const model = modelsByRef.get(ref) ?? transport.model;
          this.deps.usage?.record({
            ref,
            providerId: model.providerId,
            modelId: model.id,
            usage: entry.usage,
            costUsd: entry.costUsd,
          });
          this.deps.onUsageRecord?.({
            ref,
            providerId: model.providerId,
            modelId: model.id,
            usage: entry.usage,
            costUsd: entry.costUsd,
          });
        }
        usageByRef.clear();
      };

      // 上下文预算优先用模型目录里的窗口，设置里的全局值只作为没有目录信息时的兜底。
      const contextWindowTokens =
        transport.model.contextTokens > 0
          ? Math.min(transport.model.contextTokens, limits.contextWindowTokens ?? Number.POSITIVE_INFINITY)
          : limits.contextWindowTokens;
      const budget: ContextBudgetConfig = {
        ...(contextWindowTokens && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
        ...(resolveMaxActiveTranscriptBytes(limits.maxActiveTranscriptBytes) !== undefined
          ? { maxActiveTranscriptBytes: resolveMaxActiveTranscriptBytes(limits.maxActiveTranscriptBytes) }
          : {}),
        compaction: { ...DEFAULT_COMPACTION_SETTINGS },
      };

      const result = await runAgentLoop({
        provider: transport.provider,
        model: transport.model.id,
        request: transport.request,
        onUsage: collectUsage,
        system,
        messages,
        tools,
        ...(runScope ? { toolUnavailable: (name: string) => scopeToolUnavailable(runScope, name) } : {}),
        maxSteps: limits.maxStepsPerRun,
        signal: controller.signal,
        budget,
        budgetOwnerId: this.member.id,
        // 工具结果进上下文前的统一出口：外部来源套不可信信封、疑似密钥掩码（见 content/policy.ts）。
        transformToolResult: applyToolResultPolicy,
        byteCompactionState: this.byteCompactionState,
        onContextApplied: (info) => {
          if (info.kind === "compacted") {
            this.notice(
              `@${this.member.name} 上下文已自动压缩：压缩前约 ${info.tokensBefore} tokens，` +
                `合并了 ${info.replacedMessages} 条历史` +
                `${info.qualityDegraded ? "（自动摘要失败，仅保留无摘要边界）" : ""}`,
            );
          } else {
            this.notice(
              `@${this.member.name} 本次请求按字节预算截断：省略 ${info.omittedMessages} 条历史（完整记录仍保存）`,
            );
          }
        },
        onDelta: (text) => this.emit({ type: "delta", runId, memberId: this.member.id, text }),
        onToolCall: (call) => {
          usedTools.add(call.name);
          this.emit({ type: "tool", runId, memberId: this.member.id, name: call.name, args: call.args });
        },
        onToolResult: (call, content, status) =>
          this.emit({
            type: "tool-result",
            runId,
            memberId: this.member.id,
            name: call.name,
            content,
            ok: status.ok,
            ...(status.code ? { code: status.code } : {}),
          }),
        onRepair: ({ toolNames }) =>
          this.notice(`@${this.member.name} 的文本式工具调用已被修复执行：${toolNames.join("、")}`),
        pullPending: () => this.pending.splice(0, this.pending.length),
      });

      // 运行期间成员被移除：不再以已移除成员的身份往群里发言。
      if (!bus.getMember(this.member.id)) {
        this.emit({ type: "run-aborted", runId, memberId: this.member.id });
        return;
      }

      if (result.error) {
        this.emit({ type: "run-error", runId, memberId: this.member.id, error: result.error });
        this.notice(
          `@${this.member.name} 运行中止：${result.error}`,
          result.errorCode === "max_steps_reached" ? this.resumeHint(trigger) : undefined,
        );
        this.setStatus("error");
        return;
      }

      // 定时任务的静默交付（OpenClaw 的 NO_REPLY）：整条回复只是静默标记时群里不发这条消息，
      // 但终局事件仍带原文，让 CronService 照常记账。
      const silent =
        !!result.text &&
        trigger.senderId === CRON_SENDER_ID &&
        resolveSilentReply(result.text).quiet;

      // pass（Hermes 的分流提质规则）：全员/自动分流派下来的消息不是命令，与自己无关的成员
      // 用这一个词表示「这轮我沉默」。被点名的不算——那是派下来的活；主智能体也不算——它得兜底。
      const passed =
        !!result.text &&
        this.member.role === "sub" &&
        trigger.senderKind === "user" &&
        bus.roomRouting !== "lead" &&
        !trigger.mentions.includes(this.member.id) &&
        isPassText(result.text);

      if (result.text && !silent && !passed) {
        const message = bus.append({
          senderId: this.member.id,
          senderName: this.member.name,
          senderKind: "member",
          kind: this.member.role === "sub" ? "announce" : "chat",
          text: result.text,
          runId,
          replyTo: trigger.id,
          chainRootId: trigger.chainRootId ?? trigger.id,
          depthTurn: (trigger.depthTurn ?? 0) + 1,
          ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
          // 姿态跟着这一轮产出的消息走：唤醒规则用它挡住计划轮的 @，界面也靠它标出「计划轮」。
          ...(trigger.runScope ? { runScope: trigger.runScope } : {}),
        });
        if (trigger.taskId) board.linkMessage(trigger.taskId, message.id);
        this.emit({ type: "run-final", runId, memberId: this.member.id, text: result.text });
      } else {
        // pass 这一轮什么都没交付：终局事件留空，前端不会为它渲染一条气泡。
        this.emit({
          type: "run-final",
          runId,
          memberId: this.member.id,
          text: passed ? "" : (result.text ?? ""),
        });
      }
      // 召回账本的另一半：交付正文里出现 `Source: path#Lx` 才算这条记忆真被引用。
      if (this.deps.recallLedger && recalledHits.length > 0 && result.text && !silent && !passed) {
        const cited = findCitedRecallHits(result.text, recalledHits);
        if (cited.length > 0) {
          this.deps.recallLedger.record(
            this.deps.recallLedger.usedEvents(
              { roomId: bus.roomId, agentId: member.id, runId },
              cited,
            ),
          );
        }
      }
      if (result.maxStepsReached) {
        this.notice(
          `@${this.member.name} 单次运行 ${limits.maxStepsPerRun} 步工具调用已用尽，已停止调用工具并基于当前进展收尾。`,
          this.resumeHint(trigger),
        );
      }
      if (result.truncated) {
        this.notice(
          `@${this.member.name} 回复达到模型单次输出长度上限，自动续写若干次仍未写完：上面这份可能是不完整的稿子。` +
            `发「继续」可以接着写；长文档建议改用 file_write 的 append 分节落盘。`,
          this.resumeHint(trigger),
        );
      }
      this.setStatus("idle");
      // 学习层（P1）：结论交付完之后才复盘，异步跑、不占运行槽；复盘失败不会影响本轮。
      // 回 pass 的这一轮没有交付，不值得复盘。
      const learning = this.deps.learning;
      if (learning && result.text && !passed) {
        void learning.afterRun({
          memberId: this.member.id,
          memberName: member.name,
          memberRole: member.role,
          modelRef: member.modelRef,
          roomId: bus.roomId,
          roomName: bus.roomName,
          runId,
          triggerText: trigger.text,
          finalText: result.text,
          toolNames: [...usedTools],
          transcript: window,
          unattended: trigger.senderId === CRON_SENDER_ID,
        });
      }
    } catch (err) {
      if (isAbort(err)) {
        this.emit({ type: "run-aborted", runId, memberId: this.member.id });
        if (this.silentAbort) {
          // 刚清空会话就中止：不再往群里补一条系统消息。
        } else if (timedOut && bus.getMember(this.member.id)) {
          const timeoutLabel =
            limits.runTimeoutMs >= 1000
              ? `${Math.round(limits.runTimeoutMs / 1000)} 秒`
              : `${limits.runTimeoutMs} 毫秒`;
          this.notice(
            `@${this.member.name} 本次运行达到 ${timeoutLabel}整轮超时被中止，当前进展已保留。`,
            this.resumeHint(trigger),
          );
        } else {
          this.notice(`@${this.member.name} 本次运行已取消`);
        }
        this.setStatus("idle");
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.emit({ type: "run-error", runId, memberId: this.member.id, error: detail });
      this.notice(`@${this.member.name} 运行失败：${detail}`);
      this.setStatus("error");
    } finally {
      flushUsage();
      clearTimeout(timeout);
      this.controller = null;
      this.silentAbort = false;
    }
  }

  /**
   * 顾问扇出的调用点（Hermes MoA 的群聊版）：默认关闭，开了才有一次外部调用。
   * 失败一律吞掉——参谋只能让这一轮更好，不能让它更贵地卡住或报错。
   */
  private async collectAdvice(
    member: Member,
    trigger: RoomMessage,
    window: RoomMessage[],
    controller: AbortController,
  ): Promise<string | undefined> {
    const service = this.deps.advisors;
    if (!service) return undefined;
    let outcome;
    try {
      outcome = await service.run({
        acting: member,
        members: this.deps.bus.listMembers(),
        messages: window,
        taskText: trigger.text,
        roomId: this.deps.bus.roomId,
        turnKey: trigger.chainRootId ?? trigger.id,
        getModelDeps: this.deps.getModelDeps,
        signal: controller.signal,
      });
    } catch {
      return undefined;
    }
    // 已经被取消的这一轮不必再补一句参谋说明。
    if (outcome.note && !controller.signal.aborted) this.notice(`顾问扇出：${outcome.note}`);
    return outcome.guidance;
  }

  private setStatus(status: Member["status"]): void {
    this.member.status = status;
    this.member.lastActiveAt = Date.now();
    this.deps.bus.updateMember(this.member);
  }

  private emit(event: AgentEvent): void {
    this.deps.bus.emit({ type: "run", event });
  }

  private notice(text: string, resume?: ResumeHint): void {
    this.deps.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text,
      ...(resume ? { resume } : {}),
    });
  }

  /** 中止原因可恢复时带上「继续」所需的成员/任务定位信息，前端据此渲染一键重派。 */
  private resumeHint(trigger: RoomMessage): ResumeHint {
    return {
      memberId: this.member.id,
      memberName: this.member.name,
      ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
    };
  }
}
