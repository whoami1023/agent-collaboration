/**
 * 知识库（LLM Wiki 式）数据模型。
 *
 * 设计参考 nashsu/llm_wiki（GPL-3.0）的三层结构——原始材料只读、LLM 维护的 wiki 层、
 * 约束生成方式的 schema 层；以及它的内容目录 / 变更日志 / 双阶段摄入 / 来源摘要兜底做法。
 * 本项目没有复制其代码与提示词，按这里的运行时重新实现，存储布局与接口也按本项目的
 * 「每账号一个工作区」重排。
 */

export const KNOWLEDGE_PAGE_TYPES = [
  "source",
  "entity",
  "concept",
  "query",
  "comparison",
  "synthesis",
  "note",
] as const;

export type KnowledgePageType = (typeof KNOWLEDGE_PAGE_TYPES)[number];

/** 页面类型 → wiki 下的目录。与 schema.md 里的默认表一致；模型给的路径会按它校正。 */
export const PAGE_TYPE_DIRS: Record<KnowledgePageType, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  query: "queries",
  comparison: "comparisons",
  synthesis: "syntheses",
  note: "notes",
};

export const PAGE_TYPE_LABELS: Record<KnowledgePageType, string> = {
  source: "来源",
  entity: "实体",
  concept: "概念",
  query: "问答",
  comparison: "对比",
  synthesis: "综合",
  note: "笔记",
};

export const KNOWLEDGE_LIMITS = {
  maxBases: 20,
  maxNameChars: 48,
  maxDescriptionChars: 240,
  maxPurposeChars: 4_000,
  maxSchemaChars: 8_000,
  maxSourceBytes: 2 * 1024 * 1024,
  maxSourceTitleChars: 120,
  /** 单次摄入送给模型的正文上限：超出的部分截断并注明，避免一次吃掉整份上下文。 */
  maxPromptSourceChars: 60_000,
  /** 生成阶段参考的既有页面：最多 3 页、每页 6000 字。 */
  maxReferencePages: 3,
  maxReferencePageChars: 6_000,
  maxPages: 800,
  maxQueueAttempts: 3,
} as const;

export interface KnowledgeBaseMeta {
  id: string;
  name: string;
  description: string;
  /** 生成时的用途约束（purpose.md 的正文）；空表示通用知识库。 */
  purpose: string;
  /** 页面类型与命名约束（schema.md 的正文）。 */
  schema: string;
  /** 摄入用模型；空表示跟随账号默认模型。 */
  modelRef?: string;
  /** 检索用 embedding 模型；空表示只用关键词 + 图谱扩展。 */
  embeddingRef?: string;
  createdAt: number;
  updatedAt: number;
  pageCount: number;
  sourceCount: number;
  pendingCount: number;
}

export type KnowledgeSourceStatus = "queued" | "ingesting" | "ready" | "failed";

export interface KnowledgeSource {
  id: string;
  title: string;
  /** 相对知识库目录的原始材料路径（raw/sources/...）。 */
  rawPath: string;
  sha256: string;
  bytes: number;
  addedAt: number;
  status: KnowledgeSourceStatus;
  /** 摄入后生成的来源摘要页（wiki/sources/...）。 */
  summaryPath?: string;
  pagePaths: string[];
  error?: string;
  ingestedAt?: number;
}

export type KnowledgeQueueState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface KnowledgeQueueItem {
  id: string;
  sourceId: string;
  title: string;
  state: KnowledgeQueueState;
  attempts: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface KnowledgePageMeta {
  /** 相对 wiki/ 的路径，如 entities/openclaw.md。 */
  path: string;
  type: KnowledgePageType;
  title: string;
  tags: string[];
  related: string[];
  sources: string[];
  created: string;
  updated: string;
  links: string[];
  size: number;
  /** 索引里展示的第一段正文摘要。 */
  summary?: string;
}

export interface KnowledgePage extends KnowledgePageMeta {
  body: string;
}

export interface KnowledgeSourceIndex {
  sources: KnowledgeSource[];
}

export interface KnowledgeStoreIndex {
  bases: Array<Pick<KnowledgeBaseMeta, "id" | "name" | "description" | "createdAt" | "updatedAt">>;
}

export interface KnowledgeSnapshot {
  base: KnowledgeBaseMeta;
  sources: KnowledgeSource[];
  queue: KnowledgeQueueItem[];
  pages: KnowledgePageMeta[];
  /** 摄入时标记的异步审核项（只在需要人工判断时出现）。 */
  reviews: KnowledgeReview[];
  overview: string;
  index: string;
  log: string;
}

export type KnowledgeReviewKind = "create-page" | "research" | "skip";
export type KnowledgeReviewStatus = "pending" | "done" | "skipped";

export interface KnowledgeReview {
  id: string;
  kind: KnowledgeReviewKind;
  status: KnowledgeReviewStatus;
  title: string;
  /** 为什么需要人看：矛盾、缺口、命名冲突等。 */
  reason: string;
  /** 建议的检索词（research 类）。 */
  query?: string;
  sourceId?: string;
  createdAt: number;
  resolvedAt?: number;
  /** 已建页时记录路径；已研究时记录新来源 ID。 */
  pagePath?: string;
  researchSourceId?: string;
  error?: string;
}

export interface KnowledgeSearchHit {
  baseId: string;
  baseName: string;
  path: string;
  title: string;
  type: KnowledgePageType;
  score: number;
  snippet: string;
  /** 命中来源：关键词、向量或图谱扩展（可多选）。 */
  via?: Array<"keyword" | "vector" | "graph">;
  vectorScore?: number;
}

export type KnowledgeSearchMode = "keyword" | "hybrid" | "keyword+graph" | "hybrid+graph";

/** 链接补全提案：在 pagePath 正文里给 alias 首次出现处补一条指向 targetPath 的 wikilink。 */
export interface KnowledgeLinkProposal {
  pagePath: string;
  targetPath: string;
  alias: string;
  snippet: string;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  mode: KnowledgeSearchMode;
  /** embedding 不可用时的降级原因；不影响关键词结果。 */
  warning?: string;
}

/** 向量缓存：按页面路径保存内容哈希与向量，模型换了就整份重置。 */
export interface KnowledgeEmbeddingEntry {
  hash: string;
  vector: number[];
}

export interface KnowledgeEmbeddingIndex {
  modelRef: string;
  dim: number;
  updatedAt: number;
  pages: Record<string, KnowledgeEmbeddingEntry>;
}

export type KnowledgeLintSeverity = "error" | "warning" | "info";

export interface KnowledgeLintIssue {
  id: string;
  severity: KnowledgeLintSeverity;
  kind:
    | "broken-link"
    | "orphan"
    | "missing-frontmatter"
    | "missing-title"
    | "duplicate-title"
    | "unindexed"
    | "missing-source-page"
    | "source-failed"
    | "stale-index"
    | "empty-page";
  path?: string;
  sourceId?: string;
  message: string;
}

export interface KnowledgeLintReport {
  checkedAt: number;
  pageCount: number;
  sourceCount: number;
  issues: KnowledgeLintIssue[];
}

export interface KnowledgeGraphNode {
  id: string;
  title: string;
  type: KnowledgePageType;
  tags: string[];
  sourceCount: number;
  /** 图谱内的度数（入边 + 出边）。 */
  degree: number;
  /** Louvain 社区编号（0 为最大社区，按规模降序重排）。 */
  community: number;
}

/** 一条关联边背后的四路信号；权重是它们的加权和，信号值用于面板解释。 */
export interface KnowledgeEdgeSignals {
  /** 直接 [[wikilink]]：0 或 1，权重 ×3。 */
  link: number;
  /** 共享来源材料：0 或 1，权重 ×4。 */
  source: number;
  /** Adamic-Adar 共同邻居得分（0–1），权重 ×1.5。 */
  adamicAdar: number;
  /** 同页面类型：0 或 1，权重 ×1。 */
  typeAffinity: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  /** 最强的信号来源；只用于列表分组与旧接口兼容。 */
  kind: "link" | "source" | "neighbor";
  weight: number;
  signals: KnowledgeEdgeSignals;
}

export interface KnowledgeCommunity {
  id: number;
  /** 社区里度数最高的页面标题，用作图例。 */
  label: string;
  size: number;
  /** 内部边数 / 可能边数；低内聚社区在洞察里提示补充交叉引用。 */
  cohesion: number;
  lowCohesion: boolean;
  members: string[];
}

export type KnowledgeInsightKind = "surprising" | "orphan" | "bridge" | "sparse-community";

export interface KnowledgeInsight {
  id: string;
  kind: KnowledgeInsightKind;
  title: string;
  detail: string;
  nodeIds: string[];
  edgeKeys?: string[];
  /** 建议的后续研究方向（由用户决定是否去研究）。 */
  suggestedTopic?: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  communities: KnowledgeCommunity[];
  insights: KnowledgeInsight[];
  truncated: boolean;
}

/** 知识库的变更事件：经主总线 SSE 广播，面板据此刷新快照与队列。 */
export interface KnowledgeEvent {
  kbId: string;
  kind: "bases" | "source" | "queue" | "pages" | "settings" | "reviews";
  sourceId?: string;
  queueItemId?: string;
  message?: string;
}

export class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}
