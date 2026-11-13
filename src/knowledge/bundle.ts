import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import JSZip from "jszip";
import { KnowledgeError, type KnowledgeBaseMeta } from "./types";

const ROOT_FILES = new Set([
  "purpose.md",
  "schema.md",
  "index.md",
  "log.md",
  "source-index.json",
  "queue.json",
  "reviews.json",
]);

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_BUNDLE_FILES = 5_000;

function isAllowed(rel: string): boolean {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) return false;
  const segments = clean.split("/");
  if (
    segments.some(
      (part) => part === "." || part === ".." || part === "" || part.startsWith("."),
    )
  ) {
    return false;
  }
  return /^(raw|wiki)\//.test(clean) || ROOT_FILES.has(clean);
}

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(abs, base)));
    else if (entry.isFile()) files.push(relative(base, abs).split(sep).join("/"));
  }
  return files;
}

/** 打包一个知识库：raw/ + wiki/ + 根目录的约束/索引/队列/审核文件；不包含向量缓存。 */
export async function exportBundle(baseDir: string, meta: KnowledgeBaseMeta): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "meta.json",
    JSON.stringify(
      { format: "agent-collaboration-knowledge", version: 1, exportedAt: Date.now(), ...meta },
      null,
      2,
    ),
  );
  for (const rel of await walk(baseDir)) {
    if (!isAllowed(rel) || rel === "embeddings.json") continue;
    zip.file(rel, await readFile(join(baseDir, ...rel.split("/"))));
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export interface KnowledgeBundle {
  meta: KnowledgeBaseMeta;
  purpose: string;
  schema: string;
  /** 相对知识库目录的文本文件内容；meta.json / purpose.md / schema.md 不重复放入。 */
  files: Map<string, Buffer>;
}

function parseMeta(raw: unknown): KnowledgeBaseMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KnowledgeError(400, "压缩包缺少有效的 meta.json");
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  if (!name) throw new KnowledgeError(400, "压缩包的 meta.json 缺少知识库名称");
  return {
    id: typeof record["id"] === "string" ? record["id"] : "",
    name,
    description: typeof record["description"] === "string" ? record["description"] : "",
    purpose: typeof record["purpose"] === "string" ? record["purpose"] : "",
    schema: typeof record["schema"] === "string" ? record["schema"] : "",
    createdAt: typeof record["createdAt"] === "number" ? record["createdAt"] : Date.now(),
    updatedAt: typeof record["updatedAt"] === "number" ? record["updatedAt"] : Date.now(),
    pageCount: 0,
    sourceCount: 0,
    pendingCount: 0,
  };
}

/** 解析并校验整库压缩包：路径逃逸、文件数量与解压体积都在这里拒绝。 */
export async function readBundle(buffer: Buffer): Promise<KnowledgeBundle> {
  if (buffer.length > MAX_BUNDLE_BYTES) {
    throw new KnowledgeError(400, "压缩包超过 50 MB");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new KnowledgeError(400, "不是有效的 ZIP 压缩包");
  }
  const metaEntry = zip.file("meta.json");
  if (!metaEntry) throw new KnowledgeError(400, "压缩包缺少 meta.json");
  let meta: KnowledgeBaseMeta;
  try {
    meta = parseMeta(JSON.parse(await metaEntry.async("string")));
  } catch (err) {
    if (err instanceof KnowledgeError) throw err;
    throw new KnowledgeError(400, "meta.json 不是有效的 JSON");
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const rel = name.replace(/\\/g, "/");
    if (rel === "meta.json" || rel === "purpose.md" || rel === "schema.md") continue;
    if (!isAllowed(rel)) continue;
    if (files.size >= MAX_BUNDLE_FILES) throw new KnowledgeError(400, "压缩包文件数量过多");
    const data = await entry.async("nodebuffer");
    total += data.length;
    if (total > MAX_BUNDLE_BYTES) throw new KnowledgeError(400, "解压后超过 50 MB");
    files.set(rel, data);
  }
  if ([...files.keys()].filter((path) => /^wiki\/.+\.md$/i.test(path)).length > 1_000) {
    throw new KnowledgeError(400, "压缩包里的页面数量超过上限");
  }
  return {
    meta,
    purpose: zip.file("purpose.md") ? await zip.file("purpose.md")!.async("string") : "",
    schema: zip.file("schema.md") ? await zip.file("schema.md")!.async("string") : "",
    files,
  };
}
