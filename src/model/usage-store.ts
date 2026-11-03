// 模型用量账本：按 `provider/model` × UTC 自然日聚合 token 与成本，
// 对应 OpenClaw 的 usage-cost 统计口径（`packages/llm-core/src/usage-cost.ts`），
// MIT License — Copyright (c) 2026 OpenClaw Foundation；存储换成本项目的每工作区 JSON。

import { readJson, writeJsonAtomic } from "../store/persist";
import { addUsage, emptyUsage, type UsageTotals } from "./usage-cost";

export const USAGE_STORE_VERSION = 1;
const RETENTION_DAYS = 120;
const MAX_ENTRIES = 5_000;
const FLUSH_DEBOUNCE_MS = 2_000;

export interface UsageEntry {
  /** `provider/model`。 */
  ref: string;
  providerId: string;
  modelId: string;
  /** YYYY-MM-DD（UTC）。 */
  day: string;
  runs: number;
  usage: UsageTotals;
  costUsd: number;
  updatedAt: number;
}

interface UsageFile {
  version: number;
  entries: UsageEntry[];
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function isUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const num = (key: string) =>
    typeof record[key] === "number" && Number.isFinite(record[key] as number) ? Math.floor(record[key] as number) : 0;
  return { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite") };
}

function isEntry(value: unknown): value is UsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ref === "string" &&
    typeof entry.providerId === "string" &&
    typeof entry.modelId === "string" &&
    typeof entry.day === "string" &&
    typeof entry.runs === "number" &&
    typeof entry.costUsd === "number" &&
    isUsage(entry.usage) !== null
  );
}

export interface UsageAggregate {
  ref: string;
  providerId: string;
  modelId: string;
  runs: number;
  usage: UsageTotals;
  costUsd: number;
}

export interface UsageSnapshot {
  days: number;
  runs: number;
  usage: UsageTotals;
  costUsd: number;
  byRef: UsageAggregate[];
  byDay: Array<{ day: string; runs: number; usage: UsageTotals; costUsd: number }>;
}

export interface RecordUsageInput {
  ref: string;
  providerId: string;
  modelId: string;
  usage: UsageTotals;
  costUsd: number;
  at?: number;
}

/** 记账是非关键路径：读失败当空账本，写失败只留日志，绝不阻塞智能体运行。 */
export class ModelUsageStore {
  private entries: UsageEntry[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly onError: (message: string) => void = () => {}) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      try {
        const parsed = await readJson<UsageFile | null>(this.file, null);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isEntry) : [];
        this.entries = entries.map((entry) => ({ ...entry, usage: isUsage(entry.usage) ?? emptyUsage() }));
      } catch (err) {
        this.onError(`用量账本读取失败：${err instanceof Error ? err.message : String(err)}`);
        this.entries = [];
      }
      this.loaded = true;
    })();
    await this.loadPromise;
  }

  /** 合并进内存账本并延迟落盘（一次运行内的多次工具调用会共享同一个日聚合）。 */
  async record(input: RecordUsageInput): Promise<void> {
    await this.ensureLoaded();
    const at = input.at ?? Date.now();
    const day = dayKey(at);
    const usage = isUsage(input.usage) ?? emptyUsage();
    if (
      usage.input === 0 &&
      usage.output === 0 &&
      usage.cacheRead === 0 &&
      usage.cacheWrite === 0 &&
      !(input.costUsd > 0)
    ) {
      return;
    }
    const existing = this.entries.find((entry) => entry.ref === input.ref && entry.day === day);
    if (existing) {
      existing.runs += 1;
      existing.usage = addUsage(existing.usage, usage);
      existing.costUsd += Number.isFinite(input.costUsd) ? input.costUsd : 0;
      existing.updatedAt = at;
    } else {
      this.entries.push({
        ref: input.ref,
        providerId: input.providerId,
        modelId: input.modelId,
        day,
        runs: 1,
        usage,
        costUsd: Number.isFinite(input.costUsd) ? input.costUsd : 0,
        updatedAt: at,
      });
    }
    this.prune(at);
    this.scheduleFlush();
  }

  private prune(now: number): void {
    const cutoff = dayKey(now - RETENTION_DAYS * 86_400_000);
    this.entries = this.entries.filter((entry) => entry.day >= cutoff);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.sort((a, b) => b.updatedAt - a.updatedAt);
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot: UsageFile = { version: USAGE_STORE_VERSION, entries: this.entries };
    this.writeChain = this.writeChain
      .then(() => writeJsonAtomic(this.file, snapshot))
      .catch((err: unknown) => {
        this.onError(`用量账本写入失败：${err instanceof Error ? err.message : String(err)}`);
      });
    await this.writeChain;
  }

  /** 最近 `days` 天的用量汇总；可按供应商过滤，供模型面板与 /status 展示。 */
  async snapshot(options: { days?: number; providerId?: string } = {}): Promise<UsageSnapshot> {
    await this.ensureLoaded();
    const days = Math.max(1, Math.min(RETENTION_DAYS, options.days ?? 7));
    const from = dayKey(Date.now() - (days - 1) * 86_400_000);
    const scoped = this.entries.filter(
      (entry) => entry.day >= from && (!options.providerId || entry.providerId === options.providerId),
    );
    const byRef = new Map<string, UsageAggregate>();
    const byDay = new Map<string, { day: string; runs: number; usage: UsageTotals; costUsd: number }>();
    let usage = emptyUsage();
    let costUsd = 0;
    let runs = 0;
    for (const entry of scoped) {
      const ref = byRef.get(entry.ref) ?? {
        ref: entry.ref,
        providerId: entry.providerId,
        modelId: entry.modelId,
        runs: 0,
        usage: emptyUsage(),
        costUsd: 0,
      };
      ref.runs += entry.runs;
      ref.usage = addUsage(ref.usage, entry.usage);
      ref.costUsd += entry.costUsd;
      byRef.set(entry.ref, ref);

      const day = byDay.get(entry.day) ?? { day: entry.day, runs: 0, usage: emptyUsage(), costUsd: 0 };
      day.runs += entry.runs;
      day.usage = addUsage(day.usage, entry.usage);
      day.costUsd += entry.costUsd;
      byDay.set(entry.day, day);

      usage = addUsage(usage, entry.usage);
      costUsd += entry.costUsd;
      runs += entry.runs;
    }
    return {
      days,
      runs,
      usage,
      costUsd,
      byRef: [...byRef.values()].sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    };
  }

  /** 删除用户/重置工作区时清账。 */
  async clear(): Promise<void> {
    this.entries = [];
    await this.flush();
  }
}
