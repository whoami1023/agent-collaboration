import { readFile } from "node:fs/promises";
import { newId } from "../core/ids";
import type { PublicUser } from "../core/types";
import { writeJsonAtomic } from "../store/persist";
import { BUILTIN_SHARED_SKILLS, BUILTIN_SKILLS_VERSION } from "./builtin";
import {
  builtinCategoryOf,
  inferSkillCategory,
  normalizeSkillCategory,
  type SkillCategory,
} from "./categories";
import {
  formatSkillFileSize,
  isSkillEntryPoint,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILES,
  normalizeSkillFile,
  normalizeSkillFilePath,
  normalizeSkillFiles,
  SkillFileError,
  type SkillFileRecord,
} from "./skill-files";
import { parseSkillMarkdown, skillNameFromFile, SkillMarkdownError } from "./skill-md";

export type SkillScope = "shared" | "personal";
export type { SkillFileRecord } from "./skill-files";

export interface SkillRecord {
  id: string;
  scope: SkillScope;
  ownerId: string | null;
  name: string;
  description: string;
  instructions: string;
  /** 技能分类；缺失时内置技能按名称归类，其余归入「其他」。 */
  category?: SkillCategory;
  /** 技能目录里除 SKILL.md 之外的文件：脚本、参考资料、模板等。 */
  files?: SkillFileRecord[];
  builtin?: boolean;
  imported?: boolean;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  scope: SkillScope;
}

export interface SkillInput {
  scope?: unknown;
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  category?: unknown;
  files?: unknown;
}

export interface SkillImportFile {
  filename?: unknown;
  content?: unknown;
  encoding?: unknown;
}

export interface SkillImportInput {
  scope?: unknown;
  overwrite?: unknown;
  files?: unknown;
}

export interface SkillImportResult {
  filename: string;
  ok: boolean;
  action?: "created" | "updated";
  skill?: SkillRecord;
  error?: string;
  warnings?: string[];
}

export interface SkillLibraryOptions {
  seedShared?: boolean;
  now?: () => number;
}

interface SkillData {
  skills: SkillRecord[];
  removedBuiltins?: string[];
  builtinVersion?: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DESCRIPTION_MAX = 160;
const INSTRUCTIONS_MAX = 20000;
const MAX_SKILLS = 500;
/** 一次导入最多 20 个技能目录；目录里的附带文件单独计数，最多 200 项。 */
const MAX_IMPORT_SKILLS = 20;
const MAX_IMPORT_ENTRIES = 200;
const MAX_FILENAME_CHARS = 240;
/** 压缩包/系统垃圾：这些不该变成技能的附带文件。 */
const IGNORED_IMPORT_PATHS = /(^|\/)(?:__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\/\.)/i;


export class SkillError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

function normalizeScope(raw: unknown): SkillScope {
  if (raw === undefined || raw === "personal") return "personal";
  if (raw === "shared") return "shared";
  throw new SkillError(400, "技能范围只能是 shared 或 personal");
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SkillError(400, "技能名称不能为空");
  const name = raw.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new SkillError(400, "技能名称需为小写字母、数字或短横线，最长 48 位");
  }
  return name;
}

function normalizeDescription(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SkillError(400, "技能描述不能为空");
  }
  const description = raw.trim();
  if (description.length > DESCRIPTION_MAX) {
    throw new SkillError(400, `技能描述不能超过 ${DESCRIPTION_MAX} 个字符`);
  }
  return description;
}

function normalizeInstructions(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SkillError(400, "技能说明不能为空");
  }
  const instructions = raw.trim();
  if (instructions.length > INSTRUCTIONS_MAX) {
    throw new SkillError(400, `技能说明不能超过 ${INSTRUCTIONS_MAX} 个字符`);
  }
  return instructions;
}

function normalizeCategoryInput(raw: unknown): SkillCategory {
  const category = normalizeSkillCategory(raw);
  if (!category) {
    throw new SkillError(400, "技能分类无效，请使用技能库提供的分类");
  }
  return category;
}

function byName(a: SkillRecord, b: SkillRecord): number {
  return a.name.localeCompare(b.name);
}

function importFilenameOf(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "SKILL.md";
  const slashed = raw.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!slashed) return "SKILL.md";
  return slashed.length > MAX_FILENAME_CHARS ? `…/${slashed.slice(-MAX_FILENAME_CHARS)}` : slashed;
}

/** 技能目录：SKILL.md 所在的相对目录，根目录用空串表示。 */
function importRootOf(filename: string): string {
  const index = filename.lastIndexOf("/");
  return index === -1 ? "" : filename.slice(0, index);
}

function stripRoot(filename: string, root: string): string {
  if (!root) return filename;
  return filename.startsWith(`${root}/`) ? filename.slice(root.length + 1) : filename;
}

function fitsRoot(filename: string, root: string): boolean {
  return !root || filename.startsWith(`${root}/`);
}

function normalizeFilesInput(raw: unknown): SkillFileRecord[] {
  try {
    return normalizeSkillFiles(raw);
  } catch (err) {
    throw new SkillError(400, err instanceof Error ? err.message : String(err));
  }
}

/** 附带文件按路径排序后，同目录的文件相邻，列表里读起来才像一棵目录树。 */
function sortFiles(files: SkillFileRecord[]): SkillFileRecord[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

interface ImportEntry {
  filename: string;
  content: unknown;
  encoding?: unknown;
}

interface ImportGroup {
  filename: string;
  content: unknown;
  root: string;
  files: ImportEntry[];
}

/**
 * 一个坏文件不该毁掉整个技能：路径非法、超预算的逐个跳过并写进警告，
 * 剩下的照常导入（OpenClaw 的 skip-with-diagnostic 思路）。
 */
function collectBundleFiles(entries: ImportEntry[], warnings: string[]): SkillFileRecord[] {
  const files: SkillFileRecord[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    let file: SkillFileRecord;
    try {
      file = normalizeSkillFile({
        path: entry.filename,
        content: typeof entry.content === "string" ? entry.content : "",
        encoding: entry.encoding,
      });
    } catch (err) {
      warnings.push(`已跳过 ${entry.filename}：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`已跳过重复的附带文件：${file.path}`);
      continue;
    }
    if (files.length >= MAX_SKILL_FILES) {
      warnings.push(`附带文件超过 ${MAX_SKILL_FILES} 个，${file.path} 及之后的文件已跳过。`);
      break;
    }
    if (total + file.size > MAX_SKILL_BUNDLE_BYTES) {
      warnings.push(
        `附带文件合计接近 ${MAX_SKILL_BUNDLE_BYTES / 1024 / 1024} MB 上限，${file.path}（${formatSkillFileSize(file.size)}）已跳过。`,
      );
      continue;
    }
    seen.add(key);
    total += file.size;
    files.push(file);
  }
  return files;
}

function bundlePreview(files: SkillFileRecord[]): string {
  const shown = files.slice(0, 4).map((file) => file.path).join("、");
  return files.length > 4 ? `${shown} 等 ${files.length} 个` : shown;
}



/** 导入的 SKILL.md 常超出我们的字段上限：截断并提示，好过整条技能被拒。 */
function fitImportedField(value: string, max: number, label: string, warnings: string[]): string {
  if (value.length <= max) return value;
  warnings.push(`${label}过长（${value.length} 字符），已截断到 ${max} 字符。`);
  return value.slice(0, max);
}

/** SKILL.md 的 name 写法五花八门（`PDF Forms`、`pdf_forms`），统一转成小写短横线 slug。 */
function importedName(raw: string, warnings: string[]): string {
  try {
    return normalizeName(raw);
  } catch {
    const slugged = skillNameFromFile(raw);
    if (!slugged) throw new SkillError(400, `技能名称无法转成小写短横线格式：${raw}`);
    if (slugged.length > 48) throw new SkillError(400, `技能名称过长：${slugged}`);
    warnings.push(`技能名称已规范化为 ${slugged}。`);
    return slugged;
  }
}

export class SkillLibrary {
  private data: SkillData = { skills: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly seedShared: boolean;

  constructor(
    private readonly file: string,
    options: SkillLibraryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.seedShared = options.seedShared ?? true;
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<SkillData>;
      this.data = {
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        removedBuiltins: Array.isArray(raw.removedBuiltins)
          ? raw.removedBuiltins.filter((name): name is string => typeof name === "string")
          : [],
        ...(typeof raw.builtinVersion === "number" ? { builtinVersion: raw.builtinVersion } : {}),
      };
      if (this.installBuiltins()) await this.persist();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = { skills: [], removedBuiltins: [], builtinVersion: 0 };
      this.installBuiltins();
      await this.persist();
    }
  }

  private installBuiltins(): boolean {
    if (!this.seedShared) return false;
    const byName = new Map(
      this.data.skills
        .filter((skill) => skill.scope === "shared")
        .map((skill) => [skill.name, skill] as const),
    );
    const removed = new Set(this.data.removedBuiltins ?? []);
    const now = this.now();
    const migrate = (this.data.builtinVersion ?? 0) < BUILTIN_SKILLS_VERSION;
    let changed = false;
    for (const seed of BUILTIN_SHARED_SKILLS) {
      if (removed.has(seed.name)) continue;
      const existing = byName.get(seed.name);
      if (!existing) {
        this.data.skills.push({
          id: newId("sk"),
          scope: "shared",
          ownerId: null,
          name: seed.name,
          description: seed.description,
          instructions: seed.instructions,
          category: builtinCategoryOf(seed.name),
          builtin: true,
          source: seed.source,
          createdAt: now,
          updatedAt: now,
        });
        changed = true;
        continue;
      }
      // 版本升级时刷新内置记录；管理员自建的同名技能保持原样。
      if (migrate && existing.builtin) {
        existing.description = seed.description;
        existing.instructions = seed.instructions;
        existing.source = seed.source;
        existing.category = builtinCategoryOf(seed.name);
        existing.updatedAt = now;
        changed = true;
      } else if (existing.builtin && !existing.category) {
        // 老数据没有分类字段：无需等版本升级，启动时补齐。
        existing.category = builtinCategoryOf(seed.name);
        changed = true;
      }
    }
    if (migrate) {
      this.data.builtinVersion = BUILTIN_SKILLS_VERSION;
      changed = true;
    }
    return changed;
  }

  listShared(): SkillRecord[] {
    return this.data.skills.filter((skill) => skill.scope === "shared").sort(byName);
  }

  listPersonal(ownerId: string): SkillRecord[] {
    return this.data.skills
      .filter((skill) => skill.scope === "personal" && skill.ownerId === ownerId)
      .sort(byName);
  }

  listForAgent(userId: string): SkillRecord[] {
    return [...this.listShared(), ...this.listPersonal(userId)];
  }

  readForAgent(userId: string, rawName: unknown): SkillRecord | undefined {
    if (typeof rawName !== "string") return undefined;
    const name = rawName.trim().replace(/^[$/]+/, "").toLowerCase();
    if (!name) return undefined;
    return this.listForAgent(userId).find((skill) => skill.name === name);
  }

  /** 按路径取技能目录里的附带文件；路径大小写不敏感，与磁盘目录一致。 */
  readSkillFile(
    userId: string,
    rawName: unknown,
    rawPath: unknown,
  ): { skill: SkillRecord; file: SkillFileRecord } | undefined {
    const skill = this.readForAgent(userId, rawName);
    if (!skill?.files?.length) return undefined;
    if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
    let path: string;
    try {
      path = normalizeSkillFilePath(rawPath);
    } catch {
      return undefined;
    }
    const key = path.toLowerCase();
    const file = skill.files.find((candidate) => candidate.path.toLowerCase() === key);
    return file ? { skill, file } : undefined;
  }

  /** 接口层按技能 id 取附带文件正文：共享技能任何登录用户可读，个人技能仅属主可读。 */
  readFile(user: PublicUser, id: string, rawPath: unknown): SkillFileRecord {
    const record = this.find(id);
    if (record.scope === "personal" && record.ownerId !== user.id) {
      throw new SkillError(403, "只能读取自己的个人技能文件");
    }
    const files = record.files ?? [];
    if (files.length === 0) throw new SkillError(404, "该技能没有附带文件");
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new SkillError(400, "附带文件路径不能为空");
    }
    let path: string;
    try {
      path = normalizeSkillFilePath(rawPath);
    } catch (err) {
      throw new SkillError(400, err instanceof SkillFileError ? err.message : "附带文件路径无效");
    }
    const key = path.toLowerCase();
    const file = files.find((candidate) => candidate.path.toLowerCase() === key);
    if (!file) throw new SkillError(404, "技能里没有这个文件");
    return file;
  }

  async create(user: PublicUser, input: SkillInput): Promise<SkillRecord> {
    return this.mutate(async () => {
      const scope = normalizeScope(input.scope);
      if (scope === "shared" && user.role !== "admin") {
        throw new SkillError(403, "只有管理员可以新建共享技能");
      }
      if (this.data.skills.length >= MAX_SKILLS) {
        throw new SkillError(400, `技能总数不能超过 ${MAX_SKILLS} 个`);
      }
      const name = normalizeName(input.name);
      const description = normalizeDescription(input.description);
      const instructions = normalizeInstructions(input.instructions);
      const category =
        input.category === undefined ? undefined : normalizeCategoryInput(input.category);
      const files = normalizeFilesInput(input.files);
      const ownerId = user.id;
      this.assertNameFree(name, scope, ownerId, null);
      const now = this.now();
      const record: SkillRecord = {
        id: newId("sk"),
        scope,
        ownerId,
        name,
        description,
        instructions,
        ...(category ? { category } : {}),
        ...(files.length > 0 ? { files: sortFiles(files) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      this.data.skills.push(record);
      await this.persist();
      return record;
    });
  }

  async update(user: PublicUser, id: string, input: SkillInput): Promise<SkillRecord> {
    return this.mutate(async () => {
      const record = this.find(id);
      this.assertCanManage(user, record);
      const name = input.name === undefined ? record.name : normalizeName(input.name);
      const description =
        input.description === undefined
          ? record.description
          : normalizeDescription(input.description);
      const instructions =
        input.instructions === undefined
          ? record.instructions
          : normalizeInstructions(input.instructions);
      const category =
        input.category === undefined ? record.category : normalizeCategoryInput(input.category);
      if (record.builtin && name !== record.name) {
        throw new SkillError(400, "内置技能不能改名，可以修改描述和说明");
      }
      if (name !== record.name) {
        this.assertNameFree(name, record.scope, record.ownerId, record.id);
      }
      const files = input.files === undefined ? record.files : normalizeFilesInput(input.files);
      record.name = name;
      record.description = description;
      record.instructions = instructions;
      if (category) record.category = category;
      else delete record.category;
      if (files && files.length > 0) record.files = sortFiles(files);
      else delete record.files;
      record.updatedAt = this.now();
      await this.persist();
      return record;
    });
  }

  async remove(user: PublicUser, id: string): Promise<void> {
    await this.mutate(async () => {
      const record = this.find(id);
      this.assertCanManage(user, record);
      this.data.skills = this.data.skills.filter((skill) => skill.id !== record.id);
      if (record.builtin) {
        const removed = new Set(this.data.removedBuiltins ?? []);
        removed.add(record.name);
        this.data.removedBuiltins = [...removed];
      }
      await this.persist();
    });
  }

  async importMany(user: PublicUser, input: SkillImportInput): Promise<SkillImportResult[]> {
    return this.mutate(async () => {
      const scope = normalizeScope(input.scope);
      if (scope === "shared" && user.role !== "admin") {
        throw new SkillError(403, "只有管理员可以导入共享技能");
      }
      const overwrite = input.overwrite === true;
      const rawEntries = Array.isArray(input.files) ? input.files : null;
      if (!rawEntries || rawEntries.length === 0) {
        throw new SkillError(400, "请选择或粘贴至少一份 SKILL.md");
      }
      if (rawEntries.length > MAX_IMPORT_ENTRIES) {
        throw new SkillError(
          400,
          `单次导入最多 ${MAX_IMPORT_ENTRIES} 个文件（含脚本等附带文件），请分批发起导入`,
        );
      }
      const ownerId = user.id;
      const results: SkillImportResult[] = [];

      const entries: ImportEntry[] = [];
      for (const raw of rawEntries) {
        const entry = raw as SkillImportFile | null;
        const filename = importFilenameOf(entry?.["filename"]);
        if (IGNORED_IMPORT_PATHS.test(filename)) continue;
        entries.push({
          filename,
          content: entry?.["content"],
          encoding: entry?.["encoding"],
        });
      }
      const entryFiles = entries.filter((entry) => isSkillEntryPoint(entry.filename));
      if (entryFiles.length === 0 && entries.length > 1) {
        throw new SkillError(
          400,
          "没找到 SKILL.md：请选择技能目录本身，或至少选中一份 SKILL.md",
        );
      }
      if (entryFiles.length > MAX_IMPORT_SKILLS) {
        throw new SkillError(400, `单次最多导入 ${MAX_IMPORT_SKILLS} 个技能`);
      }

      // 只给一份文件时不苛求文件名：它整份就是技能说明（兼容粘贴与改名后的 md）。
      const entriesAsGroups = entries.length === 1 ? entries : entryFiles;
      const entryPaths = new Set(entriesAsGroups.map((entry) => entry.filename));
      const groups: ImportGroup[] = entriesAsGroups.map((entry) => ({
        filename: entry.filename,
        content: entry.content,
        root: importRootOf(entry.filename),
        files: [],
      }));
      // 目录越长越具体：`pdf/forms/SKILL.md` 下的脚本不该被根目录的 SKILL.md 抢走。
      const bySpecificity = [...groups].sort((a, b) => b.root.length - a.root.length);
      for (const entry of entries) {
        if (entryPaths.has(entry.filename)) continue;
        const group = bySpecificity.find((candidate) => fitsRoot(entry.filename, candidate.root));
        if (group) {
          group.files.push({ ...entry, filename: stripRoot(entry.filename, group.root) });
        } else if (groups.length === 1 && groups[0]) {
          groups[0].files.push(entry);
        } else {
          results.push({
            filename: entry.filename,
            ok: false,
            error: "附近没有 SKILL.md，无法判断它属于哪个技能",
          });
        }
      }

      let changed = false;
      for (const group of groups) {
        const filename = group.filename;
        if (typeof group.content !== "string" || !group.content.trim()) {
          results.push({ filename, ok: false, error: "SKILL.md 内容为空" });
          continue;
        }
        try {
          const parsed = parseSkillMarkdown(group.content, { filename });
          const warnings = [...parsed.warnings];
          const name = importedName(parsed.name, warnings);
          const description = fitImportedField(
            parsed.description,
            DESCRIPTION_MAX,
            "技能描述",
            warnings,
          );
          const instructions = fitImportedField(
            parsed.instructions,
            INSTRUCTIONS_MAX,
            "技能说明",
            warnings,
          );
          const files = collectBundleFiles(group.files, warnings);
          if (files.length > 0) {
            warnings.push(`附带 ${files.length} 个文件：${bundlePreview(files)}`);
          }
          const declaredCategory = normalizeSkillCategory(parsed.category);
          if (parsed.category && !declaredCategory) {
            warnings.push(`无法识别分类「${parsed.category}」，已按名称与描述归类。`);
          }
          const source = `导入自 ${filename}`;
          const existing = this.data.skills.find(
            (skill) => skill.scope === scope && skill.ownerId === ownerId && skill.name === name,
          );
          if (existing) {
            if (!overwrite) {
              results.push({
                filename,
                ok: false,
                error: "已有同名技能，勾选「覆盖」才能更新",
                warnings,
              });
              continue;
            }
            existing.description = description;
            existing.instructions = instructions;
            existing.category =
              declaredCategory ?? existing.category ?? inferSkillCategory(name, description);
            existing.source = source;
            existing.imported = true;
            if (files.length > 0) existing.files = sortFiles(files);
            else if (existing.files?.length) {
              warnings.push(
                `本次没有附带文件，原有 ${existing.files.length} 个附带文件保持不变。`,
              );
            }
            existing.updatedAt = this.now();
            changed = true;
            results.push({ filename, ok: true, action: "updated", skill: existing, warnings });
            continue;
          }
          if (this.data.skills.length >= MAX_SKILLS) {
            results.push({ filename, ok: false, error: `技能总数不能超过 ${MAX_SKILLS} 个` });
            continue;
          }
          const now = this.now();
          const record: SkillRecord = {
            id: newId("sk"),
            scope,
            ownerId,
            name,
            description,
            instructions,
            category: declaredCategory ?? inferSkillCategory(name, description),
            ...(files.length > 0 ? { files: sortFiles(files) } : {}),
            imported: true,
            source,
            createdAt: now,
            updatedAt: now,
          };
          this.data.skills.push(record);
          changed = true;
          results.push({ filename, ok: true, action: "created", skill: record, warnings });
        } catch (err) {
          results.push({
            filename,
            ok: false,
            error:
              err instanceof SkillError ||
              err instanceof SkillMarkdownError ||
              err instanceof SkillFileError
                ? err.message
                : `SKILL.md 解析失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (changed) await this.persist();
      return results;
    });
  }

  private find(id: string): SkillRecord {
    const record = this.data.skills.find((skill) => skill.id === id);
    if (!record) throw new SkillError(404, "技能不存在");
    return record;
  }

  private assertCanManage(user: PublicUser, record: SkillRecord): void {
    if (record.scope === "shared") {
      if (user.role !== "admin") throw new SkillError(403, "只有管理员可以管理共享技能");
      return;
    }
    if (record.ownerId !== user.id) throw new SkillError(403, "只能管理自己的个人技能");
  }

  private assertNameFree(
    name: string,
    scope: SkillScope,
    ownerId: string | null,
    excludeId: string | null,
  ): void {
    const clash = this.data.skills.some(
      (skill) =>
        skill.id !== excludeId &&
        skill.scope === scope &&
        skill.ownerId === ownerId &&
        skill.name === name,
    );
    if (clash) {
      throw new SkillError(
        409,
        scope === "shared" ? "共享库中已有同名技能" : "你的个人库中已有同名技能",
      );
    }
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.data);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
