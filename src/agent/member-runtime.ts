import type { AgentEvent, Limits, Member, ResumeHint, RoomMessage } from "../core/types";
import { SYSTEM_ID } from "../core/types";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { LlmMessage, ToolCall } from "../provider/types";
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
import { runAgentLoop, type ToolImpl } from "./loop";
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
import { createToolResultTransform } from "./content/policy";
import type { ToolOutputStore } from "./content/offload";
import type { QuestionStore } from "../room/questions";
import { scopeToolUnavailable } from "./run-scope";
import { isPassText } from "../room/routing";
import { buildInstruction, buildSystemPrompt, formatRoomWindow } from "./prompts";
import type { LoadedRunJournal, RunJournalRecorder, RunJournalStore } from "./run-journal";
import type { MissionStore } from "./mission-ledger";
import type { KnowledgeService } from "../knowledge/service";
import type { ApprovalGate } from "../room/approvals";

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
  /** 工具输出存档：大结果落盘后按成员隔离地检索与分页读取。 */
  toolOutputs?: ToolOutputStore;
  /** 结构化提问：真正需要用户决定的点做成卡片，答案回来再唤醒本成员。 */
  questions?: QuestionStore;
  /** 运行日志：进程中断后续跑；未提供时不做检查点。 */
  journals?: RunJournalStore;
  /** 任务台账：主智能体每轮读取本用户任务的进展、停滞与重规划要求。 */
  missions?: MissionStore;
  /** 知识库：既往整理过的资料，工具检索 + 提示词里给一份目录摘录。 */
  knowledge?: KnowledgeService;
  /** 执行前审批：高风险工具调用先挂起问用户。 */
  approvals?: ApprovalGate;
  onFinished?(memberId: string): void;
  /** 每次运行结束后回报本程各模型的 token 与成本，供 SSE 与账本消费。 */
  onUsageRecord?(record: MemberUsageRecord): void;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 交接上下文包只给被派发的成员：先看这段，再决定是否回读文件与群聊。 */
function formatHandoff(handoff: NonNullable<RoomMessage["handoff"]>): string {
  const lines = [`【交接上下文包】来自 @${handoff.fromName}`];
  if (handoff.context.trim()) lines.push(handoff.context.trim());
  if (handoff.files && handoff.files.length > 0) {
    lines.push(`相关文件：${handoff.files.join("、")}`);
  }
  lines.push("先核对上面的输入与文件再动手；不要假设派发者已经替你完成。");
  return lines.join("\n");
}

export interface MemberRunOptions {
  /** 编排器为该工作项预分配的运行 id；续跑时沿用上次的 id。 */
  runId?: string;
  workItemId?: string;
  /** 上次中断的 runId：存在可用日志时从断点继续，而不是重跑整轮。 */
  resumeRunId?: string;
}

export class MemberRuntime {
  private controller: AbortController | null = null;
  private pending: LlmMessage[] = [];
  private running = false;
  /** 本轮运行停在 ask_user 上：不要再排追加轮，等用户回答后续跑。 */
  private suspended = false;
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

  async run(trigger: RoomMessage, options: MemberRunOptions = {}): Promise<void> {
    if (this.running) {
      this.steer(trigger);
      return;
    }
    this.running = true;
    this.suspended = false;
    try {
      let current = trigger;
      for (let round = 0; round < 3; round += 1) {
        // 运行日志只覆盖第一回合：后续回合是「运行中又收到消息」的追加轮，各自独立。
        await this.runOnce(current, round === 0 ? options : {});
        if (this.suspended) {
          // 等用户回答期间不再处理追加消息；它们留在队列里，回答后按顺序排。
          this.pending = [];
          break;
        }
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

  private async runOnce(trigger: RoomMessage, runOptions: MemberRunOptions = {}): Promise<void> {
    const { bus, board } = this.deps;
    const limits = this.deps.getLimits();
    const runId = runOptions.runId ?? newId("run");
    const loaded = runOptions.resumeRunId ? this.deps.journals?.load(runOptions.resumeRunId) : null;
    const resume =
      loaded && !loaded.done && loaded.memberId === this.member.id ? loaded : undefined;
    const controller = new AbortController();
    this.controller = controller;
    /** 区分「跑满整轮超时」与「用户手动取消」：前者要给出可继续的恢复入口。 */
    let timedOut = false;
    /** 本轮是被 ask_user 挂起的：不写终局、不关闭运行日志。 */
    let suspendedHere = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.runTimeoutMs);
    timeout.unref();

    this.setStatus("running");
    const initiator: "person" | "routine" | "handoff" =
      trigger.senderId === CRON_SENDER_ID ? "routine" : trigger.handoff ? "handoff" : "person";
    this.emit({ type: "run-start", runId, memberId: this.member.id, initiator });

    /** 运行日志：每一步已完成的回合与工具结果都落盘，进程中断后据此续跑。 */
    let journal: RunJournalRecorder | null = null;
    let journalFinished = false;
    const finishJournal = (terminal: Parameters<RunJournalRecorder["finish"]>[0]): void => {
      if (!journal || journalFinished) return;
      journalFinished = true;
      journal.finish(terminal);
    };

    // 运行中止或报错时也要把已产生的 token 用量入账，所以记账函数声明在 try 外。
    let flushUsage: () => void = () => {};
    /** 本轮真实调用过的工具名：复盘素材用它区分「动手做过」与「只是说了说」。 */
    const usedTools = new Set<string>();
    // 交付闸门的证据台账：本轮真实写出/跑成的事实，续跑时从未完成的任务卡上重新装回。
    const evidence = new EvidenceLedger();
    evidence.seed(board.list());
    /** 推理轨迹：只作为 run 事件展示与存档，绝不写回上下文。 */
    let reasoningText = "";
    let reasoningReported = 0;
    let reasoningAt = 0;
    const flushReasoning = (force = false): void => {
      if (!reasoningText || reasoningText.length === reasoningReported) return;
      const now = Date.now();
      if (!force && reasoningText.length - reasoningReported < 600 && now - reasoningAt < 1200) {
        return;
      }
      reasoningReported = reasoningText.length;
      reasoningAt = now;
      this.emit({
        type: "reasoning",
        runId,
        memberId: this.member.id,
        text: reasoningText.slice(0, 4_000),
      });
    };

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
        ...(this.deps.toolOutputs ? { toolOutputs: this.deps.toolOutputs } : {}),
        ...(this.deps.knowledge ? { knowledge: this.deps.knowledge } : {}),
        ...(this.deps.questions ? { questions: this.deps.questions } : {}),
        runId,
        chainRootId: trigger.chainRootId ?? trigger.id,
        depthTurn: trigger.depthTurn ?? 0,
      });
      // 主智能体要按成员能力档案决定把活派给谁：每次运行前同步 TEAM.md 再读进来，
      // 保证新建、移除成员或改技能授权后下一轮就看到最新值（读失败则不注入，fail-open）。
      let teamFile: string | undefined;
      if (member.role === "main" && this.deps.memory) {
        await this.deps.memory.syncTeamFile().catch(() => undefined);
        teamFile = await this.deps.memory.readTeamFile();
      }
      // 知识库目录摘录：只在有实际内容时注入；读失败不阻断本轮。
      const knowledge = await this.deps.knowledge?.summary().catch(() => undefined);
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
        ...(knowledge ? { knowledge } : {}),
        availableTools: new Set(tools.map((tool) => tool.schema.name)),
        nowMs: Date.now(),
      });
      // Lane-1 触发召回（移植 active-memory）：在主模型请求前跑，失败即不注入（fail-open）。
      // 续跑时上下文取自日志里模型真正看过的那一份，不再重新召回/扇出，避免重复花销与重复注入。
      let recallContext: string | undefined;
      let recalledHits: TriggerRecallHit[] = [];
      if (!resume && this.deps.memory) {
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
      // 任务台账只给主智能体：它负责统筹，其他成员拿到交接上下文包就够。
      const missionContext =
        !resume && member.role === "main" && this.deps.missions
          ? this.deps.missions.takeContext(trigger.chainRootId ?? trigger.id, board.list())
          : null;
      const handoffContext = !resume && trigger.handoff ? formatHandoff(trigger.handoff) : null;
      const messages: LlmMessage[] = resume
        ? [...resume.initialMessages]
        : [
            {
              role: "user",
              content:
                `${recallContext ? `${recallContext}\n\n` : ""}` +
                `${window ? `群聊最近记录：\n${window}\n\n` : ""}` +
                `${missionContext ? `${missionContext}\n\n` : ""}` +
                `${handoffContext ? `${handoffContext}\n\n` : ""}` +
                `${buildInstruction(member, trigger, bus.roomMode, bus.roomRouting)}`,
            },
          ];
      // 顾问扇出（Hermes 的 MoA 群聊版）：动手之前先请几位在册成员出建议。
      // 建议块作为**独立的一条用户消息**进本轮上下文，系统提示词一个字节都不动，前缀缓存照旧命中。
      const guidance = resume ? undefined : await this.collectAdvice(member, trigger, windowMessages, controller, runId);
      if (guidance) messages.push({ role: "user", content: guidance });
      // 续跑的分支上下文来自运行日志；用户对挂起问题的回答不在日志里，必须在历史之后补进来。
      const resumeFollowUp =
        resume && trigger.resumeQuestionId
          ? `${trigger.text}\n\n` +
            "上面的内容是对你刚才提问的回答。请从被挂起的位置继续完成原来的任务，不要重复提问；" +
            "如果回答要求调整计划，先说明调整，再继续执行。"
          : undefined;
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

      // 工具结果进上下文前的统一出口：脱敏 → 大输出落盘选片 → 外部来源套不可信信封。
      // 查询词用本轮触发消息 + 工具参数，选片因此贴着「这一轮到底在找什么」。
      const transformToolResult = createToolResultTransform({
        ...(this.deps.toolOutputs ? { store: this.deps.toolOutputs } : {}),
        memberId: this.member.id,
        roomId: bus.roomId,
        runId,
        query: trigger.text,
      });

      // 每次工具调用重试了几次：终局事件要把它带进执行轨迹。
      const retryCounts = new Map<string, number>();

      // 运行日志：刚开始就写一份初始快照，进程在任何一步中断都能从这里接着恢复。
      journal = this.deps.journals?.start({
        roomId: bus.roomId,
        runId,
        memberId: this.member.id,
        initialMessages: messages,
        ...(runOptions.workItemId ? { workItemId: runOptions.workItemId } : {}),
        ...(resume ? { resumeFrom: resume } : {}),
      }) ?? null;
      if (resume) {
        const retryable = resume.pendingCalls.filter((call) => {
          const tool = tools.find((candidate) => candidate.schema.name === call.name);
          return tool !== undefined && (tool.retry === "safe" || tool.retry === "idempotent");
        }).length;
        const unknown = resume.pendingCalls.length - retryable;
        const detail =
          `已恢复 ${resume.steps} 步、跳过 ${resume.summary.replayedTools} 个已完成工具调用` +
          (resume.pendingCalls.length > 0
            ? `；重跑 ${retryable} 个只读/幂等调用，${unknown} 个副作用调用结果未知`
            : "");
        this.notice(`@${this.member.name} 从上次中断处继续：${detail}`);
        this.emit({
          type: "span",
          runId,
          memberId: this.member.id,
          spanId: newId("span"),
          name: "断点续跑",
          phase: "end",
          ok: true,
          detail,
        });
      }

      const result = await runAgentLoop({
        provider: transport.provider,
        model: transport.model.id,
        request: transport.request,
        onUsage: collectUsage,
        system,
        messages,
        tools,
        ...(journal ? { journal } : {}),
        ...(resume
          ? {
              resume: {
                messages: resume.messages,
                pendingCalls: resume.pendingCalls,
                steps: resume.steps,
              },
            }
          : {}),
        ...(resumeFollowUp ? { resumeFollowUp } : {}),
        ...(runScope ? { toolUnavailable: (name: string) => scopeToolUnavailable(runScope, name) } : {}),
        maxSteps: limits.maxStepsPerRun,
        signal: controller.signal,
        ...(this.deps.approvals
          ? {
              beforeTool: (call: ToolCall, tool: ToolImpl) =>
                this.deps.approvals!.check({
                  runId,
                  memberId: this.member.id,
                  memberName: this.member.name,
                  call,
                  tool,
                }),
              approvalResumable: (call: ToolCall) =>
                this.deps.approvals!.canResume(runId, call),
            }
          : {}),
        budget,
        budgetOwnerId: this.member.id,
        // 工具结果进上下文前的统一出口：外部来源套不可信信封、疑似密钥掩码（见 content/policy.ts）。
        transformToolResult,
        // 压缩摘要后追加确定性状态块：列出最近的工具输出存档与取回方式，避免压缩后丢线索。
        ...(this.deps.toolOutputs
          ? { compactionState: () => this.deps.toolOutputs!.stateBlock(this.member.id, bus.roomId) }
          : {}),
        // 压缩后的每个新回合按当前问题召回旧工具输出；只在已有压缩摘要后生效。
        ...(this.deps.toolOutputs
          ? {
              recall: {
                produce: (query: string) =>
                  this.deps.toolOutputs!.recallBlock(this.member.id, bus.roomId, query),
              },
            }
          : {}),
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
        onReasoningDelta: (delta) => {
          reasoningText += delta;
          flushReasoning();
        },
        onToolCall: (call) => {
          usedTools.add(call.name);
          this.emit({ type: "tool", runId, memberId: this.member.id, name: call.name, args: call.args });
        },
        onToolRetry: (info) => {
          retryCounts.set(info.callId, info.attempt);
        },
        onToolResult: (call, content, status) => {
          const retries = retryCounts.get(call.id);
          retryCounts.delete(call.id);
          this.emit({
            type: "tool-result",
            runId,
            memberId: this.member.id,
            name: call.name,
            content,
            ok: status.ok,
            ...(status.code ? { code: status.code } : {}),
            ...(retries ? { retries } : {}),
          });
        },
        onRepair: ({ toolNames }) =>
          this.notice(`@${this.member.name} 的文本式工具调用已被修复执行：${toolNames.join("、")}`),
        pullPending: () => this.pending.splice(0, this.pending.length),
      });

      // 推理轨迹先于终局事件收尾，执行轨迹里「思考」才会排在交付前面。
      flushReasoning(true);

      // 提问挂起：问题卡已经由工具发出，这里只收束运行，不发交付气泡、不关闭日志。
      if (result.suspended) {
        suspendedHere = true;
        this.suspended = true;
        journal?.pause({
          questionId: result.suspended.questionId,
          messageId: result.suspended.messageId,
        });
        this.emit({
          type: "run-suspended",
          runId,
          memberId: this.member.id,
          questionId: result.suspended.questionId,
          messageId: result.suspended.messageId,
          initiator,
        });
        this.setStatus("waiting");
        return;
      }

      // 运行期间成员被移除：不再以已移除成员的身份往群里发言。
      if (!bus.getMember(this.member.id)) {
        this.emit({ type: "run-aborted", runId, memberId: this.member.id, reason: "removed" });
        finishJournal({ status: "aborted", reason: "removed" });
        return;
      }

      if (result.error) {
        this.emit({ type: "run-error", runId, memberId: this.member.id, error: result.error });
        finishJournal({
          status: "error",
          error: result.error,
          ...(result.errorCode ? { code: result.errorCode } : {}),
          steps: result.steps,
        });
        this.notice(
          `@${this.member.name} 运行中止：${result.error}`,
          result.errorCode === "max_steps_reached" ? this.resumeHint(trigger) : undefined,
        );
        this.setStatus("error");
        return;
      }
      finishJournal({
        status: "ok",
        text: result.text,
        steps: result.steps,
        ...(result.maxStepsReached ? { maxStepsReached: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      });

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
          initiator,
        });
        if (trigger.taskId) board.linkMessage(trigger.taskId, message.id);
        this.emit({ type: "run-final", runId, memberId: this.member.id, text: result.text, initiator });
      } else {
        // pass 这一轮什么都没交付：终局事件留空，前端不会为它渲染一条气泡。
        this.emit({
          type: "run-final",
          runId,
          memberId: this.member.id,
          text: passed ? "" : (result.text ?? ""),
          initiator,
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
        const spanId = newId("span");
        this.emit({
          type: "span",
          runId,
          memberId: this.member.id,
          spanId,
          name: "学习复盘",
          phase: "start",
        });
        void learning
          .afterRun({
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
          })
          .then(
            () =>
              this.emit({
                type: "span",
                runId,
                memberId: this.member.id,
                spanId,
                name: "学习复盘",
                phase: "end",
                ok: true,
              }),
            () =>
              this.emit({
                type: "span",
                runId,
                memberId: this.member.id,
                spanId,
                name: "学习复盘",
                phase: "end",
                ok: false,
              }),
          );
      }
    } catch (err) {
      if (isAbort(err)) {
        this.emit({
          type: "run-aborted",
          runId,
          memberId: this.member.id,
          reason: timedOut ? "timeout" : this.silentAbort ? "silent" : "cancelled",
        });
        finishJournal({
          status: "aborted",
          reason: timedOut ? "timeout" : this.silentAbort ? "silent" : "cancelled",
        });
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
      finishJournal({ status: "error", error: detail });
      this.notice(`@${this.member.name} 运行失败：${detail}`);
      this.setStatus("error");
    } finally {
      // 任何未显式收尾的退出都按「中断」记账：日志保持可续跑，而不是伪装成成功。
      // 挂起是显式暂停，日志必须保持未完成，用户回答后才能沿同一份日志续跑。
      if (!suspendedHere) finishJournal({ status: "aborted", reason: "interrupted" });
      flushReasoning(true);
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
    runId: string,
  ): Promise<string | undefined> {
    const service = this.deps.advisors;
    if (!service) return undefined;
    // 顾问是主运行下的子调用：执行轨迹里要能看出它何时开始、是否产出。
    const spanId = newId("span");
    this.emit({
      type: "span",
      runId,
      memberId: member.id,
      spanId,
      name: "顾问扇出",
      phase: "start",
    });
    let note: string | undefined;
    let ok = false;
    try {
      const outcome = await service.run({
        acting: member,
        members: this.deps.bus.listMembers(),
        messages: window,
        taskText: trigger.text,
        roomId: this.deps.bus.roomId,
        turnKey: trigger.chainRootId ?? trigger.id,
        getModelDeps: this.deps.getModelDeps,
        signal: controller.signal,
      });
      ok = Boolean(outcome.guidance);
      note = outcome.note;
      // 已经被取消的这一轮不必再补一句参谋说明。
      if (outcome.note && !controller.signal.aborted) this.notice(`顾问扇出：${outcome.note}`);
      return outcome.guidance;
    } catch {
      return undefined;
    } finally {
      this.emit({
        type: "span",
        runId,
        memberId: member.id,
        spanId,
        name: "顾问扇出",
        phase: "end",
        ok,
        ...(note ? { detail: note } : {}),
      });
    }
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
