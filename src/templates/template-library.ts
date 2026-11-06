import { readFile } from "node:fs/promises";
import { newId } from "../core/ids";
import type { PublicUser } from "../core/types";
import { scanThreats, threatWarning } from "../agent/content/threats";
import {
  DEFAULT_SKILL_CATEGORY,
  normalizeSkillCategory,
  type SkillCategory,
} from "../skills/categories";
import { writeJsonAtomic } from "../store/persist";
import {
  BUILTIN_AGENT_TEMPLATES,
  BUILTIN_TEMPLATES_VERSION,
  BUILTIN_TEMPLATE_SOURCE,
  type AgentTemplateSeed,
} from "./agent-templates";

export type TemplateScope = "builtin" | "personal";

/** 一个智能体模板：引用它即可生成一个成员（角色、工作方式、可用技能一起带过去）。 */
export interface AgentTemplateRecord {
  id: string;
  /** 小写短横线的稳定标识；内置模板用它做版本迁移，个人模板用于展示与去重。 */
  key: string;
  scope: TemplateScope;
  ownerId: string | null;
  title: string;
  category: SkillCategory;
  description: string;
  /** 引用时建议的成员名。 */
  suggestedName: string;
  brief: string;
  emoji?: string;
  vibe?: string;
  workstyle?: string[];
  /** 建议的技能白名单；引用为成员时会过滤掉该用户当前不可用的技能。 */
  skillNames?: string[];
  builtin?: boolean;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTemplateInput {
  key?: unknown;
  title?: unknown;
  category?: unknown;
  description?: unknown;
  suggestedName?: unknown;
  brief?: unknown;
  emoji?: unknown;
  vibe?: unknown;
  workstyle?: unknown;
  skillNames?: unknown;
}

/** 个人模板导出文件的格式标记；导入时带了这个标记就按导出文件严格校验版本。 */
export const TEMPLATE_EXPORT_FORMAT = "agent-collaboration/template";
export const TEMPLATE_EXPORT_VERSION = 1;

/** 导出的模板只带可迁移的设定字段，不带 id、归属与时间戳。 */
export interface TemplateExportPayload {
  key: string;
  title: string;
  category: SkillCategory;
  description: string;
  suggestedName: string;
  brief: string;
  emoji?: string;
  vibe?: string;
  workstyle?: string[];
  skillNames?: string[];
}

export interface TemplateExportDocument {
  format: typeof TEMPLATE_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  template: TemplateExportPayload;
}

export interface TemplateImportFile {
  filename?: unknown;
  content?: unknown;
}

export interface TemplateImportResult {
  filename: string;
  /** 至少成功创建一个模板；部分失败时 errors 里逐条说明。 */
  ok: boolean;
  created: AgentTemplateRecord[];
  errors: string[];
  warnings: string[];
}

/** 模板里最终会变成成员档案的文字：只有这些字段会被模型长期读到。 */
function templateCorpus(record: AgentTemplateRecord): string {
  return [
    record.title,
    record.description,
    record.brief,
    record.vibe ?? "",
    ...(record.workstyle ?? []),
  ].join("\n");
}

export interface TemplateLibraryOptions {
  seedBuiltins?: boolean;
  now?: () => number;
}

interface TemplateData {
  templates: AgentTemplateRecord[];
  removedBuiltins?: string[];
  builtinVersion?: number;
}

export class TemplateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TITLE_MAX = 40;
const DESCRIPTION_MAX = 160;
const BRIEF_MAX = 800;
const NAME_MAX = 12;
const EMOJI_MAX = 8;
const VIBE_MAX = 40;
const MAX_WORKSTYLE = 8;
const WORKSTYLE_MAX = 200;
const MAX_SKILL_NAMES = 60;
const MAX_TEMPLATES = 400;
/** 导入与技能库同一套口径：一次最多 20 个文件、50 个模板，单文件 512 KB。 */
const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_TEMPLATES = 50;
const MAX_IMPORT_FILE_CHARS = 512 * 1024;
const IMPORT_FILENAME_MAX = 240;

/** 字段上限的对外视图：成员导出草稿与前端表单都按同一套值校验。 */
export const TEMPLATE_LIMITS = {
  title: TITLE_MAX,
  description: DESCRIPTION_MAX,
  brief: BRIEF_MAX,
  suggestedName: NAME_MAX,
  emoji: EMOJI_MAX,
  vibe: VIBE_MAX,
  workstyle: MAX_WORKSTYLE,
  workstyleLine: WORKSTYLE_MAX,
  skillNames: MAX_SKILL_NAMES,
} as const;

function normalizeKey(raw: unknown, fallback: string): string {
  if (raw !== undefined && raw !== null && raw !== "") {
    if (typeof raw !== "string") throw new TemplateError(400, "模板标识必须是字符串");
    const key = raw.trim().toLowerCase();
    if (!KEY_RE.test(key)) {
      throw new TemplateError(400, "模板标识需为小写字母、数字或短横线，最长 48 位");
    }
    return key;
  }
  // 未填标识：从标题生成；纯中文标题取不到 ASCII 时用 template 兜底。
  return slugify(fallback) || "template";
}

/** 个人模板可以不填标识：从标题生成，中文取不到就退化成 template-<随机>。 */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function normalizeText(raw: unknown, label: string, max: number, required: boolean): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (required) throw new TemplateError(400, `${label}不能为空`);
    return "";
  }
  if (value.length > max) throw new TemplateError(400, `${label}最多 ${max} 字`);
  return value;
}

function normalizeCategory(raw: unknown): SkillCategory {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SKILL_CATEGORY;
  const category = normalizeSkillCategory(raw);
  if (!category) throw new TemplateError(400, `无法识别的模板分类：${String(raw)}`);
  return category;
}

function normalizeWorkstyle(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TemplateError(400, "工作方式必须是字符串数组");
  if (raw.length > MAX_WORKSTYLE) {
    throw new TemplateError(400, `工作方式最多 ${MAX_WORKSTYLE} 条`);
  }
  const lines: string[] = [];
  for (const item of raw) {
    const line = normalizeText(item, "工作方式条目", WORKSTYLE_MAX, true);
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

function normalizeSkillNames(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TemplateError(400, "技能清单必须是技能名数组");
  if (raw.length > MAX_SKILL_NAMES) {
    throw new TemplateError(400, `一个模板最多引用 ${MAX_SKILL_NAMES} 个技能`);
  }
  const names: string[] = [];
  for (const item of raw) {
    const name = normalizeText(item, "技能名", 48, true).toLowerCase().replace(/^[$/]+/, "");
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function seedRecord(seed: AgentTemplateSeed, now: number): AgentTemplateRecord {
  return {
    id: newId("tpl"),
    key: seed.key,
    scope: "builtin",
    ownerId: null,
    title: seed.title,
    category: seed.category,
    description: seed.description,
    suggestedName: seed.suggestedName,
    brief: seed.brief,
    emoji: seed.emoji,
    vibe: seed.vibe,
    workstyle: [...seed.workstyle],
    skillNames: [...seed.skillNames],
    builtin: true,
    source: BUILTIN_TEMPLATE_SOURCE,
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exportPayload(record: AgentTemplateRecord): TemplateExportPayload {
  return {
    key: record.key,
    title: record.title,
    category: record.category,
    description: record.description,
    suggestedName: record.suggestedName,
    brief: record.brief,
    ...(record.emoji ? { emoji: record.emoji } : {}),
    ...(record.vibe ? { vibe: record.vibe } : {}),
    ...(record.workstyle?.length ? { workstyle: [...record.workstyle] } : {}),
    ...(record.skillNames?.length ? { skillNames: [...record.skillNames] } : {}),
  };
}

/** 导入文件既接受导出格式，也接受裸对象、裸数组和 { templates: [...] } 批量文件。 */
function documentsFrom(content: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TemplateError(400, "文件不是有效的 JSON");
  }
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) throw new TemplateError(400, "模板文件应为 JSON 对象或数组");
  if (parsed["format"] !== undefined && parsed["format"] !== TEMPLATE_EXPORT_FORMAT) {
    throw new TemplateError(400, "不是本系统的模板导出文件（format 不匹配）");
  }
  if (parsed["version"] !== undefined && parsed["version"] !== TEMPLATE_EXPORT_VERSION) {
    throw new TemplateError(400, `不支持的模板导出格式版本：${String(parsed["version"])}`);
  }
  if (Array.isArray(parsed["templates"])) return parsed["templates"];
  if (parsed["template"] !== undefined) return [parsed["template"]];
  return [parsed];
}

/** 只取模板设定的白名单字段，忽略导出文件里的 id、归属、内置标记等运行时信息。 */
function pickTemplateInput(doc: Record<string, unknown>): AgentTemplateInput {
  return {
    ...(doc["key"] !== undefined ? { key: doc["key"] } : {}),
    title: doc["title"],
    description: doc["description"],
    brief: doc["brief"],
    ...(doc["category"] !== undefined ? { category: doc["category"] } : {}),
    ...(doc["suggestedName"] !== undefined ? { suggestedName: doc["suggestedName"] } : {}),
    ...(doc["emoji"] !== undefined ? { emoji: doc["emoji"] } : {}),
    ...(doc["vibe"] !== undefined ? { vibe: doc["vibe"] } : {}),
    ...(doc["workstyle"] !== undefined ? { workstyle: doc["workstyle"] } : {}),
    ...(doc["skillNames"] !== undefined ? { skillNames: doc["skillNames"] } : {}),
  };
}

/**
 * 智能体模板库：内置模板随系统预装（与技能库同样的版本迁移规则），
 * 个人模板由每个账号自建、只有本人可见。存储为单个 data/templates.json。
 */
export class TemplateLibrary {
  private data: TemplateData = { templates: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly seedBuiltins: boolean;

  constructor(
    private readonly file: string,
    options: TemplateLibraryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.seedBuiltins = options.seedBuiltins ?? true;
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<TemplateData>;
      this.data = {
        templates: Array.isArray(raw.templates) ? raw.templates : [],
        removedBuiltins: Array.isArray(raw.removedBuiltins)
          ? raw.removedBuiltins.filter((key): key is string => typeof key === "string")
          : [],
        ...(typeof raw.builtinVersion === "number" ? { builtinVersion: raw.builtinVersion } : {}),
      };
      if (this.installBuiltins()) await this.persist();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = { templates: [], removedBuiltins: [], builtinVersion: 0 };
      this.installBuiltins();
      await this.persist();
    }
  }

  private installBuiltins(): boolean {
    if (!this.seedBuiltins) return false;
    const byKey = new Map(
      this.data.templates
        .filter((record) => record.scope === "builtin")
        .map((record) => [record.key, record] as const),
    );
    const removed = new Set(this.data.removedBuiltins ?? []);
    const now = this.now();
    const migrate = (this.data.builtinVersion ?? 0) < BUILTIN_TEMPLATES_VERSION;
    let changed = false;
    for (const seed of BUILTIN_AGENT_TEMPLATES) {
      if (removed.has(seed.key)) continue;
      const existing = byKey.get(seed.key);
      if (!existing) {
        this.data.templates.push(seedRecord(seed, now));
        changed = true;
        continue;
      }
      // 版本升级时刷新内置模板正文；用户自建的同 key 模板保持原样。
      if (migrate && existing.builtin) {
        Object.assign(existing, {
          title: seed.title,
          category: seed.category,
          description: seed.description,
          suggestedName: seed.suggestedName,
          brief: seed.brief,
          emoji: seed.emoji,
          vibe: seed.vibe,
          workstyle: [...seed.workstyle],
          skillNames: [...seed.skillNames],
          source: BUILTIN_TEMPLATE_SOURCE,
          updatedAt: now,
        });
        changed = true;
      }
    }
    if (migrate) {
      this.data.builtinVersion = BUILTIN_TEMPLATES_VERSION;
      changed = true;
    }
    return changed;
  }

  listBuiltin(): AgentTemplateRecord[] {
    return this.data.templates.filter((record) => record.scope === "builtin").sort(byTitle);
  }

  listPersonal(ownerId: string): AgentTemplateRecord[] {
    return this.data.templates
      .filter((record) => record.scope === "personal" && record.ownerId === ownerId)
      .sort(byTitle);
  }

  listFor(userId: string): AgentTemplateRecord[] {
    return [...this.listBuiltin(), ...this.listPersonal(userId)];
  }

  /** 接口层按 id 取模板：内置对全部账号可见，个人模板仅属主可见。 */
  getFor(user: PublicUser, id: string): AgentTemplateRecord {
    const record = this.data.templates.find((candidate) => candidate.id === id);
    if (!record) throw new TemplateError(404, "模板不存在");
    if (record.scope === "personal" && record.ownerId !== user.id) {
      throw new TemplateError(403, "只能使用自己的个人模板");
    }
    return record;
  }

  /** 导出个人模板：内置模板不导出，避免把系统预装内容混进个人备份。 */
  exportFor(user: PublicUser, id: string): TemplateExportDocument {
    const record = this.getFor(user, id);
    if (record.scope !== "personal") {
      throw new TemplateError(400, "内置模板随系统预装，只能导出个人模板");
    }
    return {
      format: TEMPLATE_EXPORT_FORMAT,
      version: TEMPLATE_EXPORT_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      template: exportPayload(record),
    };
  }

  /**
   * 导入个人模板。沿用 create 的全部校验与落盘，逐个模板给结果；
   * 标识撞车不中断导入，改为自动加序号并给出提示。
   */
  async importMany(user: PublicUser, input: { files?: unknown }): Promise<TemplateImportResult[]> {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw new TemplateError(400, "请选择要导入的模板 JSON 文件");
    }
    if (input.files.length > MAX_IMPORT_FILES) {
      throw new TemplateError(400, `单次最多导入 ${MAX_IMPORT_FILES} 个文件`);
    }
    const parsedFiles: Array<
      { filename: string; documents: unknown[] } | { filename: string; error: string }
    > = [];
    let total = 0;
    for (const [index, raw] of input.files.entries()) {
      const entry = isRecord(raw) ? raw : {};
      const filename =
        typeof entry["filename"] === "string" && entry["filename"].trim()
          ? entry["filename"].trim().slice(0, IMPORT_FILENAME_MAX)
          : `模板-${index + 1}.json`;
      const content = entry["content"];
      if (typeof content !== "string" || !content.trim()) {
        parsedFiles.push({ filename, error: "文件内容为空" });
        continue;
      }
      if (content.length > MAX_IMPORT_FILE_CHARS) {
        parsedFiles.push({ filename, error: `文件超过 ${MAX_IMPORT_FILE_CHARS / 1024} KB` });
        continue;
      }
      try {
        const documents = documentsFrom(content);
        total += documents.length;
        parsedFiles.push({ filename, documents });
      } catch (err) {
        parsedFiles.push({
          filename,
          error: err instanceof TemplateError ? err.message : "无法解析模板文件",
        });
      }
    }
    if (total > MAX_IMPORT_TEMPLATES) {
      throw new TemplateError(400, `单次最多导入 ${MAX_IMPORT_TEMPLATES} 个模板，请分批导入`);
    }

    const results: TemplateImportResult[] = [];
    for (const item of parsedFiles) {
      if ("error" in item) {
        results.push({
          filename: item.filename,
          ok: false,
          created: [],
          errors: [item.error],
          warnings: [],
        });
        continue;
      }
      if (item.documents.length === 0) {
        results.push({
          filename: item.filename,
          ok: false,
          created: [],
          errors: ["文件里没有模板"],
          warnings: [],
        });
        continue;
      }
      const created: AgentTemplateRecord[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const doc of item.documents) {
        if (!isRecord(doc)) {
          errors.push("模板条目必须是 JSON 对象");
          continue;
        }
        const wantedKey = typeof doc["key"] === "string" ? doc["key"].trim().toLowerCase() : "";
        // 沿用一个合法但已被占用的标识时，保留原名加序号，而不是退化到标题生成的模板标识。
        const conflict =
          wantedKey !== "" && KEY_RE.test(wantedKey) && this.keyTaken(wantedKey, user.id);
        try {
          const record = await this.create(
            user,
            conflict
              ? { ...pickTemplateInput(doc), key: this.freeKey(wantedKey, user.id) }
              : pickTemplateInput(doc),
          );
          created.push(record);
          if (conflict) warnings.push(`标识「${wantedKey}」已被占用，新模板改用「${record.key}」`);
          // 模板会被原样写成成员档案（等于该成员每一轮都要读的指令）。
          // 导入是用户自己发起的，所以只提示不拒收 —— 但要把命中摆在导入结果里。
          const threats = scanThreats(templateCorpus(record), "warn");
          if (threats.length > 0) warnings.push(`${record.title}：${threatWarning(threats)}`);
        } catch (err) {
          const title =
            typeof doc["title"] === "string" && doc["title"].trim()
              ? `「${doc["title"].trim().slice(0, TITLE_MAX)}」`
              : "模板";
          errors.push(`${title}：${err instanceof TemplateError ? err.message : "导入失败"}`);
        }
      }
      results.push({ filename: item.filename, ok: created.length > 0, created, errors, warnings });
    }
    return results;
  }

  async create(user: PublicUser, input: AgentTemplateInput): Promise<AgentTemplateRecord> {
    return this.mutate(async () => {
      if (this.data.templates.length >= MAX_TEMPLATES) {
        throw new TemplateError(400, `模板总数不能超过 ${MAX_TEMPLATES} 个`);
      }
      const title = normalizeText(input.title, "模板名称", TITLE_MAX, true);
      const key = this.resolveKey(user, input, title);
      const emoji = normalizeText(input.emoji, "Emoji", EMOJI_MAX, false);
      const vibe = normalizeText(input.vibe, "气质", VIBE_MAX, false);
      const now = this.now();
      const record: AgentTemplateRecord = {
        id: newId("tpl"),
        key,
        scope: "personal",
        ownerId: user.id,
        title,
        category: normalizeCategory(input.category),
        description: normalizeText(input.description, "模板描述", DESCRIPTION_MAX, true),
        suggestedName: normalizeText(input.suggestedName, "建议成员名", NAME_MAX, false) || title.slice(0, NAME_MAX),
        brief: normalizeText(input.brief, "功能描述", BRIEF_MAX, true),
        ...(emoji ? { emoji } : {}),
        ...(vibe ? { vibe } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const workstyle = normalizeWorkstyle(input.workstyle);
      if (workstyle.length > 0) record.workstyle = workstyle;
      const skillNames = normalizeSkillNames(input.skillNames);
      if (skillNames.length > 0) record.skillNames = skillNames;
      this.data.templates.push(record);
      await this.persist();
      return record;
    });
  }

  async update(user: PublicUser, id: string, input: AgentTemplateInput): Promise<AgentTemplateRecord> {
    return this.mutate(async () => {
      const record = this.getFor(user, id);
      this.assertCanManage(user, record);
      const title =
        input.title === undefined ? record.title : normalizeText(input.title, "模板名称", TITLE_MAX, true);
      if (input.key !== undefined) {
        const key = normalizeKey(input.key, title);
        if (key !== record.key) this.assertKeyFree(key, record.ownerId ?? user.id);
        record.key = key;
      }
      if (input.category !== undefined) record.category = normalizeCategory(input.category);
      if (input.description !== undefined) {
        record.description = normalizeText(input.description, "模板描述", DESCRIPTION_MAX, true);
      }
      if (input.suggestedName !== undefined) {
        record.suggestedName =
          normalizeText(input.suggestedName, "建议成员名", NAME_MAX, false) ||
          title.slice(0, NAME_MAX);
      }
      if (input.brief !== undefined) {
        record.brief = normalizeText(input.brief, "功能描述", BRIEF_MAX, true);
      }
      if (input.emoji !== undefined) {
        const emoji = normalizeText(input.emoji, "Emoji", EMOJI_MAX, false);
        if (emoji) record.emoji = emoji;
        else delete record.emoji;
      }
      if (input.vibe !== undefined) {
        const vibe = normalizeText(input.vibe, "气质", VIBE_MAX, false);
        if (vibe) record.vibe = vibe;
        else delete record.vibe;
      }
      if (input.workstyle !== undefined) {
        const lines = normalizeWorkstyle(input.workstyle);
        if (lines.length > 0) record.workstyle = lines;
        else delete record.workstyle;
      }
      if (input.skillNames !== undefined) {
        const names = normalizeSkillNames(input.skillNames);
        if (names.length > 0) record.skillNames = names;
        else delete record.skillNames;
      }
      record.title = title;
      record.updatedAt = this.now();
      await this.persist();
      return record;
    });
  }

  async remove(user: PublicUser, id: string): Promise<AgentTemplateRecord> {
    return this.mutate(async () => {
      const record = this.getFor(user, id);
      this.assertCanManage(user, record);
      this.data.templates = this.data.templates.filter((candidate) => candidate.id !== record.id);
      if (record.builtin) {
        const removed = new Set(this.data.removedBuiltins ?? []);
        removed.add(record.key);
        this.data.removedBuiltins = [...removed];
      }
      await this.persist();
      return record;
    });
  }

  /** 删号时清掉该账号的个人模板；内置模板不受影响。 */
  async removeOwnedBy(ownerId: string): Promise<number> {
    return this.mutate(async () => {
      const before = this.data.templates.length;
      this.data.templates = this.data.templates.filter(
        (record) => !(record.scope === "personal" && record.ownerId === ownerId),
      );
      const removed = before - this.data.templates.length;
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  private resolveKey(user: PublicUser, input: AgentTemplateInput, title: string): string {
    if (input.key === undefined) return this.freeKey(normalizeKey(undefined, title), user.id);
    const key = normalizeKey(input.key, title);
    this.assertKeyFree(key, user.id);
    return key;
  }

  /** 自动生成的标识撞上本人已有模板时加序号，避免中文标题全都退化成同一个 key。 */
  private freeKey(base: string, ownerId: string): string {
    let candidate = base.slice(0, 44);
    for (let index = 2; this.keyTaken(candidate, ownerId); index += 1) {
      candidate = `${base.slice(0, 44)}-${index}`;
    }
    return candidate;
  }

  private keyTaken(key: string, ownerId: string): boolean {
    return this.data.templates.some(
      (record) => record.key === key && (record.scope === "builtin" || record.ownerId === ownerId),
    );
  }

  private assertCanManage(user: PublicUser, record: AgentTemplateRecord): void {
    if (record.builtin) {
      if (user.role !== "admin") {
        throw new TemplateError(403, "内置模板随系统预装，普通账号只能引用；要改动请先另存为个人模板");
      }
      return;
    }
    if (record.ownerId !== user.id) throw new TemplateError(403, "只能管理自己创建的模板");
  }

  private assertKeyFree(key: string, ownerId: string): void {
    if (this.keyTaken(key, ownerId)) {
      throw new TemplateError(400, `模板标识「${key}」已存在，请换一个`);
    }
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.data);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

function byTitle(a: AgentTemplateRecord, b: AgentTemplateRecord): number {
  return a.title.localeCompare(b.title, "zh-CN");
}
