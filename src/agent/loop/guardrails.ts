/**
 * 工具调用护栏：把「原地转圈」从靠模型自觉变成运行期事实。
 *
 * 移植自 Hermes `agent/tool_guardrails.py`。原来的循环只知道「整批调用签名连续相同」，
 * 漏掉三类真实故障：换了顺序的同一组调用（A,B → B,A）、参数相同但结果也相同的空转
 * （读了又读同一个文件）、以及同一个工具反复失败还一路试下去。
 *
 * 三条设计约束：
 * - **只观察，不改工具行为**：warn 追加到工具结果里，block 变成一条合成结果，
 *   halt 才结束本轮。角色交替（每个 tool_call 必须有 tool 结果）始终不破。
 * - **护栏自己的拒绝不计入失败**，否则一次拦截会污染下一条调用的判断。
 * - **限流类失败不算「同样参数又失败一次」**：等冷却后重试同一调用是正确行为。
 */
import { createHash } from "node:crypto";

export type ToolClass = "idempotent" | "mutating" | "failure-tolerant";

/**
 * 变更型工具的一次成功会清空失败计数（重试是「新一次实验」而不是延续）；
 * 容错型工具（跑命令、跑脚本）的不同失败本身就是排查过程，不参与「同一工具连续失败」的升级。
 */
const TOOL_CLASSES: Record<string, ToolClass> = {
  file_list: "idempotent",
  file_read: "idempotent",
  task_list: "idempotent",
  room_history: "idempotent",
  memory_search: "idempotent",
  memory_get: "idempotent",
  use_skill: "idempotent",
  read_skill_file: "idempotent",
  web_search: "idempotent",
  web_fetch: "idempotent",
  file_write: "mutating",
  memory_append: "mutating",
  task_create: "mutating",
  task_dispatch: "mutating",
  task_update: "mutating",
  task_attach_artifact: "mutating",
  cron: "mutating",
  run_command: "failure-tolerant",
  run_skill_script: "failure-tolerant",
};

export function toolClass(name: string): ToolClass {
  return TOOL_CLASSES[name] ?? "idempotent";
}

const EXACT_ARG_FAIL_WARN = 2;
const EXACT_ARG_FAIL_BLOCK = 5;
/** 容错型工具拿不到「同参数失败」的宽容档：同一条命令失败三次就该换法子。 */
const EXACT_ARG_FAIL_BLOCK_TOLERANT = 3;
const SAME_TOOL_FAIL_WARN = 3;
const SAME_TOOL_FAIL_HALT = 8;
const NO_PROGRESS_WARN = 2;
const NO_PROGRESS_BLOCK = 5;
/** 重复结果引用桩：短结果是有效信号，长结果是纯粹的上下文浪费。 */
const DEDUPE_MIN_BYTES = 512;
const BATCH_HISTORY = 64;

export type GuardrailVerdict =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "halt"; reason: string };

interface CallState {
  fails: number;
  noProgress: number;
  lastResultHash: string;
  warned: boolean;
}

interface BatchCycleState {
  repeats: number;
  period: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** 参数规范化：键排序 + 紧凑分隔符，否则同一调用的两种 JSON 写法会被当成两次不同尝试。 */
function canonicalArgs(args: Record<string, unknown>): string {
  const entries = Object.keys(args)
    .sort()
    .map((key) => `${key}:${stableStringify(args[key])}`);
  return `{${entries.join(",")}}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

const FAILURE_PREFIXES = [
  "错误：",
  "工具执行失败",
  "更新失败",
  "写入失败",
  "读取失败",
  "登记失败",
  "启动失败",
  "执行失败",
  "调用失败",
];

const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|限流|请求过于频繁/i;

/** 命令退出码非零算失败（同一条命令重跑没意义），但按容错档处理。 */
function nonzeroExitCode(text: string): boolean {
  const match = /退出码：(\d+)/.exec(text);
  return match !== null && match[1] !== "0";
}

export function looksLikeFailure(text: string): boolean {
  const head = text.trimStart().slice(0, 16);
  return FAILURE_PREFIXES.some((prefix) => head.startsWith(prefix)) || nonzeroExitCode(text);
}

export class ToolGuardrails {
  private readonly calls = new Map<string, CallState>();
  private readonly failuresByTool = new Map<string, number>();
  private readonly resultSeen = new Map<string, { count: number; preview: string; atCall: number }>();
  private readonly batches: string[] = [];
  private callOrder = 0;
  private cycle: BatchCycleState | null = null;

  /** 护栏自己发出的拒绝：不能再被记成一次失败。 */
  recordRefusal(): void {
    this.callOrder += 1;
  }

  private state(signature: string): CallState {
    const existing = this.calls.get(signature);
    if (existing) return existing;
    const created: CallState = { fails: 0, noProgress: 0, lastResultHash: "", warned: false };
    this.calls.set(signature, created);
    return created;
  }

  /** 执行前拦截：只拦「同样参数已经失败到没意义」和「整批在循环」两类。 */
  beforeCall(name: string, args: Record<string, unknown>): GuardrailVerdict {
    const signature = `${name}|${canonicalArgs(args)}`;
    const state = this.state(signature);
    const cls = toolClass(name);
    const blockAt = cls === "failure-tolerant" ? EXACT_ARG_FAIL_BLOCK_TOLERANT : EXACT_ARG_FAIL_BLOCK;
    if (state.fails >= blockAt) {
      return {
        action: "block",
        reason:
          `错误：${name} 用完全相同的参数已经连续失败 ${state.fails} 次，这一轮不再执行这次调用。` +
          "重复同样的调用不会得到不同结果。请先判断失败原因：换一个参数/路径/方法，" +
          "或者如实说明卡在哪一步、需要用户做什么。",
      };
    }
    if (state.noProgress >= NO_PROGRESS_BLOCK) {
      return {
        action: "block",
        reason:
          `错误：${name} 同样的参数已经拿回 ${state.noProgress + 1} 次完全相同的内容，不再执行。` +
          "重复读同一份资料不会新增信息。请基于已经读到的内容往下走，或换一个查询目标。",
      };
    }
    if (this.cycle && this.cycle.repeats >= 3) {
      return {
        action: "halt",
        reason:
          `检测到工具调用在循环：最近反复执行同一组 ${this.cycle.period} 个调用且没有新进展，已中止本次运行`,
      };
    }
    return { action: "allow" };
  }

  /** 一批调用确定后、执行前调用：识别 A,B,A,B 这类「重排但没进展」的批次循环。 */
  beforeBatch(calls: { name: string; args: Record<string, unknown> }[]): GuardrailVerdict {
    const signature = digest(
      calls.map((call) => `${call.name}|${canonicalArgs(call.args)}`).join(";"),
    );
    this.batches.push(signature);
    if (this.batches.length > BATCH_HISTORY) this.batches.shift();
    const cycle = detectCycle(this.batches);
    this.cycle = cycle;
    if (cycle && cycle.repeats >= 3) {
      // 到这一步模型已经吃过一次整批拦截还是原样重来：继续拦只会白耗步数，直接中止本轮。
      return {
        action: "halt",
        reason:
          `检测到工具调用在循环：最近反复执行同一组 ${cycle.period} 个调用且没有新进展，已中止本次运行`,
      };
    }
    if (cycle && cycle.repeats >= 2 && cycle.period >= 2) {
      return {
        action: "block",
        reason:
          `错误：最近 ${cycle.repeats} 轮都在重复同一组 ${cycle.period} 个工具调用（内容没有变化），` +
          "这一轮不再执行。请改用不同的信息源或参数，或者直接向用户说明当前进展与卡点。",
      };
    }
    return { action: "allow" };
  }

  /**
   * 执行后记账。返回送进上下文的内容（可能被换成重复结果引用桩）与追加的提醒。
   */
  observe(
    name: string,
    args: Record<string, unknown>,
    raw: string,
    options: { refused?: boolean } = {},
  ): { content: string; note?: string; halt?: string } {
    this.callOrder += 1;
    if (options.refused) return { content: raw };
    const signature = `${name}|${canonicalArgs(args)}`;
    const state = this.state(signature);
    const cls = toolClass(name);
    const resultHash = digest(raw);
    const failed = looksLikeFailure(raw);
    const rateLimited = RATE_LIMIT_RE.test(raw);
    const notes: string[] = [];
    let halt: string | undefined;

    if (failed) {
      if (!rateLimited) state.fails += 1;
      const toolFails = (this.failuresByTool.get(name) ?? 0) + 1;
      this.failuresByTool.set(name, rateLimited ? 0 : toolFails);
      if (state.fails === EXACT_ARG_FAIL_WARN && cls !== "failure-tolerant") {
        notes.push("提醒：这次调用与上一次参数完全相同且同样失败，重跑不会改变结果。");
      }
      if (state.fails >= EXACT_ARG_FAIL_WARN && toolFails >= SAME_TOOL_FAIL_WARN) {
        notes.push(
          `提醒：${name} 本轮已连续失败 ${toolFails} 次。请停止在同一个方向上试错，` +
            "改换方法（换工具、换路径、换来源）或如实报告受阻。",
        );
      }
      if (cls !== "failure-tolerant" && toolFails >= SAME_TOOL_FAIL_HALT) {
        halt = `工具 ${name} 本轮连续失败 ${toolFails} 次，已中止本次运行（继续试下去只会重复同样的错误）`;
      }
    } else {
      state.fails = 0;
      this.failuresByTool.set(name, 0);
      if (cls === "mutating") {
        // 一次成功的变更说明「新实验」开始了：把这一轮攒下的失败痕迹清掉。
        this.failuresByTool.clear();
      }
      if (cls === "idempotent" && state.lastResultHash === resultHash) {
        state.noProgress += 1;
        if (state.noProgress === NO_PROGRESS_WARN) {
          notes.push(
            "提醒：这次调用与上次参数相同、返回内容也完全相同——没有新进展。" +
              "请基于已读到的内容继续，或换一个查询目标。",
          );
        }
      } else {
        state.noProgress = 0;
      }
      state.lastResultHash = resultHash;
    }

    const deduped = this.dedupe(name, raw, resultHash);
    if (deduped.stub) {
      notes.unshift(deduped.stub);
    }
    return {
      content: deduped.content,
      ...(notes.length > 0 ? { note: notes.join("\n") } : {}),
      ...(halt ? { halt } : {}),
    };
  }

  /** 第 2 次起把逐字相同的长结果换成引用桩：省上下文，也让模型看清「这次没拿到新东西」。 */
  private dedupe(name: string, raw: string, hash: string): { content: string; stub?: string } {
    if (raw.length === 0) return { content: raw };
    const seen = this.resultSeen.get(hash);
    if (!seen) {
      this.resultSeen.set(hash, {
        count: 1,
        preview: raw.slice(0, 120),
        atCall: this.callOrder,
      });
      return { content: raw };
    }
    seen.count += 1;
    if (Buffer.byteLength(raw, "utf8") < DEDUPE_MIN_BYTES) return { content: raw };
    return {
      content:
        `（${name} 的返回与本轮第 ${seen.atCall} 次调用逐字相同，已省略 ${
          Buffer.byteLength(raw, "utf8")
        } 字节。需要重看请说「回看第 ${seen.atCall} 次调用的结果」。）`,
      stub: `提醒：这次调用得到的是重复内容（第 ${seen.count} 次），已用引用替代以节省上下文。`,
    };
  }
}

/**
 * 在批次签名序列里找周期 2–4 的重复段。
 * 只看紧邻的尾部，避免把「很久以前做过同样的事」误判成循环。
 */
function detectCycle(batches: readonly string[]): BatchCycleState | null {
  for (let period = 2; period <= 4; period += 1) {
    let repeats = 0;
    const needed = period * 2;
    if (batches.length < needed) continue;
    const tail = batches.slice(-needed);
    const firstHalf = tail.slice(0, period);
    const secondHalf = tail.slice(period);
    if (firstHalf.every((value, index) => value === secondHalf[index])) {
      repeats = 2;
      // 往前再数几轮，估计到底重复了几次（用于 warn → block → halt 的升级）。
      for (let start = batches.length - needed - period; start >= 0; start -= period) {
        const earlier = batches.slice(start, start + period);
        if (earlier.every((value, index) => value === firstHalf[index])) repeats += 1;
        else break;
      }
      return { repeats, period };
    }
  }
  return null;
}
