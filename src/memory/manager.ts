/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * - extensions/memory-core/src/memory/manager-search-orchestration.ts（search 编排：
 *   candidate 窗口、keyword-only 收尾、hybrid 合并选择、bootstrap sync —— 结构与常量逐项对应）
 * - extensions/memory-core/src/memory/manager-search.ts（prepareExactPathMatcher、
 *   scoreFallbackKeywordResult、normalizeSearchTokens/literalSearchMatcher 用法、
 *   searchKeywordWithFallback 的 AND→OR 回退语义）
 * - extensions/memory-core/src/memory/manager-search-retrieval.ts（SNIPPET_MAX_CHARS=700、
 *   finalizeKeywordOnlyResults、compareKeywordSearchHits）
 * - extensions/memory-core/src/agents/memory-search.ts（默认值：maxResults 6、minScore 0.35、
 *   hybrid vector 0.7 / text 0.3、candidateMultiplier 4、MMR 0.7、timeDecay 30 天、chunking 400/80、
 *   sessions deltaBytes 100000 / deltaMessages 50）
 * - packages/memory-host-sdk/src/host/internal.ts（listMemoryFiles/buildFileEntry 的发现规则：
 *   MEMORY.md、USER.md、memory/**.md，跳过符号链接，按 hash 增量重建）
 * 适配（重要）：
 * - 存储层用进程内倒排 BM25 索引替代 SQLite FTS5；相关度用标准 Okapi BM25 公式，
 *   再经与 bm25RankToScore(rank<0) 相同的 relevance/(1+relevance) 饱和模型映射到 (0,1)。
 * - unicode61 对整段 CJK 会产生超长单 token，OpenClaw 用非 ASCII substring 计划兜底；
 *   这里对非 ASCII token 直接做子串命中，ASCII token 保持整词命中。
 * - 向量分数经 (1+cosine)/2 映射进 hybrid 的饱和域，保证 keyword-scale 反饱和数学成立。
 * - 多模态、extraPaths、provenance、PostgreSQL 通道、跨进程 worker 不在移植范围。
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Member } from "../core/types";
import type { RoomBus } from "../room/bus";
import {
  extractCuratedEntryRecallMetadata,
  stripMemoryAnnotationCarriers,
} from "./annotations";
import { AGENT_FILE_ORDER, ensureMemberAgentFiles } from "./bootstrap-files";
import { chunkMarkdown, hashText, remapChunkLines, type MemoryChunk } from "./chunking";
import type { MemoryEmbeddingProvider } from "./embedding";
import { cosineSimilarity, HashProjectionEmbeddingProvider } from "./embedding";
import { mergeHybridResults, scoreExactPathTieForTemporalDecay, selectHybridSearchResults } from "./hybrid";
import { applyMMRToHybridResults, type MMRConfig } from "./mmr";
import {
  applyRetrievalRanking,
  prepareActiveProjectKeys,
  projectScoreMultiplier,
} from "./project-ranking";
import type { MemorySource, TemporalDecayConfig } from "./temporal-decay";
import { applyTemporalDecayToHybridResults } from "./temporal-decay";
import {
  bm25RelevanceToScore,
  literalSearchMatcher,
  normalizeSearchTokens,
} from "./tokenize";

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const SEARCH_CANDIDATE_UNIVERSE = 200;
const SNIPPET_MAX_CHARS = 700;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SESSION_MAX_MESSAGES = 500;
/** 「智能体文件」面板的保存上限（256 KB，与技能文件的单文件口径一致）。 */
const MAX_AGENT_FILE_BYTES = 256 * 1024;

export interface MemorySearchSettings {
  chunking: { tokens: number; overlap: number };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: MMRConfig;
      temporalDecay: TemporalDecayConfig;
    };
  };
}

export const DEFAULT_MEMORY_SEARCH_SETTINGS: MemorySearchSettings = {
  chunking: { tokens: 400, overlap: 80 },
  query: {
    maxResults: 6,
    minScore: 0.35,
    hybrid: {
      enabled: true,
      vectorWeight: 0.7,
      textWeight: 0.3,
      candidateMultiplier: 4,
      mmr: { enabled: true, lambda: 0.7 },
      temporalDecay: { enabled: true, halfLifeDays: 30 },
    },
  },
};

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore: number;
  textScore: number;
  snippet: string;
  source: MemorySource;
  importance?: number;
  triggers?: string;
  projectKey?: string;
}

interface IndexedChunk {
  id: string;
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  snippet: string;
  tokens: string[];
  tokenSet: Set<string>;
  lowerText: string;
  embedding: number[];
  importance?: number;
  triggers?: string;
  projectKey?: string;
}

interface ExactPathHit {
  id: string;
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  exactPathSpecificity: 0 | 1 | 2 | 3;
  pathScore: number;
}

interface BodyKeywordHit {
  id: string;
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  textScore: number;
  hasBodyMatch: boolean;
  importance?: number;
  triggers?: string;
  projectKey?: string;
}

type KeywordHit = BodyKeywordHit & {
  pathScore: number;
  exactPathSpecificity: 0 | 1 | 2 | 3;
};

interface FileState {
  path: string;
  absPath: string;
  hash: string;
  mtimeMs: number;
}

function normalizePathIdentifier(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").normalize("NFC").toLowerCase();
}

/** 逐字移植自 manager-search.ts prepareExactPathMatcher。 */
export function prepareExactPathMatcher(
  query: string,
): (candidatePath: string) => 0 | 1 | 2 | 3 {
  const normalizedQuery = normalizePathIdentifier(query);
  if (!normalizedQuery || normalizedQuery === ".") {
    return () => 0;
  }
  const hasDirectory = normalizedQuery.includes("/");
  return (candidatePath) => {
    const normalizedPath = normalizePathIdentifier(candidatePath);
    if (normalizedQuery === normalizedPath) {
      return 3;
    }
    if (hasDirectory) {
      return 0;
    }
    const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
    if (normalizedQuery === basename) {
      return 2;
    }
    const extensionIndex = basename.lastIndexOf(".");
    const stem = extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
    return normalizedQuery === stem ? 1 : 0;
  };
}

/** 逐字移植自 manager-search.ts scoreFallbackKeywordResult。 */
function scoreFallbackKeywordResult(params: {
  queryMatchers: Array<{ word: RegExp; substring: RegExp }>;
  path: string;
  text: string;
  ftsScore: number;
}): number {
  const { queryMatchers } = params;
  if (queryMatchers.length === 0) {
    return params.ftsScore;
  }

  const textTokens = normalizeSearchTokens(params.text);
  const textTokenSet = new Set(textTokens);
  const overlap = queryMatchers.filter(({ word }) =>
    textTokens.some((token) => word.test(token)),
  ).length;
  const uniqueQueryOverlap = overlap / queryMatchers.length;
  const density = overlap / Math.max(textTokenSet.size, 1);
  const normalizedPath = params.path.normalize("NFC");
  const pathBoost = queryMatchers.reduce(
    (score, { substring }) => score + (substring.test(normalizedPath) ? 0.18 : 0),
    0,
  );
  const textLengthBoost = Math.min(params.text.length / 160, 0.18);

  const lexicalBoost = uniqueQueryOverlap * 0.45 + density * 0.2 + pathBoost + textLengthBoost;
  // Scale boosts into the remaining headroom so relevance survives recency weighting.
  return (params.ftsScore + lexicalBoost) / (1 + lexicalBoost);
}

function compareKeywordSearchHits(
  a: KeywordHit,
  b: KeywordHit,
  preferExactBody = true,
): number {
  const specificityDelta = b.exactPathSpecificity - a.exactPathSpecificity;
  if (specificityDelta !== 0) {
    return specificityDelta;
  }
  if (preferExactBody && a.exactPathSpecificity > 0) {
    const bodyPresenceDelta = Number(b.hasBodyMatch) - Number(a.hasBodyMatch);
    if (bodyPresenceDelta !== 0) {
      return bodyPresenceDelta;
    }
  }
  const relevanceDelta = b.score - a.score;
  if (relevanceDelta !== 0) {
    return relevanceDelta;
  }
  const textDelta = b.textScore - a.textScore;
  if (textDelta !== 0) {
    return textDelta;
  }
  if (a.exactPathSpecificity === 0) {
    const pathDelta = b.pathScore - a.pathScore;
    if (pathDelta !== 0) {
      return pathDelta;
    }
  }
  return (
    a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine ||
    a.id.localeCompare(b.id)
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0 && count < 64) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface MemorySearchManagerOptions {
  workspaceDir: string;
  bus: RoomBus;
  settings?: MemorySearchSettings;
  /** null = FTS-only（对应 OpenClaw provider "none" 哨兵）。 */
  embeddingProvider?: MemoryEmbeddingProvider | null;
}

export class MemorySearchManager {
  private readonly settings: MemorySearchSettings;
  private readonly provider: MemoryEmbeddingProvider | null;
  private chunks: IndexedChunk[] = [];
  private fileStates = new Map<string, FileState>();
  private bodyDf = new Map<string, number>();
  private pathDf = new Map<string, number>();
  private avgBodyLen = 0;
  private avgPathLen = 0;
  private dirty = true;
  private sessionState = { count: -1, maxTs: 0, bytes: 0 };
  private sessionMtimes = new Map<string, number>();
  private memoryMtimes = new Map<string, number>();
  private syncPromise: Promise<void> | null = null;

  constructor(private readonly options: MemorySearchManagerOptions) {
    this.settings = options.settings ?? structuredClone(DEFAULT_MEMORY_SEARCH_SETTINGS);
    this.provider =
      options.embeddingProvider === undefined
        ? new HashProjectionEmbeddingProvider()
        : options.embeddingProvider;
  }

  markDirty(): void {
    this.dirty = true;
  }

  getSettings(): MemorySearchSettings {
    return this.settings;
  }

  /** 对应 OpenClaw sync(reason:"search")：dirty 时重建索引；search 前调用。 */
  async sync(): Promise<void> {
    if (this.syncPromise) {
      await this.syncPromise;
      this.syncPromise = null;
    }
    if (!this.dirty) return;
    const promise = this.syncOnce();
    this.syncPromise = promise;
    try {
      await promise;
      this.dirty = false;
    } finally {
      if (this.syncPromise === promise) this.syncPromise = null;
    }
  }

  private async syncOnce(): Promise<void> {
    const entries: IndexedChunk[] = [];
    const memoryFiles = await this.listIndexMemoryFiles();
    const nextStates = new Map<string, FileState>();
    const nextMtimes = new Map<string, number>();
    for (const absPath of memoryFiles) {
      const fileState = await this.buildFileEntry(absPath);
      if (!fileState) continue;
      nextStates.set(fileState.path, fileState);
      nextMtimes.set(fileState.path, fileState.mtimeMs);
      const content = await fs.readFile(fileState.absPath, "utf8");
      const lines = content.split("\n");
      for (const chunk of chunkMarkdown(content, {
        ...this.settings.chunking,
        perEntry: true,
      })) {
        entries.push(
          this.buildChunk({
            source: "memory",
            fileState,
            chunk,
            lines,
          }),
        );
      }
    }
    this.fileStates = nextStates;
    this.memoryMtimes = nextMtimes;

    const messages = this.options.bus.listMessages(SESSION_MAX_MESSAGES);
    const nextSessionState = {
      count: messages.length,
      maxTs: messages.reduce((max, message) => Math.max(max, message.ts), 0),
      bytes: this.sessionBytesOf(messages),
    };
    const sessionMtimes = new Map<string, number>();
    // 适配：内存索引每次重建都完整收录当前群聊窗口（OpenClaw 的 delta 门控服务于
    // 昂贵的外部 embedding 批量计费，本地哈希投影无需增量）。
    if (nextSessionState.count > 0) {
      const roomPath = `sessions/${this.options.bus.roomId}.md`;
      sessionMtimes.set(roomPath, nextSessionState.maxTs);
      const lines: string[] = [];
      const lineMap: number[] = [];
      for (const message of messages) {
        const who =
          message.senderKind === "user"
            ? `${message.senderName}（用户）`
            : message.senderKind === "system"
              ? "系统"
              : `@${message.senderName}`;
        const meta = message.taskId ? `${who} 任务 ${message.taskId}` : who;
        lines.push(`#${message.seq} ${meta}: ${message.text}`);
        lineMap.push(message.seq);
      }
      const content = lines.join("\n");
      const state: FileState = {
        path: roomPath,
        absPath: roomPath,
        hash: hashText(content),
        mtimeMs: nextSessionState.maxTs,
      };
      const chunks = chunkMarkdown(content, this.settings.chunking);
      remapChunkLines(chunks, lineMap);
      for (const chunk of chunks) {
        entries.push(
          this.buildChunk({
            source: "sessions",
            fileState: state,
            chunk,
            lines: [],
          }),
        );
      }
    }
    this.sessionState = nextSessionState;
    this.sessionMtimes = sessionMtimes;

    let embeddings: number[][] = [];
    if (this.provider && entries.length > 0) {
      try {
        embeddings = await this.provider.embed(entries.map((entry) => stripMemoryAnnotationCarriers(entry.text)));
      } catch {
        embeddings = [];
      }
    }
    entries.forEach((entry, index) => {
      entry.embedding = embeddings[index] ?? [];
    });

    this.chunks = entries;
    this.rebuildStatistics();
  }

  private sessionBytesOf(messages: ReturnType<RoomBus["listMessages"]>): number {
    let bytes = 0;
    for (const message of messages) bytes += message.text.length * 2 + 32;
    return bytes;
  }

  private buildChunk(params: {
    source: MemorySource;
    fileState: FileState;
    chunk: MemoryChunk;
    lines: string[];
  }): IndexedChunk {
    const { source, fileState, chunk, lines } = params;
    let importance: number | undefined;
    let triggers: string | undefined;
    let projectKey: string | undefined;
    if (source === "memory" && chunk.entryStartLine !== undefined && chunk.entryEndLine !== undefined) {
      const metadata = extractCuratedEntryRecallMetadata({
        sourceLines: lines.slice(chunk.entryStartLine - 1, chunk.entryEndLine),
        curatedRoot: true,
        projectScopeEligible: true,
      });
      importance = metadata.importance ?? undefined;
      triggers = metadata.triggers ?? undefined;
      projectKey = metadata.projectKey ?? undefined;
    }
    const tokens = normalizeSearchTokens(chunk.text);
    return {
      id: `${source}:${fileState.path}:${chunk.startLine}:${chunk.endLine}`,
      source,
      path: fileState.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      snippet: chunk.text.slice(0, SNIPPET_MAX_CHARS),
      tokens,
      tokenSet: new Set(tokens),
      lowerText: chunk.text.normalize("NFC").toLowerCase(),
      embedding: [],
      ...(importance !== undefined ? { importance } : {}),
      ...(triggers !== undefined ? { triggers } : {}),
      ...(projectKey !== undefined ? { projectKey } : {}),
    };
  }

  private rebuildStatistics(): void {
    this.bodyDf = new Map();
    this.pathDf = new Map();
    let bodyTotal = 0;
    let pathTotal = 0;
    const seenIds = new Set<string>();
    for (const chunk of this.chunks) {
      bodyTotal += chunk.tokens.length;
      for (const token of new Set(chunk.tokens)) {
        this.bodyDf.set(token, (this.bodyDf.get(token) ?? 0) + 1);
      }
      if (!seenIds.has(`${chunk.source}:${chunk.path}`)) {
        seenIds.add(`${chunk.source}:${chunk.path}`);
        const pathTokens = new Set(normalizeSearchTokens(chunk.path));
        pathTotal += pathTokens.size;
        for (const token of pathTokens) {
          this.pathDf.set(token, (this.pathDf.get(token) ?? 0) + 1);
        }
      }
    }
    this.avgBodyLen = this.chunks.length > 0 ? bodyTotal / this.chunks.length : 0;
    this.avgPathLen = seenIds.size > 0 ? pathTotal / seenIds.size : 0;
  }

  private tokenHitsDocument(token: string, chunk: IndexedChunk): boolean {
    return chunk.tokenSet.has(token) || (!isAscii(token) && chunk.lowerText.includes(token));
  }

  private termFrequency(token: string, chunk: IndexedChunk): number {
    const inSet = chunk.tokenSet.has(token);
    if (!inSet && !isAscii(token)) {
      return countOccurrences(chunk.lowerText, token);
    }
    let count = 0;
    for (const candidate of chunk.tokens) {
      if (candidate === token) count += 1;
    }
    return count;
  }

  private bm25BodyScore(queryTokens: string[], chunk: IndexedChunk, totalDocs: number): number {
    let relevance = 0;
    const dl = chunk.tokens.length;
    const avg = this.avgBodyLen || 1;
    for (const token of queryTokens) {
      const tf = this.termFrequency(token, chunk);
      if (tf === 0) continue;
      const df = this.bodyDf.get(token) ?? 1;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      relevance += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avg)));
    }
    return bm25RelevanceToScore(relevance);
  }

  private searchBodyKeyword(
    queryTokens: string[],
    limit: number,
    sources: readonly MemorySource[],
    matchAny: boolean,
    agentId?: string,
  ): BodyKeywordHit[] {
    if (queryTokens.length === 0) return [];
    const visibleChunks = this.chunks.filter((chunk) => this.chunkVisibleTo(chunk.path, agentId));
    const totalDocs = visibleChunks.length;
    const sourceSet = new Set(sources);
    const hits: BodyKeywordHit[] = [];
    for (const chunk of visibleChunks) {
      if (!sourceSet.has(chunk.source)) continue;
      const matched = queryTokens.filter((token) => this.tokenHitsDocument(token, chunk));
      if (matched.length === 0) continue;
      if (!matchAny && matched.length !== queryTokens.length) continue;
      const score = this.bm25BodyScore(matched, chunk, totalDocs);
      if (score <= 0) continue;
      hits.push({
        id: chunk.id,
        source: chunk.source,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: chunk.snippet,
        score,
        textScore: score,
        hasBodyMatch: true,
        ...(chunk.importance !== undefined ? { importance: chunk.importance } : {}),
        ...(chunk.triggers !== undefined ? { triggers: chunk.triggers } : {}),
        ...(chunk.projectKey !== undefined ? { projectKey: chunk.projectKey } : {}),
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine)
      .slice(0, limit);
  }

  private searchPathKeyword(
    queryTokens: string[],
    limit: number,
    sources: readonly MemorySource[],
    query: string,
    agentId?: string,
  ): ExactPathHit[] {
    const matchExactPath = prepareExactPathMatcher(query);
    const sourceSet = new Set(sources);
    const visibleChunks = this.chunks.filter((chunk) => this.chunkVisibleTo(chunk.path, agentId));
    const totalPaths = new Set(visibleChunks.map((chunk) => `${chunk.source}:${chunk.path}`)).size || 1;
    const results = new Map<string, ExactPathHit>();
    const firstChunks = new Map<string, IndexedChunk>();
    for (const chunk of visibleChunks) {
      const key = `${chunk.source}:${chunk.path}`;
      if (!firstChunks.has(key)) firstChunks.set(key, chunk);
    }
    for (const chunk of firstChunks.values()) {
      if (!sourceSet.has(chunk.source)) continue;
      const normalizedPath = normalizePathIdentifier(chunk.path);
      const specificity = matchExactPath(chunk.path);
      const pathTokens = new Set(normalizeSearchTokens(normalizedPath));
      const matched = queryTokens.filter((token) => pathTokens.has(token) || normalizedPath.includes(token));
      const pathScore =
        matched.length === 0
          ? 0
          : bm25RelevanceToScore(
              matched.reduce((sum, token) => {
                const df = this.pathDf.get(token) ?? 1;
                return sum + Math.log(1 + (totalPaths - df + 0.5) / (df + 0.5));
              }, 0),
            );
      if (specificity === 0 && pathScore === 0) continue;
      const hit: ExactPathHit = {
        id: chunk.id,
        source: chunk.source,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: chunk.snippet,
        exactPathSpecificity: specificity,
        pathScore,
      };
      const existing = results.get(hit.id);
      if (existing) {
        existing.pathScore = Math.max(existing.pathScore, hit.pathScore);
        existing.exactPathSpecificity = Math.max(
          existing.exactPathSpecificity,
          hit.exactPathSpecificity,
        ) as 0 | 1 | 2 | 3;
      } else {
        results.set(hit.id, hit);
      }
    }
    return [...results.values()]
      .sort(
        (a, b) =>
          b.exactPathSpecificity - a.exactPathSpecificity ||
          b.pathScore - a.pathScore ||
          a.path.localeCompare(b.path),
      )
      .slice(0, limit);
  }

  /**
   * 检索主入口。编排流程对应 manager-search-orchestration.searchCandidates：
   * candidates = min(200, max(1, floor(maxResults * candidateMultiplier)))，
   * keyword（AND→空结果时 OR + path 命中），keyword-only 收尾或 hybrid 合并选择。
   */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sources?: MemorySource[];
      activeProjectKeys?: readonly string[];
      lexicalOnly?: boolean;
      signal?: AbortSignal;
      nowMs?: number;
      /** 子成员 ID：只让该成员检索到自己的 agents/<id>/ 记忆文件。 */
      agentId?: string;
    },
  ): Promise<MemorySearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    await this.sync();
    opts?.signal?.throwIfAborted();
    if (this.chunks.length === 0) return [];

    const hybrid = this.settings.query.hybrid;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const sources =
      opts?.sources && opts.sources.length > 0 ? [...new Set(opts.sources)] : (["memory", "sessions"] as MemorySource[]);
    const candidates = Math.min(
      SEARCH_CANDIDATE_UNIVERSE,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    const queryTokens = uniqueStrings(normalizeSearchTokens(normalizedQuery));
    const boostMatchers = queryTokens.map((token) => ({
      word: literalSearchMatcher(token, true),
      substring: literalSearchMatcher(token),
    }));

    let bodyHits = this.searchBodyKeyword(queryTokens, candidates, sources, false, opts?.agentId);
    const pathHits = this.searchPathKeyword(queryTokens, candidates, sources, normalizedQuery, opts?.agentId);
    if (bodyHits.length === 0 && pathHits.length === 0) {
      bodyHits = this.searchBodyKeyword(queryTokens, candidates, sources, true, opts?.agentId);
    }
    const boosted = bodyHits.map((hit) => ({
      ...hit,
      score: scoreFallbackKeywordResult({
        queryMatchers: boostMatchers,
        path: hit.path,
        text: this.chunkTextOf(hit.id, hit.snippet),
        ftsScore: hit.score,
      }),
    }));

    const keywordMerged: KeywordHit[] = [...boosted.map((hit) => ({
      ...hit,
      pathScore: 0,
      exactPathSpecificity: 0 as const,
    }))];
    const byId = new Map(keywordMerged.map((hit) => [hit.id, hit]));
    for (const hit of pathHits) {
      const chunk = this.chunkById(hit.id);
      if (!chunk) continue;
      const existing = byId.get(hit.id);
      if (existing) {
        existing.pathScore = Math.max(existing.pathScore, hit.pathScore);
        existing.exactPathSpecificity = Math.max(
          existing.exactPathSpecificity,
          hit.exactPathSpecificity,
        ) as KeywordHit["exactPathSpecificity"];
        continue;
      }
      byId.set(hit.id, {
        id: hit.id,
        source: hit.source,
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        snippet: hit.snippet,
        score: hit.pathScore > 0 ? hit.pathScore : 1,
        textScore: 0,
        hasBodyMatch: false,
        pathScore: hit.pathScore,
        exactPathSpecificity: hit.exactPathSpecificity,
        ...(chunk.importance !== undefined ? { importance: chunk.importance } : {}),
        ...(chunk.triggers !== undefined ? { triggers: chunk.triggers } : {}),
        ...(chunk.projectKey !== undefined ? { projectKey: chunk.projectKey } : {}),
      });
    }

    const keywordOnly = !this.provider || opts?.lexicalOnly === true || !hybrid.enabled;
    if (keywordOnly) {
      return this.finalizeKeywordOnlyResults({
        results: [...byId.values()],
        temporalDecay: hybrid.temporalDecay,
        maxResults,
        minScore,
        activeProjectKeys: opts?.activeProjectKeys,
        nowMs: opts?.nowMs,
      });
    }

    let queryVec: number[];
    try {
      queryVec = (await this.provider!.embed([normalizedQuery]))[0] ?? [];
    } catch {
      return this.finalizeKeywordOnlyResults({
        results: [...byId.values()],
        temporalDecay: hybrid.temporalDecay,
        maxResults,
        minScore,
        activeProjectKeys: opts?.activeProjectKeys,
        nowMs: opts?.nowMs,
      });
    }
    const hasVector = queryVec.some((value) => value !== 0);
    if (!hasVector) {
      return this.finalizeKeywordOnlyResults({
        results: [...byId.values()],
        temporalDecay: hybrid.temporalDecay,
        maxResults,
        minScore,
        activeProjectKeys: opts?.activeProjectKeys,
        nowMs: opts?.nowMs,
      });
    }

    const sourceSet = new Set(sources);
    const scoredVector: Array<{ hit: KeywordHit; vectorScore: number; exactPathSpecificity: 0 | 1 | 2 | 3 }> = [];
    for (const chunk of this.chunks) {
      if (!sourceSet.has(chunk.source) || chunk.embedding.length === 0) continue;
      if (!this.chunkVisibleTo(chunk.path, opts?.agentId)) continue;
      const cosine = cosineSimilarity(queryVec, chunk.embedding);
      if (cosine <= 0) continue;
      scoredVector.push({
        hit: {
          id: chunk.id,
          source: chunk.source,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          snippet: chunk.snippet,
          score: (1 + cosine) / 2,
          textScore: 0,
          hasBodyMatch: false,
          pathScore: 0,
          exactPathSpecificity: 0,
          ...(chunk.importance !== undefined ? { importance: chunk.importance } : {}),
          ...(chunk.triggers !== undefined ? { triggers: chunk.triggers } : {}),
          ...(chunk.projectKey !== undefined ? { projectKey: chunk.projectKey } : {}),
        },
        vectorScore: (1 + cosine) / 2,
        exactPathSpecificity: prepareExactPathMatcher(normalizedQuery)(chunk.path),
      });
    }
    scoredVector.sort((a, b) => b.vectorScore - a.vectorScore);
    const vectorTop = scoredVector.slice(0, candidates);

    const merged = await mergeHybridResults({
      vector: vectorTop.map((entry) => ({
        ...entry.hit,
        vectorScore: entry.vectorScore,
        exactPathSpecificity: entry.exactPathSpecificity,
      })),
      keyword: [...byId.values()].map((entry) => ({
        ...entry,
        rankingScore: entry.score,
      })),
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
      activeProjectKeys: opts?.activeProjectKeys,
      workspaceDir: this.options.workspaceDir,
      sessionSourceMtimes: this.sessionMtimes,
      memorySourceMtimes: this.memoryMtimes,
      nowMs: opts?.nowMs,
    });
    return selectHybridSearchResults({
      merged,
      keyword: [...byId.values()],
      vectorCandidates: vectorTop.map((entry) => entry.hit),
      maxResults,
      minScore,
    });
  }

  /** 逐字移植自 manager-search-retrieval.ts finalizeKeywordOnlyResults。 */
  private async finalizeKeywordOnlyResults(params: {
    results: KeywordHit[];
    temporalDecay: TemporalDecayConfig;
    maxResults: number;
    minScore: number;
    activeProjectKeys?: readonly string[];
    nowMs?: number;
  }): Promise<MemorySearchResult[]> {
    const appliesTemporalDecay = params.temporalDecay.enabled;
    const decayInputs = appliesTemporalDecay
      ? params.results.map((entry) => {
          if (entry.exactPathSpecificity === 0) {
            return entry;
          }
          const contentScore = entry.hasBodyMatch ? entry.score : 0;
          return { ...entry, score: scoreExactPathTieForTemporalDecay(contentScore) };
        })
      : params.results;
    const activeProjects = prepareActiveProjectKeys(params.activeProjectKeys);
    const weighted = applyRetrievalRanking(decayInputs, activeProjects);
    const strict = weighted.filter(
      (entry) =>
        (entry.exactPathSpecificity > 0
          ? projectScoreMultiplier(entry.projectKey, activeProjects)
          : entry.score) >= params.minScore,
    );
    const eligible = strict.length > 0 ? strict : weighted.filter((entry) => entry.score >= 0);
    const decayed = await applyTemporalDecayToHybridResults({
      results: eligible,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.options.workspaceDir,
      sessionSourceMtimes: this.sessionMtimes,
      memorySourceMtimes: this.memoryMtimes,
      nowMs: params.nowMs,
    });
    const ranked = decayed
      .sort((left, right) => compareKeywordSearchHits(left, right, !appliesTemporalDecay))
      .map((entry) =>
        entry.exactPathSpecificity > 0
          ? Object.assign(entry, {
              score: projectScoreMultiplier(entry.projectKey, activeProjects),
            })
          : entry,
      );
    return ranked
      .slice(0, params.maxResults)
      .map(({ id: _id, exactPathSpecificity: _s, pathScore: _p, hasBodyMatch: _b, ...entry }) => ({
        ...entry,
        // keyword-only 通道没有向量命中，vectorScore 恒为 0（口径与 hybrid 结果的公开字段对齐）。
        vectorScore: 0,
      }));
  }

  private chunkById(id: string): IndexedChunk | undefined {
    return this.chunks.find((chunk) => chunk.id === id);
  }

  private chunkTextOf(id: string, fallback: string): string {
    return this.chunkById(id)?.text ?? fallback;
  }

  /** 对应 listMemoryFiles：MEMORY.md、USER.md、memory/**.md（跳过符号链接根）。 */
  private async listMemoryFiles(): Promise<string[]> {
    const { workspaceDir } = this.options;
    const result: string[] = [];
    const canonical = path.join(workspaceDir, "MEMORY.md");
    if (await isRegularMarkdown(canonical)) result.push(canonical);
    const userFile = path.join(workspaceDir, "USER.md");
    if (await isRegularMarkdown(userFile)) result.push(userFile);
    const memoryDir = path.join(workspaceDir, "memory");
    try {
      const dirStat = await fs.lstat(memoryDir);
      if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
        await collectMarkdownFiles(memoryDir, result);
      }
    } catch {
      // missing memory dir is fine
    }
    return result;
  }

  /** 检索语料 = 共享记忆 + 每个子成员自己的 MEMORY.md / USER.md（按成员作用域过滤）。 */
  private async listIndexMemoryFiles(): Promise<string[]> {
    const result = await this.listMemoryFiles();
    const agentsDir = path.join(this.options.workspaceDir, "agents");
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(agentsDir, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of MEMBER_MEMORY_FILES) {
        const abs = path.join(agentsDir, entry.name, name);
        if (await isRegularMarkdown(abs)) result.push(abs);
      }
    }
    return result;
  }

  /** 子成员记忆只对它自己可见；共享语料（根部记忆、群聊转录）对所有成员可见。 */
  private chunkVisibleTo(relPath: string, agentId: string | undefined): boolean {
    if (!relPath.startsWith("agents/")) return true;
    return agentId !== undefined && relPath.startsWith(`agents/${agentId}/`);
  }

  private async buildFileEntry(absPath: string): Promise<FileState | null> {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return null;
      const content = await fs.readFile(absPath, "utf8");
      const relPath = path
        .relative(this.options.workspaceDir, absPath)
        .replaceAll("\\", "/");
      return { path: relPath, absPath, hash: hashText(content), mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Web 端「智能体文件」面板清单：记忆语料 + 身份/性格文件，按 bootstrap 顺序排列。
   * 选中子成员时改列它自己的档案（agents/<id>/），主智能体维持工作区根部的文件。
   */
  async listAgentFiles(
    memberId?: string,
  ): Promise<Array<{ path: string; sizeBytes: number; updatedAt: number }>> {
    const member = memberId ? this.options.bus.getMember(memberId) : undefined;
    if (member && member.role !== "main") {
      await this.ensureMemberFiles(member);
      return this.listMemberAgentFiles(member.id);
    }
    const { workspaceDir } = this.options;
    const files = await this.listMemoryFiles();
    for (const name of NON_MEMORY_AGENT_FILES) {
      const abs = path.join(workspaceDir, name);
      if (await isRegularMarkdown(abs)) files.push(abs);
    }
    const listed: Array<{ path: string; sizeBytes: number; updatedAt: number }> = [];
    for (const abs of files) {
      const entry = await this.buildFileEntry(abs);
      if (!entry) continue;
      try {
        const stat = await fs.stat(abs);
        listed.push({ path: entry.path, sizeBytes: stat.size, updatedAt: stat.mtimeMs });
      } catch {
        // 竞态删除：跳过
      }
    }
    return listed.sort(
      (left, right) => agentFileRank(left.path) - agentFileRank(right.path) || left.path.localeCompare(right.path),
    );
  }

  /** 子成员的档案目录第一次被打开时按其角色描述生成默认文件（只补缺失项）。 */
  private async ensureMemberFiles(member: Member): Promise<void> {
    const created = await this.ensureMemberProfile(member);
    if (created.length > 0) this.markDirty();
  }

  /** 生成子成员的默认档案（SOUL.md / IDENTITY.md），返回本次新建的文件名。 */
  async ensureMemberProfile(member: Member, parentName?: string): Promise<string[]> {
    const parent = parentName ?? (member.spawnedBy ? this.options.bus.getMember(member.spawnedBy)?.name : undefined);
    const brief = member.brief?.trim();
    return ensureMemberAgentFiles(this.options.workspaceDir, member.id, {
      memberName: member.name,
      brief: brief ? brief.slice(0, 800) : "由用户创建的成员，等待分配任务；职责写在给你的简报里。",
      roomName: this.options.bus.roomName,
      parentName: parent ?? "主智能体",
    });
  }

  /** 移除成员时删除它的档案目录 agents/<id>/；目录不存在视为已清理。 */
  async removeMemberProfile(memberId: string): Promise<void> {
    const agentsRoot = path.resolve(this.options.workspaceDir, "agents");
    const dir = path.resolve(agentsRoot, memberId);
    if (!dir.startsWith(`${agentsRoot}${path.sep}`)) throw new Error("成员 ID 不合法");
    await fs.rm(dir, { recursive: true, force: true });
  }

  private async listMemberAgentFiles(
    memberId: string,
  ): Promise<Array<{ path: string; sizeBytes: number; updatedAt: number }>> {
    const dir = path.join(this.options.workspaceDir, "agents", memberId);
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const listed: Array<{ path: string; sizeBytes: number; updatedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const abs = path.join(dir, entry.name);
      const file = await this.buildFileEntry(abs);
      if (!file) continue;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      listed.push({ path: file.path, sizeBytes: stat.size, updatedAt: stat.mtimeMs });
    }
    return listed.sort(
      (left, right) => agentFileRank(left.path) - agentFileRank(right.path) || left.path.localeCompare(right.path),
    );
  }

  /**
   * 「智能体文件」面板的读取口径：记忆根、工作区根部的身份文件，以及子成员档案。
   * 默认按预览行数截断；编辑时传 full 取全文，避免保存时覆盖掉预览之外的内容。
   */
  async readAgentFile(
    relPath: string,
    options?: { full?: boolean },
  ): Promise<{ content: string; truncated: boolean; totalLines: number; more: boolean }> {
    return this.readWithin(
      relPath,
      isAgentFileAllowed,
      `只允许读写 MEMORY.md、USER.md、SOUL.md、IDENTITY.md、memory/ 或 agents/<id>/ 下的文件：${relPath}`,
      options?.full ? { from: 1, lines: Number.MAX_SAFE_INTEGER, full: true } : undefined,
    );
  }

  /** 面板里的就地编辑：同一个白名单，落盘后重建记忆索引。 */
  async writeAgentFile(
    relPath: string,
    content: unknown,
  ): Promise<{ path: string; sizeBytes: number; totalLines: number }> {
    if (typeof content !== "string") throw new Error("文件内容必须是文本");
    if (content.includes("\0")) throw new Error("文件内容必须是文本，不能包含二进制字符");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > MAX_AGENT_FILE_BYTES) {
      throw new Error(`文件不能超过 ${MAX_AGENT_FILE_BYTES / 1024} KB`);
    }
    const normalized = String(relPath).trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized || path.isAbsolute(normalized)) throw new Error(`路径不合法：${relPath}`);
    const workspaceRoot = path.resolve(this.options.workspaceDir);
    const absPath = path.resolve(workspaceRoot, normalized);
    if (!isAgentFileAllowed(absPath, workspaceRoot)) {
      throw new Error(`只允许读写 MEMORY.md、USER.md、SOUL.md、IDENTITY.md、memory/ 或 agents/<id>/ 下的文件：${relPath}`);
    }
    const rel = path.relative(workspaceRoot, absPath).replaceAll("\\", "/");
    // 白名单已确认在可写范围内，父目录缺失（如新建 memory/ 文件）时补建。
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const realRoot = await fs.realpath(workspaceRoot).catch(() => workspaceRoot);
    const parentReal = await fs.realpath(path.dirname(absPath)).catch(() => undefined);
    if (!parentReal || (parentReal !== realRoot && !isPathInsideDir(realRoot, parentReal))) {
      throw new Error(`路径越出工作区：${relPath}`);
    }
    await fs.writeFile(absPath, content, "utf8");
    this.markDirty();
    return { path: rel, sizeBytes, totalLines: content.split("\n").length };
  }

  /** memory_get 的安全读取：路径必须解析回工作区内且属于记忆根（含该成员自己的记忆文件）。 */
  async readFile(
    relPath: string,
    params?: { from?: number; lines?: number; agentId?: string },
  ): Promise<{ content: string; truncated: boolean; totalLines: number; more: boolean }> {
    return this.readWithin(
      relPath,
      (abs, root) => isMemoryRootPath(abs, root) || isMemberMemoryPath(abs, root, params?.agentId),
      params?.agentId
        ? `只允许读取 MEMORY.md、USER.md、memory/ 或自己的 agents/<成员ID>/MEMORY.md、USER.md：${relPath}`
        : `只允许读取 MEMORY.md、USER.md 或 memory/ 下的文件：${relPath}`,
      params ? { from: params.from, lines: params.lines } : undefined,
    );
  }

  private async readWithin(
    relPath: string,
    isAllowed: (absPath: string, workspaceRoot: string) => boolean,
    refusal: string,
    params?: { from?: number; lines?: number; full?: boolean },
  ): Promise<{ content: string; truncated: boolean; totalLines: number; more: boolean }> {
    const { workspaceDir } = this.options;
    const normalized = relPath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized)) {
      throw new Error(`路径不合法：${relPath}`);
    }
    const workspaceRoot = path.resolve(workspaceDir);
    const absPath = path.resolve(workspaceRoot, normalized);
    if (!isAllowed(absPath, workspaceRoot)) {
      throw new Error(refusal);
    }
    const realDir = await fs.realpath(workspaceDir).catch(() => workspaceRoot);
    const realPath = await fs.realpath(absPath).catch(() => undefined);
    if (!realPath || !isPathInsideDir(realDir, realPath)) {
      throw new Error(`路径越出工作区：${relPath}`);
    }
    const content = await fs.readFile(realPath, "utf8");
    const lines = content.split("\n");
    if (params?.full) {
      return { content, truncated: false, totalLines: lines.length, more: false };
    }
    const from = Math.max(1, Math.floor(params?.from ?? 1));
    const count = Math.min(400, Math.max(1, Math.floor(params?.lines ?? 200)));
    const slice = lines.slice(from - 1, from - 1 + count);
    const more = from - 1 + slice.length < lines.length;
    return { content: slice.join("\n"), truncated: slice.length < lines.length, totalLines: lines.length, more };
  }

  /**
   * 适配：本项目没有文件写工具，记忆写回走受控追加（策展条目格式与 OpenClaw 注释语法一致）。
   * 子成员传入 agentId 时写到它自己的 agents/<id>/MEMORY.md。
   */
  async appendEntry(
    text: string,
    annotations?: { triggers?: string[]; importance?: number },
    options?: { agentId?: string },
  ): Promise<string> {
    const clean = text.trim().replace(/\s+/gu, " ");
    if (!clean) throw new Error("记忆内容不能为空");
    const parts = [`- ${clean}`];
    if (annotations?.triggers?.length) {
      parts.push(`<!-- trigger: ${annotations.triggers.map((t) => t.trim().replace(/-->/g, "")).filter(Boolean).join(", ")} -->`);
    }
    if (annotations?.importance !== undefined) {
      const value = Math.max(1, Math.min(10, Math.floor(annotations.importance)));
      parts.push(`<!-- importance: ${value} -->`);
    }
    const relPath = options?.agentId ? `agents/${options.agentId}/MEMORY.md` : "MEMORY.md";
    const file = path.join(this.options.workspaceDir, relPath);
    if (options?.agentId) await fs.mkdir(path.dirname(file), { recursive: true });
    let prefix = "";
    try {
      const existing = await fs.readFile(file, "utf8");
      prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    } catch {
      prefix = "# 长期记忆\n\n";
    }
    await fs.appendFile(file, `${prefix}${parts.join(" ")}\n`, "utf8");
    this.markDirty();
    return relPath;
  }
}

function isAscii(value: string): boolean {
  return !/[^\p{ASCII}]/u.test(value);
}

function isPathInsideDir(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 记忆语料根：MEMORY.md、USER.md 与 memory/**.md（对应 OpenClaw 的 listMemoryFiles 范围）。 */
function isMemoryRootPath(absPath: string, workspaceRoot: string): boolean {
  return (
    absPath === path.join(workspaceRoot, "MEMORY.md") ||
    absPath === path.join(workspaceRoot, "USER.md") ||
    absPath.startsWith(path.join(workspaceRoot, "memory") + path.sep)
  );
}

/** 不属于检索语料、但属于智能体档案的工作区文件（性格与身份）。 */
const NON_MEMORY_AGENT_FILES: readonly string[] = ["SOUL.md", "IDENTITY.md"];

/** 子成员私有的记忆文件：检索语料随 agents/<id>/ 收录，只对该成员可见。 */
const MEMBER_MEMORY_FILES: readonly string[] = ["MEMORY.md", "USER.md"];

function isMemberMemoryPath(absPath: string, workspaceRoot: string, agentId: string | undefined): boolean {
  if (!agentId) return false;
  const relative = path.relative(path.join(workspaceRoot, "agents", agentId), absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return MEMBER_MEMORY_FILES.includes(relative.split(path.sep).join("/"));
}

/** 子成员自己的档案目录：agents/<memberId>/<name>.md（只允许一层，且不越出工作区）。 */
function isMemberAgentPath(absPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(path.join(workspaceRoot, "agents"), absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.length === 2 && segments.every(Boolean) && segments[1].toLowerCase().endsWith(".md");
}

/** 「智能体文件」面板的读写白名单：记忆根 + 工作区根部身份文件 + 子成员档案。 */
function isAgentFileAllowed(absPath: string, workspaceRoot: string): boolean {
  return (
    isMemoryRootPath(absPath, workspaceRoot) ||
    NON_MEMORY_AGENT_FILES.some((name) => absPath === path.join(workspaceRoot, name)) ||
    isMemberAgentPath(absPath, workspaceRoot)
  );
}

function agentFileRank(relPath: string): number {
  // 子成员档案的路径带 agents/<id>/ 前缀，按文件名排序保持统一顺序。
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const index = (AGENT_FILE_ORDER as readonly string[]).indexOf(base);
  return index === -1 ? AGENT_FILE_ORDER.length : index;
}

async function isRegularMarkdown(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile() && absPath.endsWith(".md");
  } catch {
    return false;
  }
}

async function collectMarkdownFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await collectMarkdownFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
}

/** MMR 复用导出，方便测试与召回层。 */
export { applyMMRToHybridResults };
