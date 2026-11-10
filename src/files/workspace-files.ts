/**
 * 文件工作区：每用户工作区下的 files/ 目录。
 *
 * 思路对应 OpenClaw 的 agent workspace（docs/concepts/agent-workspace.md）：
 * 工作区是智能体读写文件的根，工具只接受相对路径；这里把根收窄到 files/，
 * 避免 API 与工具碰到 state.json、settings.json 等运行时数据。
 */

import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_PREVIEW_BYTES = 256 * 1024;
export const MAX_LIST_ENTRIES = 500;
/** 文本分页的默认上限：一次最多 400 行、64 KB，超出时由调用方继续翻页。 */
export const MAX_LINE_PAGE_LINES = 400;
export const MAX_LINE_PAGE_BYTES = 64 * 1024;
const MAX_LIST_DEPTH = 12;
const BINARY_SNIFF_BYTES = 8192;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "sh",
  "bash",
  "ps1",
  "sql",
  "log",
  "ini",
  "conf",
  "env",
]);

export type WorkspaceFileKind = "file" | "dir";
export type WorkspaceFilePreview = "text" | "image" | "binary";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  sizeBytes: number;
  updatedAt: number;
}

export interface WorkspaceFileListing {
  files: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface WorkspaceFileContent {
  path: string;
  name: string;
  sizeBytes: number;
  updatedAt: number;
  binary: boolean;
  preview: WorkspaceFilePreview;
  inlineMime: string | null;
  content: string;
  truncated: boolean;
}

export interface WorkspaceFileLineRange {
  path: string;
  sizeBytes: number;
  updatedAt: number;
  binary: boolean;
  startLine: number;
  endLine: number;
  text: string;
  /** 后面还有没读到的行。 */
  more: boolean;
}

export interface WorkspaceFileLineOptions {
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  maxBytes?: number;
}

export interface WorkspaceFileDownload {
  path: string;
  name: string;
  absPath: string;
  sizeBytes: number;
  updatedAt: number;
  inlineMime: string | null;
}

export class WorkspaceFileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

function isInsideDir(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/** 按字节上限截断字符串，避免把 UTF-8 多字节序列留在半个字符上。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= maxBytes ? text : buffer.subarray(0, maxBytes).toString("utf8");
}

export function inlineMimeFor(name: string): string | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  if (ext === "pdf") return "application/pdf";
  // 统一按 text/plain 内联，避免把上传的 HTML/SVG 当同源页面执行。
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  return null;
}

function normalizeRelPath(raw: string): string {
  const normalized = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) throw new WorkspaceFileError(400, "文件路径不能为空");
  if (normalized.includes("\0") || path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new WorkspaceFileError(400, `路径不合法：${raw}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[\u0000-\u001f]/.test(segment),
    )
  ) {
    throw new WorkspaceFileError(400, `路径不合法：${raw}`);
  }
  return segments.join("/");
}

export class WorkspaceFiles {
  private readonly root: string;

  constructor(workspaceDir: string) {
    this.root = path.resolve(workspaceDir, "files");
  }

  get rootDir(): string {
    return this.root;
  }

  async list(): Promise<WorkspaceFileListing> {
    await this.ensureRoot();
    const realRoot = await fs.realpath(this.root);
    const files: WorkspaceFileEntry[] = [];
    let truncated = false;

    const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
      if (truncated || depth > MAX_LIST_DEPTH) return;
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        // 符号链接可能指向工作区之外，文件工作区不跟随。
        if (entry.isSymbolicLink()) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          files.push({ path: rel, name: entry.name, kind: "dir", sizeBytes: 0, updatedAt: 0 });
          await walk(abs, rel, depth + 1);
        } else if (entry.isFile()) {
          const stat = await fs.stat(abs);
          files.push({
            path: rel,
            name: entry.name,
            kind: "file",
            sizeBytes: stat.size,
            updatedAt: stat.mtimeMs,
          });
        }
      }
    };

    await walk(realRoot, "", 0);
    files.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
    return { files, truncated };
  }

  async read(rawPath: string, options: { maxBytes?: number } = {}): Promise<WorkspaceFileContent> {
    const { rel, abs, stat } = await this.existingFile(rawPath);
    const maxBytes = Math.max(1, Math.min(options.maxBytes ?? MAX_PREVIEW_BYTES, MAX_TEXT_BYTES));
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      const handle = await fs.open(abs, "r");
      try {
        await handle.read(buffer, 0, length, 0);
      } finally {
        await handle.close();
      }
    }
    const inlineMime = inlineMimeFor(rel);
    const image = inlineMime?.startsWith("image/") === true;
    const binary = image || looksBinary(buffer);
    const preview: WorkspaceFilePreview = image ? "image" : binary ? "binary" : "text";
    return {
      path: rel,
      name: path.basename(rel),
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs,
      binary,
      preview,
      inlineMime,
      content: preview === "text" ? buffer.toString("utf8") : "",
      truncated: stat.size > length,
    };
  }

  /**
   * 按行分页读取：只返回请求的行区间，支持超过 MAX_TEXT_BYTES 的大文件。
   * 行按 \n 切分并去掉行尾 \r；单行本身超过页预算时在预算处截断并明确标注，
   * 否则一条超长 JSON 会绕过页上限把整份文件带进上下文。
   */
  async readLines(
    rawPath: string,
    options: WorkspaceFileLineOptions = {},
  ): Promise<WorkspaceFileLineRange> {
    const { rel, abs, stat } = await this.existingFile(rawPath);
    const startLine = Math.max(1, Math.round(options.startLine ?? 1));
    const requestedEnd =
      options.endLine === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(startLine, Math.round(options.endLine));
    const maxLines = Math.max(
      1,
      Math.min(MAX_LINE_PAGE_LINES, Math.round(options.maxLines ?? MAX_LINE_PAGE_LINES)),
    );
    const maxBytes = Math.max(
      1,
      Math.min(MAX_PREVIEW_BYTES, Math.round(options.maxBytes ?? MAX_LINE_PAGE_BYTES)),
    );
    const image = inlineMimeFor(rel)?.startsWith("image/") === true;

    const handle = await fs.open(abs, "r");
    try {
      const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
      if (sniff.length > 0) await handle.read(sniff, 0, sniff.length, 0);
      const binary = image || looksBinary(sniff);
      if (binary) {
        return {
          path: rel,
          sizeBytes: stat.size,
          updatedAt: stat.mtimeMs,
          binary: true,
          startLine,
          endLine: startLine - 1,
          text: "",
          more: false,
        };
      }

      const decoder = new StringDecoder("utf8");
      const page: string[] = [];
      let current = "";
      let lineNo = 0;
      let usedBytes = 0;
      let more = false;
      let stopped = false;
      let position = 0;
      const buffer = Buffer.alloc(64 * 1024);

      const finishLine = (): void => {
        lineNo += 1;
        if (stopped) {
          current = "";
          return;
        }
        if (lineNo < startLine) {
          current = "";
          return;
        }
        if (lineNo > requestedEnd) {
          more = true;
          stopped = true;
          current = "";
          return;
        }
        const line = current.endsWith("\r") ? current.slice(0, -1) : current;
        const size = Buffer.byteLength(line, "utf8") + (page.length > 0 ? 1 : 0);
        if (page.length >= maxLines || usedBytes + size > maxBytes) {
          if (page.length === 0) {
            page.push(
              `${truncateUtf8(line, maxBytes)}\n…（本行超过单页上限，已截断；请缩小范围或先检索）`,
            );
            usedBytes = maxBytes;
          }
          more = true;
          stopped = true;
          current = "";
          return;
        }
        page.push(line);
        usedBytes += size;
        current = "";
      };

      while (!stopped && position < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        const chunk = decoder.write(buffer.subarray(0, bytesRead));
        for (const char of chunk) {
          if (char === "\n") finishLine();
          else current += char;
        }
      }
      if (!stopped) {
        current += decoder.end();
        if (current.length > 0) finishLine();
        if (position < stat.size) more = true;
      }
      const endLine = page.length > 0 ? startLine + page.length - 1 : startLine - 1;
      return {
        path: rel,
        sizeBytes: stat.size,
        updatedAt: stat.mtimeMs,
        binary: false,
        startLine,
        endLine,
        text: page.join("\n"),
        more,
      };
    } finally {
      await handle.close();
    }
  }

  async write(
    rawPath: string,
    content: Buffer,
    options: { overwrite?: boolean; append?: boolean } = {},
  ): Promise<WorkspaceFileEntry> {
    if (!Buffer.isBuffer(content)) throw new WorkspaceFileError(400, "文件内容必须是二进制数据");
    if (options.append && options.overwrite) {
      throw new WorkspaceFileError(400, "append 与 overwrite 不能同时使用");
    }
    if (content.length > MAX_UPLOAD_BYTES) {
      throw new WorkspaceFileError(413, `文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    await this.ensureRoot();
    const rel = normalizeRelPath(rawPath);
    const abs = this.absFor(rel);
    await this.assertWritableParent(rel);

    let existing: Stats | undefined;
    try {
      existing = await fs.lstat(abs);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
    }
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceFileError(400, `不允许覆盖符号链接：${rel}`);
    }
    if (existing?.isDirectory()) {
      throw new WorkspaceFileError(400, `目标是一个目录：${rel}`);
    }
    if (existing && !options.overwrite && !options.append) {
      throw new WorkspaceFileError(409, `文件已存在：${rel}`);
    }
    if (options.append && existing && existing.size + content.length > MAX_UPLOAD_BYTES) {
      throw new WorkspaceFileError(413, `追加后文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    const realRoot = await fs.realpath(this.root);
    const parentReal = await fs.realpath(path.dirname(abs)).catch(() => undefined);
    if (!parentReal || !isInsideDir(realRoot, parentReal)) {
      throw new WorkspaceFileError(400, `路径越出文件工作区：${rel}`);
    }
    if (options.append) {
      await fs.appendFile(abs, content);
    } else {
      await fs.writeFile(abs, content);
    }
    const stat = await fs.stat(abs);
    return {
      path: rel,
      name: path.basename(rel),
      kind: "file",
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs,
    };
  }

  async createDirectory(rawPath: string): Promise<WorkspaceFileEntry> {
    await this.ensureRoot();
    const rel = normalizeRelPath(rawPath);
    const abs = this.absFor(rel);
    await this.assertWritableParent(rel);

    let existing: Stats | undefined;
    try {
      existing = await fs.lstat(abs);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
    }
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceFileError(400, `不允许在符号链接上建目录：${rel}`);
    }
    if (existing) {
      throw new WorkspaceFileError(
        409,
        existing.isDirectory() ? `目录已存在：${rel}` : `同名文件已存在：${rel}`,
      );
    }

    await fs.mkdir(abs, { recursive: true });
    const realRoot = await fs.realpath(this.root);
    const parentReal = await fs.realpath(path.dirname(abs)).catch(() => undefined);
    if (!parentReal || !isInsideDir(realRoot, parentReal)) {
      throw new WorkspaceFileError(400, `路径越出文件工作区：${rel}`);
    }
    const stat = await fs.stat(abs);
    return {
      path: rel,
      name: path.basename(rel),
      kind: "dir",
      sizeBytes: 0,
      updatedAt: stat.mtimeMs,
    };
  }

  async remove(rawPath: string): Promise<WorkspaceFileEntry> {
    await this.ensureRoot();
    const rel = normalizeRelPath(rawPath);
    const abs = this.absFor(rel);
    let stat: Stats;
    try {
      stat = await fs.lstat(abs);
    } catch (err) {
      if (isErrno(err, "ENOENT")) throw new WorkspaceFileError(404, `文件不存在：${rel}`);
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspaceFileError(400, `不允许删除符号链接：${rel}`);
    }
    const realRoot = await fs.realpath(this.root);
    const parentReal = await fs.realpath(path.dirname(abs)).catch(() => undefined);
    if (!parentReal || !isInsideDir(realRoot, parentReal)) {
      throw new WorkspaceFileError(400, `路径越出文件工作区：${rel}`);
    }
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) {
      throw new WorkspaceFileError(400, `目标不是文件或目录：${rel}`);
    }
    try {
      if (isDir) await fs.rmdir(abs);
      else await fs.unlink(abs);
    } catch (err) {
      // 只允许删除空目录，避免一次误删整棵子树。
      if (isErrno(err, "ENOTEMPTY") || isErrno(err, "EEXIST")) {
        throw new WorkspaceFileError(409, `目录不为空，请先删除里面的文件：${rel}`);
      }
      if (isErrno(err, "ENOENT")) throw new WorkspaceFileError(404, `文件不存在：${rel}`);
      throw err;
    }
    return {
      path: rel,
      name: path.basename(rel),
      kind: isDir ? "dir" : "file",
      sizeBytes: isDir ? 0 : stat.size,
      updatedAt: Date.now(),
    };
  }

  async download(rawPath: string): Promise<WorkspaceFileDownload> {
    const { rel, abs, stat } = await this.existingFile(rawPath);
    return {
      path: rel,
      name: path.basename(rel),
      absPath: abs,
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs,
      inlineMime: inlineMimeFor(rel),
    };
  }

  private async existingFile(rawPath: string): Promise<{
    rel: string;
    abs: string;
    stat: Stats;
  }> {
    await this.ensureRoot();
    const rel = normalizeRelPath(rawPath);
    const abs = this.absFor(rel);
    const realRoot = await fs.realpath(this.root);
    const realPath = await fs.realpath(abs).catch((err: unknown) => {
      if (isErrno(err, "ENOENT")) throw new WorkspaceFileError(404, `文件不存在：${rel}`);
      throw err;
    });
    if (!isInsideDir(realRoot, realPath)) {
      throw new WorkspaceFileError(400, `路径越出文件工作区：${rel}`);
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) throw new WorkspaceFileError(400, `目标不是文件：${rel}`);
    return { rel, abs: realPath, stat };
  }

  private absFor(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (!isInsideDir(this.root, abs) || path.relative(this.root, abs) === "") {
      throw new WorkspaceFileError(400, `路径不合法：${rel}`);
    }
    return abs;
  }

  /** 建目录前先逐级确认已有父目录不是符号链接，避免 mkdir 顺着链接写到工作区外。 */
  private async assertWritableParent(rel: string): Promise<void> {
    const segments = rel.split("/").slice(0, -1);
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat: Stats;
      try {
        stat = await fs.lstat(current);
      } catch (err) {
        if (isErrno(err, "ENOENT")) return;
        throw err;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkspaceFileError(400, `路径不合法：${rel}`);
      }
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      const stat = await fs.lstat(this.root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new WorkspaceFileError(500, "文件工作区目录不可用");
      }
      return;
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
    }
    await fs.mkdir(this.root, { recursive: true });
  }
}
