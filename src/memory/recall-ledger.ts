/**
 * 召回留痕账本（移植 gbrain 的 retrieval feedback ledger 思路）：
 * 记两件事——本轮**主动注入**了哪些记忆（volunteered），以及这些记忆**后来被引用**了没有（used）。
 * 只追加 JSONL，不参与检索；维护巡检据此判断「召回了但没人用」的记忆是否该降权或清理。
 *
 * 口径：
 * - volunteered 由 lane-1 触发召回写入，一条命中一行，带 path#L 引用与分数；
 * - used 只在最终交付文本里出现对应 `Source: path#Lx` 引用时才记，不猜「模型可能用了」；
 * - 账本是工作区级旁路，写入失败一律 fail-open，绝不影响本轮回复。
 */

import fs from "node:fs/promises";

const MAX_QUERY_CHARS = 200;
const MAX_PATH_CHARS = 300;
export const DEFAULT_COMPACT_KEEP = 2000;
const CITATION_RE = /Source:\s*([^\s#]+)#L(\d+)(?:-L(\d+))?/giu;

export interface RecallHitRef {
  path: string;
  startLine: number;
  endLine?: number;
  entryId?: string;
  citation?: string;
  score?: number;
}

interface RecallEventBase {
  ts: number;
  roomId: string;
  agentId: string;
  runId: string;
  path: string;
  startLine: number;
  endLine?: number;
  entryId?: string;
  citation: string;
}

export interface RecallVolunteeredEvent extends RecallEventBase {
  type: "volunteered";
  /** 触发召回的那条消息（截断），用来回看「为什么会注入这条」。 */
  query: string;
  score: number;
}

export interface RecallUsedEvent extends RecallEventBase {
  type: "used";
}

export type RecallLedgerEvent = RecallVolunteeredEvent | RecallUsedEvent;

export interface RecallLedgerContext {
  roomId: string;
  agentId: string;
  runId: string;
}

function bounded(value: string, max: number): string {
  const clean = value.replace(/[\r\n]+/gu, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

export function recallCitation(hit: RecallHitRef): string {
  return hit.citation ?? `${hit.path}#L${String(hit.startLine)}`;
}

/** 从交付文本里抽取 `Source: path#Lx[-Ly]`，与注入过的命中按行区间求重叠。 */
export function findCitedRecallHits(
  text: string,
  hits: readonly RecallHitRef[],
): RecallHitRef[] {
  const cited: Array<{ path: string; start: number; end: number }> = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const rawPath = match[1]?.trim().replace(/^\.\//u, "");
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (!rawPath || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    cited.push({ path: rawPath, start, end });
  }
  if (cited.length === 0) return [];
  const matched: RecallHitRef[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const hitPath = hit.path.replace(/^\.\//u, "");
    const hitStart = hit.startLine;
    const hitEnd = hit.endLine ?? hit.startLine;
    const used = cited.some(
      (citation) =>
        citation.path === hitPath && citation.start <= hitEnd && citation.end >= hitStart,
    );
    if (!used) continue;
    const key = `${hitPath}:${hit.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(hit);
  }
  return matched;
}

function asEvent(value: unknown): RecallLedgerEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== "volunteered" && type !== "used") return undefined;
  if (
    typeof record.ts !== "number" ||
    !Number.isFinite(record.ts) ||
    typeof record.roomId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.startLine !== "number" ||
    typeof record.citation !== "string"
  ) {
    return undefined;
  }
  const base: RecallEventBase = {
    ts: record.ts,
    roomId: record.roomId,
    agentId: record.agentId,
    runId: record.runId,
    path: record.path,
    startLine: record.startLine,
    citation: record.citation,
    ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
    ...(typeof record.entryId === "string" ? { entryId: record.entryId } : {}),
  };
  if (type === "used") return { type, ...base };
  if (typeof record.query !== "string" || typeof record.score !== "number") return undefined;
  return { type, ...base, query: record.query, score: record.score };
}

export class RecallLedger {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onError: (message: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 同步返回、按顺序异步追加：记录召回不能拖慢正在说话的成员。 */
  record(events: readonly RecallLedgerEvent[]): void {
    if (events.length === 0) return;
    const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    this.chain = this.chain.then(() =>
      fs.appendFile(this.file, payload, "utf8").catch((error: unknown) => {
        this.onError(`召回账本写入失败：${error instanceof Error ? error.message : String(error)}`);
      }),
    );
  }

  volunteeredEvents(context: RecallLedgerContext, query: string, hits: readonly RecallHitRef[]): RecallVolunteeredEvent[] {
    const ts = this.now();
    const safeQuery = bounded(query, MAX_QUERY_CHARS);
    return hits.map((hit) => ({
      type: "volunteered",
      ts,
      ...context,
      path: bounded(hit.path, MAX_PATH_CHARS),
      startLine: hit.startLine,
      ...(hit.endLine !== undefined ? { endLine: hit.endLine } : {}),
      ...(hit.entryId ? { entryId: hit.entryId } : {}),
      citation: recallCitation(hit),
      query: safeQuery,
      score: Math.round((hit.score ?? 0) * 1000) / 1000,
    }));
  }

  usedEvents(context: RecallLedgerContext, hits: readonly RecallHitRef[]): RecallUsedEvent[] {
    const ts = this.now();
    return hits.map((hit) => ({
      type: "used",
      ts,
      ...context,
      path: bounded(hit.path, MAX_PATH_CHARS),
      startLine: hit.startLine,
      ...(hit.endLine !== undefined ? { endLine: hit.endLine } : {}),
      ...(hit.entryId ? { entryId: hit.entryId } : {}),
      citation: recallCitation(hit),
    }));
  }

  async list(limit = 200): Promise<RecallLedgerEvent[]> {
    await this.flush();
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const events: RecallLedgerEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = asEvent(JSON.parse(line));
        if (event) events.push(event);
      } catch {
        // 坏行跳过：账本是旁路，不值得为一行半截 JSON 丢掉整份历史。
      }
    }
    const boundedLimit = Math.max(1, Math.min(DEFAULT_COMPACT_KEEP * 10, Math.floor(limit)));
    return events.slice(-boundedLimit);
  }

  /** 只保留最近 keep 条；返回压缩前后条数，维护巡检据此汇报。 */
  async compact(keep = DEFAULT_COMPACT_KEEP): Promise<{ kept: number; dropped: number }> {
    const events = await this.list(Number.MAX_SAFE_INTEGER);
    const keepCount = Math.max(1, Math.floor(keep));
    if (events.length <= keepCount) {
      return { kept: events.length, dropped: 0 };
    }
    const keptEvents = events.slice(-keepCount);
    const payload = keptEvents.map((event) => `${JSON.stringify(event)}\n`).join("");
    await this.flush();
    this.chain = this.chain.then(() => fs.writeFile(this.file, payload, "utf8"));
    await this.flush();
    return { kept: keptEvents.length, dropped: events.length - keptEvents.length };
  }

  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
  }
}
