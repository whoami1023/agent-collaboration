import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  KnowledgeBaseMeta,
  KnowledgeGraph,
  KnowledgeLintReport,
  KnowledgeLinkProposal,
  KnowledgeQueueItem,
  KnowledgeReview,
  KnowledgeSearchHit,
  KnowledgeSearchMode,
  KnowledgeSnapshot,
  KnowledgeSource,
  WorkspaceFileEntry,
} from "./api";
import {
  addKnowledgeSource,
  cancelKnowledgeQueue,
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgePage,
  enrichKnowledge,
  fetchKnowledgeBases,
  fetchKnowledgeGraph,
  fetchKnowledgeLint,
  fetchKnowledgePage,
  fetchKnowledgeSnapshot,
  fetchKnowledgeSourceRaw,
  fetchWorkspaceFiles,
  importKnowledgeBundle,
  importKnowledgeFolder,
  knowledgeExportUrl,
  reindexKnowledge,
  removeKnowledgeSource,
  researchKnowledge,
  rescanKnowledgeSources,
  resolveKnowledgeReview,
  retryKnowledgeQueue,
  saveKnowledgePage,
  searchKnowledge,
  updateKnowledgeBase,
} from "./api";
import {
  KNOWLEDGE_PAGE_TYPES,
  PAGE_TYPE_LABELS,
  type KnowledgePageType,
} from "../../src/knowledge/types";
import KnowledgeGraphView, {
  COMMUNITY_COLORS,
  TYPE_COLORS,
  type GraphHighlight,
} from "./KnowledgeGraph";
import KnowledgePagePreview from "./KnowledgePagePreview";
import { Icon } from "./icons";

type KnowledgeTab = "pages" | "sources" | "queue" | "reviews" | "graph" | "overview" | "lint";

type PanelMode =
  | { kind: "browse" }
  | { kind: "create-base" }
  | { kind: "edit-base" }
  | { kind: "page"; path: string; content: string; isNew: boolean }
  | {
      kind: "source";
      sourceId: string;
      title: string;
      content: string;
      bytes: number;
      binary: boolean;
    };

interface BaseFormState {
  name: string;
  description: string;
  purpose: string;
  schema: string;
  modelRef: string;
  embeddingRef: string;
}

const EMPTY_BASE_FORM: BaseFormState = {
  name: "",
  description: "",
  purpose: "",
  schema: "",
  modelRef: "",
  embeddingRef: "",
};

/** 从聊天消息带进来的知识页草稿：打开面板后直接进入新建页面。 */
export interface KnowledgePageDraft {
  title: string;
  content: string;
  nonce: number;
}

const SEARCH_MODE_LABEL: Record<KnowledgeSearchMode, string> = {
  keyword: "关键词",
  hybrid: "关键词 + 向量",
  "keyword+graph": "关键词 + 图谱扩展",
  "hybrid+graph": "关键词 + 向量 + 图谱扩展",
};

const REVIEW_KIND_LABEL = {
  "create-page": "建议建页",
  research: "建议补资料",
  skip: "建议忽略",
} as const;

const BASE_PRESETS: Array<{ key: string; label: string; purpose: string; schema: string }> = [
  {
    key: "general",
    label: "通用",
    purpose:
      "# 知识库用途\n\n- 记录这个知识库服务什么工作：要回答哪些问题、给谁看、哪些内容值得长期保留。\n- 一段材料值不值得整理成页面，以这里写的边界为准。",
    schema: "",
  },
  {
    key: "research",
    label: "调研",
    purpose:
      "# 调研知识库\n\n- 为方案设计、选型与技术评审提供依据。\n- 保留来源、结论、证据与局限；过程性讨论与未经验证的猜测不单独成页。\n- 不同来源互相矛盾时，在页面里并列写明，不要强行统一。",
    schema:
      "# 页面规则\n\n- 概念页写清定义、适用场景、代价与代表实现。\n- 对比页必须包含对比表与选型建议。\n- 每个结论注明来自哪份来源；样本不足写进「局限」。",
  },
  {
    key: "reading",
    label: "阅读",
    purpose:
      "# 阅读知识库\n\n- 沉淀书籍、长文与课程的章节要点、概念与作者观点。\n- 保留页码/章节定位，方便回到原文；区分作者观点与自己的判断。",
    schema:
      "# 页面规则\n\n- 来源页按章节/文章组织摘要。\n- 概念页记录定义、上下文与例子。\n- 用 [[链接]] 把同一主题在不同材料里的论述串起来。",
  },
  {
    key: "project",
    label: "项目",
    purpose:
      "# 项目知识库\n\n- 记录项目背景、决策、约束、接口与踩坑经验，供新成员与后续维护使用。\n- 只保留可复用的结论与依据；一次性操作细节不单独成页。",
    schema:
      "# 页面规则\n\n- 决策页写清背景、备选方案、选择理由与影响。\n- 实体页记录系统、服务与外部依赖。\n- 变更与事故写时间、影响范围与后续动作。",
  },
];

const NEW_PAGE_TEMPLATE = `---
type: note
title: 新页面
tags: []
related: []
sources: []
---

在这里写正文。可以用 [[其他页面]] 关联已有知识。
`;

const SOURCE_STATUS_LABEL: Record<KnowledgeSource["status"], string> = {
  queued: "排队中",
  ingesting: "整理中",
  ready: "已整理",
  failed: "失败",
};

const QUEUE_STATE_LABEL: Record<KnowledgeQueueItem["state"], string> = {
  queued: "排队",
  running: "整理中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

const INSIGHT_LABEL = {
  surprising: "意外关联",
  orphan: "孤立页",
  bridge: "桥接节点",
  "sparse-community": "稀疏集群",
} as const;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatInstant(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function slugForPath(title: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "answer";
}

function draftPage(draft: KnowledgePageDraft): { path: string; content: string } {
  const today = new Date().toISOString().slice(0, 10);
  const title = draft.title.trim() || "问答整理";
  return {
    path: `queries/${slugForPath(title)}-${today}.md`,
    content: [
      "---",
      "type: query",
      `title: ${JSON.stringify(title)}`,
      "tags: [问答]",
      "related: []",
      "sources: []",
      "---",
      "",
      draft.content.trim(),
      "",
    ].join("\n"),
  };
}

/** 每个库的页面按类型分组，顺序跟 schema 一致，方便对照。 */
function groupPages(pages: KnowledgeSnapshot["pages"]): Array<{
  type: KnowledgePageType;
  pages: KnowledgeSnapshot["pages"];
}> {
  return KNOWLEDGE_PAGE_TYPES.map((type) => ({
    type,
    pages: pages.filter((page) => page.type === type),
  })).filter((group) => group.pages.length > 0);
}

/** 文件工作区路径输入：聚焦时读清单，输入时按包含关系给出可选路径。 */
function WorkspacePathSuggest({
  label,
  mode,
  value,
  placeholder,
  entries,
  loading,
  error,
  onChange,
  onRequestLoad,
}: {
  label: string;
  mode: "file" | "dir";
  value: string;
  placeholder: string;
  entries: WorkspaceFileEntry[] | null;
  loading: boolean;
  error: string | null;
  onChange(value: string): void;
  onRequestLoad(): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const wanted = mode === "dir" ? "dir" : "file";
    const query = value.trim().toLowerCase();
    const scored: Array<{ entry: WorkspaceFileEntry; score: number }> = [];
    for (const entry of entries ?? []) {
      if (entry.kind !== wanted) continue;
      const path = entry.path.replace(/\\/g, "/");
      const index = query ? path.toLowerCase().indexOf(query) : 0;
      if (query && index < 0) continue;
      scored.push({ entry, score: index });
    }
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (!query && mode === "file" && a.entry.updatedAt !== b.entry.updatedAt) {
        return b.entry.updatedAt - a.entry.updatedAt;
      }
      return a.entry.path.localeCompare(b.entry.path);
    });
    return scored.slice(0, 8).map((item) => item.entry);
  }, [entries, mode, value]);

  useEffect(() => {
    setActive(0);
  }, [value, open]);

  function choose(path: string): void {
    onChange(path);
    setOpen(false);
  }

  return (
    <label className="field path-suggest-field">
      <span>{label}</span>
      <div className="path-suggest-wrap">
        <input
          value={value}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            onRequestLoad();
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (!open) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && matches[active]) {
              event.preventDefault();
              choose(matches[active]!.path);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {open && (
          <ul className="path-suggest" role="listbox">
            {loading && <li className="path-suggest-empty">正在读取文件工作区…</li>}
            {!loading && error && <li className="path-suggest-empty">{error}</li>}
            {!loading && !error && matches.length === 0 && (
              <li className="path-suggest-empty">
                {entries === null
                  ? "正在等待文件工作区清单"
                  : `没有匹配的${mode === "dir" ? "目录" : "文件"}`}
              </li>
            )}
            {!loading &&
              !error &&
              matches.map((entry, index) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`path-suggest-item${index === active ? " active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(entry.path);
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    <Icon name={entry.kind === "dir" ? "folder" : "file"} size={13} />
                    <span className="path-suggest-path">{entry.path}</span>
                    <span className="path-suggest-meta">
                      {entry.kind === "dir"
                        ? "目录"
                        : `${Math.max(1, Math.round(entry.sizeBytes / 1024))} KB`}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </label>
  );
}

export default function KnowledgePanel({
  onClose,
  refreshToken,
  modelChoices,
  onPendingChange,
  draft,
  onDraftUsed,
}: {
  onClose(): void;
  refreshToken: number;
  modelChoices: { ref: string; label: string }[];
  onPendingChange?(count: number): void;
  draft?: KnowledgePageDraft | null;
  onDraftUsed?(): void;
}) {
  const [bases, setBases] = useState<KnowledgeBaseMeta[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [tab, setTab] = useState<KnowledgeTab>("pages");
  const [mode, setMode] = useState<PanelMode>({ kind: "browse" });
  const [baseForm, setBaseForm] = useState<BaseFormState>(EMPTY_BASE_FORM);
  const [sourceForm, setSourceForm] = useState<{
    title: string;
    content: string;
    filePath: string;
  } | null>(null);
  const [folderForm, setFolderForm] = useState<{ path: string } | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceFileEntry[] | null>(null);
  const [workspaceEntriesLoading, setWorkspaceEntriesLoading] = useState(false);
  const [workspaceEntriesError, setWorkspaceEntriesError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [linkProposals, setLinkProposals] = useState<KnowledgeLinkProposal[] | null>(null);
  const [lint, setLint] = useState<KnowledgeLintReport | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [graphColorMode, setGraphColorMode] = useState<"type" | "community">("type");
  const [activeInsight, setActiveInsight] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingBase, setConfirmingBase] = useState(false);
  const [confirmingSource, setConfirmingSource] = useState<string | null>(null);
  const [confirmingPage, setConfirmingPage] = useState(false);

  const selectedBase = bases?.find((base) => base.id === selectedId) ?? null;

  const reloadBases = useCallback(async () => {
    try {
      const next = await fetchKnowledgeBases();
      setBases(next);
      setSelectedId((current) =>
        current && next.some((base) => base.id === current) ? current : (next[0]?.id ?? null),
      );
      onPendingChange?.(next.reduce((sum, base) => sum + base.pendingCount, 0));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
      setBases([]);
    }
  }, [onPendingChange]);

  const reloadSnapshot = useCallback(async (id: string) => {
    try {
      setSnapshot(await fetchKnowledgeSnapshot(id));
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  const loadWorkspaceEntries = useCallback(async () => {
    if (workspaceEntriesLoading || workspaceEntries) return;
    setWorkspaceEntriesLoading(true);
    setWorkspaceEntriesError(null);
    try {
      const listing = await fetchWorkspaceFiles();
      setWorkspaceEntries(listing.files);
    } catch (err) {
      setWorkspaceEntriesError(messageOf(err));
    } finally {
      setWorkspaceEntriesLoading(false);
    }
  }, [workspaceEntries, workspaceEntriesLoading]);

  useEffect(() => {
    void reloadBases();
  }, [reloadBases, refreshToken]);

  useEffect(() => {
    if (!selectedId) {
      setSnapshot(null);
      return;
    }
    void reloadSnapshot(selectedId);
  }, [selectedId, reloadSnapshot, refreshToken]);

  // 有材料在整理时补一个慢轮询：SSE 事件可能因为刷新页面而错过。
  useEffect(() => {
    if (!selectedId || !snapshot || snapshot.base.pendingCount === 0) return;
    const timer = setInterval(() => void reloadSnapshot(selectedId), 4000);
    return () => clearInterval(timer);
  }, [selectedId, snapshot, reloadSnapshot]);

  // 打开体检 / 图谱 / 概览标签时按需拉数据。
  useEffect(() => {
    if (!selectedId) return;
    if (tab === "lint" && mode.kind === "browse") {
      fetchKnowledgeLint(selectedId)
        .then(setLint)
        .catch((err: unknown) => setError(messageOf(err)));
    }
    if ((tab === "overview" || tab === "graph") && mode.kind === "browse") {
      fetchKnowledgeGraph(selectedId)
        .then(setGraph)
        .catch((err: unknown) => setError(messageOf(err)));
    }
  }, [selectedId, tab, mode.kind, refreshToken]);

  // 聊天消息带来的草稿：等库清单就绪后直接进入新建页面，交给用户确认路径与正文。
  useEffect(() => {
    if (!draft || bases === null) return;
    if (bases.length === 0) {
      setNotice("还没有知识库：请先创建一个，再把回答存为知识页。");
      onDraftUsed?.();
      return;
    }
    const page = draftPage(draft);
    setError(null);
    setNotice("已把这条回答放进新建页面：确认标题与路径后点保存。");
    setSelectedId((current) => current ?? bases[0]!.id);
    setPreviewMode(false);
    setMode({ kind: "page", path: page.path, content: page.content, isNew: true });
    onDraftUsed?.();
  }, [draft, bases, onDraftUsed]);

  const pageGroups = useMemo(() => groupPages(snapshot?.pages ?? []), [snapshot]);
  const pendingReviews = snapshot?.reviews.filter((item) => item.status === "pending").length ?? 0;
  const activeInsightData = graph?.insights.find((insight) => insight.id === activeInsight) ?? null;
  const graphHighlight: GraphHighlight | null = activeInsightData
    ? { nodeIds: activeInsightData.nodeIds, edgeKeys: activeInsightData.edgeKeys ?? [] }
    : null;

  function resetMessages() {
    setError(null);
    setNotice(null);
  }

  function openCreateBase() {
    resetMessages();
    setBaseForm(EMPTY_BASE_FORM);
    setMode({ kind: "create-base" });
  }

  function openEditBase() {
    if (!selectedBase) return;
    resetMessages();
    setBaseForm({
      name: selectedBase.name,
      description: selectedBase.description,
      purpose: selectedBase.purpose,
      schema: selectedBase.schema,
      modelRef: selectedBase.modelRef ?? "",
      embeddingRef: selectedBase.embeddingRef ?? "",
    });
    setConfirmingBase(false);
    setMode({ kind: "edit-base" });
  }

  async function submitBaseForm() {
    if (busy) return;
    setBusy("base");
    setError(null);
    try {
      if (mode.kind === "create-base") {
        const base = await createKnowledgeBase({
          name: baseForm.name,
          description: baseForm.description,
          purpose: baseForm.purpose,
          ...(baseForm.schema ? { schema: baseForm.schema } : {}),
          ...(baseForm.modelRef ? { modelRef: baseForm.modelRef } : {}),
          ...(baseForm.embeddingRef ? { embeddingRef: baseForm.embeddingRef } : {}),
        });
        setNotice(`已创建知识库「${base.name}」，导入材料后会在后台逐份整理。`);
        setSelectedId(base.id);
      } else if (mode.kind === "edit-base" && selectedId) {
        await updateKnowledgeBase(selectedId, {
          name: baseForm.name,
          description: baseForm.description,
          purpose: baseForm.purpose,
          schema: baseForm.schema,
          modelRef: baseForm.modelRef,
          embeddingRef: baseForm.embeddingRef,
        });
        setNotice("知识库设置已保存，之后的摄入按新约束执行。");
      }
      setMode({ kind: "browse" });
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteBase() {
    if (!selectedId || busy) return;
    setBusy("base-delete");
    setError(null);
    try {
      const name = selectedBase?.name ?? "知识库";
      await deleteKnowledgeBase(selectedId);
      setNotice(`知识库「${name}」已删除（原始材料、wiki 页面、索引与日志一并清除）。`);
      setConfirmingBase(false);
      setSnapshot(null);
      setGraph(null);
      setLint(null);
      setHits(null);
      setQuery("");
      setActiveInsight(null);
      setSourceForm(null);
      setTab("pages");
      setMode({ kind: "browse" });
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitSource() {
    if (!selectedId || !sourceForm || busy) return;
    if (!sourceForm.content.trim() && !sourceForm.filePath.trim()) {
      setError("粘贴材料正文，或填写文件工作区里的文件路径");
      return;
    }
    setBusy("source");
    setError(null);
    try {
      await addKnowledgeSource(selectedId, {
        ...(sourceForm.title.trim() ? { title: sourceForm.title.trim() } : {}),
        ...(sourceForm.content.trim() ? { content: sourceForm.content } : {}),
        ...(sourceForm.filePath.trim() ? { filePath: sourceForm.filePath.trim() } : {}),
      });
      setNotice("材料已加入整理队列：分析 → 写页面 → 更新索引与日志。");
      setSourceForm(null);
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveSource(source: KnowledgeSource) {
    if (!selectedId) return;
    setBusy(`source-${source.id}`);
    setError(null);
    try {
      await removeKnowledgeSource(selectedId, source.id);
      setNotice(`已删除来源「${source.title}」；它生成的 wiki 页面保留。`);
      setConfirmingSource(null);
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry(itemId?: string) {
    if (!selectedId || busy) return;
    setBusy("queue");
    setError(null);
    try {
      const queue = await retryKnowledgeQueue(selectedId, itemId);
      setSnapshot((current) => (current ? { ...current, queue } : current));
      setNotice("失败的整理已重新排队。");
      await reloadSnapshot(selectedId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel(itemId?: string) {
    if (!selectedId || busy) return;
    setBusy("queue");
    setError(null);
    try {
      const queue = await cancelKnowledgeQueue(selectedId, itemId);
      setSnapshot((current) => (current ? { ...current, queue } : current));
      setNotice("已取消待处理的整理。");
      await reloadSnapshot(selectedId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleSearch() {
    if (!selectedId) return;
    const text = query.trim();
    if (!text) {
      setHits(null);
      return;
    }
    setBusy("search");
    setError(null);
    try {
      const result = await searchKnowledge(text, selectedId);
      setHits(result.hits);
      setSearchMode(result.mode);
      setSearchWarning(result.warning ?? null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function openPage(path: string) {
    if (!selectedId) return;
    setBusy("page");
    setError(null);
    try {
      const { page, raw } = await fetchKnowledgePage(selectedId, path);
      setMode({ kind: "page", path: page.path, content: raw, isNew: false });
      setPreviewMode(false);
      setConfirmingPage(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function openSourceRaw(sourceId: string) {
    if (!selectedId) return;
    setBusy("source-raw");
    setError(null);
    try {
      const result = await fetchKnowledgeSourceRaw(selectedId, sourceId);
      setMode({
        kind: "source",
        sourceId,
        title: result.source.title,
        content: result.content,
        bytes: result.source.bytes,
        binary: result.binary,
      });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  function openNewPage() {
    resetMessages();
    setMode({ kind: "page", path: "notes/新页面.md", content: NEW_PAGE_TEMPLATE, isNew: true });
    setPreviewMode(false);
    setConfirmingPage(false);
  }

  async function saveCurrentPage() {
    if (!selectedId || mode.kind !== "page" || busy) return;
    setBusy("page-save");
    setError(null);
    try {
      const page = await saveKnowledgePage(selectedId, mode.path, mode.content);
      setNotice(`页面已保存：${page.path}`);
      setMode({ kind: "page", path: page.path, content: mode.content, isNew: false });
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteCurrentPage() {
    if (!selectedId || mode.kind !== "page" || busy) return;
    setBusy("page-delete");
    setError(null);
    try {
      await deleteKnowledgePage(selectedId, mode.path);
      setNotice(`已删除页面 ${mode.path}`);
      setMode({ kind: "browse" });
      setConfirmingPage(false);
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleReindex() {
    if (!selectedId || busy) return;
    setBusy("reindex");
    setError(null);
    try {
      setSnapshot(await reindexKnowledge(selectedId));
      setNotice("索引、总览与计数已按当前页面重建。");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleEnrich(apply: boolean) {
    if (!selectedId || busy) return;
    setBusy(apply ? "enrich-apply" : "enrich");
    setError(null);
    try {
      const result = await enrichKnowledge(selectedId, { apply, maxLinks: 40 });
      setLinkProposals(result.proposals);
      if (apply) {
        setNotice(
          result.applied > 0
            ? `已补全 ${result.applied} 条 wikilink，索引与日志已更新。`
            : "没有补上新的链接（可能都已有链接或目标不唯一）。",
        );
        await reloadSnapshot(selectedId);
        await reloadBases();
      } else {
        setNotice(
          result.proposals.length > 0
            ? `发现 ${result.proposals.length} 条可补链接，确认后再应用。`
            : "没有发现可补的链接。",
        );
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleResolveReview(
    review: KnowledgeReview,
    action: "create-page" | "research" | "skip",
  ) {
    if (!selectedId || busy) return;
    setBusy(`review-${review.id}`);
    setError(null);
    try {
      await resolveKnowledgeReview(selectedId, review.id, action);
      setNotice(
        action === "skip"
          ? "已忽略这条审核。"
          : action === "create-page"
            ? `已创建页面 ${review.title}。`
            : `已为「${review.title}」检索资料并加入整理队列。`,
      );
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleResearch(topic: string) {
    if (!selectedId || busy) return;
    setBusy("research");
    setError(null);
    try {
      const result = await researchKnowledge(selectedId, { topic });
      setNotice(
        `研究「${result.source.title}」已收集 ${result.documents} 篇正文，检索词：${result.queries.join(
          " / ",
        )}；已加入整理队列。${result.warning ? `（${result.warning}）` : ""}`,
      );
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFolder() {
    if (!selectedId || !folderForm || busy) return;
    if (!folderForm.path.trim()) {
      setError("填写文件工作区里的目录路径，留空表示导入整个工作区根目录");
      return;
    }
    setBusy("folder");
    setError(null);
    try {
      const result = await importKnowledgeFolder(selectedId, {
        path: folderForm.path.trim(),
        maxFiles: 20,
      });
      const skipped = result.skipped.length + result.unsupported.length;
      setNotice(
        `文件夹导入完成：新增 ${result.added.length} 份材料${
          skipped > 0 ? `，跳过 ${skipped} 个文件` : ""
        }。`,
      );
      if (skipped > 0) {
        setError(
          [...result.skipped, ...result.unsupported]
            .slice(0, 5)
            .map((item) => `${item.path}：${item.reason}`)
            .join("；"),
        );
      }
      setFolderForm(null);
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportBundle(file: File) {
    if (busy) return;
    setBusy("bundle");
    setError(null);
    try {
      const base = await importKnowledgeBundle(file);
      setNotice(`已导入知识库「${base.name}」，索引已按页面重建。`);
      await reloadBases();
      setSelectedId(base.id);
      setTab("pages");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleRescan() {
    if (!selectedId || busy) return;
    setBusy("rescan");
    setError(null);
    try {
      const result = await rescanKnowledgeSources(selectedId);
      setNotice(
        `已扫描 raw/sources：新增 ${result.added}、更新 ${result.updated}、失效 ${result.removed}。`,
      );
      await reloadSnapshot(selectedId);
      await reloadBases();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  const headTitle =
    mode.kind === "page" ? "知识库 · 页面" : mode.kind === "create-base" ? "知识库 · 新建" : "知识库";

  return (
    <div className="board-sheet skills-sheet knowledge-sheet">
      <div className="board-head">
        <span className="section-label">{headTitle}</span>
        <div className="board-head-actions">
          <span className="chip">{bases?.length ?? 0}</span>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="刷新知识库"
            title="刷新知识库"
            onClick={() => {
              void reloadBases();
              if (selectedId) void reloadSnapshot(selectedId);
            }}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭知识库面板"
            title="关闭面板，回到作战室"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="board-body skills-body">
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="form-note">{notice}</p>}

        {mode.kind === "source" ? (
          <div className="knowledge-editor">
            <div className="knowledge-editor-bar">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setMode({ kind: "browse" });
                  setTab("sources");
                  setError(null);
                }}
              >
                <Icon name="back" size={13} />
                返回来源
              </button>
              <span className="knowledge-editor-title">原文 · {mode.title}</span>
              <span className="knowledge-row-meta">{mode.bytes} 字节 · 只读</span>
            </div>
            {mode.binary ? (
              <p className="empty small">
                该来源是二进制文件（如 PDF、图片或压缩包），暂不支持在线预览原文。
              </p>
            ) : (
              <div className="knowledge-raw-scroll">
                <pre className="knowledge-raw-text">{mode.content}</pre>
              </div>
            )}
          </div>
        ) : mode.kind === "page" ? (
          <div className="knowledge-editor">
            <div className="knowledge-editor-bar">
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setMode({ kind: "browse" });
                  setPreviewMode(false);
                  setError(null);
                }}
              >
                <Icon name="back" size={13} />
                返回
              </button>
              <span className="knowledge-editor-title">
                {mode.isNew ? "新建页面" : mode.path}
              </span>
              <div className="knowledge-editor-modes" role="group" aria-label="编辑或预览">
                <button
                  type="button"
                  className={`btn sm${previewMode ? " ghost" : ""}`}
                  aria-pressed={!previewMode}
                  onClick={() => setPreviewMode(false)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={`btn sm${previewMode ? "" : " ghost"}`}
                  aria-pressed={previewMode}
                  onClick={() => setPreviewMode(true)}
                >
                  预览
                </button>
              </div>
            </div>
            {mode.isNew && (
              <label className="field">
                <span>页面路径（相对 wiki/，至少两级目录，如 notes/topic.md）</span>
                <input
                  value={mode.path}
                  onChange={(event) =>
                    setMode({ ...mode, path: event.target.value })
                  }
                  placeholder="notes/topic.md"
                />
              </label>
            )}
            {previewMode ? (
              <div className="knowledge-preview-scroll">
                <KnowledgePagePreview
                  raw={mode.content}
                  onOpen={(path) => void openPage(path)}
                />
              </div>
            ) : (
              <textarea
                className="knowledge-editor-text"
                value={mode.content}
                spellCheck={false}
                onChange={(event) => setMode({ ...mode, content: event.target.value })}
              />
            )}
            <div className="knowledge-editor-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={busy !== null}
                onClick={() => void saveCurrentPage()}
              >
                <Icon name="check" size={13} />
                {busy === "page-save" ? "保存中…" : "保存页面"}
              </button>
              {!mode.isNew &&
                (confirmingPage ? (
                  <>
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={busy !== null}
                      onClick={() => void deleteCurrentPage()}
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setConfirmingPage(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setConfirmingPage(true)}
                  >
                    <Icon name="trash" size={13} />
                    删除
                  </button>
                ))}
            </div>
            <p className="hint">
              页面正文按 Markdown 保存；frontmatter 里的 type 决定它归到哪一类，保存后索引与总览会自动重建。
            </p>
          </div>
        ) : mode.kind === "create-base" || mode.kind === "edit-base" ? (
          <div className="knowledge-base-form">
            <div className="knowledge-presets">
              <span className="hint">场景模板（填充用途与页面规则，仍可修改）：</span>
              {BASE_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setBaseForm((current) => ({
                      ...current,
                      purpose: preset.purpose,
                      schema: preset.schema,
                    }))
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>名称</span>
              <input
                value={baseForm.name}
                maxLength={48}
                onChange={(event) => setBaseForm({ ...baseForm, name: event.target.value })}
                placeholder="如：竞品资料、项目知识、法规条款"
              />
            </label>
            <label className="field">
              <span>一句话说明（会展示在面板与智能体提示词里）</span>
              <input
                value={baseForm.description}
                maxLength={240}
                onChange={(event) =>
                  setBaseForm({ ...baseForm, description: event.target.value })
                }
                placeholder="如：收集与整理竞品的公开资料"
              />
            </label>
            <label className="field">
              <span>摄入模型（留空跟随账号默认模型）</span>
              <select
                value={baseForm.modelRef}
                onChange={(event) => setBaseForm({ ...baseForm, modelRef: event.target.value })}
              >
                <option value="">跟随默认模型</option>
                {modelChoices.map((choice) => (
                  <option key={choice.ref} value={choice.ref}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>向量检索模型（可选，OpenAI 兼容 /embeddings；留空只用关键词 + 图谱扩展）</span>
              <input
                value={baseForm.embeddingRef}
                maxLength={200}
                onChange={(event) =>
                  setBaseForm({ ...baseForm, embeddingRef: event.target.value })
                }
                placeholder="如 openai/text-embedding-3-small；需先在模型设置里登记"
              />
            </label>
            <label className="field">
              <span>用途约束 purpose.md（留空用默认：通用知识库）</span>
              <textarea
                rows={4}
                value={baseForm.purpose}
                maxLength={4000}
                onChange={(event) => setBaseForm({ ...baseForm, purpose: event.target.value })}
                placeholder="这个库用来回答什么问题、面向谁、什么内容值得保留"
              />
            </label>
            <label className="field">
              <span>页面规范 schema.md（留空用默认：来源/实体/概念/问答/对比/综合/笔记）</span>
              <textarea
                rows={6}
                value={baseForm.schema}
                maxLength={8000}
                onChange={(event) => setBaseForm({ ...baseForm, schema: event.target.value })}
                placeholder="页面类型、命名与关联规则；不填就用默认规范"
              />
            </label>
            <div className="knowledge-editor-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={busy !== null || !baseForm.name.trim()}
                onClick={() => void submitBaseForm()}
              >
                <Icon name="check" size={13} />
                {mode.kind === "create-base" ? "创建知识库" : "保存设置"}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setMode({ kind: "browse" });
                  setError(null);
                }}
              >
                取消
              </button>
            </div>
            {mode.kind === "edit-base" && selectedBase && (
              <div className="knowledge-danger-zone">
                <p className="hint">
                  删除会清除这个库的原始材料、wiki 页面、索引与变更日志，无法恢复；正在整理的来源会先中止。
                </p>
                {confirmingBase ? (
                  <div className="knowledge-editor-actions">
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={busy !== null}
                      onClick={() => void handleDeleteBase()}
                    >
                      {busy === "base-delete" ? "删除中…" : "确认删除知识库"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setConfirmingBase(false)}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setConfirmingBase(true)}
                  >
                    <Icon name="trash" size={13} />
                    删除知识库
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="knowledge-base-bar">
              <select
                value={selectedId ?? ""}
                aria-label="选择知识库"
                onChange={(event) => {
                  setSelectedId(event.target.value || null);
                  setQuery("");
                  setHits(null);
                  setSearchMode(null);
                  setSearchWarning(null);
                  setLint(null);
                  setLinkProposals(null);
                  setGraph(null);
                  setActiveInsight(null);
                  setPreviewMode(false);
                  setTab("pages");
                }}
              >
                {(bases ?? []).length === 0 && <option value="">还没有知识库</option>}
                {(bases ?? []).map((base) => (
                  <option key={base.id} value={base.id}>
                    {base.name}
                    {base.pendingCount > 0 ? `（${base.pendingCount} 整理中）` : ""}
                  </option>
                ))}
              </select>
              <button type="button" className="btn sm" onClick={openCreateBase}>
                <Icon name="plus" size={13} />
                新建
              </button>
              <label
                className="btn ghost sm knowledge-import-btn"
                title="导入另一个知识库的 ZIP 压缩包"
              >
                <Icon name="import" size={13} />
                {busy === "bundle" ? "导入中…" : "导入"}
                <input
                  type="file"
                  accept=".zip,application/zip"
                  hidden
                  disabled={busy !== null}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void handleImportBundle(file);
                  }}
                />
              </label>
              {selectedBase && (
                <button type="button" className="btn ghost sm" onClick={openEditBase}>
                  <Icon name="edit" size={13} />
                  设置
                </button>
              )}
              {selectedBase &&
                (confirmingBase ? (
                  <>
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={busy !== null}
                      onClick={() => void handleDeleteBase()}
                    >
                      {busy === "base-delete" ? "删除中…" : "确认删除"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => setConfirmingBase(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="删除这个知识库及其全部页面与原始材料"
                    onClick={() => setConfirmingBase(true)}
                  >
                    <Icon name="trash" size={13} />
                    删除
                  </button>
                ))}
            </div>
            {confirmingBase && selectedBase && (
              <p className="form-note knowledge-delete-note">
                将删除「{selectedBase.name}」的原始材料、wiki 页面、索引与变更日志，无法恢复；正在整理的来源会先中止。
              </p>
            )}

            {!selectedId && (
              <div className="skills-empty">
                <p className="empty small">
                  知识库把原始材料整理成可检索的 wiki：导入材料后，模型会分析要点、写成页面，并维护索引与变更日志。
                </p>
                <button type="button" className="btn primary sm" onClick={openCreateBase}>
                  <Icon name="plus" size={13} />
                  创建第一个知识库
                </button>
              </div>
            )}

            {selectedId && snapshot && (
              <>
                {selectedBase && (
                  <p className="hint knowledge-summary">
                    {selectedBase.description || "（暂无说明）"} · 页面 {selectedBase.pageCount} · 来源{" "}
                    {selectedBase.sourceCount}
                    {selectedBase.pendingCount > 0 ? ` · ${selectedBase.pendingCount} 份整理中` : ""}
                    {selectedBase.modelRef ? ` · 模型 ${selectedBase.modelRef}` : ""}
                    {selectedBase.embeddingRef ? ` · 向量 ${selectedBase.embeddingRef}` : ""}
                  </p>
                )}

                <div className="skills-toolbar">
                  <div className="skills-tabs" role="tablist" aria-label="知识库视图">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "pages"}
                      className={`skills-tab${tab === "pages" ? " active" : ""}`}
                      onClick={() => setTab("pages")}
                    >
                      页面
                      <span className="chip">{snapshot.pages.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "sources"}
                      className={`skills-tab${tab === "sources" ? " active" : ""}`}
                      onClick={() => setTab("sources")}
                    >
                      来源
                      <span className="chip">{snapshot.sources.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "queue"}
                      className={`skills-tab${tab === "queue" ? " active" : ""}`}
                      onClick={() => setTab("queue")}
                    >
                      整理队列
                      <span className="chip">{snapshot.queue.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "graph"}
                      className={`skills-tab${tab === "graph" ? " active" : ""}`}
                      onClick={() => setTab("graph")}
                    >
                      图谱
                      {graph && <span className="chip">{graph.edges.length}</span>}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "overview"}
                      className={`skills-tab${tab === "overview" ? " active" : ""}`}
                      onClick={() => setTab("overview")}
                    >
                      概览
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "reviews"}
                      className={`skills-tab${tab === "reviews" ? " active" : ""}`}
                      onClick={() => setTab("reviews")}
                    >
                      审核
                      {pendingReviews > 0 && <span className="chip">{pendingReviews}</span>}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "lint"}
                      className={`skills-tab${tab === "lint" ? " active" : ""}`}
                      onClick={() => setTab("lint")}
                    >
                      体检
                    </button>
                  </div>
                </div>

                {tab === "pages" && (
                  <>
                    <div className="skills-toolbar">
                      <label className="skills-search">
                        <Icon name="search" />
                        <input
                          value={query}
                          placeholder="检索页面（回车）"
                          onChange={(event) => setQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void handleSearch();
                          }}
                        />
                      </label>
                      <div className="skills-toolbar-actions">
                        {hits !== null && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => {
                              setHits(null);
                              setQuery("");
                              setSearchMode(null);
                              setSearchWarning(null);
                            }}
                          >
                            清除检索
                          </button>
                        )}
                        <button type="button" className="btn primary sm" onClick={openNewPage}>
                          <Icon name="plus" size={13} />
                          新建页面
                        </button>
                      </div>
                    </div>

                    {hits !== null ? (
                      <>
                        <p className="hint knowledge-search-mode">
                          检索方式：{searchMode ? SEARCH_MODE_LABEL[searchMode] : "关键词"}
                          {searchWarning ? ` · ${searchWarning}` : ""}
                        </p>
                        {hits.length === 0 ? (
                          <p className="empty small">没有匹配的页面。</p>
                        ) : (
                          <ul className="knowledge-list">
                            {hits.map((hit) => (
                              <li key={`${hit.baseId}-${hit.path}`}>
                                <button
                                  type="button"
                                  className="knowledge-row"
                                  onClick={() => void openPage(hit.path)}
                                >
                                  <span className="knowledge-row-title">
                                    {hit.title}
                                    <span className="chip">{PAGE_TYPE_LABELS[hit.type]}</span>
                                    {hit.via?.includes("vector") && (
                                      <span className="knowledge-tag via-vector">向量</span>
                                    )}
                                    {hit.via?.includes("graph") && (
                                      <span className="knowledge-tag via-graph">图谱</span>
                                    )}
                                  </span>
                                  <span className="knowledge-row-meta">{hit.path}</span>
                                  {hit.snippet && (
                                    <span className="knowledge-row-snippet">{hit.snippet}</span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    ) : pageGroups.length === 0 ? (
                      <div className="skills-empty">
                        <p className="empty small">
                          还没有页面。到「来源」里导入第一份材料，整理完成后这里会出现摘要与知识点。
                        </p>
                      </div>
                    ) : (
                      pageGroups.map((group) => (
                        <section key={group.type} className="knowledge-group">
                          <h3 className="knowledge-group-title">
                            {PAGE_TYPE_LABELS[group.type]}
                            <span className="chip">{group.pages.length}</span>
                          </h3>
                          <ul className="knowledge-list">
                            {group.pages.map((page) => (
                              <li key={page.path}>
                                <button
                                  type="button"
                                  className="knowledge-row"
                                  onClick={() => void openPage(page.path)}
                                >
                                  <span className="knowledge-row-title">{page.title}</span>
                                  <span className="knowledge-row-meta">{page.path}</span>
                                  {page.summary && (
                                    <span className="knowledge-row-snippet">{page.summary}</span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))
                    )}
                  </>
                )}

                {tab === "sources" && (
                  <>
                    <div className="skills-toolbar">
                      <p className="hint">
                        原始材料只读保存在 raw/；模型读完后写入 wiki 页面，来源摘要页由系统兜底生成。
                      </p>
                      <div className="skills-toolbar-actions">
                        {sourceForm || folderForm ? (
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => {
                              setSourceForm(null);
                              setFolderForm(null);
                            }}
                          >
                            取消
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={busy !== null}
                              title="扫描 raw/sources：外部新增/修改/删除会同步到来源与队列"
                              onClick={() => void handleRescan()}
                            >
                              <Icon name="refresh" size={13} />
                              {busy === "rescan" ? "扫描中…" : "扫描目录"}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setFolderForm({ path: "" })}
                            >
                              <Icon name="folder" size={13} />
                              导入文件夹
                            </button>
                            <button
                              type="button"
                              className="btn primary sm"
                              onClick={() =>
                                setSourceForm({ title: "", content: "", filePath: "" })
                              }
                            >
                              <Icon name="upload" size={13} />
                              导入材料
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {folderForm && (
                      <div className="knowledge-source-form">
                        <WorkspacePathSuggest
                          label="文件工作区里的目录（留空导入根目录；支持 MD/TXT/CSV/JSON/HTML/DOCX/XLSX/PDF，单次最多 20 个、单文件 2 MB）"
                          mode="dir"
                          value={folderForm.path}
                          placeholder="如 papers/energy"
                          entries={workspaceEntries}
                          loading={workspaceEntriesLoading}
                          error={workspaceEntriesError}
                          onChange={(path) => setFolderForm({ path })}
                          onRequestLoad={() => void loadWorkspaceEntries()}
                        />
                        <div className="knowledge-editor-actions">
                          <button
                            type="button"
                            className="btn primary sm"
                            disabled={busy !== null}
                            onClick={() => void handleImportFolder()}
                          >
                            <Icon name="folder" size={13} />
                            {busy === "folder" ? "导入中…" : "开始导入"}
                          </button>
                        </div>
                      </div>
                    )}

                    {sourceForm && (
                      <div className="knowledge-source-form">
                        <label className="field">
                          <span>标题（留空取正文首行或文件名）</span>
                          <input
                            value={sourceForm.title}
                            maxLength={120}
                            onChange={(event) =>
                              setSourceForm({ ...sourceForm, title: event.target.value })
                            }
                            placeholder="如：2026 年行业报告"
                          />
                        </label>
                        <WorkspacePathSuggest
                          label="或从文件工作区导入（相对路径，如 reports/report.md）"
                          mode="file"
                          value={sourceForm.filePath}
                          placeholder="reports/report.md"
                          entries={workspaceEntries}
                          loading={workspaceEntriesLoading}
                          error={workspaceEntriesError}
                          onChange={(filePath) => setSourceForm({ ...sourceForm, filePath })}
                          onRequestLoad={() => void loadWorkspaceEntries()}
                        />
                        <label className="field">
                          <span>或直接粘贴文本（≤ 2 MB；与上面的文件二选一）</span>
                          <textarea
                            rows={6}
                            value={sourceForm.content}
                            onChange={(event) =>
                              setSourceForm({ ...sourceForm, content: event.target.value })
                            }
                            placeholder="把文章、纪要、条款等材料粘贴到这里"
                          />
                        </label>
                        <div className="knowledge-editor-actions">
                          <button
                            type="button"
                            className="btn primary sm"
                            disabled={busy !== null}
                            onClick={() => void submitSource()}
                          >
                            <Icon name="upload" size={13} />
                            {busy === "source" ? "提交中…" : "加入整理队列"}
                          </button>
                        </div>
                      </div>
                    )}

                    {snapshot.sources.length === 0 ? (
                      <p className="empty small">还没有导入材料。</p>
                    ) : (
                      <ul className="knowledge-list">
                        {snapshot.sources.map((source) => (
                          <li key={source.id} className="knowledge-source">
                            <div className="knowledge-row-title">
                              {source.title}
                              <span
                                className={`knowledge-tag status-${source.status}`}
                                title={source.error ?? ""}
                              >
                                {SOURCE_STATUS_LABEL[source.status]}
                              </span>
                            </div>
                            <div className="knowledge-row-meta">
                              {formatInstant(source.addedAt)} · {source.bytes} 字节 ·{" "}
                              {source.pagePaths.length} 页
                            </div>
                            {source.error && <p className="form-error">{source.error}</p>}
                            <div className="knowledge-source-actions">
                              {source.summaryPath && (
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  onClick={() => void openPage(source.summaryPath!)}
                                >
                                  <Icon name="file" size={13} />
                                  查看摘要
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busy !== null}
                                onClick={() => void openSourceRaw(source.id)}
                              >
                                <Icon name="file" size={13} />
                                {busy === "source-raw" ? "读取中…" : "查看原文"}
                              </button>
                              {confirmingSource === source.id ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn danger sm"
                                    disabled={busy !== null}
                                    onClick={() => void handleRemoveSource(source)}
                                  >
                                    确认删除
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => setConfirmingSource(null)}
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  onClick={() => setConfirmingSource(source.id)}
                                >
                                  <Icon name="trash" size={13} />
                                  删除来源
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

                {tab === "queue" && (
                  <>
                    <div className="skills-toolbar">
                      <p className="hint">
                        摄入逐条串行执行：先产出分析计划，再写页面；进程中断后重启会接着整理。
                      </p>
                      <div className="skills-toolbar-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy !== null}
                          onClick={() => void handleRetry()}
                        >
                          <Icon name="restore" size={13} />
                          重试失败项
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy !== null}
                          onClick={() => void handleCancel()}
                        >
                          <Icon name="close" size={13} />
                          取消待处理
                        </button>
                      </div>
                    </div>
                    {snapshot.queue.length === 0 ? (
                      <p className="empty small">队列是空的。</p>
                    ) : (
                      <ul className="knowledge-list">
                        {snapshot.queue.map((item) => (
                          <li key={item.id} className="knowledge-queue-item">
                            <div className="knowledge-row-title">
                              {item.title}
                              <span className={`knowledge-tag status-${item.state}`}>
                                {QUEUE_STATE_LABEL[item.state]}
                              </span>
                            </div>
                            <div className="knowledge-row-meta">
                              第 {item.attempts} 次 · 入队 {formatInstant(item.createdAt)}
                              {item.finishedAt ? ` · 完成 ${formatInstant(item.finishedAt)}` : ""}
                            </div>
                            {item.error && <p className="form-error">{item.error}</p>}
                            {(item.state === "failed" || item.state === "cancelled") && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busy !== null}
                                onClick={() => void handleRetry(item.id)}
                              >
                                <Icon name="restore" size={13} />
                                重试这条
                              </button>
                            )}
                            {(item.state === "queued" || item.state === "running") && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                disabled={busy !== null}
                                onClick={() => void handleCancel(item.id)}
                              >
                                <Icon name="close" size={13} />
                                取消这条
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

                {tab === "reviews" && (
                  <>
                    <div className="skills-toolbar">
                      <p className="hint">
                        摄入时模型标记的需要人工判断项：可以建页、按建议去联网补资料，或直接跳过。处理不阻塞整理队列。
                      </p>
                      <div className="skills-toolbar-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => {
                            if (selectedId) void reloadSnapshot(selectedId);
                          }}
                        >
                          <Icon name="refresh" size={13} />
                          刷新
                        </button>
                      </div>
                    </div>
                    {snapshot.reviews.length === 0 ? (
                      <p className="empty small">没有待审核项。整理完成后若有矛盾、命名冲突或资料缺口，会出现在这里。</p>
                    ) : (
                      <ul className="knowledge-list">
                        {snapshot.reviews.map((review) => (
                          <li key={review.id} className="knowledge-review-item">
                            <div className="knowledge-row-title">
                              <span
                                className={`knowledge-tag review-${review.kind}${
                                  review.status !== "pending" ? " review-resolved" : ""
                                }`}
                              >
                                {review.status === "pending"
                                  ? REVIEW_KIND_LABEL[review.kind]
                                  : review.status === "skipped"
                                    ? "已跳过"
                                    : "已处理"}
                              </span>
                              {review.title}
                            </div>
                            <span className="knowledge-row-snippet">{review.reason}</span>
                            {review.query && (
                              <span className="knowledge-row-meta">检索词：{review.query}</span>
                            )}
                            {review.error && <p className="form-error">{review.error}</p>}
                            {review.status === "pending" ? (
                              <div className="knowledge-source-actions">
                                {review.kind === "create-page" && (
                                  <button
                                    type="button"
                                    className="btn primary sm"
                                    disabled={busy !== null}
                                    onClick={() => void handleResolveReview(review, "create-page")}
                                  >
                                    <Icon name="file" size={13} />
                                    建页
                                  </button>
                                )}
                                {review.kind === "research" && (
                                  <button
                                    type="button"
                                    className="btn primary sm"
                                    disabled={busy !== null}
                                    onClick={() => void handleResolveReview(review, "research")}
                                  >
                                    <Icon name="search" size={13} />
                                    {busy === `review-${review.id}` ? "检索中…" : "去研究"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  disabled={busy !== null}
                                  onClick={() => void handleResolveReview(review, "skip")}
                                >
                                  跳过
                                </button>
                              </div>
                            ) : (
                              <span className="knowledge-row-meta">
                                {review.resolvedAt ? formatInstant(review.resolvedAt) : ""}
                                {review.pagePath ? ` · ${review.pagePath}` : ""}
                                {review.researchSourceId ? ` · 来源 ${review.researchSourceId}` : ""}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}

                {tab === "graph" && (
                  <>
                    <div className="skills-toolbar">
                      <div className="knowledge-graph-modes" role="group" aria-label="图谱着色方式">
                        <button
                          type="button"
                          className={`skills-tab${graphColorMode === "type" ? " active" : ""}`}
                          onClick={() => setGraphColorMode("type")}
                        >
                          按类型
                        </button>
                        <button
                          type="button"
                          className={`skills-tab${graphColorMode === "community" ? " active" : ""}`}
                          onClick={() => setGraphColorMode("community")}
                        >
                          按社区
                        </button>
                      </div>
                      <p className="hint">
                        四路信号合成关联度：直接链接 ×3、共享来源 ×4、共同邻居（Adamic-Adar）×1.5、同类型 ×1。节点大小按关联数，悬停高亮邻居，点击打开页面。
                      </p>
                    </div>

                    {!graph ? (
                      <p className="empty small">正在加载图谱…</p>
                    ) : graph.nodes.length === 0 ? (
                      <p className="empty small">还没有页面，导入材料并整理后这里会出现图谱。</p>
                    ) : (
                      <>
                        <KnowledgeGraphView
                          graph={graph}
                          colorMode={graphColorMode}
                          highlight={graphHighlight}
                          onOpenPage={(path) => void openPage(path)}
                        />
                        <div className="knowledge-graph-legend">
                          {graphColorMode === "type"
                            ? KNOWLEDGE_PAGE_TYPES.map((type) => {
                                const count = graph.nodes.filter(
                                  (node) => node.type === type,
                                ).length;
                                if (count === 0) return null;
                                return (
                                  <span key={type} className="knowledge-legend-item">
                                    <i style={{ background: TYPE_COLORS[type] }} />
                                    {PAGE_TYPE_LABELS[type]}
                                    <em>{count}</em>
                                  </span>
                                );
                              })
                            : graph.communities.map((community) => (
                                <span key={community.id} className="knowledge-legend-item">
                                  <i
                                    style={{
                                      background:
                                        COMMUNITY_COLORS[community.id % COMMUNITY_COLORS.length],
                                    }}
                                  />
                                  {community.label}
                                  <em>
                                    {community.size} 页 · 内聚 {community.cohesion.toFixed(2)}
                                    {community.lowCohesion ? " ⚠" : ""}
                                  </em>
                                </span>
                              ))}
                        </div>
                        {graph.truncated && (
                          <p className="hint">
                            图谱超过上限，只展示最近更新的 300 个页面与 1500 条关联。
                          </p>
                        )}

                        <div className="knowledge-graph-insights">
                          <h3 className="knowledge-group-title">
                            图谱洞察
                            {activeInsight && (
                              <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() => setActiveInsight(null)}
                              >
                                清除高亮
                              </button>
                            )}
                          </h3>
                          {graph.insights.length === 0 ? (
                            <p className="empty small">
                              没有发现意外关联、孤立页或低内聚集群。
                            </p>
                          ) : (
                            <ul className="knowledge-list">
                              {graph.insights.map((insight) => (
                                <li key={insight.id} className="knowledge-insight-item">
                                  <button
                                    type="button"
                                    className={`knowledge-insight${
                                      activeInsight === insight.id ? " active" : ""
                                    }`}
                                    title="点击在图谱中高亮这条洞察"
                                    onClick={() =>
                                      setActiveInsight((current) =>
                                        current === insight.id ? null : insight.id,
                                      )
                                    }
                                  >
                                    <span className="knowledge-row-title">
                                      <span className={`knowledge-tag insight-${insight.kind}`}>
                                        {INSIGHT_LABEL[insight.kind]}
                                      </span>
                                      {insight.title}
                                    </span>
                                    <span className="knowledge-row-snippet">{insight.detail}</span>
                                    {insight.suggestedTopic && (
                                      <span className="knowledge-row-meta">
                                        建议研究：{insight.suggestedTopic}
                                      </span>
                                    )}
                                  </button>
                                  {insight.suggestedTopic && (
                                    <button
                                      type="button"
                                      className="btn ghost sm knowledge-insight-research"
                                      disabled={busy !== null}
                                      title="联网检索并整理成来源材料，加入摄入队列"
                                      onClick={() => void handleResearch(insight.suggestedTopic!)}
                                    >
                                      <Icon name="search" size={13} />
                                      {busy === "research" ? "研究中…" : "去研究"}
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <h3 className="knowledge-group-title">关联最多的页面</h3>
                        <ul className="knowledge-list">
                          {[...graph.nodes]
                            .sort(
                              (a, b) =>
                                b.degree - a.degree || a.title.localeCompare(b.title, "zh"),
                            )
                            .slice(0, 8)
                            .map((node) => (
                              <li key={node.id}>
                                <button
                                  type="button"
                                  className="knowledge-row"
                                  onClick={() => void openPage(node.id)}
                                >
                                  <span className="knowledge-row-title">
                                    {node.title}
                                    <span className="chip">{PAGE_TYPE_LABELS[node.type]}</span>
                                  </span>
                                  <span className="knowledge-row-meta">
                                    {node.id} · {node.degree} 条关联 · {node.sourceCount} 份来源
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      </>
                    )}
                  </>
                )}

                {tab === "overview" && (
                  <div className="knowledge-overview">
                    <div className="knowledge-stats">
                      <span className="chip">{snapshot.pages.length} 页</span>
                      <span className="chip">{snapshot.sources.length} 来源</span>
                      <span className="chip">{snapshot.queue.length} 队列项</span>
                      {graph && (
                        <span className="chip">
                          {graph.nodes.length} 节点 / {graph.edges.length} 关联
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy !== null}
                        onClick={() => void handleReindex()}
                      >
                        <Icon name="refresh" size={13} />
                        {busy === "reindex" ? "重建中…" : "重建索引"}
                      </button>
                      <a
                        className="btn ghost sm"
                        href={knowledgeExportUrl(selectedId)}
                        download
                        title="导出整库（raw + wiki + 队列/审核快照，不含向量缓存）"
                      >
                        <Icon name="download" size={13} />
                        导出整库
                      </a>
                    </div>
                    <h3 className="knowledge-group-title">总览</h3>
                    <pre className="knowledge-pre">{snapshot.overview || "（还没有页面）"}</pre>
                    <h3 className="knowledge-group-title">索引</h3>
                    <pre className="knowledge-pre">{snapshot.index || "（索引为空）"}</pre>
                    <details className="knowledge-details">
                      <summary>变更日志（最近 200 条）</summary>
                      <pre className="knowledge-pre">{snapshot.log || "（暂无记录）"}</pre>
                    </details>
                  </div>
                )}

                {tab === "lint" && (
                  <>
                    <div className="skills-toolbar">
                      <p className="hint">
                        体检检查断链、孤立页、缺 frontmatter、重复标题与失败来源；只报告，不自动改页。
                      </p>
                      <div className="skills-toolbar-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => {
                            if (!selectedId) return;
                            fetchKnowledgeLint(selectedId)
                              .then(setLint)
                              .catch((err: unknown) => setError(messageOf(err)));
                          }}
                        >
                          <Icon name="inspect" size={13} />
                          重新检查
                        </button>
                      </div>
                    </div>
                    <div className="knowledge-enrich">
                      <div className="skills-toolbar">
                        <p className="hint">
                          链接补全：按页面标题/文件名扫描正文，跳过代码块、已有链接与 URL；先出提案，确认后才写入。
                        </p>
                        <div className="skills-toolbar-actions">
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy !== null}
                            onClick={() => void handleEnrich(false)}
                          >
                            <Icon name="search" size={13} />
                            {busy === "enrich" ? "扫描中…" : "补全链接"}
                          </button>
                          {linkProposals && linkProposals.length > 0 && (
                            <button
                              type="button"
                              className="btn primary sm"
                              disabled={busy !== null}
                              onClick={() => void handleEnrich(true)}
                            >
                              <Icon name="check" size={13} />
                              {busy === "enrich-apply"
                                ? "应用中…"
                                : `应用全部（${linkProposals.length}）`}
                            </button>
                          )}
                          {linkProposals && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setLinkProposals(null)}
                            >
                              清除提案
                            </button>
                          )}
                        </div>
                      </div>
                      {linkProposals && linkProposals.length > 0 && (
                        <ul className="knowledge-list">
                          {linkProposals.slice(0, 20).map((proposal, index) => (
                            <li
                              key={`${proposal.pagePath}-${proposal.targetPath}-${index}`}
                              className="knowledge-lint-item"
                            >
                              <div className="knowledge-row-title">
                                {proposal.pagePath}
                                <span className="chip">→ {proposal.targetPath}</span>
                              </div>
                              <div className="knowledge-row-meta">
                                别名「{proposal.alias}」 · {proposal.snippet}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {!lint ? (
                      <p className="empty small">正在检查…</p>
                    ) : lint.issues.length === 0 ? (
                      <p className="form-note">
                        检查了 {lint.pageCount} 页 / {lint.sourceCount} 份来源，没有发现问题。
                      </p>
                    ) : (
                      <ul className="knowledge-list">
                        {lint.issues.map((issue) => (
                          <li key={issue.id} className="knowledge-lint-item">
                            <div className="knowledge-row-title">
                              {issue.message}
                              <span className={`knowledge-tag severity-${issue.severity}`}>
                                {issue.severity === "error"
                                  ? "错误"
                                  : issue.severity === "warning"
                                    ? "警告"
                                    : "提示"}
                              </span>
                            </div>
                            {issue.path && (
                              <button
                                type="button"
                                className="knowledge-row-meta knowledge-link"
                                onClick={() => void openPage(issue.path!)}
                              >
                                {issue.path}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
