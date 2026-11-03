// Ported and adapted from OpenClaw src/cron/store/scheduler-actor.worker.ts +
// src/cron/service/{timer-execution,timer-outcomes,timer-job-runner,run-queue,startup-run-repair,
// failure-alerts,auto-disable}.ts (MIT License — Copyright (c) 2026 OpenClaw Foundation).
//
// 结构照搬 OpenClaw 的调度器：一个单发 setTimeout 链（一次最多睡 60 秒，好让挂起/时钟跳变被发现）
// → 每次唤醒先算「该跑哪些作业」（正常到期 / 启动补齐 / 时钟前跳补齐）→ 按并发上限排队执行 →
// 跑完把终态记进作业状态与运行历史，再算下一次触发 → 重新武装定时器。
//
// 与 OpenClaw 的三处必要差异（都不是简化，是宿主不同）：
// 1. 「投递」在本项目是群聊：agentTurn 的回复由成员自己发进作战室，静默（NO_REPLY）算投递被抑制
//    但仍算成功；command 的输出由这里代成一条系统消息。
// 2. 状态写在 CronStore 的 JSON 文件里而不是 SQLite 事务，所以没有 worker 广播、receipt 表、
//    grant generation 与 post-commit publication 那一层。
// 3. 每个账号是一个独立的 CronHost（相当于 OpenClaw 的一个 storeKey），并发上限按账号算；
//    账号没有加载好的工作区时按「ownerless」记账为 skipped，而不是凭空造一个运行。

import { newId } from "../core/ids";
import { SYSTEM_ID } from "../core/types";
import { errorMessage } from "./util";
import { CronStore, emptyCronJobState } from "./store";
import { CronRunHistory, type CronRunQuery } from "./history";
import {
  CRON_LIMITS,
  CronError,
  mergeCronDefinition,
  normalizeCronInput,
  triggerChanged,
  type NormalizedCronInput,
} from "./normalize";
import {
  applyOutcomeStreaks,
  errorBackoffMs,
  resolveCronCompletionStatus,
  type CronDeliveryStatus,
} from "./completion-status";
import { buildCronCommandBody, capTerminalReply, resolveSilentReply } from "./run-prompt";
import { validateCronScheduleTimestamp } from "./validate-timestamp";
import { runCronCommand } from "./command-runner";
import { MAX_CRON_TIMER_DELAY_MS, MIN_REFIRE_GAP_MS } from "./timer-constants";
import {
  DEFAULT_AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  DEFAULT_FAILURE_ALERT_AFTER,
  DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
  DEFAULT_MAX_CONCURRENT_CRON_RUNS,
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_STARTUP_CATCHUP_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  STARTUP_INTERRUPTED_ERROR,
  type CronAuthorship,
  type CronJob,
  type CronJobState,
  type CronRunRecord,
  type CronRunStatus,
  type CronRunTrigger,
  type CronTurnOutcome,
} from "./types";
import type { CronHost } from "./host";
import {
  buildAutoDisabled,
  computeJobNextRunAtMs,
  describeSchedule,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  isRunnableJob,
  isTimeScheduledJob,
  isWithinActiveHours,
  needsTimerMaintenance,
  normalizeConsecutiveErrors,
  recomputeJobNextRunAtMs,
  resolveCronRestartRetryAtMs,
  resolveManualOneShotOccurrenceAtMs,
  resolveOneShotReplacementAtMs,
  shouldAutoDisableAfterRunFailure,
  shouldAutoDisableScheduleErrors,
  type TimedCronJob,
} from "./jobs-scheduling";

/** 一次性作业落在活跃时段外：不消耗这次 occurrence，一分钟后重新核对。 */
const ACTIVE_HOURS_RETRY_MS = 60_000;
/** 与 OpenClaw DEFAULT_MAX_TRANSIENT_RETRIES 一致：一次性作业的快速重试预算。 */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

export type CronServiceEvent =
  | { type: "job"; ownerId: string; job: CronJob; state: CronJobState }
  | { type: "job-removed"; ownerId: string; jobId: string }
  | { type: "run"; ownerId: string; run: CronRunRecord };

export interface CronJobView {
  job: CronJob;
  state: CronJobState;
  lastRun?: CronRunRecord;
}

export interface CronServiceDeps {
  store: CronStore;
  history: CronRunHistory;
  /** 账号 → 作战室；返回 undefined 表示这个账号当前没有加载好的工作区。 */
  getHost(ownerId: string): CronHost | undefined;
  nowMs?(): number;
  onEvent?(event: CronServiceEvent): void;
  logger?(message: string, level?: "info" | "warn" | "error"): void;
}

type StartupOverflow = {
  catchupAtMs: number;
  delayMs: number;
  lastRunAtMs?: number;
};

interface PayloadOutcome {
  status: CronRunStatus;
  summary?: string;
  error?: string;
  /** 静默（NO_REPLY）：本轮群里没发消息。 */
  quiet?: boolean;
  /** 回复是否落到了群里；command payload 没有这个概念。 */
  delivered?: boolean;
  memberId?: string;
  /** 永久失败（可执行文件不存在等）：一次性作业直接停用。 */
  permanent?: boolean;
  /** 活跃时段外、或群里还没有投递对象而跳过的一次性作业要保住这次 occurrence。 */
  deferOccurrence?: boolean;
}

interface RunResult extends PayloadOutcome {
  startedAt: number;
  endedAt: number;
  trigger: CronRunTrigger;
  slot?: number;
  /** 手动运行按「借用」处理：不消耗调度槽位。 */
  preserveSchedule?: boolean;
  interruptedByRestart?: boolean;
}

export class CronService {
  private timer?: NodeJS.Timeout;
  private running = false;
  /** 本进程正在执行的作业 ID（对应 OpenClaw 的 activeJobMarkers）。 */
  private readonly activeIds = new Set<string>();
  private readonly runningPerOwner = new Map<string, number>();
  private pending: Array<{ timed: TimedCronJob; trigger: CronRunTrigger; slot?: number }> = [];
  private lastWallMs?: number;
  private lastMonotonicMs?: number;
  private wakeAtMs?: number;
  private catchupNeeded = false;
  private startupOverflow = new Map<string, StartupOverflow>();
  /** 启动立即批次里的作业：整批结算完才放行 overflow。 */
  private startupImmediate = new Set<string>();
  private loadError?: string;

  constructor(private readonly deps: CronServiceDeps) {}

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private log(message: string, level: "info" | "warn" | "error" = "info"): void {
    this.deps.logger?.(message, level);
  }

  get loaded(): boolean {
    return this.running;
  }

  get lastLoadError(): string | undefined {
    return this.loadError;
  }

  // ---------------------------------------------------------------- 生命周期

  async start(): Promise<void> {
    if (this.running) return;
    const loaded = await this.deps.store.load().catch((err: unknown) => {
      this.loadError = errorMessage(err);
      throw err;
    });
    if (loaded.rejected > 0) {
      this.log(`定时任务有 ${loaded.rejected} 条定义不合法，已隔离到 crons.rejected-*.json`, "warn");
    }
    await this.deps.history.load().catch((err: unknown) => {
      this.loadError = errorMessage(err);
    });
    this.running = true;
    await this.repairInterruptedRuns();
    // 缺排期的启用作业交给第一轮 tick 的维护带去补算：这里再算一遍会把同一次调度错误记成两次。
    this.tick({ starting: true });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = false;
    this.pending = [];
    this.catchupNeeded = false;
    for (const jobId of [...this.manualRuns.keys()]) this.dropManualRuns(jobId);
  }

  async flush(): Promise<void> {
    await this.deps.store.flush();
    await this.deps.history.flush();
  }

  /** 上一次进程退出时还在跑的运行：记账为被打断，重新武装到一个「补偿时刻」，不重复计数失败。 */
  private async repairInterruptedRuns(): Promise<void> {
    const nowMs = this.now();
    for (const job of this.deps.store.listJobs()) {
      const state = this.deps.store.getState(job.id);
      const startedAt = state.runningAtMs ?? state.queuedAtMs;
      if (startedAt === undefined) continue;
      const timed: TimedCronJob = { job, state };
      // OpenClaw 的 replacement 口径：一次性任务只有「槽位还在那次运行之后」才保得住；
      // 周期性任务被打断的这轮按退避尽快重来，而不是死等下一个自然槽位（那可能已经晚了整整一个周期）。
      const restartRetryAtMs = resolveCronRestartRetryAtMs(timed, startedAt, nowMs);
      const replacementAtMs =
        resolveOneShotReplacementAtMs(timed, startedAt) ?? restartRetryAtMs;
      timed.state.runningAtMs = undefined;
      timed.state.queuedAtMs = undefined;
      timed.state.runningReceiptId = undefined;
      timed.state.lastRunAtMs = startedAt;
      timed.state.lastRunStatus = "error";
      timed.state.lastDurationMs = Math.max(0, nowMs - startedAt);
      timed.state.lastError = STARTUP_INTERRUPTED_ERROR;
      timed.state.nextRunAtMs = replacementAtMs;
      timed.state.startupCatchupAtMs =
        restartRetryAtMs !== undefined && restartRetryAtMs === replacementAtMs
          ? replacementAtMs
          : undefined;
      job.updatedAtMs = nowMs;
      // 跑没跑过说不清的一次性任务绝不重放，直接停用；补偿时刻也算不出来时按新调度补算。
      if (job.schedule.kind === "at" && replacementAtMs === undefined) job.enabled = false;
      if (isJobEnabled(job) && timed.state.nextRunAtMs === undefined) {
        const result = recomputeJobNextRunAtMs(timed, nowMs);
        if (result.scheduleError) this.recordScheduleError(timed, result.scheduleError);
      }
      await this.deps.store.upsertJob(job);
      await this.deps.store.setState(job.id, timed.state);
      await this.deps.history.append({
        id: newId("cronrun"),
        jobId: job.id,
        jobName: job.name,
        ownerId: job.ownerId,
        trigger: "startup",
        status: "error",
        startedAt,
        endedAt: nowMs,
        durationMs: timed.state.lastDurationMs,
        quiet: true,
        error: capTerminalReply(STARTUP_INTERRUPTED_ERROR),
        nextRunAtMs: timed.state.nextRunAtMs,
      });
      this.emitRun(job.ownerId, job.id);
      this.notifyHost(
        job.ownerId,
        `定时任务「${job.name}」上一次运行被服务重启打断，已重新武装${
          hasScheduledNextRunAtMs(timed.state.nextRunAtMs)
            ? `，下一次 ${new Date(timed.state.nextRunAtMs).toLocaleString("zh-CN")}`
            : "（当前已停用）"
        }。`,
      );
    }
  }

  // ---------------------------------------------------------------- 定时器

  private arm(nowMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeAtMs = undefined;
    let nextWake: number | undefined;
    let anyEnabled = false;
    for (const job of this.deps.store.listJobs()) {
      if (!isJobEnabled(job) || !isTimeScheduledJob(job)) continue;
      anyEnabled = true;
      const state = this.deps.store.getState(job.id);
      if (
        !this.activeIds.has(job.id) &&
        typeof state.queuedAtMs !== "number" &&
        typeof state.runningAtMs !== "number" &&
        !this.startupOverflowWaits(job.id, state) &&
        hasScheduledNextRunAtMs(state.nextRunAtMs)
      ) {
        nextWake = Math.min(nextWake ?? Number.POSITIVE_INFINITY, state.nextRunAtMs);
      }
    }
    if (!anyEnabled) return;
    const rawDelay = nextWake === undefined ? MAX_CRON_TIMER_DELAY_MS : Math.max(0, nextWake - nowMs);
    const wakeAtMs = nowMs + (rawDelay === 0 ? MIN_REFIRE_GAP_MS : rawDelay);
    this.wakeAtMs = wakeAtMs;
    // 睡到下一次触发，但最多 60 秒：挂起与系统时钟跳变要能被自己发现。
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.wakeAtMs !== undefined && this.now() < this.wakeAtMs) {
        this.arm(this.now());
        return;
      }
      this.tick();
    }, Math.min(Math.max(0, wakeAtMs - nowMs), MAX_CRON_TIMER_DELAY_MS));
    this.timer.unref();
  }

  /** 改过作业之后立刻重排：新建一个 30 秒后的任务不该等到下一个 60 秒心跳才被发现。 */
  rearm(): void {
    if (!this.running) return;
    this.arm(this.now());
  }

  /** 一次心跳：补齐判定 → 选择到期作业 → 排队执行 → 维护 → 重新武装。 */
  tick(options: { starting?: boolean; skipJobIds?: string[] } = {}): void {
    if (!this.running) return;
    const nowMs = this.now();
    const monotonicMs = performance.now();
    const elapsedWall = this.lastWallMs === undefined ? 0 : nowMs - this.lastWallMs;
    const elapsedMonotonic = this.lastMonotonicMs === undefined ? 0 : monotonicMs - this.lastMonotonicMs;
    this.catchupNeeded ||=
      elapsedWall - elapsedMonotonic > MIN_REFIRE_GAP_MS ||
      (this.wakeAtMs !== undefined && nowMs > this.wakeAtMs + MIN_REFIRE_GAP_MS);
    const forwardJump = this.catchupNeeded;

    this.settleStartupBatch(nowMs);

    const timedList = this.timedJobs();
    let candidates: TimedCronJob[] = [];
    if (options.starting || forwardJump) {
      candidates = this.boundedCatchup(timedList, nowMs, options);
    } else {
      candidates = timedList.filter(
        (timed) =>
          !this.startupOverflowWaits(timed.job.id, timed.state) &&
          isRunnableJob({
            timed,
            nowMs,
            allowCronMissedRunByLastRun: true,
            activeInProcess: this.activeIds.has(timed.job.id),
          }),
      );
    }

    for (const timed of candidates) {
      const slot = timed.state.nextRunAtMs;
      const host = this.deps.getHost(timed.job.ownerId);
      if (!host) {
        // OpenClaw 的 ownerless 记账：没有可投递的会话就不跑，但要留下痕迹并推进调度。
        void this.recordOwnerlessSkipped({ timed, trigger: "schedule", slot }, nowMs);
        continue;
      }
      this.enqueue({
        timed,
        trigger:
          slot !== undefined && timed.state.startupCatchupAtMs === slot ? "startup" : "schedule",
        slot,
      });
    }

    this.settleOverflowBookkeeping();
    void this.maintain(timedList, nowMs);
    this.lastWallMs = nowMs;
    this.lastMonotonicMs = monotonicMs;
    this.catchupNeeded = false;
    this.arm(nowMs);
  }

  private timedJobs(): TimedCronJob[] {
    return this.deps.store.listJobs().map((job) => ({ job, state: this.deps.store.getState(job.id) }));
  }

  private timedOf(jobId: string): TimedCronJob | undefined {
    const job = this.deps.store.getJob(jobId);
    if (!job) return undefined;
    return { job, state: this.deps.store.getState(job.id) };
  }

  /** 启动补齐（OpenClaw boundedCatchup）：漏跑按最紧急排序，最多立即跑 5 个，其余错峰排队；
   *  需要模型调用的漏跑整批推到 120 秒之后，避免服务刚起来就被历史任务打满。 */
  private boundedCatchup(
    timedList: TimedCronJob[],
    nowMs: number,
    options: { skipJobIds?: string[] },
  ): TimedCronJob[] {
    const skipped = new Set(options.skipJobIds ?? []);
    const missed: TimedCronJob[] = [];
    for (const timed of timedList) {
      const { job, state } = timed;
      if (
        !isJobEnabled(job) ||
        skipped.has(job.id) ||
        this.startupOverflowWaits(job.id, state) ||
        this.activeIds.has(job.id)
      ) {
        continue;
      }
      if (typeof state.runningAtMs === "number" || typeof state.queuedAtMs === "number") continue;
      // 退避窗口内的漏跑：把槽位挪到退避到期，而不是立刻补一次注定失败的重试。
      if (job.schedule.kind === "cron" && state.lastRunStatus === "error") {
        const backoff = state.lastRunAtMs
          ? state.lastRunAtMs +
            Math.max(0, state.lastDurationMs ?? 0) +
            errorBackoffMs(normalizeConsecutiveErrors(state.consecutiveErrors), DEFAULT_ERROR_BACKOFF_SCHEDULE_MS)
          : undefined;
        if (backoff !== undefined && nowMs < backoff && state.nextRunAtMs !== backoff) {
          state.nextRunAtMs = backoff;
          void this.deps.store.setState(job.id, state);
          continue;
        }
      }
      if (
        !isRunnableJob({
          timed,
          nowMs,
          skipAtIfAlreadyRan: true,
          allowCronMissedRunByLastRun: true,
          activeInProcess: false,
        })
      ) {
        continue;
      }
      missed.push(timed);
    }
    if (missed.length === 0) return [];
    missed.sort(
      (left, right) => (left.state.nextRunAtMs ?? 0) - (right.state.nextRunAtMs ?? 0),
    );
    const isAgentWork = (timed: TimedCronJob) => timed.job.payload.kind === "agentTurn";
    const immediatePool = missed.filter((timed) => !isAgentWork(timed));
    const deferredAgents = missed.filter(isAgentWork);
    const immediate = immediatePool.slice(0, DEFAULT_MAX_MISSED_JOBS_PER_RESTART);
    const overflowCandidates: Array<{ timed: TimedCronJob; delayMs?: number }> = [
      ...immediatePool.slice(DEFAULT_MAX_MISSED_JOBS_PER_RESTART).map((timed) => ({ timed })),
      ...deferredAgents.map((timed) => ({
        timed,
        delayMs: DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
      })),
    ];
    const stagger = DEFAULT_STARTUP_CATCHUP_STAGGER_MS;
    for (const [index, entry] of overflowCandidates.entries()) {
      const candidate = nowMs + (entry.delayMs ?? stagger) + index * stagger;
      entry.timed.state.nextRunAtMs = candidate;
      entry.timed.state.startupCatchupAtMs = candidate;
      void this.deps.store.setState(entry.timed.job.id, entry.timed.state);
      if (entry.delayMs === undefined) {
        this.startupOverflow.set(entry.timed.job.id, {
          catchupAtMs: candidate,
          delayMs: (index + 1) * stagger,
          lastRunAtMs: entry.timed.state.lastRunAtMs,
        });
      }
    }
    if (overflowCandidates.length > 0) {
      this.log(
        `定时任务启动补齐：立即运行 ${immediate.length} 个，错峰排队 ${overflowCandidates.length} 个（漏跑合计 ${missed.length}）`,
      );
    }
    this.startupImmediate = new Set(immediate.map((timed) => timed.job.id));
    return immediate;
  }

  /** 立即批次全部跑完之后再放行 overflow，避免一次重启堆出两批并发。 */
  private settleStartupBatch(nowMs: number): void {
    if (this.startupOverflow.size === 0) {
      this.startupImmediate.clear();
      return;
    }
    const stillBusy = [...this.startupImmediate].some((jobId) => this.activeIds.has(jobId));
    if (stillBusy) return;
    this.startupImmediate.clear();
    for (const [jobId, pending] of [...this.startupOverflow]) {
      const timed = this.timedOf(jobId);
      if (
        !timed ||
        timed.state.nextRunAtMs !== pending.catchupAtMs ||
        timed.state.startupCatchupAtMs !== pending.catchupAtMs
      ) {
        // 期间被手动跑过或编辑过：这次补齐已经不再属于它。
        this.startupOverflow.delete(jobId);
        continue;
      }
      if (timed.state.lastRunAtMs !== pending.lastRunAtMs) {
        timed.state.startupCatchupAtMs = undefined;
      } else {
        timed.state.nextRunAtMs = nowMs + pending.delayMs;
        timed.state.startupCatchupAtMs = timed.state.nextRunAtMs;
      }
      void this.deps.store.setState(jobId, timed.state);
      this.startupOverflow.delete(jobId);
    }
  }

  private startupOverflowWaits(jobId: string, state: CronJobState): boolean {
    const pending = this.startupOverflow.get(jobId);
    if (!pending) return false;
    return (
      state.nextRunAtMs === pending.catchupAtMs &&
      state.startupCatchupAtMs === pending.catchupAtMs &&
      state.lastRunAtMs === pending.lastRunAtMs
    );
  }

  /** overflow 记账：启动补齐的槽位一旦被消耗，startupCatchupAtMs 就要跟着清掉。 */
  private settleOverflowBookkeeping(): void {
    for (const timed of this.timedJobs()) {
      if (typeof timed.state.runningAtMs === "number" || typeof timed.state.queuedAtMs === "number") {
        continue;
      }
      if (
        timed.state.startupCatchupAtMs !== undefined &&
        timed.state.startupCatchupAtMs !== timed.state.nextRunAtMs &&
        !this.startupOverflow.has(timed.job.id)
      ) {
        timed.state.startupCatchupAtMs = undefined;
        void this.deps.store.setState(timed.job.id, timed.state);
      }
    }
  }

  private async maintain(timedList: TimedCronJob[], nowMs: number): Promise<void> {
    for (const timed of timedList) {
      if (this.activeIds.has(timed.job.id)) continue;
      if (!needsTimerMaintenance(timed, nowMs)) continue;
      const result = recomputeJobNextRunAtMs(timed, nowMs);
      if (result.scheduleError) this.recordScheduleError(timed, result.scheduleError);
      // 记了调度错误也必须落盘：否则 nextRun 没变时计数会随内存快照一起丢掉，自动停用永远凑不满 3 次。
      if (result.changed || result.scheduleError) await this.deps.store.setState(timed.job.id, timed.state);
    }
  }

  /** 连续算不出触发时刻的作业要被停用（OpenClaw MAX_SCHEDULE_ERRORS 语义）。 */
  private recordScheduleError(timed: TimedCronJob, detail: string): void {
    const count = normalizeConsecutiveErrors(timed.state.scheduleErrorCount) + 1;
    timed.state.scheduleErrorCount = count;
    timed.state.nextRunAtMs = undefined;
    timed.state.lastError = `调度计算失败：${detail}`;
    if (!shouldAutoDisableScheduleErrors(timed)) {
      this.log(`定时任务「${timed.job.name}」调度计算失败（第 ${count} 次）：${detail}`, "warn");
      return;
    }
    if (timed.job.enabled) {
      timed.job.enabled = false;
      timed.state.autoDisabled = buildAutoDisabled(
        "schedule-errors",
        this.now(),
        count,
      );
      void this.deps.store.upsertJob(timed.job);
      this.notifyHost(
        timed.job.ownerId,
        `⚠️ 定时任务「${timed.job.name}」已连续 ${count} 次算不出触发时间（${detail}），已自动停用。请修改调度方式后重新启用。`,
      );
      this.log(`定时任务「${timed.job.name}」因调度错误连续 ${count} 次被停用`, "error");
    }
  }

  // ---------------------------------------------------------------- 运行队列

  private enqueue(entry: { timed: TimedCronJob; trigger: CronRunTrigger; slot?: number }): void {
    const ownerId = entry.timed.job.ownerId;
    if (this.activeIds.has(entry.timed.job.id)) return;
    if (this.pending.some((item) => item.timed.job.id === entry.timed.job.id)) return;
    if (this.canStart(ownerId)) {
      void this.execute(entry);
      return;
    }
    entry.timed.state.queuedAtMs = this.now();
    void this.deps.store.setState(entry.timed.job.id, entry.timed.state);
    this.pending.push(entry);
  }

  private canStart(ownerId: string): boolean {
    return (this.runningPerOwner.get(ownerId) ?? 0) < DEFAULT_MAX_CONCURRENT_CRON_RUNS;
  }

  private pump(): void {
    if (this.pending.length === 0) return;
    for (let index = 0; index < this.pending.length; index += 1) {
      const entry = this.pending[index];
      if (!entry) continue;
      if (!this.deps.getHost(entry.timed.job.ownerId)) {
        this.pending.splice(index, 1);
        void this.recordOwnerlessSkipped(entry, this.now());
        continue;
      }
      if (!this.canStart(entry.timed.job.ownerId)) continue;
      this.pending.splice(index, 1);
      void this.execute(entry);
      index -= 1;
    }
  }

  /** 没有可投递的作战室：记为 skipped；周期性任务照旧推进调度，一次性任务保住这次 occurrence 等一会儿再核对。 */
  private async recordOwnerlessSkipped(
    entry: { timed: TimedCronJob; trigger: CronRunTrigger; slot?: number },
    nowMs: number,
  ): Promise<void> {
    await this.finalize(entry.timed, {
      status: "skipped",
      startedAt: nowMs,
      endedAt: nowMs,
      trigger: entry.trigger,
      slot: entry.slot,
      preserveSchedule: entry.trigger === "manual",
      deferOccurrence: entry.timed.job.schedule.kind === "at",
      summary: "账号的工作区尚未加载，这次运行没有投递对象",
      error: "找不到该账号的作战室",
    });
  }

  private async execute(entry: {
    timed: TimedCronJob;
    trigger: CronRunTrigger;
    slot?: number;
  }): Promise<void> {
    const { job, state } = entry.timed;
    const startedAt = this.now();
    this.activeIds.add(job.id);
    this.runningPerOwner.set(job.ownerId, (this.runningPerOwner.get(job.ownerId) ?? 0) + 1);
    state.runningAtMs = startedAt;
    state.runningReceiptId = newId("cronreceipt");
    if (entry.trigger === "manual") state.queuedAtMs = undefined;
    await this.deps.store.setState(job.id, state);
    let outcome: PayloadOutcome;
    try {
      const host = this.deps.getHost(job.ownerId);
      if (!host) {
        outcome = {
          status: "skipped",
          summary: "账号的工作区尚未加载，这次运行没有投递对象",
          error: "找不到该账号的作战室",
          deferOccurrence: job.schedule.kind === "at",
        };
      } else {
        outcome = await this.runPayload(host, entry.timed, startedAt);
      }
    } catch (err) {
      outcome = { status: "error", error: errorMessage(err) };
    } finally {
      this.activeIds.delete(job.id);
      const left = (this.runningPerOwner.get(job.ownerId) ?? 1) - 1;
      if (left > 0) this.runningPerOwner.set(job.ownerId, left);
      else this.runningPerOwner.delete(job.ownerId);
    }
    await this.finalize(entry.timed, {
      ...outcome,
      startedAt,
      endedAt: this.now(),
      trigger: entry.trigger,
      slot: entry.slot,
      preserveSchedule: entry.trigger === "manual",
    });
    this.pump();
    this.arm(this.now());
  }

  private async runPayload(
    host: CronHost,
    timed: TimedCronJob,
    startedAt: number,
  ): Promise<PayloadOutcome> {
    const { job, state } = timed;
    if (!isWithinActiveHours(timed, startedAt)) {
      return {
        status: "skipped",
        summary: "不在该任务的活跃时段内",
        error: "活跃时段外跳过",
        deferOccurrence: job.schedule.kind === "at",
      };
    }

    if (job.payload.kind === "command") {
      const cwd = job.payload.cwd?.trim() || host.commandCwd || process.cwd();
      const result = await runCronCommand({
        argv: job.payload.argv,
        cwd,
        ...(job.payload.timeoutSeconds !== undefined
          ? { timeoutSeconds: job.payload.timeoutSeconds }
          : {}),
      });
      return {
        status: result.ok ? "ok" : "error",
        summary: capTerminalReply(result.summary),
        ...(result.error !== undefined ? { error: capTerminalReply(result.error) } : {}),
        ...(result.permanent ? { permanent: true } : {}),
      };
    }

    const previousResult =
      state.lastRunStatus === "ok" && state.lastSummary ? state.lastSummary : undefined;
    const body = buildCronCommandBody({
      job: { id: job.id, name: job.name },
      message: job.payload.message,
      nowMs: startedAt,
      ...(previousResult !== undefined ? { previousResult } : {}),
      ...(state.lastError === STARTUP_INTERRUPTED_ERROR ? { restartContinuation: true } : {}),
    });
    const turn: CronTurnOutcome = await host.orchestrator.runScheduledTurn({
      text: body,
      ...(job.payload.targetMemberId !== undefined
        ? { targetMemberId: job.payload.targetMemberId }
        : {}),
      timeoutMs: host.getSettings().limits.runTimeoutMs + 30_000,
    });
    if (turn.status !== "ok") {
      return {
        status: "error",
        error: capTerminalReply(turn.error ?? `定时运行以 ${turn.status} 结束`),
        ...(turn.memberId !== undefined ? { memberId: turn.memberId } : {}),
      };
    }
    const silent = resolveSilentReply(turn.text);
    return {
      status: "ok",
      quiet: silent.quiet,
      delivered: !silent.quiet && silent.visible.length > 0,
      summary: capTerminalReply(silent.quiet ? "" : silent.visible),
      ...(turn.memberId !== undefined ? { memberId: turn.memberId } : {}),
    };
  }

  // ---------------------------------------------------------------- 终态记账

  /** 对应 OpenClaw applyJobResult：状态、退避、停用、删除、告警与历史一次算完。 */
  private async finalize(timed: TimedCronJob, r: RunResult): Promise<void> {
    const { job, state } = timed;
    const previousNextRunAtMs = state.nextRunAtMs;
    const host = this.deps.getHost(job.ownerId);
    const interruptedByRestart = r.interruptedByRestart === true;

    state.runningAtMs = undefined;
    state.queuedAtMs = undefined;
    state.runningReceiptId = undefined;
    if (state.startupCatchupAtMs !== undefined && state.startupCatchupAtMs === r.slot) {
      state.startupCatchupAtMs = undefined;
    }
    state.lastRunAtMs = r.startedAt;
    state.lastRunStatus = r.status;
    state.lastDurationMs = Math.max(0, r.endedAt - r.startedAt);
    state.lastSummary = r.status === "ok" ? r.summary : undefined;
    state.lastError = r.status === "ok" ? undefined : r.error;
    job.updatedAtMs = r.endedAt;

    const deliveryStatus = this.resolveDeliveryStatus(r);
    const completion = resolveCronCompletionStatus({
      status: r.status,
      deliveryStatus,
      ...(r.quiet ? { deliverySuppressionReason: "silent-reply" } : {}),
    });

    // 与 OpenClaw 一致：被重启打断与被中止的运行不增加失败计数，跳过走独立计数。
    const runFailed = r.status === "error" && !interruptedByRestart;
    const previousConsecutiveErrors = normalizeConsecutiveErrors(state.consecutiveErrors);
    if (r.status === "error") {
      if (runFailed) state.consecutiveErrors = previousConsecutiveErrors + 1;
      state.consecutiveSkipped = 0;
    } else if (r.status === "skipped") {
      Object.assign(state, applyOutcomeStreaks(state, "skipped"));
    } else {
      Object.assign(state, applyOutcomeStreaks(state, "ok"));
      if (completion === "succeeded") state.lastFailureAlertAtMs = undefined;
    }

    // 借用一次运行（手动试跑）能不能动调度，OpenClaw 是分两种口径的：周期性任务永远只是借用，
    // 槽位、停用、重试都不归它管；一次性任务只有在 occurrence 还在未来的时候才保得住——
    // 已经到点的那一次被手动跑掉就是消耗掉了，成功按 deleteAfterRun 处理、失败按重试/停用走。
    const oneShotOccurrenceAtMs =
      job.schedule.kind === "at"
        ? resolveManualOneShotOccurrenceAtMs(timed, previousNextRunAtMs, r.startedAt)
        : undefined;
    const preserveSlot =
      r.preserveSchedule === true &&
      (job.schedule.kind !== "at" || oneShotOccurrenceAtMs !== undefined);

    if (r.status === "ok" && !preserveSlot && r.slot !== undefined) {
      // 槽位被消耗：下一次触发要从运行结束时刻重新算。
      state.nextRunAtMs = undefined;
    }
    if (preserveSlot) {
      state.nextRunAtMs = previousNextRunAtMs;
    } else if (r.status === "skipped" && r.deferOccurrence) {
      state.nextRunAtMs = r.endedAt + ACTIVE_HOURS_RETRY_MS;
    } else if (
      r.status === "ok" &&
      completion === "succeeded" &&
      job.schedule.kind === "at" &&
      job.deleteAfterRun !== false
    ) {
      await this.removeJobDefinition(job, r);
      return;
    } else if (job.schedule.kind === "at" && isJobEnabled(job) && r.status !== "error") {
      // 跑完或跳过（且这一次没被保住）就停用：留着过期槽位等于让定时器自触发（OpenClaw #11452）。
      job.enabled = false;
      state.nextRunAtMs = undefined;
      await this.deps.store.upsertJob(job);
      this.emitJob(job);
    } else if (!isJobEnabled(job)) {
      state.nextRunAtMs = undefined;
    } else if (r.status === "error") {
      await this.scheduleAfterError(timed, r, previousConsecutiveErrors);
    } else {
      this.scheduleAfterSuccess(timed, r, previousConsecutiveErrors);
    }

    if (runFailed) {
      this.maybeAlertFailure(timed, r);
    }

    const record: CronRunRecord = {
      id: newId("cronrun"),
      jobId: job.id,
      jobName: job.name,
      ownerId: job.ownerId,
      trigger: r.trigger,
      ...(r.trigger === "schedule" || r.trigger === "startup"
        ? { scheduledSlotMs: r.slot }
        : {}),
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationMs: Math.max(0, r.endedAt - r.startedAt),
      quiet: r.quiet === true,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(hasScheduledNextRunAtMs(state.nextRunAtMs) ? { nextRunAtMs: state.nextRunAtMs } : {}),
      ...(r.memberId !== undefined ? { memberId: r.memberId } : {}),
    };
    await this.deps.history.append(record);
    // 运行期间作业可能被人删掉（面板上删一个正在跑的任务）：历史照记，定义和状态都不许写回去。
    if (this.deps.store.getJob(job.id)) {
      await this.deps.store.setState(job.id, state);
      if (job.schedule.kind !== "at" || r.status !== "ok") await this.deps.store.upsertJob(job);
    }
    this.emitRun(job.ownerId, job.id, record);
    this.settleManualRuns(job.id, record);

    // command payload 没有成员替它发言，输出要由调度器代投进群（OpenClaw 的 delivery 那一层）。
    if (job.payload.kind === "command" && host) {
      this.notifyHost(
        job.ownerId,
        this.commandNotice(job, r),
      );
    }
  }

  private resolveDeliveryStatus(r: RunResult): CronDeliveryStatus {
    if (r.status === "ok") {
      if (r.quiet === true) return "not-delivered";
      if (r.delivered === true) return "delivered";
      return r.summary ? "delivered" : "not-requested";
    }
    return r.delivered === undefined && !r.quiet ? "not-requested" : "not-delivered";
  }

  private scheduleAfterSuccess(
    timed: TimedCronJob,
    r: RunResult,
    previousConsecutiveErrors: number,
  ): void {
    const { job, state } = timed;
    const natural = this.computeNaturalNext(timed, r, previousConsecutiveErrors > 0);
    if (natural === undefined) {
      if (job.schedule.kind === "at") {
        // 一次性作业成功之后没有下一次；没走到删除分支时保持停用。
        state.nextRunAtMs = undefined;
        return;
      }
      state.nextRunAtMs = undefined;
      this.recordScheduleError(timed, "无法计算下一次触发时间");
      return;
    }
    const lowerBound = r.endedAt + MIN_REFIRE_GAP_MS;
    state.nextRunAtMs =
      job.schedule.kind === "cron" || job.schedule.kind === "every"
        ? Math.max(natural, lowerBound)
        : natural;
  }

  private async scheduleAfterError(
    timed: TimedCronJob,
    r: RunResult,
    previousConsecutiveErrors: number,
  ): Promise<void> {
    const { job, state } = timed;
    if (job.schedule.kind === "at") {
      if (r.permanent === true || state.consecutiveErrors > DEFAULT_MAX_TRANSIENT_RETRIES) {
        job.enabled = false;
        state.nextRunAtMs = undefined;
        await this.deps.store.upsertJob(job);
        this.notifyHost(
          job.ownerId,
          `定时任务「${job.name}」未能完成并已停用：${state.lastError ?? "未知原因"}`,
        );
        this.emitJob(job);
        return;
      }
      state.nextRunAtMs =
        r.endedAt +
        Math.max(
          MIN_REFIRE_GAP_MS,
          errorBackoffMs(
            Math.max(1, state.consecutiveErrors),
            DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
          ),
        );
      return;
    }
    if (shouldAutoDisableAfterRunFailure(timed)) {
      job.enabled = false;
      state.nextRunAtMs = undefined;
      state.autoDisabled = buildAutoDisabled(
        "consecutive-failures",
        r.endedAt,
        state.consecutiveErrors,
      );
      await this.deps.store.upsertJob(job);
      this.notifyHost(
        job.ownerId,
        `⚠️ 定时任务「${job.name}」连续失败 ${state.consecutiveErrors} 次（已达 ${DEFAULT_AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES} 次上限），已自动停用。请修复原因后重新启用。`,
      );
      this.log(`定时任务「${job.name}」连续失败后被停用`, "error");
      this.emitJob(job);
      return;
    }
    const natural = this.computeNaturalNext(timed, r, true);
    const backoffNext =
      r.endedAt +
      errorBackoffMs(
        Math.max(1, normalizeConsecutiveErrors(state.consecutiveErrors)),
        DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
      );
    const lowerBound = Math.max(backoffNext, r.endedAt + MIN_REFIRE_GAP_MS);
    state.nextRunAtMs = natural === undefined ? lowerBound : Math.max(natural, lowerBound);
  }

  private computeNaturalNext(
    timed: TimedCronJob,
    r: RunResult,
    preserveEveryAnchor: boolean,
  ): number | undefined {
    try {
      return computeJobNextRunAtMs(timed, r.endedAt, { preserveEveryAnchor });
    } catch (err) {
      this.recordScheduleError(timed, errorMessage(err));
      return undefined;
    }
  }

  /** 连续失败告警：达到阈值且过了冷却期才发一次，成功运行会清掉冷却。 */
  private maybeAlertFailure(timed: TimedCronJob, r: RunResult): void {
    const { job, state } = timed;
    if (state.consecutiveErrors < DEFAULT_FAILURE_ALERT_AFTER) return;
    const last = state.lastFailureAlertAtMs;
    if (last !== undefined && r.endedAt - last < DEFAULT_FAILURE_ALERT_COOLDOWN_MS) return;
    state.lastFailureAlertAtMs = r.endedAt;
    this.notifyHost(
      job.ownerId,
      `⚠️ 定时任务「${job.name}」已连续失败 ${state.consecutiveErrors} 次：${state.lastError ?? "未知原因"}\n下一次会按退避重试，修复后可以在定时任务面板里重新启用或立即试跑一次。`,
    );
    this.log(`定时任务「${job.name}」连续失败 ${state.consecutiveErrors} 次`, "warn");
  }

  private commandNotice(job: CronJob, r: RunResult): string {
    const head = job.payload.kind === "command" ? job.payload.argv.join(" ") : job.name;
    const label =
      r.status === "ok" ? "运行完成" : r.status === "skipped" ? "已跳过" : "运行失败";
    const body = r.status === "ok" ? r.summary : (r.error ?? r.summary);
    return [
      `定时命令「${head}」${label}（用时 ${Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000))} 秒）。`,
      body ? String(body) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async removeJobDefinition(job: CronJob, r: RunResult): Promise<void> {
    await this.deps.store.removeJob(job.id);
    this.startupOverflow.delete(job.id);
    this.notifyHost(
      job.ownerId,
      `定时任务「${job.name}」已完成一次性运行并从面板移除。${r.summary ? `\n\n${r.summary}` : ""}`,
    );
    this.deps.onEvent?.({ type: "job-removed", ownerId: job.ownerId, jobId: job.id });
    const record: CronRunRecord = {
      id: newId("cronrun"),
      jobId: job.id,
      jobName: job.name,
      ownerId: job.ownerId,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationMs: Math.max(0, r.endedAt - r.startedAt),
      quiet: r.quiet === true,
      ...(r.summary ? { summary: r.summary } : {}),
    };
    await this.deps.history.append(record);
    this.settleManualRuns(job.id, record);
  }

  private notifyHost(ownerId: string, text: string): void {
    const host = this.deps.getHost(ownerId);
    if (!host) return;
    host.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text,
    });
  }

  private emitJob(job: CronJob): void {
    this.deps.onEvent?.({
      type: "job",
      ownerId: job.ownerId,
      job: { ...job },
      state: this.deps.store.getState(job.id),
    });
  }

  private emitRun(ownerId: string, jobId: string, record?: CronRunRecord): void {
    const job = this.deps.store.getJob(jobId);
    if (record) {
      this.deps.onEvent?.({ type: "run", ownerId, run: record });
      if (job) {
        this.deps.onEvent?.({
          type: "job",
          ownerId,
          job: { ...job },
          state: this.deps.store.getState(jobId),
        });
      }
      return;
    }
    if (job) this.emitJob(job);
  }

  // ---------------------------------------------------------------- 对外命令面

  listJobs(ownerId: string): CronJobView[] {
    return this.deps.store.listJobs(ownerId).map((job) => ({
      job,
      state: this.deps.store.getState(job.id),
      lastRun: this.deps.history.lastFor(job.id),
    }));
  }

  getJob(ownerId: string, jobId: string): CronJobView | undefined {
    const job = this.deps.store.getJob(jobId);
    if (!job || job.ownerId !== ownerId) return undefined;
    return {
      job,
      state: this.deps.store.getState(jobId),
      lastRun: this.deps.history.lastFor(jobId),
    };
  }

  listRuns(ownerId: string, query: Omit<CronRunQuery, "ownerId"> = {}) {
    return this.deps.history.list({ ...query, ownerId });
  }

  status(ownerId: string): {
    total: number;
    enabled: number;
    running: number;
    nextRunAtMs?: number;
  } {
    const jobs = this.deps.store.listJobs(ownerId);
    let enabled = 0;
    let next: number | undefined;
    for (const job of jobs) {
      if (!isJobEnabled(job)) continue;
      enabled += 1;
      const state = this.deps.store.getState(job.id);
      if (hasScheduledNextRunAtMs(state.nextRunAtMs)) {
        next = Math.min(next ?? Number.POSITIVE_INFINITY, state.nextRunAtMs);
      }
    }
    return {
      total: jobs.length,
      enabled,
      running: jobs.filter((job) => this.activeIds.has(job.id)).length,
      ...(next !== undefined ? { nextRunAtMs: next } : {}),
    };
  }

  async createJob(
    ownerId: string,
    raw: Record<string, unknown>,
    createdBy?: CronAuthorship,
  ): Promise<CronJob> {
    const input = normalizeCronInput(raw);
    const store = this.deps.store;
    if (store.countForOwner(ownerId) >= CRON_LIMITS.jobsPerUser) {
      throw new CronError(`每个账号最多创建 ${CRON_LIMITS.jobsPerUser} 个定时任务`);
    }
    const nowMs = this.now();
    const timestamp = validateCronScheduleTimestamp(input.schedule, nowMs);
    if (!timestamp.ok) throw new CronError(timestamp.message);
    const job: CronJob = {
      id: newId("cron"),
      ownerId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      enabled: input.enabled,
      schedule: input.schedule,
      payload: input.payload,
      ...(input.activeHours !== undefined ? { activeHours: input.activeHours } : {}),
      ...(input.deleteAfterRun !== undefined ? { deleteAfterRun: input.deleteAfterRun } : {}),
      ...(createdBy ? { createdBy: createdBy } : {}),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const state = emptyCronJobState(nowMs);
    const timed: TimedCronJob = { job, state };
    await store.upsertJob(job);
    state.nextRunAtMs = computeJobNextRunAtMs(timed, nowMs);
    await store.setState(job.id, state);
    this.emitJob(job);
    this.rearm();
    return job;
  }

  async updateJob(
    ownerId: string,
    jobId: string,
    raw: Record<string, unknown>,
  ): Promise<CronJob> {
    const current = this.requireOwned(ownerId, jobId);
    const patch: NormalizedCronInput = mergeCronDefinition(current, raw);
    const nowMs = this.now();
    const next: CronJob = {
      ...current,
      name: patch.name,
      enabled: patch.enabled,
      schedule: patch.schedule,
      payload: patch.payload,
      updatedAtMs: nowMs,
    };
    if (patch.description !== undefined) next.description = patch.description;
    else delete next.description;
    if (patch.activeHours !== undefined) next.activeHours = patch.activeHours;
    else delete next.activeHours;
    if (patch.deleteAfterRun !== undefined) next.deleteAfterRun = patch.deleteAfterRun;
    else delete next.deleteAfterRun;

    const state = this.deps.store.getState(jobId);
    const changedTrigger = triggerChanged(current, patch);
    if (changedTrigger) {
      // 换了触发器就等于旧槽位从没存在过：清掉补齐痕迹，按新调度重新武装。
      state.startupCatchupAtMs = undefined;
      state.nextRunAtMs = undefined;
      state.scheduleActivatedAtMs = nowMs;
      state.scheduleErrorCount = 0;
    }
    const timed: TimedCronJob = { job: next, state };
    if (changedTrigger) {
      // 只有真的改了触发条件才校验时间：编辑一个已经跑过的一次性任务的说明不该被过去时刻卡住。
      const timestamp = validateCronScheduleTimestamp(next.schedule, nowMs);
      if (!timestamp.ok) throw new CronError(timestamp.message);
    }
    if (isJobEnabled(next)) {
      const result = recomputeJobNextRunAtMs(timed, nowMs);
      if (result.scheduleError) this.recordScheduleError(timed, result.scheduleError);
    } else {
      state.nextRunAtMs = undefined;
    }
    // 重新启用是清除停用标记的唯一入口。
    if (patch.enabled && state.autoDisabled && current.enabled !== true) {
      state.autoDisabled = undefined;
    }
    await this.deps.store.upsertJob(next);
    await this.deps.store.setState(jobId, state);
    this.emitJob(next);
    this.rearm();
    return next;
  }

  async setEnabled(ownerId: string, jobId: string, enabled: boolean): Promise<CronJob> {
    const current = this.requireOwned(ownerId, jobId);
    const nowMs = this.now();
    const job: CronJob = { ...current, enabled, updatedAtMs: nowMs };
    const state = this.deps.store.getState(jobId);
    const timed: TimedCronJob = { job, state };
    if (enabled) {
      state.autoDisabled = undefined;
      state.consecutiveErrors = 0;
      state.consecutiveSkipped = 0;
      state.scheduleActivatedAtMs = nowMs;
      const result = recomputeJobNextRunAtMs(timed, nowMs);
      if (result.scheduleError) this.recordScheduleError(timed, result.scheduleError);
    } else if (!this.activeIds.has(jobId)) {
      state.nextRunAtMs = undefined;
      state.startupCatchupAtMs = undefined;
    }
    await this.deps.store.upsertJob(job);
    await this.deps.store.setState(jobId, state);
    this.emitJob(job);
    this.rearm();
    return job;
  }

  async removeJob(ownerId: string, jobId: string): Promise<CronJob> {
    const current = this.requireOwned(ownerId, jobId);
    await this.deps.store.removeJob(jobId);
    this.startupOverflow.delete(jobId);
    this.pending = this.pending.filter((entry) => entry.timed.job.id !== jobId);
    this.dropManualRuns(jobId);
    this.deps.onEvent?.({ type: "job-removed", ownerId, jobId });
    return current;
  }

  /** 手动试跑：借用当前定义立刻执行一次，不消耗调度槽位（OpenClaw force run 的 preserve 语义）。
   *  wait=false 只发起、不等终态（Web 面板靠 SSE 收结果）；默认等到那一次运行落账再返回记录。 */
  async runNow(
    ownerId: string,
    jobId: string,
    options: { wait?: boolean } = {},
  ): Promise<CronRunRecord | undefined> {
    const wait = options.wait !== false;
    const entry = this.prepareManualRun(ownerId, jobId);
    const done = wait ? this.waitForManualRun(entry.timed.job.id) : undefined;
    this.enqueue(entry);
    this.arm(this.now());
    return done ? await done : undefined;
  }

  private prepareManualRun(ownerId: string, jobId: string): {
    timed: TimedCronJob;
    trigger: CronRunTrigger;
    slot?: number;
  } {
    const timed = this.requireOwnedTimed(ownerId, jobId);
    if (this.activeIds.has(jobId)) throw new CronError("这个定时任务正在运行中，请等这一次结束");
    if (this.pending.some((entry) => entry.timed.job.id === jobId)) {
      throw new CronError("这个定时任务已经排在队列里了");
    }
    if (!this.deps.getHost(ownerId)) throw new CronError("账号的工作区尚未加载，无法运行定时任务");
    return { timed, trigger: "manual", slot: undefined };
  }

  private readonly manualRuns = new Map<
    string,
    Array<(record: CronRunRecord | undefined) => void>
  >();

  private waitForManualRun(jobId: string): Promise<CronRunRecord | undefined> {
    return new Promise((resolve) => {
      const waiters = this.manualRuns.get(jobId) ?? [];
      waiters.push(resolve);
      this.manualRuns.set(jobId, waiters);
    });
  }

  private settleManualRuns(jobId: string, record: CronRunRecord): void {
    const waiters = this.manualRuns.get(jobId);
    if (!waiters || waiters.length === 0) return;
    this.manualRuns.delete(jobId);
    for (const resolve of waiters) resolve(record);
  }

  /** 作业被删或调度器停掉：等终态的请求要有交代，不能永远挂着。 */
  private dropManualRuns(jobId: string): void {
    const waiters = this.manualRuns.get(jobId);
    if (!waiters || waiters.length === 0) return;
    this.manualRuns.delete(jobId);
    for (const resolve of waiters) resolve(undefined);
  }

  /** 智能体工具用的摘要视图：只列自己账号的任务。 */
  summarize(ownerId: string): string {
    const views = this.listJobs(ownerId);
    if (views.length === 0) return "当前没有定时任务。";
    return views
      .map((view) => {
        const next = view.state.nextRunAtMs
          ? new Date(view.state.nextRunAtMs).toLocaleString("zh-CN")
          : "未排期";
        const last = view.lastRun
          ? `${view.lastRun.status}${view.lastRun.error ? `（${view.lastRun.error}）` : ""}`
          : "从未运行";
        return `- ${view.job.id} 「${view.job.name}」${view.job.enabled ? "启用" : "停用"}：${describeSchedule(view.job.schedule)}｜下一次 ${next}｜上次 ${last}`;
      })
      .join("\n");
  }

  private requireOwned(ownerId: string, jobId: string): CronJob {
    const job = this.deps.store.getJob(jobId);
    if (!job || job.ownerId !== ownerId) throw new CronError("找不到这个定时任务", 404);
    return job;
  }

  private requireOwnedTimed(ownerId: string, jobId: string): TimedCronJob {
    return { job: this.requireOwned(ownerId, jobId), state: this.deps.store.getState(jobId) };
  }
}
