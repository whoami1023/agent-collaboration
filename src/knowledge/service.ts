import { createHash } from "node:crypto";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { Settings } from "../core/settings";
import { newId } from "../core/ids";
import type { WorkspaceFiles } from "../files/workspace-files";
import {
  FOLDER_IMPORT_LIMITS,
  extractTextFromFile,
} from "../files/extract-text";
import { resolveModelChain } from "../model/refs";
import {
  resolveModelRuntime,
  type RuntimeDeps as ModelRuntimeDeps,
} from "../model/registry";
import { addUsage, calculateUsageCost, emptyUsage, type UsageTotals } from "../model/usage-cost";
import type { ModelUsageStore } from "../model/usage-store";
import type { LlmProvider, LlmRequest } from "../provider/types";
import type { MemberUsageRecord } from "../agent/member-runtime";
import {
  isKnowledgePageType,
  normalizePage,
  correctPagePath,
  serializePage,
  parseFrontmatter,
  inferTypeFromPath,
} from "./frontmatter";
import {
  assertKnowledgeId,
  normalizeWikiPath,
  pagePathOf,
  slugify,
  sourceFilename,
} from "./paths";
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildResearchPlanPrompt,
  buildSourceSummaryPage,
  DEFAULT_PURPOSE,
  DEFAULT_SCHEMA,
  KNOWLEDGE_ANALYSIS_SYSTEM,
  KNOWLEDGE_GENERATION_SYSTEM,
  KNOWLEDGE_RESEARCH_PLAN_SYSTEM,
} from "./prompts";
import { KnowledgeStore, type StoredPage } from "./store";
import { exportBundle, readBundle } from "./bundle";
import { searchWeb } from "../web/search";
import { fetchWebPage } from "../web/fetch";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeError,
  PAGE_TYPE_DIRS,
  type KnowledgeBaseMeta,
  type KnowledgeEmbeddingIndex,
  type KnowledgeEvent,
  type KnowledgeGraph,
  type KnowledgeLintReport,
  type KnowledgeLinkProposal,
  type KnowledgePage,
  type KnowledgePageMeta,
  type KnowledgeQueueItem,
  type KnowledgeReview,
  type KnowledgeReviewKind,
  type KnowledgeSearchHit,
  type KnowledgeSearchResult,
  type KnowledgeSnapshot,
  type KnowledgeSource,
} from "./types";
import {
  appendLog,
  applyLinkProposals,
  buildGraph,
  buildIndex,
  buildOverview,
  extractJsonObject,
  lintWiki,
  parseFileBlocks,
  proposeLinks,
  searchPages,
  trimLog,
  type WikiFileBlock,
} from "./wiki";
import {
  cosineSimilarity,
  requestEmbeddings,
  resolveEmbeddingRuntime,
} from "./embeddings";

export interface KnowledgeServiceDeps {
  /** 本账号工作区目录（knowledge/ 会建在它下面）。 */
  dir: string;
  getSettings(): Settings;
  getModelDeps(): ModelRuntimeDeps;
  usage?: ModelUsageStore;
  /** 文件工作区：支持「从现有成果导入」而不必复制粘贴。 */
  files?: WorkspaceFiles;
  onEvent?(event: KnowledgeEvent): void;
  onUsageRecord?(record: MemberUsageRecord): void;
  /** 测试注入向量模型；生产按库配置的 embeddingRef 解析。 */
  embedder?(input: { texts: string[]; ref: string }): Promise<{ vectors: number[][]; tokens?: number }>;
  /** 测试注入联网检索；生产走内置 web_search / web_fetch。 */
  web?: {
    search(
      query: string,
      options?: { maxResults?: number },
    ): Promise<{ results: Array<{ title: string; url: string; snippet: string }>; warning?: string }>;
    fetchPage(
      url: string,
    ): Promise<{ title?: string; text: string; finalUrl: string; truncated?: boolean }>;
  };
  /** 测试注入固定时钟；生产不传。 */
  now?(): number;
}

interface AnalysisPlan {
  summary: string;
  keyPoints: string[];
  uncertainties: string[];
  pages: Array<{
    path?: string;
    type?: string;
    title?: string;
    tags?: string[];
    related?: string[];
    action?: string;
    brief?: string;
  }>;
  reviews: Array<{
    kind?: string;
    title?: string;
    reason?: string;
    query?: string;
  }>;
}

interface IngestOutcome {
  pagePaths: string[];
  summaryPath: string;
  note?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function walkRawFiles(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walkRawFiles(join(dir, entry.name), next)));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

function asString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function asStringArray(value: unknown, maxItems = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim())
    .slice(0, maxItems);
}

/** 单次补全：摄入是后台任务，不需要工具与多步循环，只要文本与 usage。 */
async function completeOnce(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<{ text: string; usage: UsageTotals }> {
  let text = "";
  let usage = emptyUsage();
  for await (const event of provider.stream(request)) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "usage") usage = addUsage(usage, event.usage);
  }
  return { text, usage };
}

/**
 * 每账号一个知识库服务：多库 CRUD、来源摄入的持久串行队列、检索 / 体检 / 图谱。
 *
 * 摄入是两阶段模型调用：先产出结构化计划，再按计划写 FILE 块；来源摘要页由系统兜底，
 * 所以即使模型只写回半页，至少也有一份可读的摘要与日志。原始材料只落 raw/，
 * wiki 页面是整理结果，索引与总览由系统按页面清单重建。
 */
export class KnowledgeService {
  private readonly store: KnowledgeStore;
  private closed = false;
  private readonly workers = new Map<string, Promise<void>>();
  /** 每库最多一个在跑的摄入：按队列项记录控制器与所属库，取消/删库只影响该库。 */
  private readonly controllers = new Map<string, { controller: AbortController; kbId: string }>();
  /** 已删除的库：worker 收尾时不再回写，避免把刚删掉的目录重新建出来。 */
  private readonly deletedBases = new Set<string>();
  /** 每库一把异步锁：来源索引 / 队列是读-改-写 JSON，并发写会互相覆盖。 */
  private readonly kbLocks = new Map<string, Promise<unknown>>();
  /** raw/sources 外部变更监听与去抖。 */
  private watcher: FSWatcher | null = null;
  private readonly watchTimers = new Map<string, NodeJS.Timeout>();

  private withKbLock<T>(kbId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.kbLocks.get(kbId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.kbLocks.set(
      kbId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  constructor(private readonly deps: KnowledgeServiceDeps) {
    const now = deps.now ?? Date.now;
    this.store = new KnowledgeStore(deps.dir, {
      today: () => new Date(now()).toISOString().slice(0, 10),
    });
  }

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private today(): string {
    return new Date(this.now).toISOString().slice(0, 10);
  }

  get knowledgeDir(): string {
    return this.store.root;
  }

  /** 启动时调用：建目录、把上次中断的运行放回队列，然后开始消费。 */
  async load(): Promise<void> {
    await this.store.init();
    for (const base of await this.store.listBases()) {
      const items = await this.store.readQueue(base.id);
      let changed = false;
      for (const item of items) {
        if (item.state === "running") {
          item.state = "queued";
          item.startedAt = undefined;
          changed = true;
        }
      }
      if (changed) await this.store.writeQueue(base.id, items);
      const sources = await this.store.readSourceIndex(base.id);
      let sourceChanged = false;
      for (const source of sources) {
        if (source.status === "ingesting") {
          source.status = "queued";
          sourceChanged = true;
        }
      }
      if (sourceChanged) await this.store.writeSourceIndex(base.id, sources);
    }
  }

  /** 工作区加载完成后启动队列（不阻塞 Workspace.load 的其余装配）。 */
  start(): void {
    if (this.closed) return;
    this.startWatcher();
    void this.store
      .listBases()
      .then((bases) => {
        for (const base of bases) void this.kick(base.id);
      })
      .catch((err) => console.error("知识库队列启动失败", err));
  }

  /** 监听 raw/sources 的外部变更：写入/修改触发摄入，删除把来源标失败。 */
  private startWatcher(): void {
    if (this.closed || this.watcher) return;
    try {
      this.watcher = watch(this.store.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        const match = /^(kb_[0-9a-f]{12})\/raw\/sources\//.exec(rel);
        if (!match) return;
        this.scheduleRescan(match[1]!);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      console.warn("知识库目录监听启动失败", err);
    }
  }

  private scheduleRescan(kbId: string): void {
    if (this.closed || this.deletedBases.has(kbId)) return;
    const existing = this.watchTimers.get(kbId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.watchTimers.delete(kbId);
      void this.rescanSources(kbId).catch((err) =>
        console.error("知识库来源扫描失败", kbId, err),
      );
    }, 800);
    timer.unref?.();
    this.watchTimers.set(kbId, timer);
  }

  /**
   * 重新扫描 raw/sources：外部新增的文件自动成为来源并摄入；已有来源的文件内容变化
   * 会重新排队；被删掉的文件把来源标为失败。导入自己的写入 hash 不变，因而是空操作。
   */
  async rescanSources(kbId: string): Promise<{
    added: number;
    updated: number;
    removed: number;
  }> {
    return this.withKbLock(kbId, async () => {
      if (this.closed || this.deletedBases.has(kbId)) return { added: 0, updated: 0, removed: 0 };
      const base = await this.store.readBase(kbId);
      const sources = await this.store.readSourceIndex(kbId);
      const queue = await this.store.readQueue(kbId);
      const rawDir = join(this.store.root, base.id, "raw", "sources");
      const files = await walkRawFiles(rawDir);
      const present = new Set(files.map((file) => `raw/sources/${file}`));
      const byPath = new Map(sources.map((source) => [source.rawPath, source]));
      let added = 0;
      let updated = 0;
      const enqueue = (source: KnowledgeSource): void => {
        if (
          queue.some(
            (item) =>
              item.sourceId === source.id &&
              (item.state === "queued" || item.state === "running"),
          )
        ) {
          return;
        }
        queue.push({
          id: newId("kq"),
          sourceId: source.id,
          title: source.title,
          state: "queued",
          attempts: 0,
          createdAt: this.now,
        });
      };
      for (const file of files) {
        const rawPath = `raw/sources/${file}`;
        const content = await readFile(join(rawDir, file)).catch(() => null);
        if (!content) continue;
        if (content.length > KNOWLEDGE_LIMITS.maxSourceBytes || content.includes(0)) continue;
        const text = content.toString("utf8");
        if (!text.trim()) continue;
        const sha256 = createHash("sha256").update(text).digest("hex");
        const known = byPath.get(rawPath);
        if (!known) {
          const title = file.replace(/\.[^.]+$/, "").slice(0, KNOWLEDGE_LIMITS.maxSourceTitleChars);
          const source: KnowledgeSource = {
            id: newId("src"),
            title,
            rawPath,
            sha256,
            bytes: content.length,
            addedAt: this.now,
            status: "queued",
            pagePaths: [],
          };
          sources.push(source);
          enqueue(source);
          added += 1;
        } else if (known.sha256 !== sha256) {
          known.sha256 = sha256;
          known.bytes = content.length;
          known.status = "queued";
          known.error = undefined;
          enqueue(known);
          updated += 1;
        }
      }
      let removed = 0;
      for (const source of sources) {
        if (present.has(source.rawPath)) continue;
        if (source.status === "failed" && source.error?.includes("原始文件已删除")) continue;
        source.status = "failed";
        source.error = "原始文件已删除（外部修改），请重新导入";
        removed += 1;
        for (const item of queue) {
          if (item.sourceId !== source.id || item.state !== "queued") continue;
          item.state = "cancelled";
          item.error = "原始文件已删除";
          item.finishedAt = this.now;
          this.controllers.get(item.id)?.controller.abort();
        }
      }
      if (added + updated + removed > 0) {
        await this.store.writeSourceIndex(base.id, sources);
        await this.store.writeQueue(base.id, queue);
        await this.refreshBaseCounts(base, sources, queue);
        this.emit({ kbId: base.id, kind: "source" });
        this.emit({ kbId: base.id, kind: "queue" });
        if (added + updated > 0) void this.kick(base.id);
      }
      return { added, updated, removed };
    });
  }

  private emit(event: KnowledgeEvent): void {
    this.deps.onEvent?.(event);
  }

  async listBases(): Promise<KnowledgeBaseMeta[]> {
    return this.store.listBases();
  }

  async createBase(input: {
    name: unknown;
    description?: unknown;
    purpose?: unknown;
    schema?: unknown;
    modelRef?: unknown;
    embeddingRef?: unknown;
  }): Promise<KnowledgeBaseMeta> {
    const existing = await this.store.listBases();
    if (existing.length >= KNOWLEDGE_LIMITS.maxBases) {
      throw new KnowledgeError(400, `最多只能建 ${KNOWLEDGE_LIMITS.maxBases} 个知识库`);
    }
    const name = this.validateName(input.name);
    if (existing.some((base) => base.name.toLowerCase() === name.toLowerCase())) {
      throw new KnowledgeError(400, `知识库「${name}」已经存在，换一个名字`);
    }
    const description = asString(input.description, KNOWLEDGE_LIMITS.maxDescriptionChars);
    const purpose = asString(input.purpose, KNOWLEDGE_LIMITS.maxPurposeChars) || DEFAULT_PURPOSE;
    const schema = asString(input.schema, KNOWLEDGE_LIMITS.maxSchemaChars) || DEFAULT_SCHEMA;
    const modelRef = this.validateModelRef(input.modelRef);
    const embeddingRef = this.validateModelRef(input.embeddingRef);
    const now = this.now;
    const meta: KnowledgeBaseMeta = {
      id: newId("kb"),
      name,
      description,
      purpose,
      schema,
      ...(modelRef ? { modelRef } : {}),
      ...(embeddingRef ? { embeddingRef } : {}),
      createdAt: now,
      updatedAt: now,
      pageCount: 0,
      sourceCount: 0,
      pendingCount: 0,
    };
    await this.store.createBase(meta, purpose, schema);
    this.emit({ kbId: meta.id, kind: "bases" });
    return meta;
  }

  async updateBase(
    id: string,
    patch: {
      name?: unknown;
      description?: unknown;
      purpose?: unknown;
      schema?: unknown;
      modelRef?: unknown;
      embeddingRef?: unknown;
    },
  ): Promise<KnowledgeBaseMeta> {
    const base = await this.store.readBase(id);
    const bases = await this.store.listBases();
    if (patch.name !== undefined) {
      const name = this.validateName(patch.name);
      if (
        bases.some(
          (candidate) => candidate.id !== base.id && candidate.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new KnowledgeError(400, `知识库「${name}」已经存在，换一个名字`);
      }
      base.name = name;
    }
    if (patch.description !== undefined) {
      base.description = asString(patch.description, KNOWLEDGE_LIMITS.maxDescriptionChars);
    }
    if (patch.purpose !== undefined) {
      base.purpose =
        asString(patch.purpose, KNOWLEDGE_LIMITS.maxPurposeChars) || DEFAULT_PURPOSE;
      await this.store.writeText(base.id, "purpose.md", base.purpose);
    }
    if (patch.schema !== undefined) {
      base.schema = asString(patch.schema, KNOWLEDGE_LIMITS.maxSchemaChars) || DEFAULT_SCHEMA;
      await this.store.writeText(base.id, "schema.md", base.schema);
    }
    if (patch.modelRef !== undefined) {
      const modelRef = this.validateModelRef(patch.modelRef);
      if (modelRef) base.modelRef = modelRef;
      else delete base.modelRef;
    }
    if (patch.embeddingRef !== undefined) {
      const embeddingRef = this.validateModelRef(patch.embeddingRef);
      if (embeddingRef) base.embeddingRef = embeddingRef;
      else delete base.embeddingRef;
    }
    base.updatedAt = this.now;
    await this.store.writeBase(base);
    this.emit({ kbId: base.id, kind: "settings" });
    return base;
  }

  async deleteBase(id: string): Promise<void> {
    const base = await this.store.readBase(id);
    this.deletedBases.add(base.id);
    for (const [itemId, entry] of this.controllers) {
      if (entry.kbId !== base.id) continue;
      entry.controller.abort();
      this.controllers.delete(itemId);
    }
    // 等该库的 worker 收尾（它会把队列项落回），再删目录，避免写入与删除互相踩。
    await this.workers.get(base.id)?.catch(() => undefined);
    await this.store.removeBase(base.id);
    this.workers.delete(base.id);
    this.emit({ kbId: base.id, kind: "bases" });
  }

  async snapshot(id: string): Promise<KnowledgeSnapshot> {
    const base = await this.store.readBase(id);
    const [sources, queue, pages, reviews, overview, index, log] = await Promise.all([
      this.store.readSourceIndex(id),
      this.store.readQueue(id),
      this.store.listPages(id),
      this.store.readReviews(id),
      this.store.readText(id, "wiki/overview.md"),
      this.store.readText(id, "index.md"),
      this.store.readText(id, "log.md"),
    ]);
    return {
      // 计数以本次读到的清单为准：队列刚结束时的 meta.json 可能还没写回。
      base: {
        ...base,
        sourceCount: sources.length,
        pageCount: pages.length,
        pendingCount: queue.filter((item) => item.state === "queued" || item.state === "running").length,
      },
      sources: sources.sort((a, b) => b.addedAt - a.addedAt),
      queue: queue.sort((a, b) => b.createdAt - a.createdAt),
      reviews: reviews.sort((a, b) => {
        const pending = Number(b.status === "pending") - Number(a.status === "pending");
        return pending || b.createdAt - a.createdAt;
      }),
      pages: pages
        .map((page) => this.metaOf(page))
        .sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, "zh")),
      overview,
      index,
      log,
    };
  }

  async addSource(
    kbId: string,
    input: { title?: unknown; content?: unknown; filePath?: unknown },
  ): Promise<{ source: KnowledgeSource; queueItem: KnowledgeQueueItem }> {
    return this.withKbLock(kbId, () => this.addSourceUnlocked(kbId, input));
  }

  private async addSourceUnlocked(
    kbId: string,
    input: { title?: unknown; content?: unknown; filePath?: unknown },
  ): Promise<{ source: KnowledgeSource; queueItem: KnowledgeQueueItem }> {
    const base = await this.store.readBase(kbId);
    let content = typeof input.content === "string" ? input.content : "";
    let title = asString(input.title, KNOWLEDGE_LIMITS.maxSourceTitleChars);
    const filePath = asString(input.filePath, 500);
    if (!content && filePath) {
      const files = this.deps.files;
      if (!files) throw new KnowledgeError(400, "文件工作区尚未就绪，无法从文件导入");
      try {
        const read = await files.read(filePath, { maxBytes: KNOWLEDGE_LIMITS.maxSourceBytes });
        if (read.binary || read.preview !== "text") {
          throw new KnowledgeError(400, "只支持导入文本类文件（Markdown、TXT、CSV 等）");
        }
        content = read.content;
        if (!title) title = read.name.replace(/\.[^.]+$/, "");
        if (read.truncated) {
          throw new KnowledgeError(400, "文件超过 2 MB，请先拆分或精简后再导入");
        }
      } catch (err) {
        if (err instanceof KnowledgeError) throw err;
        throw new KnowledgeError(400, `读取文件失败：${errorMessage(err)}`);
      }
    }
    content = content.replace(/\u0000/g, "").trim();
    if (!content) throw new KnowledgeError(400, "材料内容不能为空");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > KNOWLEDGE_LIMITS.maxSourceBytes) {
      throw new KnowledgeError(400, "材料超过 2 MB，请先拆分或精简后再导入");
    }
    if (!title) title = content.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) || "未命名材料";
    const sha256 = createHash("sha256").update(content).digest("hex");
    const sources = await this.store.readSourceIndex(base.id);
    const duplicate = sources.find((source) => source.sha256 === sha256);
    if (duplicate) {
      throw new KnowledgeError(409, `这份材料已经在知识库里了（来源「${duplicate.title}」）`);
    }
    const sourceId = newId("src");
    const rawPath = await this.store.writeSourceRaw(base.id, sourceFilename(title, sourceId), content);
    const now = this.now;
    const source: KnowledgeSource = {
      id: sourceId,
      title,
      rawPath,
      sha256,
      bytes,
      addedAt: now,
      status: "queued",
      pagePaths: [],
    };
    const queueItem: KnowledgeQueueItem = {
      id: newId("kq"),
      sourceId,
      title,
      state: "queued",
      attempts: 0,
      createdAt: now,
    };
    sources.push(source);
    await this.store.writeSourceIndex(base.id, sources);
    const queue = await this.store.readQueue(base.id);
    queue.push(queueItem);
    await this.store.writeQueue(base.id, queue);
    await this.refreshBaseCounts(base, sources, queue);
    this.emit({ kbId: base.id, kind: "source", sourceId });
    this.emit({ kbId: base.id, kind: "queue", queueItemId: queueItem.id });
    void this.kick(base.id);
    return { source, queueItem };
  }

  /**
   * 文件夹导入：递归导入文件工作区某个目录下的可抽取文件，保留相对路径作为分类上下文。
   * 单文件失败/重复只记入 skipped，不中断整批；数量与单文件大小沿用导入上限。
   */
  async importFolder(
    kbId: string,
    input: { dir?: unknown; maxFiles?: unknown },
  ): Promise<{
    added: KnowledgeSource[];
    skipped: Array<{ path: string; reason: string }>;
    unsupported: Array<{ path: string; reason: string }>;
  }> {
    const base = await this.store.readBase(kbId);
    const files = this.deps.files;
    if (!files) throw new KnowledgeError(400, "文件工作区尚未就绪，无法导入文件夹");
    const dir = asString(input.dir, 300).replace(/^\/+|\/+$/g, "");
    const maxFiles = Math.max(
      1,
      Math.min(
        typeof input.maxFiles === "number" && Number.isFinite(input.maxFiles)
          ? Math.round(input.maxFiles)
          : FOLDER_IMPORT_LIMITS.maxFiles,
        FOLDER_IMPORT_LIMITS.maxFiles,
      ),
    );
    const listing = await files.list();
    const candidates = listing.files
      .filter((entry) => entry.kind === "file")
      .filter((entry) => (dir ? entry.path.startsWith(`${dir}/`) : true))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, maxFiles);

    const added: KnowledgeSource[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const unsupported: Array<{ path: string; reason: string }> = [];
    for (const entry of candidates) {
      if (entry.sizeBytes > FOLDER_IMPORT_LIMITS.maxBytes) {
        unsupported.push({ path: entry.path, reason: "文件超过 2 MB" });
        continue;
      }
      const download = await files.download(entry.path);
      const extracted = await extractTextFromFile(download.absPath);
      if ("error" in extracted) {
        unsupported.push({ path: entry.path, reason: extracted.error });
        continue;
      }
      if (!extracted.text.trim()) {
        skipped.push({ path: entry.path, reason: "提取结果为空" });
        continue;
      }
      const title = entry.path.replace(/\.[^.]+$/, "").slice(0, KNOWLEDGE_LIMITS.maxSourceTitleChars);
      const content = [
        `# ${title}`,
        "",
        `> 导入自文件工作区：${entry.path}（${extracted.format}）`,
        dir ? `> 目录分类：${dir}` : "",
        "",
        extracted.text,
      ]
        .filter((line) => line !== undefined)
        .join("\n");
      try {
        const result = await this.addSource(base.id, { title, content });
        added.push(result.source);
      } catch (err) {
        if (err instanceof KnowledgeError && err.status === 409) {
          skipped.push({ path: entry.path, reason: "内容已在知识库中" });
        } else {
          skipped.push({ path: entry.path, reason: errorMessage(err) });
        }
      }
    }
    return { added, skipped, unsupported };
  }

  /** 导出整库为 ZIP（不含向量缓存；导入侧会重建索引与计数）。 */
  async exportBundle(kbId: string): Promise<{ filename: string; data: Buffer }> {
    const base = await this.store.readBase(kbId);
    const data = await exportBundle(join(this.store.root, base.id), base);
    const safe = base.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40) || "knowledge";
    return { filename: `knowledge-${safe}-${this.today()}.zip`, data };
  }

  /** 导入整库：新 ID、重名自动加后缀，页面与原始材料按原样落盘后重建索引。 */
  async importBundle(buffer: Buffer, input: { name?: unknown } = {}): Promise<KnowledgeBaseMeta> {
    const existing = await this.store.listBases();
    if (existing.length >= KNOWLEDGE_LIMITS.maxBases) {
      throw new KnowledgeError(400, `最多只能建 ${KNOWLEDGE_LIMITS.maxBases} 个知识库`);
    }
    const bundle = await readBundle(buffer);
    const requested =
      asString(input.name, KNOWLEDGE_LIMITS.maxNameChars + 20) || bundle.meta.name;
    let name = this.validateName(requested);
    if (existing.some((base) => base.name.toLowerCase() === name.toLowerCase())) {
      const stem = name.slice(0, 38);
      let index = 2;
      while (
        existing.some((base) => base.name.toLowerCase() === `${stem}（导入${index}）`.toLowerCase())
      ) {
        index += 1;
      }
      name = `${stem}（导入${index}）`;
    }
    const now = this.now;
    const meta: KnowledgeBaseMeta = {
      id: newId("kb"),
      name,
      description: asString(bundle.meta.description, KNOWLEDGE_LIMITS.maxDescriptionChars),
      purpose: bundle.purpose.trim() || DEFAULT_PURPOSE,
      schema: bundle.schema.trim() || DEFAULT_SCHEMA,
      createdAt: now,
      updatedAt: now,
      pageCount: 0,
      sourceCount: 0,
      pendingCount: 0,
    };
    await this.store.createBase(meta, meta.purpose, meta.schema);
    for (const [rel, data] of bundle.files) {
      if (rel === "index.md" || rel === "log.md") continue; // 由系统重建
      await this.store.writeFileBytes(meta.id, rel, data);
    }
    // 导入时还没整理完的来源不能直接当成功：标失败，留给用户重试。
    const sources = await this.store.readSourceIndex(meta.id);
    for (const source of sources) {
      if (source.status === "queued" || source.status === "ingesting") {
        source.status = "failed";
        source.error = "导入时该来源尚未完成整理，请在来源页重试";
      }
    }
    await this.store.writeSourceIndex(meta.id, sources);
    await this.store.writeQueue(meta.id, []);
    const log = await this.store.readText(meta.id, "log.md");
    await this.store.writeText(
      meta.id,
      "log.md",
      appendLog(log, {
        date: this.today(),
        action: "manual",
        title: name,
        pagePaths: [],
        note: `从压缩包导入：${bundle.files.size} 个文件（${sources.length} 份来源）`,
      }),
    );
    await this.reindex(meta.id);
    this.emit({ kbId: meta.id, kind: "bases" });
    return this.store.readBase(meta.id);
  }

  /** 来源原文：只读返回；二进制文件不返回正文，交给前端提示不可预览。 */
  async readSourceRaw(
    kbId: string,
    sourceId: string,
  ): Promise<{ source: KnowledgeSource; content: string; binary: boolean }> {
    const base = await this.store.readBase(kbId);
    const sources = await this.store.readSourceIndex(base.id);
    const source = sources.find((item) => item.id === sourceId);
    if (!source) throw new KnowledgeError(404, "来源不存在");
    const content = await this.store.readSourceRaw(base.id, source.rawPath);
    const binary = content.includes("\0");
    if (!content && !binary) {
      throw new KnowledgeError(404, "原始文件不存在（可能已被外部删除）");
    }
    return { source, content: binary ? "" : content, binary };
  }

  async removeSource(kbId: string, sourceId: string): Promise<void> {
    const base = await this.store.readBase(kbId);
    const sources = await this.store.readSourceIndex(kbId);
    const source = sources.find((item) => item.id === sourceId);
    if (!source) throw new KnowledgeError(404, "来源不存在");
    const queue = await this.store.readQueue(kbId);
    for (const item of queue) {
      if (item.sourceId !== sourceId) continue;
      if (item.state === "running") this.controllers.get(item.id)?.controller.abort();
      item.state = "cancelled";
      item.finishedAt = this.now;
      item.error = "来源已删除";
    }
    await this.store.deleteSourceRaw(kbId, source.rawPath);
    const remaining = sources.filter((item) => item.id !== sourceId);
    await this.store.writeSourceIndex(kbId, remaining);
    await this.store.writeQueue(kbId, queue);
    await this.refreshBaseCounts(base, remaining, queue);
    await this.rebuildIndexAndOverview(base, remaining);
    const log = await this.store.readText(kbId, "log.md");
    await this.store.writeText(
      kbId,
      "log.md",
      appendLog(log, {
        date: this.today(),
        action: "delete",
        title: source.title,
        sourceId: source.id,
        pagePaths: [],
        note: "已删除来源与原始材料；此前的 wiki 页面保留。",
      }),
    );
    this.emit({ kbId, kind: "source", sourceId });
    this.emit({ kbId, kind: "queue" });
  }

  async retryQueue(kbId: string, itemId?: string): Promise<KnowledgeQueueItem[]> {
    const base = await this.store.readBase(kbId);
    const queue = await this.store.readQueue(kbId);
    const sources = await this.store.readSourceIndex(kbId);
    let touched = false;
    for (const item of queue) {
      if (itemId && item.id !== itemId) continue;
      if (item.state !== "failed" && item.state !== "cancelled") continue;
      item.state = "queued";
      item.error = undefined;
      item.startedAt = undefined;
      item.finishedAt = undefined;
      item.attempts = 0;
      const source = sources.find((candidate) => candidate.id === item.sourceId);
      if (source) {
        source.status = "queued";
        source.error = undefined;
      }
      touched = true;
    }
    if (!touched) throw new KnowledgeError(400, "没有可重试的队列项");
    await this.store.writeQueue(kbId, queue);
    await this.store.writeSourceIndex(kbId, sources);
    await this.rebuildIndexAndOverview(base, sources);
    await this.refreshBaseCounts(base, sources, queue);
    this.emit({ kbId, kind: "queue" });
    void this.kick(kbId);
    return queue;
  }

  async cancelQueue(kbId: string, itemId?: string): Promise<KnowledgeQueueItem[]> {
    const base = await this.store.readBase(kbId);
    const queue = await this.store.readQueue(kbId);
    const sources = await this.store.readSourceIndex(kbId);
    let touched = false;
    for (const item of queue) {
      if (itemId && item.id !== itemId) continue;
      if (item.state === "running") {
        this.controllers.get(item.id)?.controller.abort();
        continue; // runItem 的 catch 会把它落到 cancelled
      }
      if (item.state !== "queued") continue;
      item.state = "cancelled";
      item.finishedAt = this.now;
      item.error = "已取消";
      const source = sources.find((candidate) => candidate.id === item.sourceId);
      if (source) {
        source.status = "failed";
        source.error = "已取消整理，可稍后重试";
      }
      touched = true;
    }
    if (!touched && !itemId) throw new KnowledgeError(400, "没有可取消的队列项");
    await this.store.writeQueue(kbId, queue);
    await this.store.writeSourceIndex(kbId, sources);
    await this.rebuildIndexAndOverview(base, sources);
    await this.refreshBaseCounts(base, sources, queue);
    this.emit({ kbId, kind: "queue" });
    return queue;
  }

  async readPage(kbId: string, pagePath: string): Promise<KnowledgePage> {
    const page = await this.store.readPage(kbId, pagePath);
    if (!page) throw new KnowledgeError(404, "页面不存在");
    return this.pageOf(page);
  }

  /** 面板编辑用：正文之外还带原始文本（含 frontmatter），保存时不会被冲掉。 */
  async readPageForEdit(kbId: string, pagePath: string): Promise<{ page: KnowledgePage; raw: string }> {
    const stored = await this.store.readPage(kbId, pagePath);
    if (!stored) throw new KnowledgeError(404, "页面不存在");
    return { page: this.pageOf(stored), raw: stored.raw };
  }

  async writePage(kbId: string, pagePath: string, content: string): Promise<KnowledgePage> {
    const base = await this.store.readBase(kbId);
    let normalized: string;
    try {
      normalized = pagePathOf(normalizeWikiPath(pagePath));
    } catch (err) {
      throw err instanceof KnowledgeError ? err : new KnowledgeError(400, "页面路径不合法");
    }
    const raw = typeof content === "string" ? content : "";
    if (!raw.trim()) throw new KnowledgeError(400, "页面内容不能为空");
    const existing = await this.store.readPage(kbId, normalized);
    // normalizePage 会保留合法的 type；用户把它改坏时退回原类型，避免页面从分类里消失。
    const { meta, body } = normalizePage(raw, {
      path: normalized,
      today: this.today(),
      fallbackTitle: existing?.title ?? normalized.split("/").pop()?.replace(/\.md$/i, ""),
      fallbackType: existing?.type ?? inferTypeFromPath(normalized),
      sourceIds: existing?.sources ?? [],
    });
    const finalPath = pagePathOf(correctPagePath(meta.path, meta.type));
    if (finalPath !== normalized) await this.store.deletePage(kbId, normalized);
    const stored = await this.store.writePage(
      kbId,
      finalPath,
      serializePage(
        {
          ...meta,
          path: finalPath,
          created: existing?.created ?? meta.created,
          updated: this.today(),
        },
        body,
      ),
    );
    const [sources, queue] = await Promise.all([
      this.store.readSourceIndex(kbId),
      this.store.readQueue(kbId),
    ]);
    await this.rebuildIndexAndOverview(base, sources);
    const log = await this.store.readText(kbId, "log.md");
    await this.store.writeText(
      kbId,
      "log.md",
      appendLog(log, {
        date: this.today(),
        action: "manual",
        title: stored.title,
        pagePaths: [finalPath],
        note: existing ? "用户编辑了页面" : "用户新建了页面",
      }),
    );
    await this.refreshBaseCounts(base, sources, queue);
    this.emit({ kbId, kind: "pages" });
    return this.pageOf(stored);
  }

  async deletePage(kbId: string, pagePath: string): Promise<void> {
    const base = await this.store.readBase(kbId);
    const page = await this.store.readPage(kbId, pagePath);
    if (!page) throw new KnowledgeError(404, "页面不存在");
    await this.store.deletePage(kbId, page.path);
    const [sources, queue] = await Promise.all([
      this.store.readSourceIndex(kbId),
      this.store.readQueue(kbId),
    ]);
    await this.rebuildIndexAndOverview(base, sources);
    const log = await this.store.readText(kbId, "log.md");
    await this.store.writeText(
      kbId,
      "log.md",
      appendLog(log, {
        date: this.today(),
        action: "delete",
        title: page.title,
        pagePaths: [page.path],
        note: "用户删除了页面",
      }),
    );
    await this.refreshBaseCounts(base, sources, queue);
    this.emit({ kbId, kind: "pages" });
  }

  async reindex(kbId: string): Promise<KnowledgeSnapshot> {
    const base = await this.store.readBase(kbId);
    const [sources, queue, pages] = await Promise.all([
      this.store.readSourceIndex(kbId),
      this.store.readQueue(kbId),
      this.store.listPages(kbId),
    ]);
    await this.rebuildIndexAndOverview(base, sources, pages);
    await this.refreshBaseCounts(base, sources, queue, pages.length);
    this.emit({ kbId, kind: "pages" });
    return this.snapshot(kbId);
  }

  /**
   * 混合检索：关键词得分 + 可选向量语义分（RRF 合并）+ 以命中页为种子的图谱扩展。
   * embedding 不可用时静默降级为关键词，并在 warning 里说明原因，绝不阻断检索。
   */
  async searchDetailed(
    query: unknown,
    kbId?: string,
    options: { expand?: boolean; limit?: number } = {},
  ): Promise<KnowledgeSearchResult> {
    const text = asString(query, 500);
    if (!text) return { hits: [], mode: "keyword" };
    const bases = kbId ? [await this.store.readBase(kbId)] : await this.store.listBases();
    const all: KnowledgeSearchHit[] = [];
    let hybrid = false;
    let expanded = false;
    let warning: string | undefined;
    for (const base of bases) {
      const pages = await this.store.listPages(base.id);
      if (pages.length === 0) continue;
      const keyword = searchPages(pages, text, 12);
      const byPath = new Map(pages.map((page) => [page.path, page]));
      const merged = new Map<
        string,
        { score: number; via: Set<"keyword" | "vector" | "graph">; vectorScore?: number; snippet: string }
      >();
      const add = (
        path: string,
        score: number,
        via: "keyword" | "vector" | "graph",
        snippet: string,
        vectorScore?: number,
      ): void => {
        const entry = merged.get(path);
        if (entry) {
          entry.score += score;
          entry.via.add(via);
          if (vectorScore !== undefined) entry.vectorScore = Math.max(entry.vectorScore ?? 0, vectorScore);
        } else {
          merged.set(path, {
            score,
            via: new Set([via]),
            ...(vectorScore !== undefined ? { vectorScore } : {}),
            snippet,
          });
        }
      };
      keyword.forEach((hit, index) => {
        add(hit.path, 1 / (60 + index + 1), "keyword", hit.snippet);
      });

      if (base.embeddingRef) {
        try {
          const index = await this.ensureEmbeddingIndex(base, pages, { maxPages: 200 });
          const queryVector = (await this.embedTexts(base, [text])).vectors[0];
          if (index && queryVector) {
            const scored = pages
              .map((page) => ({
                page,
                score: cosineSimilarity(queryVector, index.pages[page.path]?.vector ?? []),
              }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 12);
            if (scored.length > 0) hybrid = true;
            scored.forEach((entry, position) => {
              add(
                entry.page.path,
                1 / (60 + position + 1),
                "vector",
                entry.page.summary || entry.page.body.slice(0, 120),
                Number(entry.score.toFixed(3)),
              );
            });
          }
        } catch (err) {
          warning ??= `向量检索已降级为关键词：${errorMessage(err)}`;
        }
      }

      // 图谱扩展：命中页作为种子，1–2 跳带衰减地补相关页面。
      if (options.expand !== false && merged.size > 0) {
        const graph = buildGraph(pages.map((page) => this.metaOf(page)));
        const adjacency = new Map<string, Array<{ id: string; weight: number }>>();
        let maxWeight = 1;
        const addAdjacency = (from: string, to: string, weight: number): void => {
          const list = adjacency.get(from) ?? [];
          list.push({ id: to, weight });
          adjacency.set(from, list);
        };
        for (const edge of graph.edges) {
          maxWeight = Math.max(maxWeight, edge.weight);
          addAdjacency(edge.source, edge.target, edge.weight);
          addAdjacency(edge.target, edge.source, edge.weight);
        }
        const seedScore = Math.max(...[...merged.values()].map((entry) => entry.score), 0.0001);
        const seeds = [...merged.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .slice(0, 5)
          .map(([path, entry]) => ({ path, score: entry.score / seedScore }));
        let added = 0;
        for (const seed of seeds) {
          let frontier = new Map([[seed.path, seed.score]]);
          for (let hop = 1; hop <= 2 && added < 12; hop += 1) {
            const next = new Map<string, number>();
            for (const [path, score] of frontier) {
              for (const neighbor of adjacency.get(path) ?? []) {
                if (merged.has(neighbor.id)) continue;
                const weight = neighbor.weight / maxWeight;
                const candidate = score * (hop === 1 ? 0.45 : 0.2) * weight;
                if (candidate < 0.01) continue;
                next.set(neighbor.id, Math.max(next.get(neighbor.id) ?? 0, candidate));
              }
            }
            for (const [path, score] of next) {
              if (merged.has(path) || added >= 12) continue;
              const page = byPath.get(path);
              if (!page) continue;
              add(path, score, "graph", page.summary || page.body.slice(0, 120));
              expanded = true;
              added += 1;
            }
            frontier = next;
          }
        }
      }

      const maxScore = Math.max(...[...merged.values()].map((entry) => entry.score), 0.0001);
      const baseHits: KnowledgeSearchHit[] = [...merged.entries()].map(([path, entry]) => {
        const page = byPath.get(path)!;
        return {
          baseId: base.id,
          baseName: base.name,
          path,
          title: page.title,
          type: page.type,
          score: Number((entry.score / maxScore).toFixed(3)),
          snippet: entry.snippet,
          via: [...entry.via],
          ...(entry.vectorScore !== undefined ? { vectorScore: entry.vectorScore } : {}),
        };
      });
      baseHits.sort((a, b) => b.score - a.score);
      all.push(...baseHits.slice(0, 16));
    }
    const hits = all.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 20);
    return {
      hits,
      mode: hybrid
        ? expanded
          ? "hybrid+graph"
          : "hybrid"
        : expanded
          ? "keyword+graph"
          : "keyword",
      ...(warning ? { warning } : {}),
    };
  }

  /** 兼容旧调用：只要命中列表。 */
  async search(query: unknown, kbId?: string): Promise<KnowledgeSearchHit[]> {
    return (await this.searchDetailed(query, kbId)).hits;
  }

  /** 页面向量输入：标题 + 摘要 + 正文前 2000 字，兼顾语义与成本。 */
  private embeddingText(page: StoredPage): string {
    return `${page.title}\n${page.summary ?? ""}\n${page.body.slice(0, 2_000)}`;
  }

  private async embedTexts(
    base: KnowledgeBaseMeta,
    texts: string[],
  ): Promise<{ vectors: number[][]; tokens: number }> {
    const ref = base.embeddingRef?.trim();
    if (!ref) return { vectors: [], tokens: 0 };
    if (this.deps.embedder) {
      const result = await this.deps.embedder({ texts, ref });
      return { vectors: result.vectors, tokens: result.tokens ?? 0 };
    }
    const deps = this.deps.getModelDeps();
    const runtime = resolveEmbeddingRuntime(deps.settings, ref, deps.dataDir ?? this.deps.dir);
    if ("error" in runtime) throw new Error(runtime.error);
    const vectors: number[][] = [];
    let tokens = 0;
    for (let start = 0; start < texts.length; start += 32) {
      const result = await requestEmbeddings(runtime, texts.slice(start, start + 32));
      vectors.push(...result.vectors);
      tokens += result.tokens;
    }
    return { vectors, tokens };
  }

  /**
   * 维护页面向量缓存：缺失或内容哈希变化才重算，最多补 maxPages 页。
   * 保存前清掉已删除页面的向量，模型切换时整份重置。
   */
  private async ensureEmbeddingIndex(
    base: KnowledgeBaseMeta,
    pages: StoredPage[],
    options: { maxPages?: number } = {},
  ): Promise<KnowledgeEmbeddingIndex | undefined> {
    const ref = base.embeddingRef?.trim();
    if (!ref) return undefined;
    const existing = await this.store.readEmbeddings(base.id);
    const index: KnowledgeEmbeddingIndex =
      existing && existing.modelRef === ref
        ? existing
        : { modelRef: ref, dim: 0, updatedAt: 0, pages: {} };
    const alive = new Set(pages.map((page) => page.path));
    for (const path of Object.keys(index.pages)) {
      if (!alive.has(path)) delete index.pages[path];
    }
    const pending: Array<{ page: StoredPage; text: string; hash: string }> = [];
    const limit = options.maxPages ?? 200;
    for (const page of pages) {
      const text = this.embeddingText(page);
      const hash = createHash("sha256").update(text).digest("hex");
      const cached = index.pages[page.path];
      if (cached && cached.hash === hash && cached.vector.length > 0) continue;
      pending.push({ page, text, hash });
      if (pending.length >= limit) break;
    }
    if (pending.length === 0) return index;
    const { vectors, tokens } = await this.embedTexts(
      base,
      pending.map((entry) => entry.text),
    );
    if (vectors.length !== pending.length) throw new Error("向量数量与页面数量不一致");
    pending.forEach((entry, position) => {
      index.pages[entry.page.path] = { hash: entry.hash, vector: vectors[position]! };
    });
    index.dim = vectors[0]?.length ?? index.dim;
    index.updatedAt = this.now;
    await this.store.writeEmbeddings(base.id, index);
    this.recordEmbeddingUsage(ref, tokens);
    return index;
  }

  private recordEmbeddingUsage(ref: string, tokens: number): void {
    if (!this.deps.usage || tokens <= 0) return;
    try {
      const deps = this.deps.getModelDeps();
      const model = resolveModelChain(deps.settings, ref).primary;
      const usage: UsageTotals = { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 };
      const costUsd = calculateUsageCost(model, usage);
      const record = {
        ref: model.ref,
        providerId: model.providerId,
        modelId: model.id,
        usage,
        costUsd,
      };
      void this.deps.usage.record(record);
      this.deps.onUsageRecord?.(record);
    } catch {
      // 用量记账失败不影响检索。
    }
  }

  /**
   * 链接补全：默认只出提案；apply=true 时把提案落到页面正文并重建索引/日志。
   * 一次最多应用 maxLinks 条，避免手滑把整库正文改花。
   */
  async enrichLinks(
    kbId: string,
    options: { apply?: boolean; maxLinks?: number } = {},
  ): Promise<{ proposals: KnowledgeLinkProposal[]; applied: number }> {
    const base = await this.store.readBase(kbId);
    const pages = await this.store.listPages(kbId);
    const proposals = proposeLinks(pages);
    if (!options.apply) return { proposals, applied: 0 };
    const cap = Math.max(1, Math.min(options.maxLinks ?? 40, 200));
    const byPage = new Map<string, KnowledgeLinkProposal[]>();
    for (const proposal of proposals.slice(0, cap)) {
      const list = byPage.get(proposal.pagePath) ?? [];
      list.push(proposal);
      byPage.set(proposal.pagePath, list);
    }
    const changed: string[] = [];
    let applied = 0;
    for (const [pagePath, list] of byPage) {
      const page = pages.find((candidate) => candidate.path === pagePath);
      if (!page) continue;
      const parsed = parseFrontmatter(page.raw);
      const result = applyLinkProposals(parsed.body, list);
      if (result.applied === 0) continue;
      const { meta } = normalizePage(page.raw, {
        path: pagePath,
        today: this.today(),
        fallbackTitle: page.title,
        fallbackType: page.type,
        sourceIds: page.sources,
      });
      await this.store.writePage(
        kbId,
        pagePath,
        serializePage({ ...meta, updated: this.today() }, result.body),
      );
      applied += result.applied;
      changed.push(pagePath);
    }
    if (applied > 0) {
      const sources = await this.store.readSourceIndex(kbId);
      await this.rebuildIndexAndOverview(base, sources);
      const log = await this.store.readText(kbId, "log.md");
      await this.store.writeText(
        kbId,
        "log.md",
        appendLog(log, {
          date: this.today(),
          action: "manual",
          title: "链接补全",
          pagePaths: changed,
          note: `自动补全 ${applied} 条 wikilink（跳过代码块与已有链接）`,
        }),
      );
      const queue = await this.store.readQueue(kbId);
      await this.refreshBaseCounts(base, sources, queue);
      this.emit({ kbId, kind: "pages" });
    }
    return { proposals, applied };
  }

  /** 审核项：摄入时标记、用户异步处理，不阻塞整理队列。 */
  async listReviews(kbId: string): Promise<KnowledgeReview[]> {
    await this.store.readBase(kbId);
    const reviews = await this.store.readReviews(kbId);
    return reviews.sort((a, b) => {
      const pending = Number(b.status === "pending") - Number(a.status === "pending");
      return pending || b.createdAt - a.createdAt;
    });
  }

  private async recordReviews(
    base: KnowledgeBaseMeta,
    source: KnowledgeSource,
    plan: AnalysisPlan,
  ): Promise<void> {
    const existing = await this.store.readReviews(base.id);
    const known = new Set(existing.map((item) => item.title));
    const created: KnowledgeReview[] = [];
    for (const raw of plan.reviews.slice(0, 3)) {
      const kind = raw.kind;
      if (kind !== "create-page" && kind !== "research" && kind !== "skip") continue;
      const title = asString(raw.title, 120);
      if (!title || known.has(title)) continue;
      const reason = asString(raw.reason, 300) || "整理时标记需要人工判断";
      const query =
        asString(raw.query, 160) || (kind === "research" ? title.slice(0, 160) : "");
      created.push({
        id: newId("rv"),
        kind,
        status: "pending",
        title,
        reason,
        ...(query ? { query } : {}),
        sourceId: source.id,
        createdAt: this.now,
      });
      known.add(title);
    }
    // 模型没给 reviews 时，把分析阶段的存疑点转成「补资料」审核项（最多 2 条）。
    if (
      created.length === 0 &&
      plan.reviews.length === 0 &&
      plan.uncertainties.length > 0 &&
      (plan.keyPoints.length > 0 || plan.pages.length > 0)
    ) {
      for (const uncertainty of plan.uncertainties.slice(0, 2)) {
        const title = uncertainty.trim().slice(0, 120);
        if (!title || known.has(title)) continue;
        created.push({
          id: newId("rv"),
          kind: "research",
          status: "pending",
          title,
          reason: "整理时发现的存疑点，建议补充外部资料",
          query: title.slice(0, 160),
          sourceId: source.id,
          createdAt: this.now,
        });
        known.add(title);
      }
    }
    if (created.length === 0) return;
    await this.store.writeReviews(base.id, [...existing, ...created]);
    this.emit({ kbId: base.id, kind: "reviews" });
  }

  /** 处理审核项：建页、按建议检索并入库、或跳过。 */
  async resolveReview(
    kbId: string,
    reviewId: string,
    action: "create-page" | "research" | "skip",
  ): Promise<KnowledgeReview> {
    const base = await this.store.readBase(kbId);
    const reviews = await this.store.readReviews(kbId);
    const review = reviews.find((item) => item.id === reviewId);
    if (!review) throw new KnowledgeError(404, "审核项不存在");
    if (review.status !== "pending") throw new KnowledgeError(400, "这条审核已经处理过了");
    if (action === "skip") {
      review.status = "skipped";
    } else if (action === "create-page") {
      const path = `notes/审核-${slugify(review.title, "review")}-${review.id.slice(-4)}.md`;
      const page = await this.writePage(
        kbId,
        path,
        [
          "---",
          "type: note",
          `title: ${JSON.stringify(review.title)}`,
          "tags: [审核]",
          "related: []",
          `sources: [${review.sourceId ?? ""}]`,
          "---",
          "",
          `> 审核建页：${review.reason}`,
          "",
          review.query ? `待补充资料：${review.query}` : "（待补充正文）",
        ].join("\n"),
      );
      review.pagePath = page.path;
      review.status = "done";
    } else if (action === "research") {
      try {
        const result = await this.research(kbId, {
          topic: review.title,
          queries: review.query ? [review.query] : [],
        });
        review.researchSourceId = result.source.id;
        review.status = "done";
      } catch (err) {
        review.error = errorMessage(err);
        await this.store.writeReviews(kbId, reviews);
        this.emit({ kbId, kind: "reviews" });
        throw err instanceof KnowledgeError
          ? err
          : new KnowledgeError(502, `研究失败：${errorMessage(err)}`);
      }
    } else {
      throw new KnowledgeError(400, "未知的审核动作");
    }
    review.resolvedAt = this.now;
    review.error = undefined;
    await this.store.writeReviews(kbId, reviews);
    this.emit({ kbId, kind: "reviews" });
    return review;
  }

  /**
   * 深度研究：生成检索词 → 联网检索 → 抓取正文 → 组成一份来源材料并进入摄入队列。
   * 结果的质量由后续两阶段摄入继续整理；这里只负责把可用证据收集齐。
   */
  async research(
    kbId: string,
    input: { topic: unknown; queries?: unknown },
  ): Promise<{
    source: KnowledgeSource;
    queueItem: KnowledgeQueueItem;
    queries: string[];
    documents: number;
    warning?: string;
  }> {
    const base = await this.store.readBase(kbId);
    const topic = asString(input.topic, 200);
    if (!topic) throw new KnowledgeError(400, "研究主题不能为空");
    const warnings: string[] = [];
    let queries = asStringArray(input.queries, 3)
      .map((query) => query.replace(/\s+/g, " ").trim().slice(0, 160))
      .filter(Boolean);
    if (queries.length === 0) {
      const [purpose, overview] = await Promise.all([
        this.store.readText(base.id, "purpose.md"),
        this.store.readText(base.id, "wiki/overview.md"),
      ]);
      try {
        const planText = await this.generate(
          base,
          KNOWLEDGE_RESEARCH_PLAN_SYSTEM,
          buildResearchPlanPrompt({ topic, purpose: purpose || base.purpose, overview }),
          new AbortController().signal,
          800,
        );
        const json = extractJsonObject(planText);
        queries = asStringArray(json["queries"], 3)
          .map((query) => query.replace(/\s+/g, " ").trim().slice(0, 160))
          .filter(Boolean);
      } catch (err) {
        warnings.push(`检索词生成失败，直接用主题检索：${errorMessage(err)}`);
      }
    }
    if (queries.length === 0) queries = [topic];
    queries = [...new Set(queries)].slice(0, 3);

    const hits: Array<{ title: string; url: string; snippet: string; query: string }> = [];
    for (const query of queries) {
      try {
        const response = await this.webSearch(query, 5);
        if (response.warning) warnings.push(response.warning);
        for (const result of response.results) {
          hits.push({ ...result, query });
        }
      } catch (err) {
        warnings.push(`检索「${query}」失败：${errorMessage(err)}`);
      }
    }
    const unique: typeof hits = [];
    const seenUrls = new Set<string>();
    for (const hit of hits) {
      if (seenUrls.has(hit.url)) continue;
      seenUrls.add(hit.url);
      unique.push(hit);
      if (unique.length >= 6) break;
    }
    if (unique.length === 0) {
      throw new KnowledgeError(502, "没有检索到可用资料，请检查网络或换一个研究主题");
    }

    const documents: Array<{ title: string; url: string; text: string; query: string }> = [];
    for (const hit of unique.slice(0, 4)) {
      try {
        const page = await this.webFetch(hit.url);
        const text = page.text.trim();
        if (!text) continue;
        documents.push({
          title: page.title?.trim() || hit.title,
          url: page.finalUrl || hit.url,
          text: text.slice(0, 8_000),
          query: hit.query,
        });
      } catch (err) {
        warnings.push(`抓取 ${hit.url} 失败：${errorMessage(err)}`);
      }
    }

    const lines = [
      `# 深度研究：${topic}`,
      "",
      `> 由知识库研究流程生成 · ${this.today()} · 检索词：${queries.join(" / ")}`,
      "",
      "## 检索结果",
      "",
    ];
    for (const document of documents) {
      lines.push(`### ${document.title}`, "", `- 来源：${document.url}`, "");
      lines.push(document.text, "");
    }
    const fetched = new Set(documents.map((document) => document.url));
    for (const hit of unique) {
      if (fetched.has(hit.url)) continue;
      lines.push(`### ${hit.title}`, "", `- 来源：${hit.url}`, hit.snippet ? `- 摘要：${hit.snippet}` : "", "");
    }
    const content = lines.join("\n");
    if (content.length > KNOWLEDGE_LIMITS.maxSourceBytes) {
      throw new KnowledgeError(400, "研究材料超过 2 MB，请缩小研究范围");
    }
    const { source, queueItem } = await this.addSource(base.id, {
      title: `深度研究：${topic}`.slice(0, KNOWLEDGE_LIMITS.maxSourceTitleChars),
      content,
    });
    return {
      source,
      queueItem,
      queries,
      documents: documents.length,
      ...(warnings.length > 0 ? { warning: warnings.join("；") } : {}),
    };
  }

  private async webSearch(query: string, maxResults: number) {
    if (this.deps.web) return this.deps.web.search(query, { maxResults });
    const response = await searchWeb(query, { maxResults });
    return { results: response.results, ...(response.warning ? { warning: response.warning } : {}) };
  }

  private async webFetch(url: string) {
    if (this.deps.web) return this.deps.web.fetchPage(url);
    const page = await fetchWebPage(url);
    return {
      ...(page.title ? { title: page.title } : {}),
      text: page.text,
      finalUrl: page.finalUrl,
      truncated: page.truncated,
    };
  }

  async lint(kbId: string): Promise<KnowledgeLintReport> {    const [sources, pages, indexText] = await Promise.all([
      this.store.readSourceIndex(kbId),
      this.store.listPages(kbId),
      this.store.readText(kbId, "index.md"),
    ]);
    return lintWiki({ pages, sources, indexText, today: this.today() });
  }

  async graph(kbId: string): Promise<KnowledgeGraph> {
    const pages = await this.store.listPages(kbId);
    return buildGraph(pages);
  }

  /** 工具与面板共用：按 ID 或名称找库；不传且只有一个库时用它。 */
  async findBase(ref: string | undefined): Promise<KnowledgeBaseMeta | undefined> {
    const bases = await this.store.listBases();
    const clean = (ref ?? "").trim();
    if (!clean) return bases.length === 1 ? bases[0] : undefined;
    return bases.find((base) => base.id === clean) ??
      bases.find((base) => base.name.toLowerCase() === clean.toLowerCase());
  }

  async listPages(kbId: string): Promise<KnowledgePageMeta[]> {
    const pages = await this.store.listPages(kbId);
    return pages.map((page) => this.metaOf(page));
  }

  /** 系统提示词里的压缩视图：库数量、规模与索引摘录；每轮只读几份小文件。 */
  async summary(maxBases = 5): Promise<string | undefined> {
    const bases = (await this.store.listBases()).slice(0, maxBases);
    const active = bases.filter((base) => base.pageCount > 0 || base.sourceCount > 0);
    if (active.length === 0) return undefined;
    const lines: string[] = [];
    for (const base of active) {
      const index = (await this.store.readText(base.id, "index.md")).trim();
      const excerpt = index.length > 650 ? `${index.slice(0, 650)}…` : index;
      lines.push(
        `- 「${base.name}」（ID ${base.id}）：${base.pageCount} 页 / ${base.sourceCount} 份来源${
          base.description ? `；${base.description}` : ""
        }`,
      );
      if (excerpt) {
        lines.push(
          excerpt
            .split(/\r?\n/)
            .filter((line) => line.startsWith("- ") || line.startsWith("## "))
            .slice(0, 12)
            .map((line) => `  ${line}`)
            .join("\n"),
        );
      }
    }
    return lines.filter(Boolean).join("\n");
  }

  /** 关工作区：中止在跑的摄入，把它放回队列；下一次启动会接着整理。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
    this.watcher?.close();
    this.watcher = null;
    for (const entry of this.controllers.values()) entry.controller.abort();
    await Promise.allSettled([...this.workers.values()]);
  }

  private validateName(value: unknown): string {
    const name = asString(value, KNOWLEDGE_LIMITS.maxNameChars + 20);
    if (!name) throw new KnowledgeError(400, "知识库名称不能为空");
    if (name.length > KNOWLEDGE_LIMITS.maxNameChars) {
      throw new KnowledgeError(400, `知识库名称最多 ${KNOWLEDGE_LIMITS.maxNameChars} 个字`);
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new KnowledgeError(400, "知识库名称含非法字符");
    }
    return name;
  }

  private validateModelRef(value: unknown): string | undefined {
    const ref = asString(value, 200);
    if (!ref) return undefined;
    try {
      resolveModelChain(this.deps.getSettings(), ref);
      return ref;
    } catch (err) {
      throw new KnowledgeError(400, errorMessage(err));
    }
  }

  private metaOf(page: StoredPage): KnowledgePageMeta {
    const { body: _body, raw: _raw, hasFrontmatter: _hasFrontmatter, ...meta } = page;
    return meta;
  }

  private pageOf(page: StoredPage): KnowledgePage {
    const { raw: _raw, hasFrontmatter: _hasFrontmatter, ...rest } = page;
    return rest;
  }

  private async rebuildIndexAndOverview(
    base: KnowledgeBaseMeta,
    sources: KnowledgeSource[],
    pagesInput?: StoredPage[],
  ): Promise<void> {
    const pages = pagesInput ?? (await this.store.listPages(base.id));
    const metas = pages.map((page) => this.metaOf(page));
    await this.store.writeText(base.id, "index.md", buildIndex(base.name, metas, sources));
    await this.store.writeText(
      base.id,
      "wiki/overview.md",
      buildOverview(base, metas, sources, this.today()),
    );
  }

  private async refreshBaseCounts(
    base: KnowledgeBaseMeta,
    sources: KnowledgeSource[],
    queue: KnowledgeQueueItem[],
    pageCount?: number,
  ): Promise<void> {
    base.sourceCount = sources.length;
    base.pageCount = pageCount ?? (await this.store.listPages(base.id)).length;
    base.pendingCount = queue.filter(
      (item) => item.state === "queued" || item.state === "running",
    ).length;
    base.updatedAt = this.now;
    await this.store.writeBase(base);
  }

  private kick(kbId: string): Promise<void> {
    if (this.closed || this.deletedBases.has(kbId)) return Promise.resolve();
    const existing = this.workers.get(kbId);
    if (existing) return existing;
    const task = this.drain(kbId)
      .catch((err) => {
        console.error("知识库队列异常", kbId, err);
      })
      .finally(() => {
        this.workers.delete(kbId);
        if (!this.closed && !this.deletedBases.has(kbId)) {
          // 处理期间可能又进来了新材料：再检查一次。
          void this.hasQueued(kbId).then((has) => {
            if (has) void this.kick(kbId);
          });
        }
      });
    this.workers.set(kbId, task);
    return task;
  }

  private async hasQueued(kbId: string): Promise<boolean> {
    const queue = await this.store.readQueue(kbId);
    return queue.some((item) => item.state === "queued");
  }

  private async drain(kbId: string): Promise<void> {
    for (;;) {
      if (this.closed || this.deletedBases.has(kbId)) return;
      const queue = await this.store.readQueue(kbId);
      const next = queue.find((item) => item.state === "queued");
      if (!next) return;
      await this.runItem(kbId, next);
    }
  }

  private runItem(kbId: string, item: KnowledgeQueueItem): Promise<void> {
    return this.withKbLock(kbId, () => this.runItemUnlocked(kbId, item));
  }

  private async runItemUnlocked(kbId: string, item: KnowledgeQueueItem): Promise<void> {
    if (this.deletedBases.has(kbId)) return;
    const base = await this.store.readBase(kbId).catch(() => null);
    if (!base) return;
    const queue = await this.store.readQueue(kbId);
    const current = queue.find((candidate) => candidate.id === item.id);
    if (!current || current.state !== "queued") return;
    // 先登记控制器再对外暴露「running」：看到 running 的取消/删库请求一定能中止这次调用。
    const controller = new AbortController();
    this.controllers.set(current.id, { controller, kbId });
    current.state = "running";
    current.attempts += 1;
    current.startedAt = this.now;
    current.error = undefined;
    const sources = await this.store.readSourceIndex(kbId);
    const source = sources.find((candidate) => candidate.id === current.sourceId);
    if (!source) {
      current.state = "failed";
      current.error = "来源已不存在";
      current.finishedAt = this.now;
      this.controllers.delete(current.id);
      await this.store.writeQueue(kbId, queue);
      return;
    }
    source.status = "ingesting";
    source.error = undefined;
    await this.store.writeQueue(kbId, queue);
    await this.store.writeSourceIndex(kbId, sources);
    this.emit({ kbId, kind: "queue", queueItemId: current.id });
    this.emit({ kbId, kind: "source", sourceId: source.id });

    try {
      const outcome = await this.ingest(base, source, controller.signal);
      if (this.closed) {
        // 服务正在关闭：把义务放回队列，重启后继续，而不是记成失败。
        current.state = "queued";
        current.startedAt = undefined;
        current.error = undefined;
        source.status = "queued";
      } else {
        current.state = "done";
        current.finishedAt = this.now;
        source.status = "ready";
        source.summaryPath = outcome.summaryPath;
        source.pagePaths = outcome.pagePaths;
        source.ingestedAt = this.now;
        source.error = undefined;
      }
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (this.closed) {
        current.state = "queued";
        current.startedAt = undefined;
        source.status = "queued";
      } else if (aborted) {
        current.state = "cancelled";
        current.finishedAt = this.now;
        current.error = "已取消";
        source.status = "failed";
        source.error = "已取消整理，可稍后重试";
      } else {
        current.state = "failed";
        current.finishedAt = this.now;
        current.error = errorMessage(err);
        source.status = "failed";
        source.error = errorMessage(err);
      }
    } finally {
      this.controllers.delete(current.id);
    }
    const latestQueue = await this.store.readQueue(kbId);
    const slot = latestQueue.find((candidate) => candidate.id === current.id);
    if (slot) Object.assign(slot, current);
    const latestSources = await this.store.readSourceIndex(kbId);
    const sourceSlot = latestSources.find((candidate) => candidate.id === source.id);
    if (sourceSlot) Object.assign(sourceSlot, source);
    await this.store.writeQueue(kbId, latestQueue);
    // 先按内存里的最终状态重建索引与总览，再写回来源索引：
    // 这样读到「来源已整理」时，索引与总览一定已经是同一份状态。
    await this.rebuildIndexAndOverview(base, latestSources);
    await this.store.writeSourceIndex(kbId, latestSources);
    await this.refreshBaseCounts(base, latestSources, latestQueue);
    this.emit({ kbId, kind: "pages" });
    this.emit({ kbId, kind: "queue", queueItemId: current.id });
    this.emit({ kbId, kind: "source", sourceId: source.id });
  }

  private async ingest(
    base: KnowledgeBaseMeta,
    source: KnowledgeSource,
    signal: AbortSignal,
  ): Promise<IngestOutcome> {
    const raw = await this.store.readSourceRaw(base.id, source.rawPath);
    if (!raw.trim()) throw new Error("原始材料为空");
    const truncated = raw.length > KNOWLEDGE_LIMITS.maxPromptSourceChars;
    const material = truncated
      ? `${raw.slice(0, KNOWLEDGE_LIMITS.maxPromptSourceChars)}\n\n（材料已截断）`
      : raw;
    const [purpose, schema, indexText, storedPages] = await Promise.all([
      this.store.readText(base.id, "purpose.md"),
      this.store.readText(base.id, "schema.md"),
      this.store.readText(base.id, "index.md"),
      this.store.listPages(base.id),
    ]);
    const metas = storedPages.map((page) => this.metaOf(page));
    const analysisText = await this.generate(
      base,
      KNOWLEDGE_ANALYSIS_SYSTEM,
      buildAnalysisPrompt({
        base,
        sourceId: source.id,
        sourceTitle: source.title,
        sourceText: material,
        indexText,
        purpose: purpose || base.purpose,
        schema: schema || base.schema,
        existingPages: metas,
        today: this.today(),
        truncated,
      }),
      signal,
      2_000,
    );
    const plan = this.parseAnalysis(analysisText, raw);
    await this.recordReviews(base, source, plan).catch(() => undefined);
    const referencePages = this.pickReferences(storedPages, source.title, plan);
    const generationText = await this.generate(
      base,
      KNOWLEDGE_GENERATION_SYSTEM,
      buildGenerationPrompt({
        base,
        sourceId: source.id,
        sourceTitle: source.title,
        sourceText: material,
        analysis: plan,
        referencePages,
        today: this.today(),
        truncated,
      }),
      signal,
      8_000,
    );
    const blocks = parseFileBlocks(generationText);
    const notes: string[] = [];
    if (blocks.length === 0) notes.push("生成阶段没有解析出 FILE 块，仅保留来源摘要");
    const written: Array<{ path: string; page: StoredPage }> = [];
    const seenPaths = new Set<string>();
    let summaryPath: string | undefined;
    const existingByPath = new Map(storedPages.map((page) => [page.path, page]));
    for (const block of blocks) {
      if (this.closed) throw new Error("服务已关闭");
      let path: string;
      try {
        path = pagePathOf(normalizeWikiPath(block.path));
      } catch {
        notes.push(`跳过非法路径：${block.path}`);
        continue;
      }
      const parsed = parseFrontmatter(block.content);
      const type = isKnowledgePageType(parsed.data["type"])
        ? parsed.data["type"]
        : inferTypeFromPath(path);
      path = pagePathOf(correctPagePath(path, type));
      if (path.includes("/../") || path.startsWith("..")) {
        notes.push(`跳过越界路径：${block.path}`);
        continue;
      }
      const existing = existingByPath.get(path);
      const isNew = !existing;
      if (isNew && metas.length + written.length >= KNOWLEDGE_LIMITS.maxPages) {
        notes.push(`页面数量已达上限 ${KNOWLEDGE_LIMITS.maxPages}，跳过 ${path}`);
        continue;
      }
      const { meta, body } = normalizePage(block.content, {
        path,
        today: this.today(),
        fallbackTitle: path.split("/").pop()?.replace(/\.md$/i, ""),
        fallbackType: type,
        sourceIds: [source.id],
      });
      meta.created = existing?.created ?? meta.created;
      meta.updated = this.today();
      const page = await this.store.writePage(base.id, path, serializePage(meta, body));
      written.push({ path, page });
      seenPaths.add(path);
      if (meta.type === "source" && !summaryPath) summaryPath = page.path;
      // 生成阶段可能没有把来源 ID 写进 frontmatter：以系统注入为准，重写一次。
      if (!page.sources.includes(source.id)) {
        await this.store.writePage(
          base.id,
          path,
          serializePage({ ...meta, sources: [...page.sources, source.id] }, body),
        );
      }
    }
    if (!summaryPath) {
      summaryPath = await this.ensureSourceSummary(base, source, plan, written, existingByPath);
    }
    const summaryPage = await this.store.readPage(base.id, summaryPath);
    if (summaryPage && !seenPaths.has(summaryPage.path)) written.push({ path: summaryPage.path, page: summaryPage });
    const log = await this.store.readText(base.id, "log.md");
    const pagePaths = [...new Set(written.map((entry) => entry.path))];
    await this.store.writeText(
      base.id,
      "log.md",
      trimLog(
        appendLog(log, {
          date: this.today(),
          action: "ingest",
          title: source.title,
          sourceId: source.id,
          summaryPath,
          pagePaths,
          ...(notes.length > 0 ? { note: notes.join("；") } : {}),
        }),
      ),
    );
    return {
      pagePaths,
      summaryPath,
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
    };
  }

  private parseAnalysis(text: string, raw: string): AnalysisPlan {
    try {
      const json = extractJsonObject(text);
      return {
        summary: asString(json["summary"], 2_000) || raw.slice(0, 600),
        keyPoints: asStringArray(json["key_points"], 12),
        uncertainties: asStringArray(json["uncertainties"], 12),
        pages: Array.isArray(json["pages"])
          ? (json["pages"] as AnalysisPlan["pages"]).filter(
              (page) => page && typeof page === "object",
            )
          : [],
        reviews: Array.isArray(json["reviews"])
          ? (json["reviews"] as AnalysisPlan["reviews"]).filter(
              (item) => item && typeof item === "object",
            )
          : [],
      };
    } catch {
      // 分析失败不阻断：保留摘要页与原始材料，日志里说明「模型分析未解析」。
      return {
        summary: raw.slice(0, 600),
        keyPoints: [],
        uncertainties: ["模型分析输出无法解析，本页仅包含原始材料的节选摘要"],
        pages: [],
        reviews: [],
      };
    }
  }

  private pickReferences(
    pages: StoredPage[],
    title: string,
    plan: AnalysisPlan,
  ): Array<{ meta: KnowledgePageMeta; body: string }> {
    const planned = new Set(
      plan.pages
        .map((page) => (typeof page.path === "string" ? page.path.replace(/\.md$/i, "") : ""))
        .filter(Boolean),
    );
    const scored = searchPages(pages, `${title} ${plan.summary} ${plan.keyPoints.join(" ")}`, 6);
    const picked = scored
      .filter((hit) => !planned.has(hit.path.replace(/\.md$/i, "")))
      .slice(0, KNOWLEDGE_LIMITS.maxReferencePages);
    const result: Array<{ meta: KnowledgePageMeta; body: string }> = [];
    for (const hit of picked) {
      const page = pages.find((candidate) => candidate.path === hit.path);
      if (!page) continue;
      const body =
        page.body.length > KNOWLEDGE_LIMITS.maxReferencePageChars
          ? `${page.body.slice(0, KNOWLEDGE_LIMITS.maxReferencePageChars)}\n（已截断）`
          : page.body;
      result.push({ meta: this.metaOf(page), body });
    }
    return result;
  }

  private async ensureSourceSummary(
    base: KnowledgeBaseMeta,
    source: KnowledgeSource,
    plan: AnalysisPlan,
    written: Array<{ path: string; page: StoredPage }>,
    existingByPath: Map<string, StoredPage>,
  ): Promise<string> {
    const suggested = `sources/${source.id.replace(/^src_/, "source-")}.md`;
    const path = pagePathOf(correctPagePath(suggested, "source"));
    const existing = existingByPath.get(path);
    const content = buildSourceSummaryPage({
      sourceId: source.id,
      sourceTitle: source.title,
      summary: plan.summary,
      keyPoints: plan.keyPoints,
      uncertainties: plan.uncertainties,
      pagePaths: written.filter((entry) => entry.page.type !== "source").map((entry) => entry.path),
      today: this.today(),
    });
    const { meta, body } = normalizePage(content, {
      path,
      today: this.today(),
      fallbackTitle: source.title,
      fallbackType: "source",
      sourceIds: [source.id],
    });
    meta.created = existing?.created ?? meta.created;
    meta.updated = this.today();
    const stored = await this.store.writePage(base.id, path, serializePage(meta, body));
    written.push({ path: stored.path, page: stored });
    return stored.path;
  }

  private async generate(
    base: KnowledgeBaseMeta,
    system: string,
    user: string,
    signal: AbortSignal,
    maxTokens: number,
  ): Promise<string> {
    const settings = this.deps.getSettings();
    const ref = base.modelRef || settings.selection.defaultModel;
    const transport = resolveModelRuntime(ref, this.deps.getModelDeps());
    const request: LlmRequest = {
      ...transport.request,
      model: transport.model.id,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [],
      maxTokens: Math.min(maxTokens, transport.request.maxTokens ?? maxTokens),
      signal,
    };
    const { text, usage } = await completeOnce(transport.provider, request);
    if (this.deps.usage) {
      const model = transport.model;
      const costUsd = calculateUsageCost(model, usage);
      await this.deps.usage.record({
        ref: transport.activeRef() || model.ref,
        providerId: model.providerId,
        modelId: model.id,
        usage,
        costUsd,
      });
      this.deps.onUsageRecord?.({
        ref: transport.activeRef() || model.ref,
        providerId: model.providerId,
        modelId: model.id,
        usage,
        costUsd,
      });
    }
    if (!text.trim()) throw new Error("模型没有返回内容，请检查模型设置或稍后重试");
    return text;
  }

  /** 供工具直接读取页面（带正文）。 */
  async readPageWithBody(kbId: string, pagePath: string): Promise<KnowledgePage> {
    return this.readPage(kbId, pagePath);
  }

  assertBaseId(id: string): string {
    return assertKnowledgeId(id);
  }

  pageDirs(): Record<string, string> {
    return { ...PAGE_TYPE_DIRS };
  }
}
