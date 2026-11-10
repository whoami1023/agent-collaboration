/**
 * 维护巡检（移植 gbrain 的 maintenance audit 思路）：
 * 把散在三处「该处理但没人处理」的状态收进一份报告——
 * - 记忆：撤回 / 过期 / 已被取代的条目（读取时已自动排除，但需要人决定补写还是清理）；
 * - 召回：反复主动注入却从未被交付引用的条目（触发词过宽或事实过时的信号），以及账本体积；
 * - 任务：停滞、依赖缺失、负责人不在群里的卡片，和有验收条款却没有核验回执的完成态。
 *
 * 巡检默认只读；账本压缩必须显式传入保留条数，且压缩不可恢复。
 */

import type { ToolImpl } from "../agent/loop";
import { toolFailureText } from "../agent/tool-errors";
import type { RoomBus } from "../room/bus";
import type { TaskCard, TaskStatus } from "../core/types";
import type { Workboard } from "../workboard/board";
import {
  DEFAULT_COMPACT_KEEP,
  type RecallLedger,
  type RecallLedgerEvent,
} from "./recall-ledger";
import type { MemoryAuditReport, MemorySearchManager } from "./manager";

const DEFAULT_STALL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FINDINGS = 20;

export type TaskAuditIssue =
  | "stalled"
  | "missing_dependency"
  | "orphaned_owner"
  | "unverified_completion";

export interface TaskAuditFinding {
  id: string;
  title: string;
  status: TaskStatus;
  issue: TaskAuditIssue;
  detail: string;
}

export interface RecallUsageStat {
  path: string;
  startLine: number;
  entryId?: string;
  citation: string;
  volunteered: number;
  used: number;
  lastVolunteeredAt: number;
}

export interface MaintenanceReport {
  scannedAt: number;
  memory: MemoryAuditReport;
  recall: {
    events: number;
    volunteered: number;
    used: number;
    unused: RecallUsageStat[];
    compacted?: { kept: number; dropped: number };
  };
  tasks: {
    total: number;
    counts: Record<TaskAuditIssue, number>;
    findings: TaskAuditFinding[];
  };
  summary: string;
}

export interface MaintenanceScanOptions {
  memory: MemorySearchManager;
  board: Workboard;
  bus?: RoomBus;
  ledger?: RecallLedger;
  now?: number;
  /** 停滞阈值：doing/blocked 卡片超过这么久没更新算停滞。 */
  stallMs?: number;
  /** 传值才压缩账本（保留最近 N 条）；不传保持只读。 */
  compactLedgerTo?: number;
  maxFindings?: number;
}

function tallyEvents(events: readonly RecallLedgerEvent[]): {
  volunteered: number;
  used: number;
  stats: RecallUsageStat[];
} {
  let volunteered = 0;
  let used = 0;
  const byKey = new Map<string, RecallUsageStat>();
  for (const event of events) {
    const key = `${event.path}:${String(event.startLine)}`;
    const stat = byKey.get(key) ?? {
      path: event.path,
      startLine: event.startLine,
      ...(event.entryId ? { entryId: event.entryId } : {}),
      citation: event.citation,
      volunteered: 0,
      used: 0,
      lastVolunteeredAt: 0,
    };
    // 同一条目在不同轮次可能换了 citation 形态；保留最近一次账本里的写法。
    stat.citation = event.citation;
    if (event.entryId) stat.entryId = event.entryId;
    if (event.type === "volunteered") {
      volunteered += 1;
      stat.volunteered += 1;
      stat.lastVolunteeredAt = Math.max(stat.lastVolunteeredAt, event.ts);
    } else {
      used += 1;
      stat.used += 1;
    }
    byKey.set(key, stat);
  }
  return { volunteered, used, stats: [...byKey.values()] };
}

function auditTasks(params: {
  tasks: readonly TaskCard[];
  board: Workboard;
  bus?: RoomBus;
  now: number;
  stallMs: number;
}): { counts: Record<TaskAuditIssue, number>; findings: TaskAuditFinding[] } {
  const counts: Record<TaskAuditIssue, number> = {
    stalled: 0,
    missing_dependency: 0,
    orphaned_owner: 0,
    unverified_completion: 0,
  };
  const findings: TaskAuditFinding[] = [];
  const record = (task: TaskCard, issue: TaskAuditIssue, detail: string): void => {
    counts[issue] += 1;
    findings.push({ id: task.id, title: task.title, status: task.status, issue, detail });
  };
  const stallHours = Math.round(params.stallMs / (60 * 60 * 1000));
  for (const task of params.tasks) {
    const active = task.status === "doing" || task.status === "blocked";
    if (active && params.now - task.updatedAt >= params.stallMs) {
      record(task, "stalled", `已超过 ${stallHours} 小时没有更新（状态 ${task.status}）`);
    }
    const missingDeps = task.deps.filter((depId) => !params.board.get(depId));
    if (missingDeps.length > 0) {
      record(task, "missing_dependency", `依赖的任务不在看板上：${missingDeps.join("、")}`);
    }
    if (task.ownerId && params.bus && !params.bus.getMember(task.ownerId)) {
      record(task, "orphaned_owner", `负责人不在群成员里：${task.ownerId}`);
    }
    if (task.status === "done" && task.acceptance && !task.completion) {
      record(task, "unverified_completion", "有验收条款却缺少核验回执");
    }
  }
  return { counts, findings };
}

export async function runMaintenanceScan(options: MaintenanceScanOptions): Promise<MaintenanceReport> {
  const now = options.now ?? Date.now();
  const maxFindings = Math.max(1, Math.floor(options.maxFindings ?? DEFAULT_MAX_FINDINGS));
  const memory = await options.memory.auditEntries(now);

  const events = options.ledger ? await options.ledger.list(Number.MAX_SAFE_INTEGER) : [];
  const tallied = tallyEvents(events);
  const unused = tallied.stats
    .filter((stat) => stat.volunteered > 0 && stat.used === 0)
    .sort(
      (left, right) =>
        right.volunteered - left.volunteered ||
        right.lastVolunteeredAt - left.lastVolunteeredAt ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine,
    )
    .slice(0, maxFindings);
  const compacted =
    options.ledger && options.compactLedgerTo !== undefined
      ? await options.ledger.compact(options.compactLedgerTo)
      : undefined;

  const tasks = options.board.list();
  const taskAudit = auditTasks({
    tasks,
    board: options.board,
    ...(options.bus ? { bus: options.bus } : {}),
    now,
    stallMs: Math.max(1, options.stallMs ?? DEFAULT_STALL_MS),
  });
  const taskFindings = taskAudit.findings.slice(0, maxFindings);
  const unusedTotal = tallied.stats.filter((stat) => stat.volunteered > 0 && stat.used === 0).length;

  const summary = [
    `策展记忆 ${String(memory.entries)} 条：撤回 ${String(memory.retracted)}、过期 ${String(memory.stale)}、被取代 ${String(memory.superseded)}。`,
    `召回声呐：主动注入 ${String(tallied.volunteered)} 次、被交付引用 ${String(tallied.used)} 次，从未被引用 ${String(unusedTotal)} 条。`,
    `任务 ${String(tasks.length)} 张，问题 ${String(taskAudit.findings.length)} 处。`,
    compacted ? `召回账本已压缩：保留 ${String(compacted.kept)} 条，丢弃 ${String(compacted.dropped)} 条。` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    scannedAt: now,
    memory,
    recall: {
      events: events.length,
      volunteered: tallied.volunteered,
      used: tallied.used,
      unused,
      ...(compacted ? { compacted } : {}),
    },
    tasks: {
      total: tasks.length,
      counts: taskAudit.counts,
      findings: taskFindings,
    },
    summary,
  };
}

export interface MaintenanceToolOptions {
  memory: MemorySearchManager;
  board: Workboard;
  bus: RoomBus;
  ledger?: RecallLedger;
}

/** 参数校验错误统一走结构化工具错误契约，避免模型把输入问题当成巡检故障。 */
function inputError(message: string): string {
  return toolFailureText("invalid_argument", message, {
    next: "compact 传布尔值，keep 传正整数，stall_hours 传正数；或全部省略使用默认值。",
  });
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function readPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

export function buildMaintenanceTools(options: MaintenanceToolOptions): ToolImpl[] {
  return [
    {
      schema: {
        name: "maintenance_scan",
        description:
          "巡检工作区健康状态：撤回/过期/被取代的长期记忆、反复主动注入却从未被引用的召回、以及停滞或缺依赖/负责人/核验回执的任务卡。默认只读，只给报告；compact=true 时压缩召回账本（不可恢复）。用户要求整理记忆、定期维护，或怀疑记忆过时、任务卡住时使用。",
        parameters: {
          type: "object",
          properties: {
            compact: {
              type: "boolean",
              description: `是否压缩召回账本；默认 false。压缩前应得到用户确认`,
            },
            keep: {
              type: "integer",
              minimum: 1,
              description: `压缩后保留最近多少条召回事件，默认 ${DEFAULT_COMPACT_KEEP}`,
            },
            stall_hours: {
              type: "number",
              description: "进行中/受阻任务超过多少小时没更新算停滞，默认 24",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      execute: async (rawArgs) => {
        let compact: boolean | undefined;
        let keep: number | undefined;
        let stallHours: number | undefined;
        try {
          compact = readBoolean(rawArgs, "compact");
          keep = readPositiveInteger(rawArgs, "keep");
          const rawStall = rawArgs["stall_hours"];
          if (rawStall !== undefined && rawStall !== null) {
            if (typeof rawStall !== "number" || !Number.isFinite(rawStall) || rawStall <= 0) {
              throw new Error("stall_hours must be a positive number");
            }
            stallHours = rawStall;
          }
        } catch (error) {
          return inputError(error instanceof Error ? error.message : String(error));
        }
        if (compact === true && !options.ledger) {
          return toolFailureText("unavailable", "召回账本未接入，无法压缩", {
            next: "省略 compact，只跑只读巡检。",
          });
        }
        try {
          const report = await runMaintenanceScan({
            memory: options.memory,
            board: options.board,
            bus: options.bus,
            ...(options.ledger ? { ledger: options.ledger } : {}),
            ...(compact === true && options.ledger ? { compactLedgerTo: keep ?? DEFAULT_COMPACT_KEEP } : {}),
            ...(stallHours !== undefined ? { stallMs: stallHours * 60 * 60 * 1000 } : {}),
          });
          return JSON.stringify({ status: "ok", ...report });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toolFailureText("tool_failed", `维护巡检失败：${message}`, {
            next: "通常说明记忆文件或账本读取异常；先重试一次，仍失败就把原文报给用户。",
            verify: "memory_search 能返回结果、task_list 能列出任务卡，说明主链路正常。",
          });
        }
      },
    },
  ];
}
