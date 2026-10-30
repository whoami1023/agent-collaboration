/*!
 * 技能附带文件（scripts / references / assets 等）的路径与体积校验。
 * 参照 OpenClaw (https://github.com/openclaw/openclaw, MIT) 的 skill 目录语义：
 * 一个技能是一个目录，SKILL.md 是入口，其余文件随技能一起分发（src/skills/loading/*）。
 * 适配：本项目的技能记录存在 JSON 库里而非磁盘，因此附带文件按 path + 内容内联存储，
 * 路径必须是技能目录内的相对路径。
 */

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_FILES = 40;
export const MAX_SKILL_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_FILE_PATH_CHARS = 160;

export type SkillFileEncoding = "utf8" | "base64";

export interface SkillFileRecord {
  path: string;
  content: string;
  encoding: SkillFileEncoding;
  size: number;
}

export interface SkillFileInput {
  path?: unknown;
  content?: unknown;
  encoding?: unknown;
}

export class SkillFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillFileError";
  }
}

const FORBIDDEN_SEGMENT_CHARS = new Set(["<", ">", ":", '"', "|", "?", "*"]);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function basenameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** SKILL.md 本身由 instructions 字段承载，不能作为附带文件重复存一份。 */
export function isSkillEntryPoint(path: string): boolean {
  return /^skill\.(md|markdown|txt)$/i.test(basenameOf(path));
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * 归一化技能目录内的相对路径：统一分隔符、去掉前缀 ./、拒绝绝对路径与 .. 逃逸。
 * 不做大小写折叠，展示时保留用户写的大小写。
 */
export function normalizeSkillFilePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SkillFileError("附带文件路径不能为空");
  }
  const slashed = raw.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
    throw new SkillFileError(`附带文件必须位于技能目录内：${raw}`);
  }
  if (slashed.length > MAX_SKILL_FILE_PATH_CHARS) {
    throw new SkillFileError(
      `附带文件路径过长（${slashed.length} 字符），上限 ${MAX_SKILL_FILE_PATH_CHARS} 字符`,
    );
  }
  if (hasControlChar(slashed)) throw new SkillFileError("附带文件路径含控制字符");
  const segments = slashed.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new SkillFileError(`附带文件路径无效：${raw}`);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new SkillFileError(`附带文件路径不能跳出技能目录：${raw}`);
    }
    for (const char of segment) {
      if (FORBIDDEN_SEGMENT_CHARS.has(char)) {
        throw new SkillFileError(`附带文件路径不能包含 ${char}：${raw}`);
      }
    }
  }
  const normalized = segments.join("/");
  if (isSkillEntryPoint(normalized)) {
    throw new SkillFileError("SKILL.md 是技能说明本身，请在技能说明里编辑，不要作为附带文件");
  }
  return normalized;
}

export function normalizeSkillFile(raw: SkillFileInput | null | undefined): SkillFileRecord {
  const path = normalizeSkillFilePath(raw?.["path"]);
  const content = raw?.["content"];
  if (typeof content !== "string") {
    throw new SkillFileError(`附带文件 ${path} 缺少内容`);
  }
  const requested = raw?.["encoding"];
  if (requested !== undefined && requested !== "utf8" && requested !== "base64") {
    throw new SkillFileError(`附带文件 ${path} 的编码只能是 utf8 或 base64`);
  }
  const encoding: SkillFileEncoding = requested === "base64" ? "base64" : "utf8";
  if (encoding === "utf8" && content.includes("\0")) {
    throw new SkillFileError(`附带文件 ${path} 是二进制内容，请用 base64 上传`);
  }
  if (encoding === "base64") {
    const compact = content.replace(/\s/g, "");
    if (!compact || !BASE64_RE.test(compact)) {
      throw new SkillFileError(`附带文件 ${path} 不是合法的 base64`);
    }
  }
  const size = Buffer.byteLength(encoding === "base64" ? content.replace(/\s/g, "") : content, encoding);
  if (size > MAX_SKILL_FILE_BYTES) {
    throw new SkillFileError(
      `附带文件 ${path} 有 ${size} 字节，超过单个文件上限 ${MAX_SKILL_FILE_BYTES / 1024} KB`,
    );
  }
  return { path, content: encoding === "base64" ? content.replace(/\s/g, "") : content, encoding, size };
}

/** 校验并去重（大小写不敏感）整个附带文件集合，同时把总量压进预算。 */
export function normalizeSkillFiles(raw: unknown): SkillFileRecord[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SkillFileError("附带文件必须是一个数组");
  if (raw.length > MAX_SKILL_FILES) {
    throw new SkillFileError(`一个技能最多 ${MAX_SKILL_FILES} 个附带文件，当前 ${raw.length} 个`);
  }
  const byKey = new Map<string, SkillFileRecord>();
  for (const entry of raw as (SkillFileInput | null | undefined)[]) {
    const file = normalizeSkillFile(entry);
    const key = file.path.toLowerCase();
    const clash = byKey.get(key);
    if (clash) throw new SkillFileError(`附带文件路径重复：${clash.path} 与 ${file.path}`);
    byKey.set(key, file);
  }
  const files = [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_SKILL_BUNDLE_BYTES) {
    throw new SkillFileError(
      `附带文件合计 ${(total / 1024 / 1024).toFixed(1)} MB，超过单个技能 ${MAX_SKILL_BUNDLE_BYTES / 1024 / 1024} MB 上限`,
    );
  }
  return files;
}

export function formatSkillFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

