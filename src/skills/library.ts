import { readFile } from "node:fs/promises";
import { newId } from "../core/ids";
import type { PublicUser } from "../core/types";
import { writeJsonAtomic } from "../store/persist";
import { BUILTIN_SHARED_SKILLS } from "./builtin";

export type SkillScope = "shared" | "personal";

export interface SkillRecord {
  id: string;
  scope: SkillScope;
  ownerId: string | null;
  name: string;
  description: string;
  instructions: string;
  builtin?: boolean;
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
}

export interface SkillLibraryOptions {
  seedShared?: boolean;
  now?: () => number;
}

interface SkillData {
  skills: SkillRecord[];
  removedBuiltins?: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DESCRIPTION_MAX = 160;
const INSTRUCTIONS_MAX = 20000;
const MAX_SKILLS = 500;

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

function byName(a: SkillRecord, b: SkillRecord): number {
  return a.name.localeCompare(b.name);
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
      };
      if (this.installBuiltins()) await this.persist();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = { skills: [], removedBuiltins: [] };
      this.installBuiltins();
      await this.persist();
    }
  }

  private installBuiltins(): boolean {
    if (!this.seedShared) return false;
    const existing = new Set(
      this.data.skills.filter((skill) => skill.scope === "shared").map((skill) => skill.name),
    );
    const removed = new Set(this.data.removedBuiltins ?? []);
    const now = this.now();
    let added = false;
    for (const seed of BUILTIN_SHARED_SKILLS) {
      if (existing.has(seed.name) || removed.has(seed.name)) continue;
      this.data.skills.push({
        id: newId("sk"),
        scope: "shared",
        ownerId: null,
        name: seed.name,
        description: seed.description,
        instructions: seed.instructions,
        builtin: true,
        source: seed.source,
        createdAt: now,
        updatedAt: now,
      });
      added = true;
    }
    return added;
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
      if (record.builtin && name !== record.name) {
        throw new SkillError(400, "内置技能不能改名，可以修改描述和说明");
      }
      if (name !== record.name) {
        this.assertNameFree(name, record.scope, record.ownerId, record.id);
      }
      record.name = name;
      record.description = description;
      record.instructions = instructions;
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
