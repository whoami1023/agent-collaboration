import { posix } from "node:path";
import { KnowledgeError } from "./types";

const SLUG_KEEP = /[\p{L}\p{N}]+/gu;

/** 标题 → 文件名：保留中文与字母数字，其余折叠成连字符。 */
export function slugify(input: string, fallback = "page"): string {
  const normalized = input.normalize("NFKC").trim().toLowerCase();
  const parts: string[] = [];
  for (const match of normalized.matchAll(SLUG_KEEP)) {
    const text = match[0];
    // 一段连续字符超过 60 就截断，避免超长标题撑爆路径。
    parts.push(text.slice(0, 60));
  }
  const slug = parts.join("-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/** 知识库目录名只接受服务端生成的 ID，杜绝 `../` 一类的路径注入。 */
export function assertKnowledgeId(id: string): string {
  if (!/^kb_[0-9a-f]{12}$/.test(id)) throw new KnowledgeError(400, "知识库 ID 不合法");
  return id;
}

export function assertSourceId(id: string): string {
  if (!/^src_[0-9a-f]{12}$/.test(id)) throw new KnowledgeError(400, "来源 ID 不合法");
  return id;
}

export function assertQueueId(id: string): string {
  if (!/^kq_[0-9a-f]{12}$/.test(id)) throw new KnowledgeError(400, "队列项 ID 不合法");
  return id;
}

/**
 * 模型给出的页面路径归一化到 `wiki/<目录>/<文件>.md`。
 *
 * 只接受相对路径：统一斜杠、去掉 `./` 与 `wiki/` 前缀、补 `.md`；
 * 任何 `..`、绝对路径、控制字符或点开头的隐藏段都直接拒绝，调用方负责回一条可读错误。
 */
export function normalizeWikiPath(input: unknown): string {
  if (typeof input !== "string") throw new KnowledgeError(400, "页面路径必须是字符串");
  let value = input.trim().replace(/\\/g, "/");
  if (!value) throw new KnowledgeError(400, "页面路径不能为空");
  value = value.replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (value.toLowerCase().startsWith("wiki/")) value = value.slice(5);
  if (!/\.md$/i.test(value)) value = `${value}.md`;
  if (value.length > 200) throw new KnowledgeError(400, "页面路径过长");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new KnowledgeError(400, "页面路径含非法字符");
  const segments = value.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new KnowledgeError(400, "页面必须放在 wiki 的子目录里（如 concepts/example.md）");
  }
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      throw new KnowledgeError(400, "页面路径不能包含相对跳转或隐藏目录");
    }
    if (!/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u.test(segment)) {
      throw new KnowledgeError(400, `页面路径含非法片段：${segment}`);
    }
  }
  return posix.join("wiki", ...segments);
}

/** 页面路径（`wiki/...`）→ 元数据里的相对路径（`entities/x.md`）。 */
export function pagePathOf(wikiPath: string): string {
  return normalizeWikiPath(wikiPath).slice("wiki/".length);
}

/** 元数据里的相对路径 → 磁盘上的 wiki 路径。 */
export function wikiPathOf(pagePath: string): string {
  return normalizeWikiPath(pagePath);
}

/** 来源文件名：去掉目录与危险字符，保留可读标题，落到 .md 或 .txt。 */
export function sourceFilename(title: string, sourceId: string): string {
  const ext = /\.(md|markdown|txt|text)$/i.exec(title.trim())?.[1]?.toLowerCase();
  const suffix = ext === "md" || ext === "markdown" ? "md" : "txt";
  const base = slugify(title.replace(/\.(md|markdown|txt|text)$/i, ""), "source");
  return `${sourceId}-${base}.${suffix}`;
}

/** 人类可读的字节数，面板与提示词共用。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
