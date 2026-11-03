// Ported and adapted from OpenClaw src/cron 的运行历史层（MIT License — Copyright (c) 2026 OpenClaw Foundation）。
// OpenClaw 用 SQLite 表存 receipt/run 行；本项目落到一个 JSON 文件，但保留同样的纪律：
// 只写终态行、按时间+每作业条数双上限清理、分页上限裁到 1..200、删作业不删历史。

import { readJson, writeJsonAtomic } from "../store/persist";
import { CRON_STORE_VERSION, type CronRunRecord, type CronRunStatus } from "./types";

export const CRON_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CRON_RUNS_KEEP_PER_JOB = 2000;
export const CRON_RUNS_MAX_TOTAL = 20_000;
export const CRON_RUNS_PAGE_DEFAULT = 50;
export const CRON_RUNS_PAGE_MAX = 200;

interface RunsFile {
  version: number;
  runs: CronRunRecord[];
}

export interface CronRunQuery {
  ownerId?: string;
  jobId?: string;
  status?: CronRunStatus;
  /** 在任务名与摘要/错误里做子串匹配。 */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface CronRunPage {
  entries: CronRunRecord[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number;
}

function isRunRecord(value: unknown): value is CronRunRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.jobId === "string" &&
    (row.status === "ok" || row.status === "error" || row.status === "skipped") &&
    typeof row.startedAt === "number" &&
    typeof row.endedAt === "number"
  );
}

export class CronRunHistory {
  private runs: CronRunRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private mutationChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await readJson<RunsFile | null>(this.file, null);
    const rows = stored && Array.isArray(stored.runs) ? stored.runs : [];
    // 坏行跳过而不弃用整个文件：历史只用于展示与排查。
    this.runs = rows.filter(isRunRecord);
    this.loaded = true;
  }

  private async mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn);
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 追加一条终态记录并按上限裁剪。 */
  async append(record: CronRunRecord): Promise<CronRunRecord> {
    return this.mutate(() => {
      this.runs.push(record);
      this.runs.sort((a, b) => a.endedAt - b.endedAt);
      this.sweep(Date.now());
      this.queueWrite();
      return { ...record };
    });
  }

  private sweep(nowMs: number): void {
    const cutoff = nowMs - CRON_RUN_RETENTION_MS;
    let kept = this.runs.filter((run) => run.endedAt >= cutoff);
    if (kept.length > CRON_RUNS_MAX_TOTAL) {
      kept = kept.slice(kept.length - CRON_RUNS_MAX_TOTAL);
    }
    const perJob = new Map<string, number>();
    const trimmed: CronRunRecord[] = [];
    for (const run of kept) {
      const count = (perJob.get(run.jobId) ?? 0) + 1;
      perJob.set(run.jobId, count);
      if (count > CRON_RUNS_KEEP_PER_JOB) continue;
      trimmed.push(run);
    }
    this.runs = trimmed;
  }

  list(query: CronRunQuery = {}): CronRunPage {
    const status = query.status;
    const needle = query.query?.trim().toLowerCase() ?? "";
    const matched = this.runs.filter((run) => {
      if (query.ownerId && run.ownerId !== query.ownerId) return false;
      if (query.jobId && run.jobId !== query.jobId) return false;
      if (status && run.status !== status) return false;
      if (!needle) return true;
      return (
        run.jobName.toLowerCase().includes(needle) ||
        (run.summary ?? "").toLowerCase().includes(needle) ||
        (run.error ?? "").toLowerCase().includes(needle)
      );
    });
    // 最新在前（OpenClaw 的 newest-first 分页）。
    const newestFirst = matched.slice().sort((a, b) => b.endedAt - a.endedAt);
    const limit = Math.min(
      CRON_RUNS_PAGE_MAX,
      Math.max(1, Math.floor(query.limit ?? CRON_RUNS_PAGE_DEFAULT)),
    );
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const entries = newestFirst.slice(offset, offset + limit);
    return {
      entries,
      total: newestFirst.length,
      offset,
      limit,
      hasMore: offset + entries.length < newestFirst.length,
      nextOffset: offset + entries.length,
    };
  }

  lastFor(jobId: string): CronRunRecord | undefined {
    for (let index = this.runs.length - 1; index >= 0; index -= 1) {
      const run = this.runs[index];
      if (run && run.jobId === jobId) return run;
    }
    return undefined;
  }

  async removeOwnedBy(ownerId: string): Promise<number> {
    return this.mutate(() => {
      const before = this.runs.length;
      this.runs = this.runs.filter((run) => run.ownerId !== ownerId);
      const removed = before - this.runs.length;
      if (removed > 0) this.queueWrite();
      return removed;
    });
  }

  private queueWrite(): void {
    this.writeChain = this.writeChain.then(() => this.write(), () => this.write());
  }

  private async write(): Promise<void> {
    await writeJsonAtomic(this.file, {
      version: CRON_STORE_VERSION,
      runs: this.runs,
    } satisfies RunsFile);
  }

  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}
