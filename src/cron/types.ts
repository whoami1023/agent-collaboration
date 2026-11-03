// Scheduled tasks (定时任务).
// Ported and adapted from OpenClaw src/cron (https://github.com/openclaw/openclaw),
// MIT License — Copyright (c) 2026 OpenClaw Foundation. Permission is hereby granted,
// free of charge, to any person obtaining a copy of this software and associated
// documentation files, to deal in the Software without restriction, including without
// limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, subject to inclusion of this permission notice in
// all copies or substantial portions of the Software.
//
// Host-specific parts of OpenClaw's cron (worker threads, BroadcastChannel, SQLite
// receipt tables, IM channel/webhook delivery, declaration keys, on-exit/stream/event
// triggers) are intentionally not ported: this app has one Node process, per-user JSON
// workspaces and a group chat instead of channels. Everything that defines *when a job
// fires and how its outcome is accounted* is kept.

export const CRON_STORE_VERSION = 1;
/** 触发群聊消息的发送者 ID：定时任务不是用户，也不走系统消息（系统消息不唤醒成员）。 */
export const CRON_SENDER_ID = "cron";

export const DEFAULT_MAX_CONCURRENT_CRON_RUNS = 8;
/** 一个连续错误次数对应的重试间隔，取 min(n-1, len-1)（OpenClaw DEFAULT_ERROR_BACKOFF_SCHEDULE_MS）。 */
export const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000,
] as const;
export const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;
export const DEFAULT_STARTUP_CATCHUP_STAGGER_MS = 5_000;
export const DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 120_000;
export const DEFAULT_FAILURE_ALERT_AFTER = 2;
export const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 60_000;
export const DEFAULT_AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 10;
export const DEFAULT_AUTO_DISABLE_AFTER_SCHEDULE_ERRORS = 3;
/** 重启打断上一次运行的记账文案。 */
export const STARTUP_INTERRUPTED_ERROR = "定时任务被服务重启打断";
/** 整条回复只有这个词时视为静默：群里不发，但运行照常记账。 */
export const CRON_SILENT_REPLY_TOKEN = "NO_REPLY";

export type CronSchedule =
  /** 一次性任务：epoch 毫秒或 ISO 字符串。 */
  | { kind: "at"; at: string }
  /** 固定间隔：以 anchorMs 为基准对齐，缺省基准是创建时刻。 */
  | { kind: "every"; everyMs: number; anchorMs?: number }
  /** croner 表达式；staggerMs 为整点错峰窗口，显式 0 表示准点。 */
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };

export interface CronActiveHours {
  /** "HH:MM"。 */
  start: string;
  /** "HH:MM"，只允许 "24:00" 作为终点。 */
  end: string;
  /** "user"（账号设置时区）/ "local"（服务进程时区）/ IANA 时区名。 */
  timezone?: string;
}

export type CronPayload =
  /** 往群里投一条无人值守指令，唤醒目标成员（默认主智能体）。 */
  | { kind: "agentTurn"; message: string; targetMemberId?: string }
  /** 在文件工作区直接跑命令：argv 不经过 shell。 */
  | { kind: "command"; argv: string[]; cwd?: string; timeoutSeconds?: number };

/** 作业的作者：群聊里的智能体创建的任务要能追溯回它，子成员的作用域也按这份归属判定。 */
export interface CronAuthorship {
  memberId: string;
  memberName: string;
}

export interface CronJob {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  activeHours?: CronActiveHours;
  /** 一次性任务跑成功后是否删除；缺省 true（OpenClaw deleteAfterRun）。 */
  deleteAfterRun?: boolean;
  createdBy?: CronAuthorship;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CronAutoDisabled {
  reason: "consecutive-failures" | "schedule-errors";
  atMs: number;
  consecutiveErrors: number;
}

/** 运行期状态：与作业定义分文件存放，热路径只重写这份。 */
export interface CronJobState {
  nextRunAtMs?: number;
  scheduleActivatedAtMs?: number;
  runningAtMs?: number;
  queuedAtMs?: number;
  runningReceiptId?: string;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastMeaningfulResult?: boolean;
  lastDurationMs?: number;
  lastError?: string;
  lastErrorReason?: string;
  lastSummary?: string;
  consecutiveErrors: number;
  consecutiveSkipped: number;
  scheduleErrorCount: number;
  autoDisabled?: CronAutoDisabled;
  lastFailureAlertAtMs?: number;
  /** 启动补齐：错峰推迟后的实际触发时刻，用于记账与去重。 */
  startupCatchupAtMs?: number;
}

export type CronRunStatus = "ok" | "error" | "skipped";
export type CronRunTrigger = "schedule" | "manual" | "startup";

export interface CronRunRecord {
  id: string;
  jobId: string;
  jobName: string;
  ownerId: string;
  trigger: CronRunTrigger;
  /** 该次运行归属的调度槽位；手动运行为 undefined（不消耗槽位）。 */
  scheduledSlotMs?: number;
  status: CronRunStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** 静默（NO_REPLY）时不写群消息，摘要仍记账。 */
  quiet: boolean;
  summary?: string;
  error?: string;
  nextRunAtMs?: number;
  memberId?: string;
}

/** 一次无人值守群聊投递的终局：由 Orchestrator.runScheduledTurn 观测被唤醒成员那一轮的终局事件得到。 */
export interface CronTurnOutcome {
  status: "ok" | "error" | "aborted" | "timeout" | "no-target";
  /** 成员这一轮的回复原文（静默标记也在里面，由 resolveSilentReply 判）。 */
  text: string;
  memberId?: string;
  error?: string;
}
