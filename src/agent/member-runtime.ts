import type { AgentEvent, Limits, Member, ResumeHint, RoomMessage } from "../core/types";
import { SYSTEM_ID } from "../core/types";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { LlmMessage } from "../provider/types";
import { resolveProvider, type ProviderDeps } from "../provider/registry";
import type { SkillLibrary } from "../skills/library";
import { selectSkillsForMember } from "../skills/selection";
import type { MemorySearchManager } from "../memory/manager";
import type { WorkspaceFiles } from "../files/workspace-files";
import { resolveTriggerRecall } from "../memory/recall";
import { runAgentLoop } from "./loop";
import { DEFAULT_COMPACTION_SETTINGS } from "./context/compaction";
import { resolveMaxActiveTranscriptBytes, type TranscriptByteCompactionLatch } from "./context/bounded-context";
import type { ContextBudgetConfig } from "./context/budget";
import { buildTools } from "./tools";
import { buildInstruction, buildSystemPrompt, formatRoomWindow } from "./prompts";

export interface RuntimeDeps {
  bus: RoomBus;
  board: Workboard;
  getProviderDeps(): ProviderDeps;
  getLimits(): Limits;
  skills: SkillLibrary;
  ownerId: string;
  memory?: MemorySearchManager;
  files?: WorkspaceFiles;
  onFinished?(memberId: string): void;
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
      const tools = buildTools(member, {
        bus,
        board,
        skills: this.deps.skills,
        userId: this.deps.ownerId,
        ...(this.deps.memory ? { memory: this.deps.memory } : {}),
        ...(this.deps.files ? { files: this.deps.files } : {}),
      });
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
        availableTools: new Set(tools.map((tool) => tool.schema.name)),
      });
      // Lane-1 触发召回（移植 active-memory）：在主模型请求前跑，失败即不注入（fail-open）。
      let recallContext: string | undefined;
      if (this.deps.memory) {
        const recall = await resolveTriggerRecall({
          manager: this.deps.memory,
          message: trigger.text,
          signal: controller.signal,
          ...(member.role === "sub" ? { agentId: member.id } : {}),
        }).catch(() => undefined);
        recallContext = recall?.context;
      }
      const window = formatRoomWindow(bus.window(limits.maxRoomWindowChars));
      const messages: LlmMessage[] = [
        {
          role: "user",
          content:
            `${recallContext ? `${recallContext}\n\n` : ""}` +
            `${window ? `群聊最近记录：\n${window}\n\n` : ""}${buildInstruction(member, trigger, bus.roomMode)}`,
        },
      ];
      const { provider, model } = resolveProvider(this.member.providerId, this.deps.getProviderDeps());

      const budget: ContextBudgetConfig = {
        ...(limits.contextWindowTokens && limits.contextWindowTokens > 0
          ? { contextWindowTokens: limits.contextWindowTokens }
          : {}),
        ...(resolveMaxActiveTranscriptBytes(limits.maxActiveTranscriptBytes) !== undefined
          ? { maxActiveTranscriptBytes: resolveMaxActiveTranscriptBytes(limits.maxActiveTranscriptBytes) }
          : {}),
        compaction: { ...DEFAULT_COMPACTION_SETTINGS },
      };

      const result = await runAgentLoop({
        provider,
        model,
        system,
        messages,
        tools,
        maxSteps: limits.maxStepsPerRun,
        signal: controller.signal,
        budget,
        budgetOwnerId: this.member.id,
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
        onToolCall: (call) =>
          this.emit({ type: "tool", runId, memberId: this.member.id, name: call.name, args: call.args }),
        onToolResult: (call, content) =>
          this.emit({ type: "tool-result", runId, memberId: this.member.id, name: call.name, content }),
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

      if (result.text) {
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
        });
        if (trigger.taskId) board.linkMessage(trigger.taskId, message.id);
        this.emit({ type: "run-final", runId, memberId: this.member.id, text: result.text });
      } else {
        this.emit({ type: "run-final", runId, memberId: this.member.id, text: "" });
      }
      if (result.maxStepsReached) {
        this.notice(
          `@${this.member.name} 单次运行 ${limits.maxStepsPerRun} 步工具调用已用尽，已停止调用工具并基于当前进展收尾。`,
          this.resumeHint(trigger),
        );
      }
      this.setStatus("idle");
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
      clearTimeout(timeout);
      this.controller = null;
      this.silentAbort = false;
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
