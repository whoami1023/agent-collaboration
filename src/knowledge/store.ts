import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { readJson, writeJsonAtomic } from "../store/persist";
import { normalizePage, pageSummary } from "./frontmatter";
import { assertKnowledgeId, normalizeWikiPath, pagePathOf } from "./paths";
import type {
  KnowledgeBaseMeta,
  KnowledgeEmbeddingIndex,
  KnowledgePage,
  KnowledgeQueueItem,
  KnowledgeReview,
  KnowledgeSource,
} from "./types";
import { KnowledgeError } from "./types";

export interface StoredPage extends KnowledgePage {
  raw: string;
  hasFrontmatter: boolean;
}

export interface KnowledgeStoreOptions {
  /** YYYY-MM-DD 的兜底日期；测试可固定。 */
  today(): string;
}

const KB_DIRS = ["raw", "raw/sources", "wiki", "wiki/sources"] as const;

/** 每个账号的知识库目录：`<workspace>/knowledge/<kbId>/`。 */
export class KnowledgeStore {
  readonly root: string;

  constructor(
    workspaceDir: string,
    private readonly options: KnowledgeStoreOptions,
  ) {
    this.root = join(workspaceDir, "knowledge");
  }

  private dirOf(id: string): string {
    return join(this.root, assertKnowledgeId(id));
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async listBases(): Promise<KnowledgeBaseMeta[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const bases: KnowledgeBaseMeta[] = [];
    for (const entry of entries) {
      if (!/^kb_[0-9a-f]{12}$/.test(entry)) continue;
      const meta = await this.readBase(entry).catch(() => null);
      if (meta) bases.push(meta);
    }
    return bases.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async readBase(id: string): Promise<KnowledgeBaseMeta> {
    const meta = await readJson<KnowledgeBaseMeta | null>(join(this.dirOf(id), "meta.json"), null);
    if (!meta) throw new KnowledgeError(404, "知识库不存在");
    return meta;
  }

  async writeBase(meta: KnowledgeBaseMeta): Promise<void> {
    await writeJsonAtomic(join(this.dirOf(meta.id), "meta.json"), meta);
  }

  /** 建库：目录骨架 + 两份约束文件。purpose / schema 的内容由服务层生成。 */
  async createBase(meta: KnowledgeBaseMeta, purpose: string, schema: string): Promise<void> {
    const dir = this.dirOf(meta.id);
    await Promise.all(KB_DIRS.map((name) => mkdir(join(dir, name), { recursive: true })));
    await this.writeBase(meta);
    await this.writeText(meta.id, "purpose.md", purpose);
    await this.writeText(meta.id, "schema.md", schema);
    await this.writeText(meta.id, "index.md", "");
    await this.writeText(meta.id, "log.md", "# 变更日志\n");
    await this.writeText(meta.id, "wiki/overview.md", "");
    await this.writeSourceIndex(meta.id, []);
    await this.writeQueue(meta.id, []);
  }

  async removeBase(id: string): Promise<void> {
    await rm(this.dirOf(id), { recursive: true, force: true });
  }

  async readText(id: string, relativePath: string): Promise<string> {
    const file = this.safeFile(id, relativePath);
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  async writeText(id: string, relativePath: string, text: string): Promise<void> {
    const file = this.safeFile(id, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }

  /** 导入整库压缩包用：按相对路径写原始字节（raw/ 与 wiki/ 下的文件、根目录白名单）。 */
  async writeFileBytes(id: string, relativePath: string, data: Buffer): Promise<void> {
    const file = this.safeFile(id, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async readSourceIndex(id: string): Promise<KnowledgeSource[]> {
    const data = await readJson<{ sources?: KnowledgeSource[] } | null>(
      join(this.dirOf(id), "source-index.json"),
      null,
    );
    return Array.isArray(data?.sources) ? data!.sources : [];
  }

  async writeSourceIndex(id: string, sources: KnowledgeSource[]): Promise<void> {
    await writeJsonAtomic(join(this.dirOf(id), "source-index.json"), { sources });
  }

  async readQueue(id: string): Promise<KnowledgeQueueItem[]> {
    const data = await readJson<{ items?: KnowledgeQueueItem[] } | null>(
      join(this.dirOf(id), "queue.json"),
      null,
    );
    return Array.isArray(data?.items) ? data!.items : [];
  }

  async writeQueue(id: string, items: KnowledgeQueueItem[]): Promise<void> {
    await writeJsonAtomic(join(this.dirOf(id), "queue.json"), { items });
  }

  async readEmbeddings(id: string): Promise<KnowledgeEmbeddingIndex | null> {
    return readJson<KnowledgeEmbeddingIndex | null>(
      join(this.dirOf(id), "embeddings.json"),
      null,
    );
  }

  async writeEmbeddings(id: string, index: KnowledgeEmbeddingIndex): Promise<void> {
    await writeJsonAtomic(join(this.dirOf(id), "embeddings.json"), index);
  }

  async readReviews(id: string): Promise<KnowledgeReview[]> {
    const data = await readJson<{ items?: KnowledgeReview[] } | null>(
      join(this.dirOf(id), "reviews.json"),
      null,
    );
    return Array.isArray(data?.items) ? data!.items : [];
  }

  async writeReviews(id: string, items: KnowledgeReview[]): Promise<void> {
    await writeJsonAtomic(join(this.dirOf(id), "reviews.json"), { items });
  }

  async writeSourceRaw(id: string, filename: string, content: string): Promise<string> {
    const relativePath = `raw/sources/${filename}`;
    await this.writeText(id, relativePath, content);
    return relativePath;
  }

  async readSourceRaw(id: string, rawPath: string): Promise<string> {
    return this.readText(id, rawPath);
  }

  async deleteSourceRaw(id: string, rawPath: string): Promise<void> {
    await rm(this.safeFile(id, rawPath), { force: true });
  }

  async pageExists(id: string, pagePath: string): Promise<boolean> {
    try {
      const info = await stat(this.safePageFile(id, pagePath));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async readPage(id: string, pagePath: string): Promise<StoredPage | null> {
    const normalized = pagePathOf(normalizeWikiPath(pagePath));
    const raw = await this.readText(id, `wiki/${normalized}`);
    if (!raw) return null;
    return this.parseStored(normalized, raw);
  }

  async writePage(id: string, pagePath: string, content: string): Promise<StoredPage> {
    const normalized = pagePathOf(normalizeWikiPath(pagePath));
    await this.writeText(id, `wiki/${normalized}`, content);
    return this.parseStored(normalized, content);
  }

  async deletePage(id: string, pagePath: string): Promise<void> {
    const normalized = pagePathOf(normalizeWikiPath(pagePath));
    await rm(this.safePageFile(id, normalized), { force: true });
  }

  async listPages(id: string): Promise<StoredPage[]> {
    const wikiDir = join(this.dirOf(id), "wiki");
    const files = await walkMarkdown(wikiDir);
    const pages: StoredPage[] = [];
    for (const file of files) {
      const pagePath = relative(wikiDir, file).split(sep).join("/");
      // 总览是系统生成的门面页，不算知识页；索引与日志在库根目录，不在这里。
      if (pagePath === "overview.md") continue;
      const raw = await readFile(file, "utf8").catch(() => "");
      if (!raw.trim()) continue;
      pages.push(this.parseStored(pagePath, raw));
    }
    return pages;
  }

  private parseStored(pagePath: string, raw: string): StoredPage {
    const { meta, body } = normalizePage(raw, {
      path: pagePath,
      today: this.options.today(),
      fallbackTitle: pagePath.split("/").pop()?.replace(/\.md$/i, ""),
    });
    return {
      ...meta,
      summary: pageSummary(body),
      body,
      raw,
      hasFrontmatter: /^---[ \t]*\r?\n[\s\S]*?\r?\n---/.test(raw),
    };
  }
  /** raw/ 与 wiki/ 之外的相对路径一律拒绝（来源索引是服务端写的，仍按不可信输入校验）。 */
  private safeFile(id: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) {
      throw new KnowledgeError(400, "文件路径不合法");
    }
    if (!/^(raw|wiki)\//.test(normalized) && !/^(meta\.json|index\.md|log\.md|purpose\.md|schema\.md|source-index\.json|queue\.json|embeddings\.json|reviews\.json)$/.test(normalized)) {
      throw new KnowledgeError(400, "文件路径不合法");
    }
    return join(this.dirOf(id), ...normalized.split("/"));
  }

  private safePageFile(id: string, pagePath: string): string {
    return this.safeFile(id, `wiki/${pagePath}`);
  }
}

async function walkMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkMarkdown(path)));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
  }
  return files;
}
