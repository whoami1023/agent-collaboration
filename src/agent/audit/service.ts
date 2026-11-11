/**
 * 持续审计服务：运行收尾后对「成员 + 任务卡验收条款」做一次独立核对。
 *
 * 关键约束：
 * - 同一份证据只审一次（状态指纹），不重复花模型调用；
 * - 失败先有界催办，连续无进展或达到累计上限就升级给人工；
 * - 一切失败都 fail-open：审计不可用不影响成员运行与群聊。
 */
import { createHash } from "node:crypto";
import { newId } from "../../core/ids";
import type { Settings } from "../../core/settings";
import type { Member, RoomMessage, TaskCard } from "../../core/types";
import type { ActivityEvent } from "../../room/activity-log";
import type { ModelUsageStore } from "../../model/usage-store";
import {
  resolveModelRuntime,
  type ModelTransport,
  type RuntimeDeps as ModelRuntimeDeps,
} from "../../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../../model/usage-cost";
import type { LlmProvider, LlmRequest } from "../../provider/types";
import type { RoomBus } from "../../room/bus";
import type { Workboard } from "../../workboard/board";
import type { WorkspaceFiles } from "../../files/workspace-files";
import { buildAuditPrompt, parseAuditResponse } from "./prompt";
import type { AuditStore } from "./store";
import {
  AUDIT_LIMITS,
  overallVerdict,
  summarizeCriteria,
  type AuditCriterionResult,
  type AuditHost,
  type AuditRecord,
  type AuditRunInput,
  type AuditState,
} from "./types";

export interface AuditServiceDeps {
  roomId: string;
  store: AuditStore;
  board: Workboard;
  bus: RoomBus;
  files?: WorkspaceFiles;
  getSettings(): Settings;
  getModelDeps(): ModelRuntimeDeps;
  activityByMember(memberId: string): ActivityEvent[];
  usage?: ModelUsageStore;
  /** 催办：由编排器落一条系统消息并唤醒成员；返回是否真的排上了。 */
  requestNudge(memberId: string, text: string, taskId: string): boolean;
  /** 升级：只提醒用户，不再自动催办。 */
  requestEscalation(record: AuditRecord): void;
  onRecord?(record: AuditRecord): void;
  /** 审计是主运行之后的独立模型调用：执行轨迹把它挂回父运行。 */
  onSpan?(span: {
    runId: string;
    memberId: string;
    spanId: string;
    name: string;
    phase: "start" | "end";
    ok?: boolean;
    detail?: string;
  }): void;
  now?(): number;
  /** 测试注入：替换真实模型补全。 */
  complete?(prompt: { system: string; user: string }, signal: AbortSignal): Promise<{
    text: string;
    usage?: UsageTotals;
    modelRef?: string;
  } | null>;
}

/** 单轮流式补全：审计不需要工具，只要文本与 usage。 */
async function completeOnce(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<{ text: string; usage: UsageTotals }> {
  let text = "";
  let usage = emptyUsage();
  for await (const event of provider.stream(request)) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "usage") usage = addUsage(usage, event.usage);
  }
  return { text, usage };
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function fingerprint(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

export class AuditService implements AuditHost {
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly now: () => number;

  constructor(private readonly deps: AuditServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 运行收尾入口：只挑一个可审计的任务，失败不影响编排器。 */
  async afterRun(input: AuditRunInput): Promise<void> {
    const task = this.selectTask(input);
    if (!task) return;
    await this.run(input, task).catch(() => undefined);
  }

  close(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private selectTask(input: AuditRunInput): TaskCard | undefined {
    if (input.taskId) {
      const task = this.deps.board.get(input.taskId);
      if (!task || !task.acceptance?.trim()) return undefined;
      if (task.ownerId && task.ownerId !== input.memberId) return undefined;
      return task.status === "done" || task.status === "failed" ? undefined : task;
    }
    const active = this.deps.board
      .list()
      .filter(
        (task) =>
          task.ownerId === input.memberId &&
          task.acceptance?.trim() &&
          task.status !== "done" &&
          task.status !== "failed",
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return active[0];
  }

  private async run(input: AuditRunInput, task: TaskCard): Promise<void> {
    if (this.inFlight.has(task.id)) return;
    const member = this.deps.bus.getMember(input.memberId);
    if (!member || member.status === "cancelled") return;

    this.inFlight.add(task.id);
    try {
      const evidence = await this.collectEvidence(task, member);
      const hash = fingerprint({
        task: [task.updatedAt, task.status, task.acceptance],
        messages: evidence.messages.map((message) => [message.id, message.ts]),
        activities: evidence.activities.map((activity) => [activity.id, activity.at, activity.kind]),
        files: evidence.files.map((file) => [file.path, file.content?.length ?? 0]),
        fileState: evidence.fileState,
      });
      if (this.deps.store.hasState(task.id, hash)) return;

      const runId = input.runId;
      const spanId = newId("span");
      const emitSpan = (phase: "start" | "end", ok?: boolean, detail?: string) => {
        if (!runId) return;
        this.deps.onSpan?.({
          runId,
          memberId: member.id,
          spanId,
          name: "持续审计",
          phase,
          ...(ok === undefined ? {} : { ok }),
          ...(detail ? { detail } : {}),
        });
      };
      emitSpan("start");
      let completion: { text: string; usage?: UsageTotals; modelRef?: string } | null;
      try {
        completion = await this.complete(
          buildAuditPrompt({
            taskTitle: task.title,
            taskDetail: task.detail,
            acceptance: task.acceptance ?? "",
            taskStatus: task.status,
            memberName: member.name,
            messages: evidence.messages.map((message) => ({
              senderName: message.senderName,
              text: message.text,
            })),
            activities: evidence.activities.map((activity) => ({
              time: clock(activity.at),
              kind: activity.kind,
              title: activity.title,
              ...(activity.detail ? { detail: activity.detail } : {}),
            })),
            files: evidence.files,
          }),
        );
      } catch (err) {
        emitSpan("end", false, err instanceof Error ? err.message : String(err));
        throw err;
      }
      if (!completion) {
        emitSpan("end", false, "审计模型没有返回可用结果");
        return;
      }
      const criteria = parseAuditResponse(completion.text, task.acceptance ?? "");
      if (!criteria) {
        emitSpan("end", false, "审计结论无法解析");
        return;
      }

      const summary = summarizeCriteria(criteria);
      const verdict = overallVerdict(summary);
      emitSpan("end", true, `结论：${verdict}`);
      const solved = verdict === "pass";
      const at = this.now();
      const previous = this.deps.store.stateOf(task.id) ?? {
        taskId: task.id,
        bestPassed: -1,
        nudges: 0,
        totalNudges: 0,
        noProgress: 0,
      } satisfies AuditState;

      const improved = summary.passed > previous.bestPassed;
      const next: AuditState = {
        ...previous,
        bestPassed: Math.max(previous.bestPassed, summary.passed),
        nudges: solved || improved ? 0 : previous.nudges,
        totalNudges: previous.totalNudges,
        noProgress: solved || improved ? 0 : previous.noProgress + 1,
        lastHash: hash,
        lastAuditedAt: at,
      };

      const fixHint = topFixHint(criteria);
      const record: AuditRecord = {
        id: newId("audit"),
        roomId: this.deps.roomId,
        taskId: task.id,
        taskTitle: task.title,
        memberId: member.id,
        memberName: member.name,
        ...(input.runId ? { runId: input.runId } : {}),
        at,
        verdict,
        summary,
        criteria,
        stateHash: hash,
        sources: {
          messages: evidence.messages.length,
          tools: evidence.activities.filter((activity) => activity.kind === "tool").length,
          files: evidence.files.map((file) => file.path),
        },
        action: "none",
        interventionCount: next.nudges,
        maxInterventions: AUDIT_LIMITS.maxConsecutiveNudges,
        taskSolved: solved,
        modelRef: completion.modelRef ?? "",
        ...(fixHint ? { fixHint } : {}),
      };

      if (!solved) {
        const canNudge =
          previous.nudges < AUDIT_LIMITS.maxConsecutiveNudges &&
          previous.totalNudges < AUDIT_LIMITS.maxTotalNudges &&
          next.noProgress <= AUDIT_LIMITS.maxNoProgress;
        if (canNudge) {
          record.action = "nudge";
          record.interventionCount = previous.nudges + 1;
          if (this.deps.requestNudge(member.id, nudgeText(record), task.id)) {
            next.nudges = previous.nudges + 1;
            next.totalNudges = previous.totalNudges + 1;
          } else {
            record.action = "none";
            record.interventionCount = previous.nudges;
          }
        } else {
          record.action = "escalate";
        }
      }

      this.deps.store.setState(task.id, next);
      this.deps.store.add(record);
      this.deps.onRecord?.(record);
      if (record.action === "escalate") this.deps.requestEscalation(record);
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  private async collectEvidence(
    task: TaskCard,
    member: Member,
  ): Promise<{
    messages: RoomMessage[];
    activities: ActivityEvent[];
    files: Array<{ path: string; summary?: string; content?: string }>;
    fileState: Array<[string, number, number]>;
  }> {
    const messages = this.deps.bus
      .listMessages(400)
      .filter(
        (message) =>
          message.ts >= task.createdAt &&
          message.senderKind !== "system" &&
          (message.senderKind === "user" || message.senderId === member.id),
      )
      .slice(-12);
    const activities = this.deps.activityByMember(member.id)
      .filter((activity) => activity.at >= task.createdAt)
      .slice(-24);

    const files: Array<{ path: string; summary?: string; content?: string }> = [];
    const fileState: Array<[string, number, number]> = [];
    if (this.deps.files) {
      try {
        const listing = await this.deps.files.list();
        const known = new Map(listing.files.map((file) => [file.path, file]));
        for (const artifact of task.artifacts.filter((item) => item.path).slice(0, 3)) {
          const path = artifact.path!;
          const entry = known.get(path);
          if (entry) fileState.push([path, entry.sizeBytes, entry.updatedAt]);
          let content: string | undefined;
          try {
            const body = await this.deps.files.read(path, { maxBytes: 3_000 });
            if (!body.binary) content = body.content;
          } catch {
            content = undefined;
          }
          files.push({
            path,
            ...(artifact.summary ? { summary: artifact.summary } : {}),
            ...(content ? { content } : {}),
          });
        }
        if (files.length === 0) {
          // 没有挂成果时只给文件名，避免审计把无关文件正文当证据。
          for (const entry of listing.files.slice(0, 12)) files.push({ path: entry.path });
        }
      } catch {
        // 文件工作区不可用：仍可用发言与工具活动审计。
      }
    }
    return { messages, activities, files, fileState };
  }

  private async complete(prompt: {
    system: string;
    user: string;
  }): Promise<{ text: string; modelRef: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUDIT_LIMITS.auditTimeoutMs);
    timer.unref();
    this.controllers.add(controller);
    try {
      if (this.deps.complete) {
        const injected = await this.deps.complete(prompt, controller.signal);
        if (!injected?.text.trim()) return null;
        return { text: injected.text, modelRef: injected.modelRef ?? "injected" };
      }
      const settings = this.deps.getSettings();
      let transport: ModelTransport;
      try {
        transport = resolveModelRuntime(
          settings.selection.defaultModel,
          this.deps.getModelDeps(),
        );
      } catch {
        return null;
      }
      const request: LlmRequest = {
        model: transport.model.id,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        tools: [],
        maxTokens: 1_200,
        signal: controller.signal,
        ...(transport.request.params ? { params: transport.request.params } : {}),
        ...(transport.request.headers ? { headers: transport.request.headers } : {}),
        ...(transport.request.timeoutMs !== undefined
          ? { timeoutMs: transport.request.timeoutMs }
          : {}),
        ...(transport.request.baseUrl ? { baseUrl: transport.request.baseUrl } : {}),
      };
      const { text, usage } = await completeOnce(transport.provider, request);
      if (!text.trim()) return null;
      await this.recordUsage(transport, usage).catch(() => undefined);
      return { text, modelRef: transport.activeRef() || transport.model.ref };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private async recordUsage(transport: ModelTransport, usage: UsageTotals): Promise<void> {
    const usageStore = this.deps.usage;
    if (!usageStore) return;
    const ref = transport.activeRef() || transport.model.ref;
    const model = [transport.chain.primary, ...transport.chain.fallbacks].find(
      (candidate) => candidate.ref === ref,
    ) ?? transport.model;
    await usageStore.record({
      ref,
      providerId: model.providerId,
      modelId: model.id,
      usage,
      costUsd: calculateUsageCost(model, usage),
    });
  }
}

function topFixHint(criteria: readonly AuditCriterionResult[]): string {
  const target = criteria.find((item) => item.verdict !== "pass" && item.fixHint)
    ?? criteria.find((item) => item.verdict !== "pass");
  return target?.fixHint ?? target?.criterion ?? "";
}

function nudgeText(record: AuditRecord): string {
  const issues = record.summary.failed + record.summary.unsure;
  const open = record.criteria
    .filter((item) => item.verdict !== "pass")
    .slice(0, 2)
    .map((item) => (item.fixHint ? `${item.criterion}（${item.fixHint}）` : item.criterion));
  return [
    `【持续审计】任务「${record.taskTitle}」还有 ${issues}/${record.summary.total} 项验收没有通过。`,
    open.length > 0 ? `未通过：${open.join("；")}` : "请对照验收条款补齐证据。",
    "请沿用现有证据链继续完成，并在群里说明补了哪些证据。",
    `（自动催办 ${record.interventionCount}/${record.maxInterventions}；连续无进展会停止催办并转人工。）`,
  ].join("\n");
}
