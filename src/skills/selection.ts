/**
 * 成员级技能白名单（对应 OpenClaw src/skills/discovery/agent-filter.ts + filter.ts，
 * MIT License, Copyright (c) 2026 OpenClaw Foundation）。
 * 语义与上游一致：undefined 表示未配置（跟随全部可用技能），数组表示完整允许列表
 * （空数组即全部禁用）；大小写不敏感，去重后比较。
 */

export class SkillSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillSelectionError";
  }
}

export function normalizeSkillFilter(
  filter?: readonly string[] | null,
): string[] | undefined {
  if (filter === undefined || filter === null) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of filter) {
    const name = entry.trim().toLowerCase();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function isSkillSelected(
  filter: readonly string[] | undefined,
  skillName: string,
): boolean {
  return filter === undefined || filter.includes(skillName.toLowerCase());
}

export function selectSkillsForMember<T extends { name: string }>(
  skills: readonly T[],
  filter?: readonly string[] | null,
): T[] {
  const normalized = normalizeSkillFilter(filter);
  if (normalized === undefined) return [...skills];
  const allowed = new Set(normalized);
  return skills.filter((skill) => allowed.has(skill.name.toLowerCase()));
}

/**
 * 接口层校验：客户端传 null/undefined 表示恢复为「全部」；
 * 数组里出现用户用不了的技能名时整体拒绝，避免保存一个含无效项的配置。
 */
export function resolveSkillSelection(
  raw: unknown,
  available: readonly string[],
): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SkillSelectionError("names 必须是技能名数组，或 null 表示全部启用");
  }
  const known = new Set(available.map((name) => name.toLowerCase()));
  const unknown: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new SkillSelectionError("names 里的每一项都必须是技能名");
    }
    const name = entry.trim().toLowerCase();
    if (name && !known.has(name)) unknown.push(name);
  }
  if (unknown.length > 0) {
    throw new SkillSelectionError(`这些技能不在该账号的可用技能里：${unknown.join("、")}`);
  }
  return normalizeSkillFilter(raw as string[]);
}
