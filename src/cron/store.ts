// Ported and adapted from OpenClaw src/cron 的存储层（MIT License — Copyright (c) 2026 OpenClaw Foundation）。
// OpenClaw 把作业定义与运行状态物理分成 job_json / state_json 两张表：定义改动少、状态每次运行都改。
// 本项目沿用同样的分文件思路（crons.json 定义 + cron-state.json 状态），热路径只重写后者。
// 写入纪律照搬：单写队列、整文件原子改名、绝不因为个别坏行丢掉整个文件（坏行隔离出去）。

import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../store/persist";
import { isFiniteTimestamp } from "./util";
import { CRON_STORE_VERSION, type CronJob, type CronJobState } from "./types";

export const CRON_QUARANTINE_PREFIX = "crons.rejected-";

interface JobsFile {
  version: number;
  jobs: unknown[];
}

interface StateFile {
  version: number;
  state: Record<string, CronJobState>;
}

export function emptyCronJobState(nowMs = Date.now()): CronJobState {
  return {
    consecutiveErrors: 0,
    consecutiveSkipped: 0,
    scheduleErrorCount: 0,
    scheduleActivatedAtMs: nowMs,
  };
}

/** 只认结构完整的作业行；不合法的行由调用方隔离，绝不静默改写用户数据。 */
function isStoredJob(value: unknown): value is CronJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (typeof job.id !== "string" || !job.id) return false;
  if (typeof job.ownerId !== "string" || !job.ownerId) return false;
  if (typeof job.name !== "string" || !job.name) return false;
  if (typeof job.enabled !== "boolean") return false;
  if (!isFiniteTimestamp(job.createdAtMs) || !isFiniteTimestamp(job.updatedAtMs)) return false;
  const schedule = job.schedule as Record<string, unknown> | undefined;
  if (!schedule || typeof schedule.kind !== "string") return false;
  if (schedule.kind !== "at" && schedule.kind !== "every" && schedule.kind !== "cron") return false;
  const payload = job.payload as Record<string, unknown> | undefined;
  if (!payload || (payload.kind !== "agentTurn" && payload.kind !== "command")) return false;
  return true;
}

function isStoredState(value: unknown): value is CronJobState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.consecutiveErrors === "number" &&
    typeof state.consecutiveSkipped === "number" &&
    typeof state.scheduleErrorCount === "number"
  );
}

export class CronStore {
  private jobs = new Map<string, CronJob>();
  private states = new Map<string, CronJobState>();
  /** 定义与状态各一条写链：状态写得勤，但不能把定义写排队堵死。 */
  private writeChain: Promise<void> = Promise.resolve();
  private stateChain: Promise<void> = Promise.resolve();
  private mutationChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly dir: string) {}

  private get jobsFile(): string {
    return join(this.dir, "crons.json");
  }

  private get stateFile(): string {
    return join(this.dir, "cron-state.json");
  }

  async load(): Promise<{ rejected: number }> {
    if (this.loaded) return { rejected: this.rejectedCount };
    const [jobsFile, stateFile] = await Promise.all([
      readJson<JobsFile | null>(this.jobsFile, null),
      readJson<StateFile | null>(this.stateFile, null),
    ]);

    const rows = jobsFile && Array.isArray(jobsFile.jobs) ? jobsFile.jobs : [];
    const rejected: unknown[] = [];
    for (const row of rows) {
      if (!isStoredJob(row)) {
        rejected.push(row);
        continue;
      }
      this.jobs.set(row.id, { ...row });
      const persisted = stateFile?.state?.[row.id];
      this.states.set(row.id, isStoredState(persisted) ? { ...persisted } : emptyCronJobState(row.createdAtMs));
    }
    // 状态文件里指向已删作业的残留直接丢掉，不写回。
    if (stateFile?.state) {
      for (const [jobId, state] of Object.entries(stateFile.state)) {
        if (!this.jobs.has(jobId) && isStoredState(state)) {
          this.orphanStates.set(jobId, state);
        }
      }
    }
    this.rejectedCount = rejected.length;
    if (rejected.length > 0) {
      await writeJsonAtomic(join(this.dir, `${CRON_QUARANTINE_PREFIX}${Date.now()}.json`), {
        reason: "这些行不符合定时任务定义结构，已从调度中排除，原文保留供排查",
        rows: rejected,
      }).catch(() => undefined);
    }
    this.loaded = true;
    return { rejected: rejected.length };
  }

  private rejectedCount = 0;
  private orphanStates = new Map<string, CronJobState>();

  /** 串行执行读改写：两个请求不能各自基于旧快照覆盖对方。 */
  private async mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  listJobs(ownerId?: string): CronJob[] {
    const all = [...this.jobs.values()];
    const owned = ownerId ? all.filter((job) => job.ownerId === ownerId) : all;
    return owned.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  getJob(jobId: string): CronJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  getState(jobId: string): CronJobState {
    return { ...(this.states.get(jobId) ?? emptyCronJobState()) };
  }

  /** 运行期只改状态：返回合并后的新状态并异步落盘（不阻塞调度循环）。 */
  async patchState(jobId: string, patch: Partial<CronJobState>): Promise<CronJobState> {
    return this.mutate(() => {
      const next = { ...(this.states.get(jobId) ?? emptyCronJobState()), ...patch };
      this.states.set(jobId, next);
      this.stateChain = this.stateChain.then(() => this.writeStateFile(), () => this.writeStateFile());
      return { ...next };
    });
  }

  setState(jobId: string, state: CronJobState): Promise<CronJobState> {
    return this.patchState(jobId, state);
  }

  /** 定义改动：一次性提交并落盘，返回持久化后的作业。 */
  async upsertJob(job: CronJob): Promise<CronJob> {
    return this.mutate(() => {
      this.jobs.set(job.id, { ...job });
      if (!this.states.has(job.id)) this.states.set(job.id, emptyCronJobState(job.createdAtMs));
      this.queueJobsWrite();
      return { ...job };
    });
  }

  async removeJob(jobId: string): Promise<CronJob | undefined> {
    return this.mutate(() => {
      const removed = this.jobs.get(jobId);
      this.jobs.delete(jobId);
      // 状态跟着作业走；运行历史保留（OpenClaw 删作业不删历史）。
      this.states.delete(jobId);
      this.orphanStates.delete(jobId);
      this.queueJobsWrite();
      return removed ? { ...removed } : undefined;
    });
  }

  /** 删号：返回被清掉的作业，历史交给上层按 ownerId 清理。 */
  async removeOwnedBy(ownerId: string): Promise<CronJob[]> {
    return this.mutate(() => {
      const removed: CronJob[] = [];
      for (const [id, job] of this.jobs) {
        if (job.ownerId !== ownerId) continue;
        this.jobs.delete(id);
        this.states.delete(id);
        removed.push({ ...job });
      }
      if (removed.length > 0) this.queueJobsWrite();
      return removed;
    });
  }

  countForOwner(ownerId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.ownerId === ownerId) count += 1;
    return count;
  }

  private queueJobsWrite(): void {
    this.writeChain = this.writeChain.then(() => this.writeJobsFile(), () => this.writeJobsFile());
  }

  private async writeJobsFile(): Promise<void> {
    await writeJsonAtomic(this.jobsFile, {
      version: CRON_STORE_VERSION,
      jobs: [...this.jobs.values()].sort((a, b) => a.createdAtMs - b.createdAtMs),
    } satisfies JobsFile);
  }

  private async writeStateFile(): Promise<void> {
    const state: Record<string, CronJobState> = {};
    for (const [jobId, value] of this.states) state[jobId] = value;
    for (const [jobId, value] of this.orphanStates) state[jobId] = value;
    await writeJsonAtomic(this.stateFile, {
      version: CRON_STORE_VERSION,
      state,
    } satisfies StateFile);
  }

  /** 进程退出前把排队中的写全部落干。 */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
    await this.stateChain.catch(() => undefined);
    await this.writeJobsFile().catch(() => undefined);
    await this.writeStateFile().catch(() => undefined);
  }
}
