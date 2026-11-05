// 复盘产出的候选条目在进入记忆或技能库之前要过的三道闸门：格式校验、密钥拦截、与已有条目去重。
// 对应 Hermes 复盘提示词里的 do-not-capture 规则；提示词负责「不该写什么」，这里负责兜底。

import { inferSkillCategory, normalizeSkillCategory, type SkillCategory } from "../../skills/categories";
import { LEARNING_RULES, type LearningProposal, type SkillDraft } from "./types";

/** 疑似密钥与凭据：命中任意一条就整条丢弃，绝不落进记忆文件或技能说明。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /api[_-]?key\s*[:=]/i,
  /secret\s*[:=]\s*\S{6,}/i,
  /password\s*[:=]\s*\S{4,}/i,
  /access[_-]?token\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+:\S+@/m,
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** 去重口径：忽略大小写、标点与空白，只比内容本身。 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[，。、，,.!:：;；"'“”()（）【】\[\]<>《》~-]/g, "");
}

/**
 * 与已有条目「同义重述」的判定：归一化后互相包含，或共享一段 16 字以上的连续片段。
 * 记忆文件是一行一条的策展条目，语料由调用方按条目拆好后传进来。
 */
export function isDuplicateOf(content: string, entries: readonly string[]): boolean {
  const normalized = normalizeForCompare(content);
  if (normalized.length < 8) return false;
  for (const entry of entries) {
    const other = normalizeForCompare(entry);
    if (!other) continue;
    if (other.includes(normalized) || normalized.includes(other)) return true;
    if (sharesLongFragment(normalized, other)) return true;
  }
  return false;
}

/** 共享长片段：只换个说法重述同一条事实时，两边必然有一段完全相同的长文字。 */
function sharesLongFragment(a: string, b: string): boolean {
  const size = 16;
  if (a.length < size || b.length < size) return false;
  for (let i = 0; i + size <= a.length; i += 4) {
    if (b.includes(a.slice(i, i + size))) return true;
  }
  return false;
}

export interface CandidateIssue {
  reason: string;
}

export interface ValidatedCandidate {
  content: string;
  triggers: string[];
  importance: number;
  rationale: string;
}

function cleanLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function normalizeTriggers(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => cleanLine(item).slice(0, LEARNING_RULES.maxTriggerChars))
    .filter((item) => item.length > 0 && !containsSecret(item))
    .slice(0, LEARNING_RULES.maxTriggers);
}

function normalizeRationale(raw: unknown): string {
  return typeof raw === "string" ? cleanLine(raw).slice(0, LEARNING_RULES.maxRationaleChars) : "";
}

/** 校验并归一化模型给出的一条记忆候选；不合格给出可读的丢弃原因。 */
export function validateCandidate(raw: unknown): ValidatedCandidate | CandidateIssue {
  if (!raw || typeof raw !== "object") return { reason: "候选不是对象" };
  const record = raw as Record<string, unknown>;
  const content = typeof record.content === "string" ? cleanLine(record.content) : "";
  if (content.length === 0) return { reason: "正文为空" };
  if (content.length > LEARNING_RULES.maxContentChars) {
    return { reason: `正文超过 ${LEARNING_RULES.maxContentChars} 字` };
  }
  if (/^(好的|收到|明白|我将|我会|接下来|下面)/u.test(content)) return { reason: "只是承诺或客套，不是事实" };
  if (containsSecret(content)) return { reason: "疑似包含密钥或凭据" };

  const triggers = normalizeTriggers(record.triggers);
  const importance = Math.max(
    1,
    Math.min(10, Math.floor(typeof record.importance === "number" && Number.isFinite(record.importance) ? record.importance : 5)),
  );
  return { content, triggers, importance, rationale: normalizeRationale(record.rationale) };
}

export interface ValidatedSkillCandidate extends SkillDraft {
  rationale: string;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** 技能名统一成小写短横线 slug；转不出合法名字就返回 undefined（宁可不提议，也不乱造名字）。 */
export function normalizeSkillName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return SKILL_NAME_RE.test(name) ? name : undefined;
}

/** 校验一条技能候选：名称、描述、SKILL.md 正文都按技能库的口径收口。 */
export function validateSkillCandidate(raw: unknown): ValidatedSkillCandidate | CandidateIssue {
  if (!raw || typeof raw !== "object") return { reason: "技能候选不是对象" };
  const record = raw as Record<string, unknown>;

  const name = normalizeSkillName(record.name);
  if (!name) return { reason: "技能名需为小写字母、数字或短横线（最长 48 位）" };

  const description = typeof record.description === "string" ? cleanLine(record.description) : "";
  if (!description) return { reason: "技能描述为空" };
  if (description.length > LEARNING_RULES.maxSkillDescriptionChars) {
    return { reason: `技能描述超过 ${LEARNING_RULES.maxSkillDescriptionChars} 字` };
  }
  if (containsSecret(description)) return { reason: "技能描述疑似包含密钥或凭据" };

  const instructions =
    typeof record.instructions === "string" ? record.instructions.replace(/\r\n?/g, "\n").trim() : "";
  if (instructions.length < LEARNING_RULES.minSkillInstructionsChars) {
    return { reason: `技能说明少于 ${LEARNING_RULES.minSkillInstructionsChars} 字` };
  }
  if (instructions.length > LEARNING_RULES.maxSkillInstructionsChars) {
    return { reason: `技能说明超过 ${LEARNING_RULES.maxSkillInstructionsChars} 字` };
  }
  if (containsSecret(instructions)) return { reason: "技能说明疑似包含密钥或凭据" };

  const category: SkillCategory =
    normalizeSkillCategory(record.category) ?? inferSkillCategory(name, description);

  return {
    name,
    description,
    instructions,
    category,
    triggers: normalizeTriggers(record.triggers),
    rationale: normalizeRationale(record.rationale),
  };
}

/** 去重语料：已有记忆文件的条目行 + 还没确认的记忆提案，避免同一件事被反复提案。 */
export function buildDedupeEntries(memoryText: string, pending: readonly LearningProposal[]): string[] {
  const lines = memoryText
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return [
    ...lines,
    ...pending
      .filter((proposal) => proposal.kind === "memory")
      .map((proposal) => proposal.content),
  ];
}
