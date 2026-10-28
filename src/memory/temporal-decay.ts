/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * extensions/memory-core/src/memory/temporal-decay.ts。
 * 适配：本项目没有插件配置的 extraPaths（选择性引用参考路径），该分支删除；
 * 其余时间戳选择规则逐字保留：日期命名文件按文件名日期、规范记忆路径
 * （MEMORY.md/USER.md/memory/ 主题文件）永不过期、sessions 源用索引记录的 mtime。
 */

import fs from "node:fs/promises";
import path from "node:path";

export type TemporalDecayConfig = { enabled: boolean; halfLifeDays: number };

export type MemorySource = "memory" | "sessions";

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;

function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const { halfLifeDays } = params;
  const clampedAge = Math.max(0, params.ageInDays);
  if (!Number.isFinite(clampedAge)) {
    return params.score;
  }
  return params.score * Math.exp(-(Math.LN2 / halfLifeDays) * clampedAge);
}

async function extractTimestamp(params: {
  filePath: string;
  source?: string;
  workspaceDir?: string;
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  memorySourceMtimes?: ReadonlyMap<string, number | undefined>;
}): Promise<Date | null> {
  if (params.source === "sessions") {
    // Session paths are logical identities, not workspace files. Ranking uses
    // the indexed source activity, never a same-named filesystem artifact.
    const mtime = params.sessionSourceMtimes?.get(params.filePath);
    return mtime !== undefined && Number.isFinite(mtime) ? new Date(mtime) : null;
  }
  const normalized = params.filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const absolutePath = params.workspaceDir
    ? path.resolve(params.workspaceDir, params.filePath)
    : undefined;
  const canonicalPath =
    absolutePath && params.workspaceDir
      ? path.relative(params.workspaceDir, absolutePath).replaceAll("\\", "/").replace(/^\.\//, "")
      : normalized;
  const isCanonicalMemoryPath =
    canonicalPath === "MEMORY.md" ||
    canonicalPath === "USER.md" ||
    canonicalPath.startsWith("memory/");

  const match = DATED_MEMORY_PATH_RE.exec(normalized);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ) {
      return parsed;
    }
  }

  // Memory root/topic files are evergreen knowledge and should not decay.
  if (
    params.source === "memory" &&
    (normalized === "MEMORY.md" ||
      normalized === "USER.md" ||
      (canonicalPath === normalized && normalized.startsWith("memory/") && !match))
  ) {
    return null;
  }

  if (params.source === "memory" && params.memorySourceMtimes) {
    // Index-recorded mtimes win over filesystem paths already inside the index.
    const mtime = params.memorySourceMtimes.get(params.filePath);
    return mtime !== undefined && Number.isFinite(mtime) ? new Date(mtime) : null;
  }

  if (!absolutePath) {
    return null;
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    return new Date(stat.mtimeMs);
  } catch {
    return null;
  }
}

export async function applyTemporalDecayToHybridResults<
  T extends { path: string; score: number; source: string },
>(params: {
  results: T[];
  temporalDecay: TemporalDecayConfig;
  workspaceDir?: string;
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  memorySourceMtimes?: ReadonlyMap<string, number | undefined>;
  nowMs?: number;
}): Promise<T[]> {
  const config = params.temporalDecay;
  if (!config.enabled) {
    return [...params.results];
  }

  const nowMs = params.nowMs ?? Date.now();
  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    params.results.map(async (entry) => {
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir: params.workspaceDir,
          sessionSourceMtimes: params.sessionSourceMtimes,
          memorySourceMtimes: params.memorySourceMtimes,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return entry;
      }

      const decayedScore = applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: (nowMs - timestamp.getTime()) / DAY_MS,
        halfLifeDays: config.halfLifeDays,
      });

      return {
        ...entry,
        score: decayedScore,
      };
    }),
  );
}
