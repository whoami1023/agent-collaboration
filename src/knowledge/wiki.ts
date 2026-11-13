import type {
  KnowledgeBaseMeta,
  KnowledgeCommunity,
  KnowledgeGraph,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeInsight,
  KnowledgeLinkProposal,
  KnowledgeLintIssue,
  KnowledgeLintReport,
  KnowledgePage,
  KnowledgePageMeta,
  KnowledgeSearchHit,
  KnowledgeSource,
} from "./types";
import { PAGE_TYPE_LABELS, KNOWLEDGE_PAGE_TYPES } from "./types";
import { pageSummary } from "./frontmatter";

/** 模型输出里的 `---FILE: path---` 块；没写结束标记时以下一个块或结尾为界。 */
export interface WikiFileBlock {
  path: string;
  content: string;
}

export function parseFileBlocks(text: string): WikiFileBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: WikiFileBlock[] = [];
  let current: { path: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    const content = current.lines.join("\n").trim();
    if (current.path && content) blocks.push({ path: current.path, content });
    current = null;
  };
  for (const line of lines) {
    const start = /^\s*---FILE:\s*(.+?)\s*---\s*$/.exec(line);
    if (start) {
      flush();
      current = { path: start[1] ?? "", lines: [] };
      continue;
    }
    if (/^\s*---END FILE---\s*$/.test(line)) {
      flush();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return blocks;
}

/** 从模型回复里取一个 JSON 对象：允许 ```json 围栏，也允许前后夹带说明文字。 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型返回的 JSON 不是对象");
  }
  return parsed as Record<string, unknown>;
}

function linkTarget(path: string): string {
  return path.replace(/\.md$/i, "");
}

function oneLine(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/** 内容目录：完全由页面 frontmatter 与来源清单生成，手改会在下次摄入时被覆盖。 */
export function buildIndex(
  kbName: string,
  pages: readonly KnowledgePageMeta[],
  sources: readonly KnowledgeSource[],
): string {
  const lines = [
    `# ${kbName} · 内容索引`,
    "",
    "> 本文件由系统按页面与来源自动生成；要改内容请编辑页面本身，下一次摄入会重建这里。",
    "",
    `页面 ${pages.length} 个 · 来源 ${sources.length} 份`,
  ];
  for (const type of KNOWLEDGE_PAGE_TYPES) {
    const group = pages.filter((page) => page.type === type).sort((a, b) => a.title.localeCompare(b.title, "zh"));
    if (group.length === 0) continue;
    lines.push("", `## ${PAGE_TYPE_LABELS[type]}（${group.length}）`);
    for (const page of group) {
      const summary = page.summary ? ` — ${oneLine(page.summary, 110)}` : "";
      lines.push(`- [[${linkTarget(page.path)}]] — ${page.title}${summary}`);
    }
  }
  if (pages.length === 0) lines.push("", "（还没有页面，先导入来源材料）");
  if (sources.length > 0) {
    lines.push("", `## 来源材料（${sources.length}）`);
    for (const source of sources) {
      const state =
        source.status === "ready"
          ? source.summaryPath
            ? `已整理 → [[${linkTarget(source.summaryPath)}]]`
            : "已整理"
          : source.status === "failed"
            ? `失败：${source.error ?? "未知原因"}`
            : source.status === "ingesting"
              ? "整理中"
              : "待整理";
      lines.push(`- ${source.title}（${state}）`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** 总览：给人看的一页，摘要不替代页面正文。 */
export function buildOverview(
  base: Pick<KnowledgeBaseMeta, "name" | "description" | "purpose">,
  pages: readonly KnowledgePageMeta[],
  sources: readonly KnowledgeSource[],
  today: string,
): string {
  const counts = KNOWLEDGE_PAGE_TYPES.map((type) => ({
    type,
    count: pages.filter((page) => page.type === type).length,
  })).filter((entry) => entry.count > 0);
  const recent = [...pages]
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, "zh"))
    .slice(0, 8);
  const purpose = base.purpose.trim();
  const lines = [
    `# ${base.name} · 总览`,
    "",
    base.description.trim() || "（尚未填写知识库说明）",
  ];
  if (purpose) {
    lines.push("", "## 用途", ...purpose.split(/\r?\n/).slice(0, 8));
  }
  lines.push(
    "",
    "## 规模",
    `- 页面：${pages.length} 个${counts.length > 0 ? `（${counts.map((entry) => `${PAGE_TYPE_LABELS[entry.type]} ${entry.count}`).join(" · ")}）` : ""}`,
    `- 来源：${sources.length} 份，已整理 ${sources.filter((source) => source.status === "ready").length} 份`,
    `- 更新于 ${today}`,
  );
  if (recent.length > 0) {
    lines.push("", "## 最近更新的页面");
    for (const page of recent) {
      lines.push(`- [[${linkTarget(page.path)}]] — ${page.title}（${page.updated}）`);
    }
  }
  lines.push(
    "",
    "## 怎么用",
    "- 结构化的主题页在「页面」标签下按类型浏览；页面顶部的搜索框按关键词检索全文。",
    "- 新增材料走「来源」标签：原始材料只读保留，整理结果写进 wiki 页面。",
    "- 健康检查会列出断链、孤立页面与尚未整理的来源。",
  );
  return `${lines.join("\n")}\n`;
}

export interface LogEntry {
  date: string;
  action: "ingest" | "manual" | "lint" | "delete";
  title: string;
  sourceId?: string;
  summaryPath?: string;
  pagePaths: string[];
  note?: string;
}

/** 变更日志：只追加，最新在文件末尾（与 LLM Wiki 的时间顺序一致）。 */
export function appendLog(existing: string, entry: LogEntry): string {
  const lines = [
    existing.trimEnd(),
    "",
    `## [${entry.date}] ${entry.action} | ${entry.title}`,
  ];
  if (entry.sourceId) lines.push(`- 来源：${entry.sourceId}`);
  if (entry.summaryPath) lines.push(`- 来源摘要：[[${linkTarget(entry.summaryPath)}]]`);
  if (entry.pagePaths.length > 0) {
    lines.push(`- 页面：${entry.pagePaths.map((path) => `[[${linkTarget(path)}]]`).join("、")}`);
  }
  if (entry.note) lines.push(`- 说明：${entry.note}`);
  return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}

/** 日志只保留最近 200 条记录，防止一份超长历史把面板拖慢。 */
export function trimLog(text: string, maxEntries = 200): string {
  const parts = text.split(/^## \[/m);
  if (parts.length <= maxEntries + 1) return text;
  const header = parts[0] ?? "";
  return `${header}${parts.slice(-maxEntries).map((part) => `## [${part}`).join("")}`;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "what",
  "how",
  "why",
  "are",
  "was",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "及",
  "或",
  "也",
  "都",
  "就",
  "有",
  "没有",
  "什么",
  "怎么",
  "如何",
  "为什么",
  "哪些",
  "一个",
]);

/** 中英混排检索词：英文按词，中文按二元组（与记忆层的 CJK 口径一致）。 */
export function tokenizeQuery(text: string): string[] {
  const tokens = new Set<string>();
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]+/g)) {
    const token = match[0];
    if (token.length >= 2 && !STOPWORDS.has(token)) tokens.add(token);
  }
  for (const match of normalized.matchAll(/[\u3400-\u9fff\uf900-\ufaff]+/g)) {
    const run = match[0];
    if (run.length === 1) tokens.add(run);
    else if (run.length <= 6) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!STOPWORDS.has(bigram)) tokens.add(bigram);
    }
  }
  return [...tokens].filter((token) => token.length > 0);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0 && count < 5) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function snippetOf(body: string, token: string): string {
  const index = body.toLowerCase().indexOf(token.toLowerCase());
  if (index < 0) return oneLine(body, 120);
  const start = Math.max(0, index - 50);
  const end = Math.min(body.length, index + token.length + 90);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "…" : ""}`;
}

export interface SearchablePage extends KnowledgePageMeta {
  body: string;
}

/**
 * 关键词打分：标题命中权重最高，其次标签与路径，正文按出现次数（封顶 5）计分。
 * 不做向量化，也不引入外部检索服务；Embedding 是 LLM Wiki 的可选项，这里保持零依赖。
 */
export function searchPages(
  pages: readonly SearchablePage[],
  query: string,
  limit = 12,
): Array<KnowledgeSearchHit & { body: string }> {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const hits: Array<KnowledgeSearchHit & { body: string }> = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const tags = page.tags.join(" ").toLowerCase();
    const path = page.path.toLowerCase();
    const body = page.body.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      if (title.includes(token)) tokenScore += 6;
      if (tags.includes(token)) tokenScore += 3;
      if (path.includes(token)) tokenScore += 2;
      tokenScore += occurrences(body, token);
      if (tokenScore > 0) matched += 1;
      score += tokenScore;
    }
    if (score === 0) continue;
    if (matched === tokens.length) score += 2;
    hits.push({
      baseId: "",
      baseName: "",
      path: page.path,
      title: page.title,
      type: page.type,
      score: Number(score.toFixed(3)),
      snippet: snippetOf(page.body, tokens[0] ?? query),
      body: page.body,
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh")).slice(0, limit);
}

/** wikilink 解析：先按路径/去扩展名路径，再按文件名，最后按标题。 */
export function resolveLink(
  target: string,
  pages: readonly KnowledgePageMeta[],
): KnowledgePageMeta | undefined {
  const raw = target.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const clean = raw.toLowerCase().startsWith("wiki/") ? raw.slice(5) : raw;
  const withoutExt = clean.replace(/\.md$/i, "").toLowerCase();
  const exact = pages.find((page) => linkTarget(page.path).toLowerCase() === withoutExt);
  if (exact) return exact;
  const byBase = pages.find(
    (page) => (page.path.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase() === withoutExt,
  );
  if (byBase) return byBase;
  return pages.find((page) => page.title.trim().toLowerCase() === clean.toLowerCase());
}

/** 正文按行遍历，并标出代码围栏内的行；围栏行不参与链接补全。 */
function* scanBodyLines(body: string): Generator<{ line: string; fenced: boolean }> {
  let fence: "`" | "~" | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]?.[0];
    if (marker === "`" || marker === "~") {
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      yield { line, fenced: true };
      continue;
    }
    yield { line, fenced: fence !== null };
  }
}

/**
 * 把一行里「不该被链接化」的片段替换成等长空格：行内代码、已有 wikilink、
 * 链接 URL 与裸 URL。长度不变，找到的索引仍可直接用于原行替换。
 */
function maskLinkTargets(line: string): string {
  return line
    .replace(/`[^`]*`/g, (text) => " ".repeat(text.length))
    .replace(/\[\[[^\]]*\]\]/g, (text) => " ".repeat(text.length))
    .replace(/\]\([^)]*\)/g, (text) => `]${" ".repeat(Math.max(0, text.length - 1))}`)
    .replace(/https?:\/\/\S+/g, (text) => " ".repeat(text.length));
}

function findAliasIndex(line: string, alias: string): number {
  const masked = maskLinkTargets(line);
  let from = 0;
  const asciiStart = /^[A-Za-z0-9_]/.test(alias[0] ?? "");
  const asciiEnd = /[A-Za-z0-9_]$/.test(alias);
  for (;;) {
    const index = masked.indexOf(alias, from);
    if (index < 0) return -1;
    const before = masked[index - 1] ?? "";
    const after = masked[index + alias.length] ?? "";
    if (
      (asciiStart && /[A-Za-z0-9_]/.test(before)) ||
      (asciiEnd && /[A-Za-z0-9_]/.test(after))
    ) {
      from = index + 1;
      continue;
    }
    return index;
  }
}

/**
 * 链接补全提案：拿页面标题/文件名当别名，在其它页正文里找首次出现。
 * 跳过代码块、行内代码、已有链接与 URL；同一页同一目标只提议一次。
 */
export function proposeLinks(
  pages: ReadonlyArray<KnowledgePageMeta & { body: string }>,
  options: { maxPerPage?: number; minAliasChars?: number } = {},
): KnowledgeLinkProposal[] {
  const maxPerPage = options.maxPerPage ?? 5;
  const minChars = options.minAliasChars ?? 2;
  const aliasTargets = new Map<string, Set<string>>();
  const pageByPath = new Map(pages.map((page) => [page.path, page]));
  for (const page of pages) {
    const aliases = new Set<string>();
    if (page.title.trim().length >= minChars) aliases.add(page.title.trim());
    const basename = (page.path.split("/").pop() ?? "").replace(/\.md$/i, "");
    if (basename.length >= minChars) aliases.add(basename);
    for (const alias of aliases) {
      const targets = aliasTargets.get(alias) ?? new Set<string>();
      targets.add(page.path);
      aliasTargets.set(alias, targets);
    }
  }
  // 同名别名的页面不参与自动补链：宁可少补，也不把链接指错页。
  const aliases = [...aliasTargets.entries()]
    .filter(([, targets]) => targets.size === 1)
    .map(([alias, targets]) => ({ alias, targetPath: [...targets][0]! }))
    .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias, "zh"));

  const proposals: KnowledgeLinkProposal[] = [];
  for (const page of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!page.body.trim()) continue;
    const linked = new Set(
      page.links
        .map((link) => resolveLink(link, pages)?.path)
        .filter((path): path is string => Boolean(path)),
    );
    let count = 0;
    for (const { alias, targetPath } of aliases) {
      if (count >= maxPerPage) break;
      if (targetPath === page.path || linked.has(targetPath)) continue;
      if (page.title.trim() === alias && targetPath === page.path) continue;
      if (!pageByPath.has(targetPath)) continue;
      for (const { line, fenced } of scanBodyLines(page.body)) {
        if (fenced || /^\s*#/.test(line)) continue;
        const index = findAliasIndex(line, alias);
        if (index < 0) continue;
        const start = Math.max(0, index - 18);
        const snippet = line.slice(start, Math.min(line.length, index + alias.length + 24)).trim();
        proposals.push({
          pagePath: page.path,
          targetPath,
          alias,
          snippet: snippet.length > 80 ? `${snippet.slice(0, 80)}…` : snippet,
        });
        linked.add(targetPath);
        count += 1;
        break;
      }
    }
  }
  return proposals;
}

/** 按提案把首次出现替换成 `[[目标|别名]]`；已有链接与代码块同样跳过。 */
export function applyLinkProposals(
  body: string,
  proposals: ReadonlyArray<Pick<KnowledgeLinkProposal, "alias" | "targetPath">>,
): { body: string; applied: number } {
  let result = body;
  let applied = 0;
  for (const proposal of proposals) {
    const target = proposal.targetPath.replace(/\.md$/i, "");
    const lines = result.split(/\r?\n/);
    let replaced = false;
    let fence: "`" | "~" | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const marker = /^\s*(```+|~~~+)/.exec(line)?.[1]?.[0];
      if (marker === "`" || marker === "~") {
        if (!fence) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence || /^\s*#/.test(line)) continue;
      const at = findAliasIndex(line, proposal.alias);
      if (at < 0) continue;
      lines[index] =
        line.slice(0, at) +
        `[[${target}|${proposal.alias}]]` +
        line.slice(at + proposal.alias.length);
      replaced = true;
      applied += 1;
      break;
    }
    if (replaced) result = lines.join("\n");
  }
  return { body: result, applied };
}

export interface LintInput {
  pages: ReadonlyArray<KnowledgePage & { hasFrontmatter: boolean }>;
  sources: readonly KnowledgeSource[];
  indexText: string;
  today: string;
}

export function lintWiki(input: LintInput): KnowledgeLintReport {
  const issues: KnowledgeLintIssue[] = [];
  const pages = input.pages;
  const indexText = input.indexText.toLowerCase();
  const titleSeen = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const page of pages) {
    for (const link of page.links) {
      const resolved = resolveLink(link, pages);
      if (!resolved) {
        issues.push({
          id: `broken:${page.path}:${link}`,
          severity: "warning",
          kind: "broken-link",
          path: page.path,
          message: `「${page.title}」里的 [[${link}]] 找不到对应页面`,
        });
      } else {
        incoming.set(resolved.path, (incoming.get(resolved.path) ?? 0) + 1);
      }
    }
    if (!page.hasFrontmatter) {
      issues.push({
        id: `frontmatter:${page.path}`,
        severity: "warning",
        kind: "missing-frontmatter",
        path: page.path,
        message: `「${page.title}」缺少 YAML frontmatter，检索与图谱只能按正文推断`,
      });
    }
    if (page.body.trim().length < 40) {
      issues.push({
        id: `empty:${page.path}`,
        severity: "info",
        kind: "empty-page",
        path: page.path,
        message: `「${page.title}」正文过短，可能还没整理完`,
      });
    }
    const titleKey = page.title.trim().toLowerCase();
    if (titleKey) titleSeen.set(titleKey, [...(titleSeen.get(titleKey) ?? []), page.path]);
    const target = linkTarget(page.path).toLowerCase();
    if (!indexText.includes(`[[${target}]]`)) {
      issues.push({
        id: `unindexed:${page.path}`,
        severity: "warning",
        kind: "unindexed",
        path: page.path,
        message: `索引里没有「${page.title}」，请点「重建索引」`,
      });
    }
  }
  for (const [title, paths] of titleSeen) {
    if (paths.length > 1) {
      issues.push({
        id: `duplicate:${title}`,
        severity: "info",
        kind: "duplicate-title",
        message: `有 ${paths.length} 个页面都叫「${title}」：${paths.join("、")}`,
      });
    }
  }
  for (const page of pages) {
    if (page.type === "source") continue;
    if ((incoming.get(page.path) ?? 0) === 0) {
      const isOverview = /(^|\/)overview\.md$/i.test(page.path);
      if (isOverview) continue;
      issues.push({
        id: `orphan:${page.path}`,
        severity: "info",
        kind: "orphan",
        path: page.path,
        message: `「${page.title}」没有被其他页面引用`,
      });
    }
  }
  const pagePaths = new Set(pages.map((page) => page.path));
  for (const source of input.sources) {
    if (source.status === "failed") {
      issues.push({
        id: `source-failed:${source.id}`,
        severity: "warning",
        kind: "source-failed",
        sourceId: source.id,
        message: `来源「${source.title}」整理失败：${source.error ?? "未知原因"}`,
      });
    }
    if (source.status === "ready" && source.summaryPath && !pagePaths.has(source.summaryPath)) {
      issues.push({
        id: `missing-source:${source.id}`,
        severity: "error",
        kind: "missing-source-page",
        path: source.summaryPath,
        message: `来源「${source.title}」标记为已整理，但摘要页 ${source.summaryPath} 不存在`,
      });
    }
  }
  return {
    checkedAt: Date.now(),
    pageCount: pages.length,
    sourceCount: input.sources.length,
    issues: issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
  };
}

function severityRank(severity: KnowledgeLintIssue["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

const GRAPH_MAX_NODES = 300;
const GRAPH_MAX_EDGES = 1_500;
const SIGNAL_WEIGHT = { link: 3, source: 4, adamicAdar: 1.5, typeAffinity: 1 } as const;

interface PairSignals {
  link: number;
  source: number;
  adamicAdar: number;
}

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** 面板高亮用：无向边的稳定键（与前端实现保持一致）。 */
export function graphEdgeKey(source: string, target: string): string {
  return [source, target].sort().join("|");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 图谱：四路信号合成关联度——直接链接 ×3、共享来源 ×4、Adamic-Adar ×1.5、同类型 ×1。
 *
 * Adamic-Adar 只在「共同邻居」候选对上计分；类型亲和是候选对的加分项，不会给所有同类型页面
 * 凭空造边，否则同类型页面会两两相连、图谱退化成一团。社区与洞察在同一份截断后的边上计算，
 * 保证面板看到的节点、边、集群与提示互相一致。
 */
export function buildGraph(
  pages: readonly KnowledgePageMeta[],
  maxNodes = GRAPH_MAX_NODES,
): KnowledgeGraph {
  const kept = [...pages]
    .sort(
      (a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, "zh"),
    )
    .slice(0, maxNodes);
  const byPath = new Map(kept.map((page) => [page.path, page]));
  const pairs = new Map<string, PairSignals & { a: string; b: string }>();
  const ensure = (a: string, b: string): PairSignals & { a: string; b: string } => {
    const key = pairKey(a, b);
    const existing = pairs.get(key);
    if (existing) return existing;
    const entry = {
      a: a <= b ? a : b,
      b: a <= b ? b : a,
      link: 0,
      source: 0,
      adamicAdar: 0,
    };
    pairs.set(key, entry);
    return entry;
  };

  // 1) 直接 wikilink：同时作为 Adamic-Adar 的邻接关系。
  const adjacency = new Map<string, Set<string>>();
  for (const page of kept) {
    for (const link of page.links) {
      const target = resolveLink(link, kept);
      if (!target || target.path === page.path) continue;
      ensure(page.path, target.path).link = 1;
      const neighbors = adjacency.get(page.path) ?? new Set<string>();
      neighbors.add(target.path);
      adjacency.set(page.path, neighbors);
    }
  }

  // 2) 共享来源材料：同一份来源下最多取 8 页两两弱连接，避免大来源把图变成完全图。
  const bySource = new Map<string, string[]>();
  for (const page of kept) {
    for (const source of page.sources) {
      if (!source) continue;
      const list = bySource.get(source);
      if (list) list.push(page.path);
      else bySource.set(source, [page.path]);
    }
  }
  for (const paths of bySource.values()) {
    const group = [...new Set(paths)].slice(0, 8);
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        ensure(group[i]!, group[j]!).source = 1;
      }
    }
  }

  // 3) Adamic-Adar：共同邻居越多、邻居度数越低，关联越强；归一化到 0–1。
  const common = new Map<string, { a: string; b: string; score: number }>();
  for (const neighbors of adjacency.values()) {
    const list = [...neighbors].sort();
    const contribution = 1 / Math.log(Math.max(2, list.length));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        const key = pairKey(a, b);
        const entry = common.get(key);
        if (entry) entry.score += contribution;
        else common.set(key, { a, b, score: contribution });
      }
    }
  }
  for (const entry of common.values()) {
    ensure(entry.a, entry.b).adamicAdar = Math.min(1, entry.score);
  }

  // 4) 合成边：类型亲和只作为候选对的加分项。
  const edges: KnowledgeGraphEdge[] = [];
  for (const entry of pairs.values()) {
    const a = byPath.get(entry.a);
    const b = byPath.get(entry.b);
    if (!a || !b) continue;
    const typeAffinity = a.type === b.type ? 1 : 0;
    const weight = round2(
      SIGNAL_WEIGHT.link * entry.link +
        SIGNAL_WEIGHT.source * entry.source +
        SIGNAL_WEIGHT.adamicAdar * entry.adamicAdar +
        SIGNAL_WEIGHT.typeAffinity * typeAffinity,
    );
    if (weight <= 0) continue;
    edges.push({
      source: entry.a,
      target: entry.b,
      kind: entry.link ? "link" : entry.source ? "source" : "neighbor",
      weight,
      signals: {
        link: entry.link,
        source: entry.source,
        adamicAdar: round2(entry.adamicAdar),
        typeAffinity,
      },
    });
  }
  edges.sort(
    (x, y) =>
      y.weight - x.weight ||
      x.source.localeCompare(y.source) ||
      x.target.localeCompare(y.target),
  );
  const capped = edges.slice(0, GRAPH_MAX_EDGES);

  const degree = new Map<string, number>();
  for (const edge of capped) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const communityOf = detectCommunities(
    kept.map((page) => page.path),
    capped.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
  );
  const communities = summarizeCommunities(kept, capped, communityOf);
  const nodes: KnowledgeGraphNode[] = kept.map((page) => ({
    id: page.path,
    title: page.title,
    type: page.type,
    tags: page.tags,
    sourceCount: page.sources.length,
    degree: degree.get(page.path) ?? 0,
    community: communityOf.get(page.path) ?? 0,
  }));
  const insights = buildInsights(nodes, capped, communities);
  return {
    nodes,
    edges: capped,
    communities,
    insights,
    truncated: kept.length < pages.length || edges.length > GRAPH_MAX_EDGES,
  };
}

interface WeightedEdge {
  source: string;
  target: string;
  weight: number;
}

interface WeightedGraph {
  ids: string[];
  adjacency: Map<string, Map<string, number>>;
  loops: Map<string, number>;
  degree: Map<string, number>;
  totalWeight: number;
}

function buildWeightedGraph(ids: readonly string[], edges: readonly WeightedEdge[]): WeightedGraph {
  const adjacency = new Map(ids.map((id) => [id, new Map<string, number>()]));
  const loops = new Map<string, number>();
  const degree = new Map(ids.map((id) => [id, 0]));
  let totalWeight = 0;
  for (const edge of edges) {
    if (edge.weight <= 0) continue;
    totalWeight += edge.weight;
    if (edge.source === edge.target) {
      loops.set(edge.source, (loops.get(edge.source) ?? 0) + edge.weight);
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.weight * 2);
      continue;
    }
    adjacency.get(edge.source)?.set(edge.target, (adjacency.get(edge.source)?.get(edge.target) ?? 0) + edge.weight);
    adjacency.get(edge.target)?.set(edge.source, (adjacency.get(edge.target)?.get(edge.source) ?? 0) + edge.weight);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.weight);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.weight);
  }
  return { ids: [...ids], adjacency, loops, degree, totalWeight };
}

/** Louvain 第一层：按固定顺序做本地移动，直到没有节点换社区（确定性，不依赖随机数）。 */
function localMoving(graph: WeightedGraph): Map<string, number> {
  const comm = new Map(graph.ids.map((id, index) => [id, index]));
  const totals = new Map<number, number>();
  for (const id of graph.ids) {
    const c = comm.get(id)!;
    totals.set(c, (totals.get(c) ?? 0) + (graph.degree.get(id) ?? 0));
  }
  if (graph.totalWeight <= 0) return comm;
  const resolution = 2 * graph.totalWeight;
  for (let pass = 0; pass < 30; pass += 1) {
    let moved = false;
    for (const id of graph.ids) {
      const degree = graph.degree.get(id) ?? 0;
      if (degree <= 0) continue;
      const current = comm.get(id)!;
      totals.set(current, (totals.get(current) ?? 0) - degree);
      const weightTo = new Map<number, number>();
      for (const [neighbor, weight] of graph.adjacency.get(id) ?? []) {
        const c = comm.get(neighbor)!;
        weightTo.set(c, (weightTo.get(c) ?? 0) + weight);
      }
      let best = current;
      let bestGain = (weightTo.get(current) ?? 0) - (degree * (totals.get(current) ?? 0)) / resolution;
      for (const candidate of [...weightTo.keys()].sort((a, b) => a - b)) {
        if (candidate === current) continue;
        const gain =
          (weightTo.get(candidate) ?? 0) - (degree * (totals.get(candidate) ?? 0)) / resolution;
        if (gain > bestGain + 1e-9) {
          best = candidate;
          bestGain = gain;
        }
      }
      comm.set(id, best);
      totals.set(best, (totals.get(best) ?? 0) + degree);
      if (best !== current) moved = true;
    }
    if (!moved) break;
  }
  // 重排编号，便于聚合层当作新节点编号使用（最终编号会在 detectCommunities 里再按规模重排）。
  const remap = new Map<number, number>();
  for (const id of graph.ids) {
    const c = comm.get(id)!;
    if (!remap.has(c)) remap.set(c, remap.size);
  }
  return new Map(graph.ids.map((id) => [id, remap.get(comm.get(id)!)!]));
}

/** 把每个社区折叠成一个超级节点：社区内部的边成为自环，跨社区的边权重相加。 */
function aggregate(
  graph: WeightedGraph,
  comm: Map<string, number>,
): { ids: string[]; edges: WeightedEdge[] } {
  const labels = [...new Set(comm.values())].sort((a, b) => a - b);
  const superOf = new Map(labels.map((label) => [label, String(label)]));
  const ids = labels.map((label) => String(label));
  const edgeMap = new Map<string, WeightedEdge>();
  const add = (source: string, target: string, weight: number): void => {
    const key = pairKey(source, target);
    const existing = edgeMap.get(key);
    if (existing) existing.weight += weight;
    else edgeMap.set(key, { source, target, weight });
  };
  for (const [node, neighbors] of graph.adjacency) {
    for (const [neighbor, weight] of neighbors) {
      if (node >= neighbor) continue; // 每条无向边只算一次
      add(superOf.get(comm.get(node)!)!, superOf.get(comm.get(neighbor)!)!, weight);
    }
  }
  for (const [node, weight] of graph.loops) {
    add(superOf.get(comm.get(node)!)!, superOf.get(comm.get(node)!)!, weight);
  }
  return { ids, edges: [...edgeMap.values()] };
}

/**
 * 多层级 Louvain：每层本地移动后聚合，最多 8 层。返回原节点 → 社区编号，
 * 社区按规模降序重新编号（0 最大），同规模时按最小成员路径排序，保证刷新稳定。
 */
function detectCommunities(
  ids: readonly string[],
  edges: readonly WeightedEdge[],
): Map<string, number> {
  if (ids.length === 0) return new Map();
  if (!edges.some((edge) => edge.weight > 0)) {
    return new Map(ids.map((id) => [id, ids.indexOf(id)]));
  }
  let mapping = new Map(ids.map((id) => [id, id]));
  let currentIds = [...ids];
  let currentEdges = [...edges];
  for (let level = 0; level < 8; level += 1) {
    const graph = buildWeightedGraph(currentIds, currentEdges);
    if (graph.totalWeight <= 0) break;
    const comm = localMoving(graph);
    mapping = new Map(
      [...mapping].map(([original, current]) => [
        original,
        String(comm.get(current) ?? 0),
      ]),
    );
    const next = aggregate(graph, comm);
    if (next.ids.length <= 1 || next.ids.length === currentIds.length) break;
    currentIds = next.ids;
    currentEdges = next.edges;
  }
  return renumberCommunities(
    new Map(ids.map((id) => [id, Number(mapping.get(id) ?? 0)])),
    ids,
  );
}

function renumberCommunities(
  labels: Map<string, number>,
  ids: readonly string[],
): Map<string, number> {
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const label = labels.get(id) ?? 0;
    const members = groups.get(label);
    if (members) members.push(id);
    else groups.set(label, [id]);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const sizeDiff = b[1].length - a[1].length;
    if (sizeDiff !== 0) return sizeDiff;
    const aMin = [...a[1]].sort()[0] ?? "";
    const bMin = [...b[1]].sort()[0] ?? "";
    return aMin.localeCompare(bMin);
  });
  const remap = new Map(ordered.map(([label], index) => [label, index]));
  return new Map(ids.map((id) => [id, remap.get(labels.get(id) ?? 0) ?? 0]));
}

/** 社区规模、内聚度与图例标签；导出供单元测试直接验证低内聚阈值。 */
export function summarizeCommunities(
  pages: readonly KnowledgePageMeta[],
  edges: readonly KnowledgeGraphEdge[],
  communityOf: Map<string, number>,
): KnowledgeCommunity[] {  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const groups = new Map<number, string[]>();
  for (const page of pages) {
    const id = communityOf.get(page.path) ?? 0;
    const members = groups.get(id);
    if (members) members.push(page.path);
    else groups.set(id, [page.path]);
  }
  const internal = new Map<number, number>();
  for (const edge of edges) {
    const c = communityOf.get(edge.source);
    if (c !== undefined && c === communityOf.get(edge.target)) {
      internal.set(c, (internal.get(c) ?? 0) + 1);
    }
  }
  const communities: KnowledgeCommunity[] = [];
  for (const [id, members] of groups) {
    const sorted = [...members].sort(
      (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
    );
    const pairs = (members.length * (members.length - 1)) / 2;
    const cohesion = pairs > 0 ? round2((internal.get(id) ?? 0) / pairs) : 0;
    communities.push({
      id,
      label: byPath.get(sorted[0]!)?.title ?? sorted[0]!,
      size: members.length,
      cohesion,
      lowCohesion: members.length >= 3 && cohesion < 0.15,
      members: sorted,
    });
  }
  return communities.sort((a, b) => a.id - b.id);
}

/**
 * 图谱洞察：惊奇连接（跨社区/跨类型的高关联边）、孤立页、桥接节点与低内聚社区。
 * 只给提示与建议研究方向，是否去研究由用户决定。
 */
function buildInsights(
  nodes: readonly KnowledgeGraphNode[],
  edges: readonly KnowledgeGraphEdge[],
  communities: readonly KnowledgeCommunity[],
): KnowledgeInsight[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const communityById = new Map(communities.map((community) => [community.id, community]));
  const insights: KnowledgeInsight[] = [];

  const surprising = edges
    .map((edge) => {
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      if (!a || !b) return null;
      const crossCommunity = a.community !== b.community;
      const crossType = a.type !== b.type;
      if (!crossCommunity && !crossType) return null;
      return {
        edge,
        a,
        b,
        score: edge.weight * (crossCommunity ? 1.5 : 1) * (crossType ? 1.2 : 1),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
  for (const { edge, a, b } of surprising) {
    const why = [
      a.community !== b.community ? "跨社区" : "",
      a.type !== b.type ? "跨类型" : "",
    ]
      .filter(Boolean)
      .join("、");
    insights.push({
      id: `surprise:${graphEdgeKey(edge.source, edge.target)}`,
      kind: "surprising",
      title: `「${a.title}」与「${b.title}」的意外关联`,
      detail: `关联度 ${edge.weight.toFixed(1)}（${why}）：链接 ${
        edge.signals.link ? "有" : "无"
      }，共享来源 ${edge.signals.source ? "有" : "无"}，共同邻居 ${edge.signals.adamicAdar.toFixed(
        2,
      )}，同类 ${edge.signals.typeAffinity ? "是" : "否"}。`,
      nodeIds: [a.id, b.id],
      edgeKeys: [graphEdgeKey(edge.source, edge.target)],
      suggestedTopic: `「${a.title}」和「${b.title}」之间有什么值得确认或展开的关系？`,
    });
  }

  const neighborCommunities = new Map<string, Set<number>>();
  for (const edge of edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const forA = neighborCommunities.get(a.id) ?? new Set<number>();
    forA.add(b.community);
    neighborCommunities.set(a.id, forA);
    const forB = neighborCommunities.get(b.id) ?? new Set<number>();
    forB.add(a.community);
    neighborCommunities.set(b.id, forB);
  }
  const bridges = nodes
    .filter((node) => (neighborCommunities.get(node.id)?.size ?? 0) >= 3)
    .sort(
      (a, b) =>
        (neighborCommunities.get(b.id)?.size ?? 0) - (neighborCommunities.get(a.id)?.size ?? 0),
    )
    .slice(0, 3);
  for (const node of bridges) {
    const labels = [...(neighborCommunities.get(node.id) ?? [])]
      .map((id) => communityById.get(id)?.label ?? `社区 ${id}`)
      .slice(0, 4);
    insights.push({
      id: `bridge:${node.id}`,
      kind: "bridge",
      title: `「${node.title}」连接 ${labels.length} 个知识集群`,
      detail: `关键枢纽，连接：${labels.join("、")}。它把不同主题串在一起，改动或删除前先确认其它页面的引用。`,
      nodeIds: [node.id],
      suggestedTopic: `梳理「${node.title}」与 ${labels.join("、")} 之间的关系，是否该拆成独立主题？`,
    });
  }

  const orphans = nodes
    .filter((node) => node.degree <= 1)
    .sort((a, b) => a.degree - b.degree || a.title.localeCompare(b.title, "zh"))
    .slice(0, 5);
  for (const node of orphans) {
    insights.push({
      id: `orphan:${node.id}`,
      kind: "orphan",
      title: `「${node.title}」缺少关联`,
      detail: `度数为 ${node.degree}，与图谱其余部分几乎没有连接。可能是新材料、也可能是整理时漏了互链。`,
      nodeIds: [node.id],
      suggestedTopic: `为「${node.title}」补充资料，并判断它该与哪些现有主题互链。`,
    });
  }

  const sparse = communities
    .filter((community) => community.lowCohesion)
    .sort((a, b) => b.size - a.size || a.cohesion - b.cohesion)
    .slice(0, 3);
  for (const community of sparse) {
    insights.push({
      id: `sparse:${community.id}`,
      kind: "sparse-community",
      title: `集群「${community.label}」内部关联稀疏`,
      detail: `${community.size} 个页面，内聚度 ${community.cohesion.toFixed(
        2,
      )}（低于 0.15）。知识领域已成形，但页面之间的交叉引用与对比还不够。`,
      nodeIds: community.members.slice(0, 12),
      suggestedTopic: `为「${community.label}」集群补充交叉引用、对比页或综合页，把分散的页面串起来。`,
    });
  }

  return insights.slice(0, 12);
}
