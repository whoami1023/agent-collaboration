/**
 * 运行级检查点（RunJournal）：把一轮智能体运行的关键步骤追加到磁盘，
 * 进程中断后可以接着上次的回合继续，而不是把整轮重跑一遍。
 *
 * 机制参考 LangGraph 的 checkpointer（MIT License, https://github.com/langchain-ai/langgraph）：
 * - 已完成回合的 assistant / tool 消息是「已发生的事实」，续跑时原样放回上下文，不重新调用模型或工具；
 * - 只补做**没有结果**的调用；其中有副作用的调用一律标记「结果未知」，绝不自动重跑；
 * - 周期性写压缩快照并轮转 JSONL（对应 DeltaChannel 的周期快照），把加载成本压到常数级；
 * - 系统提示词、设置与密钥永远不写入日志（对应 UntrackedValue）：工具结果已经过统一的脱敏与
 *   不可信信封处理，日志只落模型真正看到的那一份内容。
 *
 * 文件布局（每个房间一个目录）：
 *   journals/<roomId>/<runId>.snapshot.json  最近一次压缩快照（原子写）
 *   journals/<roomId>/<runId>.jsonl          快照之后的追加日志
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmMessage, ToolCall } from "../provider/types";
import { newId } from "../core/ids";
import type { ToolResultStatus } from "./tool-errors";

export const JOURNAL_VERSION = 1;
/** 单条日志里内容的硬上限：工具输出存档负责大结果，日志只保留续跑需要的那份上下文。 */
const MAX_CONTENT_CHARS = 60_000;
const DEFAULT_SNAPSHOT_EVERY = 20;
const DEFAULT_MAX_RUNS = 200;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 等待用户回答的运行不算中断：按已完成日志的窗口保留，答复后还能从断点续跑。 */
const PAUSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60_000;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface RunJournalTerminal {
  status: "ok" | "error" | "aborted";
  text?: string;
  error?: string;
  code?: string;
  reason?: string;
  steps?: number;
  maxStepsReached?: boolean;
  truncated?: boolean;
}

interface BaseEntry {
  n: number;
  at: number;
}

export interface JournalAssistantEntry extends BaseEntry {
  kind: "assistant";
  step: number;
  content: string;
  calls: ToolCall[];
}

export interface JournalToolEntry extends BaseEntry {
  kind: "tool";
  step: number;
  callId: string;
  name: string;
  content: string;
  ok: boolean;
  code?: string;
  retries?: number;
}

export interface JournalTerminalEntry extends BaseEntry, RunJournalTerminal {
  kind: "terminal";
}

export type JournalEntry = JournalAssistantEntry | JournalToolEntry | JournalTerminalEntry;

interface JournalSnapshotFile {
  version: number;
  runId: string;
  roomId: string;
  memberId: string;
  workItemId?: string;
  createdAt: number;
  updatedAt: number;
  /** 快照覆盖到哪一条日志；尾部 n 大于它的日志行在加载时补放。 */
  through: number;
  initialMessages: LlmMessage[];
  messages: LlmMessage[];
  pendingCalls: ToolCall[];
  steps: number;
  done: boolean;
  terminal?: RunJournalTerminal;
  /** 这一轮停在等待用户回答的位置；不是终局，可续跑。 */
  paused?: { questionId: string; messageId: string; at: number };
}

export interface LoadedRunJournal {
  runId: string;
  roomId: string;
  memberId: string;
  workItemId?: string;
  initialMessages: LlmMessage[];
  /** 已完成的 assistant / tool 消息，按发生顺序重建。 */
  messages: LlmMessage[];
  /** 最后一条 assistant 里还没有结果的调用（续跑时逐个处理）。 */
  pendingCalls: ToolCall[];
  steps: number;
  done: boolean;
  terminal?: RunJournalTerminal;
  /** 这一轮停在等待用户回答的位置；续跑时据此确认它还没结束。 */
  paused?: { questionId: string; messageId: string };
  /** 最后一条日志的序号；续跑时从这里接着写。 */
  lastN: number;
  summary: { replayedSteps: number; replayedTools: number; pendingCalls: number };
}

/** 时间旅行用的检查点：在这里分叉 = 保留前 step 步，丢弃其后的历史。 */
export interface RunCheckpoint {
  /** 已完成的回合数；分叉时从这个数字之后接新指令。 */
  step: number;
  text: string;
  calls: string[];
  toolResults: number;
}

/** 运行日志清单的一行，供「时间旅行」列出可回看的运行。 */
export interface RunJournalSummary {
  runId: string;
  memberId: string;
  workItemId?: string;
  createdAt: number;
  updatedAt: number;
  steps: number;
  done: boolean;
  status?: RunJournalTerminal["status"];
  /** 等待用户回答而挂起（done=false 但可长期保留）。 */
  paused?: boolean;
}

export interface RunJournalCreateInput {
  roomId: string;
  runId: string;
  memberId: string;
  initialMessages: LlmMessage[];
  workItemId?: string;
  /** 续跑：沿用上一份日志的状态，从 lastN 之后继续追加。 */
  resumeFrom?: LoadedRunJournal;
}

export interface RunJournalRecorder {
  readonly runId: string;
  readonly resumed: boolean;
  assistant(step: number, content: string, calls: ToolCall[]): void;
  toolResult(
    step: number,
    call: ToolCall,
    content: string,
    status: ToolResultStatus,
    extra?: { retries?: number },
  ): void;
  /** 记录「停在等待用户回答」：不写终局、不关闭日志，只把最新状态快照落盘。 */
  pause(info: { questionId: string; messageId: string }): void;
  finish(result: RunJournalTerminal): void;
}

export interface RunJournalOptions {
  /** 累计多少条日志压一次快照并轮转；默认 20。 */
  snapshotEvery?: number;
  /** 每个房间最多保留多少份运行日志；默认 200。 */
  maxRuns?: number;
  /** 已完成日志保留多久；默认 7 天。 */
  doneRetentionMs?: number;
  now?: () => number;
}

function clip(value: string, max = MAX_CONTENT_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[运行日志：此内容超过 ${max} 字符，已截断；完整结果请从工具输出存档或文件重新读取]`;
}

function safeCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["id"] !== "string" || typeof raw["name"] !== "string") return null;
  const args =
    raw["args"] && typeof raw["args"] === "object"
      ? (raw["args"] as Record<string, unknown>)
      : {};
  return { id: raw["id"], name: raw["name"], args };
}

function safeCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map(safeCall).filter((call): call is ToolCall => call !== null);
}

function safeMessage(value: unknown): LlmMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw["role"] !== "assistant" && raw["role"] !== "tool" && raw["role"] !== "user") return null;
  if (typeof raw["content"] !== "string") return null;
  const message: LlmMessage = { role: raw["role"], content: clip(raw["content"]) };
  if (raw["role"] === "assistant") {
    const calls = safeCalls(raw["toolCalls"]);
    if (calls.length > 0) message.toolCalls = calls;
  }
  if (raw["role"] === "tool" && typeof raw["toolCallId"] === "string") {
    message.toolCallId = raw["toolCallId"];
  }
  return message;
}

function safeMessages(value: unknown): LlmMessage[] {
  if (!Array.isArray(value)) return [];
  return value.map(safeMessage).filter((message): message is LlmMessage => message !== null);
}

function preview(value: string): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

interface CompletedCheckpoint extends RunCheckpoint {
  /** 该检查点在消息数组里的结束位置（不含；本身就是下一条 assistant 的下标）。 */
  end: number;
}

/**
 * 只把「调用都有结果」的回合当作检查点：分叉点必须落在完整回合之后，
 * 否则上下文里会留下没有结果的 tool_calls，模型请求本身就不合法。
 */
function completedCheckpoints(messages: LlmMessage[]): CompletedCheckpoint[] {
  const checkpoints: CompletedCheckpoint[] = [
    { step: 0, text: "运行开始", calls: [], toolResults: 0, end: 0 },
  ];
  let index = 0;
  let step = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      index += 1;
      continue;
    }
    const calls = (message.toolCalls ?? []).map((call) => call.name);
    index += 1;
    let toolResults = 0;
    while (index < messages.length && messages[index]?.role === "tool") {
      toolResults += 1;
      index += 1;
    }
    if (toolResults < calls.length) break;
    step += 1;
    checkpoints.push({ step, text: preview(message.content), calls, toolResults, end: index });
  }
  return checkpoints;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseEntry(value: unknown): JournalEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["n"] !== "number" || typeof raw["at"] !== "number") return null;
  const kind = raw["kind"];
  if (kind === "assistant") {
    if (typeof raw["content"] !== "string" || typeof raw["step"] !== "number") return null;
    return {
      kind,
      n: raw["n"],
      at: raw["at"],
      step: raw["step"],
      content: clip(raw["content"]),
      calls: safeCalls(raw["calls"]),
    };
  }
  if (kind === "tool") {
    if (typeof raw["content"] !== "string" || typeof raw["callId"] !== "string") return null;
    return {
      kind,
      n: raw["n"],
      at: raw["at"],
      step: typeof raw["step"] === "number" ? raw["step"] : 0,
      callId: raw["callId"],
      name: typeof raw["name"] === "string" ? raw["name"] : "unknown",
      content: clip(raw["content"]),
      ok: raw["ok"] === true,
      ...(typeof raw["code"] === "string" ? { code: raw["code"] } : {}),
      ...(typeof raw["retries"] === "number" ? { retries: raw["retries"] } : {}),
    };
  }
  if (kind === "terminal") {
    const status = raw["status"];
    if (status !== "ok" && status !== "error" && status !== "aborted") return null;
    return {
      kind,
      n: raw["n"],
      at: raw["at"],
      status,
      ...(typeof raw["text"] === "string" ? { text: raw["text"] } : {}),
      ...(typeof raw["error"] === "string" ? { error: raw["error"] } : {}),
      ...(typeof raw["code"] === "string" ? { code: raw["code"] } : {}),
      ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
      ...(typeof raw["steps"] === "number" ? { steps: raw["steps"] } : {}),
      ...(raw["maxStepsReached"] === true ? { maxStepsReached: true } : {}),
      ...(raw["truncated"] === true ? { truncated: true } : {}),
    };
  }
  return null;
}

function applyEntry(
  state: {
    messages: LlmMessage[];
    pendingCalls: ToolCall[];
    steps: number;
    done: boolean;
    terminal?: RunJournalTerminal;
  },
  entry: JournalEntry,
): void {
  if (entry.kind === "assistant") {
    state.messages.push({
      role: "assistant",
      content: entry.content,
      ...(entry.calls.length > 0 ? { toolCalls: entry.calls } : {}),
    });
    state.pendingCalls = [...entry.calls];
    state.steps = Math.max(state.steps, entry.step + 1);
    return;
  }
  if (entry.kind === "tool") {
    state.messages.push({ role: "tool", toolCallId: entry.callId, content: entry.content });
    state.pendingCalls = state.pendingCalls.filter((call) => call.id !== entry.callId);
    return;
  }
  state.done = true;
  state.pendingCalls = [];
  state.terminal = {
    status: entry.status,
    ...(entry.text !== undefined ? { text: entry.text } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.steps !== undefined ? { steps: entry.steps } : {}),
    ...(entry.maxStepsReached ? { maxStepsReached: true } : {}),
    ...(entry.truncated ? { truncated: true } : {}),
  };
}

export class RunJournalStore {
  private readonly dir: string;
  private readonly snapshotEvery: number;
  private readonly maxRuns: number;
  private readonly doneRetentionMs: number;
  private readonly now: () => number;
  private lastPruneAt = 0;

  constructor(dir: string, options: RunJournalOptions = {}) {
    this.dir = dir;
    this.snapshotEvery = Math.max(1, options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY);
    this.maxRuns = Math.max(1, options.maxRuns ?? DEFAULT_MAX_RUNS);
    this.doneRetentionMs = options.doneRetentionMs ?? DONE_RETENTION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private snapshotFile(runId: string): string {
    return join(this.dir, `${runId}.snapshot.json`);
  }

  private tailFile(runId: string): string {
    return join(this.dir, `${runId}.jsonl`);
  }

  private validRunId(runId: string): boolean {
    return RUN_ID_PATTERN.test(runId);
  }

  has(runId: string): boolean {
    if (!this.validRunId(runId)) return false;
    return existsSync(this.snapshotFile(runId)) || existsSync(this.tailFile(runId));
  }

  /** 读取一份日志并重建续跑状态；文件损坏或格式不认识时返回 null，让调用方走全新运行。 */
  load(runId: string): LoadedRunJournal | null {
    if (!this.validRunId(runId)) return null;
    const snapshotRaw = this.readJson(this.snapshotFile(runId));
    const snapshot =
      snapshotRaw && typeof snapshotRaw === "object"
        ? (snapshotRaw as Record<string, unknown>)
        : null;
    if (!snapshot) return null;

    const initialMessages = safeMessages(snapshot["initialMessages"]);
    const state: {
      messages: LlmMessage[];
      pendingCalls: ToolCall[];
      steps: number;
      done: boolean;
      terminal?: RunJournalTerminal;
      paused?: { questionId: string; messageId: string };
    } = {
      messages: safeMessages(snapshot["messages"]),
      pendingCalls: safeCalls(snapshot["pendingCalls"]),
      steps: typeof snapshot["steps"] === "number" ? Math.max(0, snapshot["steps"]) : 0,
      done: snapshot["done"] === true,
    };
    const terminalRaw = snapshot["terminal"];
    if (terminalRaw && typeof terminalRaw === "object") {
      const parsed = parseEntry({ ...terminalRaw, kind: "terminal", n: 0, at: 0 });
      if (parsed?.kind === "terminal") {
        applyEntry(state, parsed);
      }
    }

    const pausedRaw = snapshot["paused"];
    if (pausedRaw && typeof pausedRaw === "object") {
      const paused = pausedRaw as Record<string, unknown>;
      if (typeof paused["questionId"] === "string" && typeof paused["messageId"] === "string") {
        state.paused = { questionId: paused["questionId"], messageId: paused["messageId"] };
      }
    }

    const through = typeof snapshot["through"] === "number" ? snapshot["through"] : 0;
    let lastN = through;
    for (const entry of this.readTail(runId, through)) {
      applyEntry(state, entry);
      lastN = Math.max(lastN, entry.n);
    }

    return {
      runId,
      roomId: typeof snapshot["roomId"] === "string" ? snapshot["roomId"] : "",
      memberId: typeof snapshot["memberId"] === "string" ? snapshot["memberId"] : "",
      ...(typeof snapshot["workItemId"] === "string" ? { workItemId: snapshot["workItemId"] } : {}),
      initialMessages,
      messages: state.messages,
      pendingCalls: state.pendingCalls,
      steps: state.steps,
      done: state.done,
      ...(state.terminal ? { terminal: state.terminal } : {}),
      ...(state.paused ? { paused: state.paused } : {}),
      lastN,
      summary: {
        replayedSteps: state.steps,
        replayedTools: state.messages.filter((message) => message.role === "tool").length,
        pendingCalls: state.pendingCalls.length,
      },
    };
  }

  /** 可回看的检查点：只含完整回合，首项是「运行开始」。 */
  checkpoints(runId: string): RunCheckpoint[] {
    const loaded = this.load(runId);
    return loaded ? completedCheckpoints(loaded.messages) : [];
  }

  /** 房间内最近的运行日志清单，按更新时间倒序。 */
  listRuns(): RunJournalSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".snapshot.json"));
    } catch {
      return [];
    }
    const runs: RunJournalSummary[] = [];
    for (const name of names) {
      const runId = name.slice(0, -".snapshot.json".length);
      if (!this.validRunId(runId)) continue;
      const raw = this.readJson(this.snapshotFile(runId));
      if (!raw || typeof raw !== "object") continue;
      const data = raw as Record<string, unknown>;
      const terminal = data["terminal"] as Record<string, unknown> | undefined;
      runs.push({
        runId,
        memberId: typeof data["memberId"] === "string" ? data["memberId"] : "",
        ...(typeof data["workItemId"] === "string" ? { workItemId: data["workItemId"] } : {}),
        createdAt: typeof data["createdAt"] === "number" ? data["createdAt"] : 0,
        updatedAt: typeof data["updatedAt"] === "number" ? data["updatedAt"] : 0,
        steps: typeof data["steps"] === "number" ? data["steps"] : 0,
        done: data["done"] === true,
        ...(terminal && (terminal["status"] === "ok" || terminal["status"] === "error" || terminal["status"] === "aborted")
          ? { status: terminal["status"] }
          : {}),
        ...(data["paused"] && typeof data["paused"] === "object" ? { paused: true } : {}),
      });
    }
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    return runs;
  }

  /**
   * 从某个检查点另起一条分支：保留前 N 个完整回合，丢掉其后历史，接上新的用户指令。
   * 原日志不动；新日志有独立 runId，后续运行只往新日志追加。
   */
  fork(sourceRunId: string, completedSteps: number, instruction: string): LoadedRunJournal | null {
    const source = this.load(sourceRunId);
    const note = instruction.trim();
    if (!source || !note) return null;
    const checkpoints = completedCheckpoints(source.messages);
    const wanted = Math.max(0, Math.floor(completedSteps));
    const boundary = checkpoints.find((checkpoint) => checkpoint.step === wanted) ?? checkpoints.at(-1)!;
    const messages: LlmMessage[] = [
      ...source.messages.slice(0, boundary.end),
      { role: "user", content: note },
    ];
    const runId = newId("run");
    const now = this.now();
    const snapshot: JournalSnapshotFile = {
      version: JOURNAL_VERSION,
      runId,
      roomId: source.roomId,
      memberId: source.memberId,
      createdAt: now,
      updatedAt: now,
      through: 0,
      initialMessages: source.initialMessages,
      messages,
      pendingCalls: [],
      steps: boundary.step,
      done: false,
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      this.writeJsonAtomic(this.snapshotFile(runId), snapshot);
      writeFileSync(this.tailFile(runId), "");
    } catch {
      return null;
    }
    return {
      runId,
      roomId: source.roomId,
      memberId: source.memberId,
      initialMessages: source.initialMessages,
      messages,
      pendingCalls: [],
      steps: boundary.step,
      done: false,
      lastN: 0,
      summary: {
        replayedSteps: boundary.step,
        replayedTools: source.messages
          .slice(0, boundary.end)
          .filter((message) => message.role === "tool").length,
        pendingCalls: 0,
      },
    };
  }

  /** 开始记录一轮运行；磁盘不可写时返回 null，运行本身不受影响。 */
  start(input: RunJournalCreateInput): RunJournalRecorder | null {
    if (!this.validRunId(input.runId)) return null;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.pruneIfDue();
    } catch {
      return null;
    }
    const resume = input.resumeFrom;
    const state = {
      messages: resume ? [...resume.messages] : [],
      pendingCalls: resume ? [...resume.pendingCalls] : [],
      steps: resume?.steps ?? 0,
      done: false,
    };
    const now = this.now();
    const snapshot: JournalSnapshotFile = {
      version: JOURNAL_VERSION,
      runId: input.runId,
      roomId: input.roomId,
      memberId: input.memberId,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      createdAt: now,
      updatedAt: now,
      through: resume?.lastN ?? 0,
      initialMessages: resume ? resume.initialMessages : input.initialMessages,
      messages: state.messages,
      pendingCalls: state.pendingCalls,
      steps: state.steps,
      done: false,
    };
    let n = resume?.lastN ?? 0;
    let sinceSnapshot = 0;
    let disabled = false;
    const tail = this.tailFile(input.runId);
    const snapshotPath = this.snapshotFile(input.runId);

    const writeSnapshot = (
      done: boolean,
      terminal?: RunJournalTerminal,
      paused?: { questionId: string; messageId: string },
    ): void => {
      const file: JournalSnapshotFile = {
        ...snapshot,
        updatedAt: this.now(),
        through: n,
        messages: state.messages,
        pendingCalls: state.pendingCalls,
        steps: state.steps,
        done,
        ...(terminal ? { terminal } : {}),
        ...(paused ? { paused: { ...paused, at: this.now() } } : {}),
      };
      this.writeJsonAtomic(snapshotPath, file);
      writeFileSync(tail, "");
      sinceSnapshot = 0;
    };

    if (!resume) {
      try {
        writeSnapshot(false);
      } catch {
        return null;
      }
    }

    const append = (entry: JournalEntry): void => {
      if (disabled) return;
      try {
        appendFileSync(tail, `${JSON.stringify(entry)}\n`);
        sinceSnapshot += 1;
        if (sinceSnapshot >= this.snapshotEvery) writeSnapshot(false);
      } catch {
        disabled = true;
      }
    };

    const recorder: RunJournalRecorder = {
      runId: input.runId,
      resumed: Boolean(resume),
      assistant: (step, content, calls) => {
        const entry: JournalAssistantEntry = {
          kind: "assistant",
          n: ++n,
          at: this.now(),
          step,
          content: clip(content),
          calls: safeCalls(calls),
        };
        state.messages.push({
          role: "assistant",
          content: entry.content,
          ...(entry.calls.length > 0 ? { toolCalls: entry.calls } : {}),
        });
        state.pendingCalls = [...entry.calls];
        state.steps = Math.max(state.steps, step + 1);
        append(entry);
      },
      pause: (info) => {
        if (state.done) return;
        if (disabled) return;
        try {
          writeSnapshot(false, undefined, info);
        } catch {
          // 快照失败不影响挂起本身；尾部日志仍能在下次启动时重建。
        }
      },
      toolResult: (step, call, content, status, extra) => {
        const entry: JournalToolEntry = {
          kind: "tool",
          n: ++n,
          at: this.now(),
          step,
          callId: call.id,
          name: call.name,
          content: clip(content),
          ok: status.ok,
          ...(status.code ? { code: status.code } : {}),
          ...(extra?.retries ? { retries: extra.retries } : {}),
        };
        state.messages.push({ role: "tool", toolCallId: call.id, content: entry.content });
        state.pendingCalls = state.pendingCalls.filter((candidate) => candidate.id !== call.id);
        append(entry);
      },
      finish: (result) => {
        if (state.done) return;
        state.done = true;
        state.pendingCalls = [];
        const entry: JournalTerminalEntry = {
          kind: "terminal",
          n: ++n,
          at: this.now(),
          ...result,
        };
        append(entry);
        if (disabled) return;
        try {
          writeSnapshot(true, result);
        } catch {
          // 快照失败不影响运行；下次启动读到没有终局的日志只会更保守地续跑。
        }
      },
    };
    return recorder;
  }

  /**
   * 保留策略：最近 maxRuns 份；已完成超过 7 天、未完成超过 24 小时的清掉。
   * 每分钟最多扫一次，避免每次运行都遍历目录。
   */
  prune(): number {
    let removed = 0;
    const now = this.now();
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((name) => name.endsWith(".snapshot.json"));
    } catch {
      return 0;
    }
    const entries: {
      runId: string;
      file: string;
      updatedAt: number;
      done: boolean;
      paused: boolean;
    }[] = [];
    for (const name of files) {
      const file = join(this.dir, name);
      const raw = this.readJson(file);
      if (!raw || typeof raw !== "object") continue;
      const data = raw as Record<string, unknown>;
      entries.push({
        runId: name.slice(0, -".snapshot.json".length),
        file,
        updatedAt: typeof data["updatedAt"] === "number" ? data["updatedAt"] : 0,
        done: data["done"] === true,
        paused: Boolean(data["paused"]),
      });
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    entries.forEach((entry, index) => {
      const retention = entry.done
        ? this.doneRetentionMs
        : entry.paused
          ? PAUSED_RETENTION_MS
          : STALE_RETENTION_MS;
      const stale = now - entry.updatedAt > retention;
      if (index < this.maxRuns && !stale) return;
      try {
        unlinkSync(entry.file);
        const tail = this.tailFile(entry.runId);
        if (existsSync(tail)) unlinkSync(tail);
        removed += 1;
      } catch {
        // 删除失败下次再试，不影响运行。
      }
    });
    return removed;
  }

  private pruneIfDue(): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    this.prune();
  }

  private readJson(file: string): unknown {
    try {
      if (!existsSync(file)) return null;
      if (statSync(file).size === 0) return null;
      return parseJson(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  private readTail(runId: string, through: number): JournalEntry[] {
    const file = this.tailFile(runId);
    let text: string;
    try {
      if (!existsSync(file)) return [];
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const entries: JournalEntry[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const entry = parseEntry(parseJson(line));
      if (entry && entry.n > through) entries.push(entry);
    }
    entries.sort((a, b) => a.n - b.n);
    return entries;
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  }
}
