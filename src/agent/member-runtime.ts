import type { AgentEvent, Limits, Member, RoomMessage } from "../core/types";
import { SYSTEM_ID } from "../core/types";
import { newId } from "../core/ids";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { LlmMessage } from "../provider/types";
import { resolveProvider, type ProviderDeps } from "../provider/registry";
import { runAgentLoop } from "./loop";
import { buildTools, type SpawnInput } from "./tools";
import { buildInstruction, buildSystemPrompt, formatRoomWindow } from "./prompts";

export interface RuntimeDeps {
  bus: RoomBus;
  board: Workboard;
  getProviderDeps(): ProviderDeps;
  getLimits(): Limits;
  spawn(parent: Member, input: SpawnInput, trigger: RoomMessage): Promise<string>;
  onFinished?(memberId: string): void;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export class MemberRuntime {
  private controller: AbortController | null = null;
  private pending: LlmMessage[] = [];
  private running = false;

  constructor(
    readonly member: Member,
    private readonly deps: RuntimeDeps,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  steer(message: RoomMessage): void {
    this.pending.push({
      role: "user",
      content: `运行中收到一条新群聊消息（#${message.seq}，来自 ${
        message.senderKind === "user" ? "用户" : `@${message.senderName}`
      }）：\n${message.text}`,
    });
  }

  cancel(): boolean {
    if (!this.controller) return false;
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
    const timeout = setTimeout(() => controller.abort(), limits.runTimeoutMs);
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
      const parent = this.member.spawnedBy ? bus.getMember(this.member.spawnedBy) : undefined;
      const system = buildSystemPrompt({
        roomName: bus.roomName,
        member: this.member,
        members: bus.listMembers(),
        parentName: parent?.name ?? null,
        taskTitles,
        limits,
      });
      const window = formatRoomWindow(bus.window(limits.maxRoomWindowChars));
      const messages: LlmMessage[] = [
        {
          role: "user",
          content: `${window ? `群聊最近记录：\n${window}\n\n` : ""}${buildInstruction(this.member, trigger)}`,
        },
      ];
      const tools = buildTools(this.member, {
        bus,
        board,
        limits,
        spawn: (input) => this.deps.spawn(this.member, input, trigger),
      });
      const { provider, model } = resolveProvider(this.member.providerId, this.deps.getProviderDeps());

      const result = await runAgentLoop({
        provider,
        model,
        system,
        messages,
        tools,
        maxSteps: limits.maxStepsPerRun,
        signal: controller.signal,
        onDelta: (text) => this.emit({ type: "delta", runId, memberId: this.member.id, text }),
        onToolCall: (call) =>
          this.emit({ type: "tool", runId, memberId: this.member.id, name: call.name, args: call.args }),
        onToolResult: (call, content) =>
          this.emit({ type: "tool-result", runId, memberId: this.member.id, name: call.name, content }),
        pullPending: () => this.pending.splice(0, this.pending.length),
      });

      if (result.error) {
        this.emit({ type: "run-error", runId, memberId: this.member.id, error: result.error });
        this.notice(`@${this.member.name} 运行中止：${result.error}`);
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
      this.setStatus("idle");
    } catch (err) {
      if (isAbort(err)) {
        this.emit({ type: "run-aborted", runId, memberId: this.member.id });
        this.notice(`@${this.member.name} 本次运行已取消`);
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

  private notice(text: string): void {
    this.deps.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text,
    });
  }
}
