// 复盘产出的候选条目在进入记忆之前要过的三道闸门：格式校验、密钥拦截、与已有条目去重。
// 对应 Hermes 复盘提示词里的 do-not-capture 规则；提示词负责「不该写什么」，这里负责兜底。

import { LEARNING_RULES, type MemoryProposal } from "./types";

/** 疑似密钥与凭据：命中任意一条就整条丢弃，绝不落进记忆文件。 */
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

/** 校验并归一化模型给出的一条候选；不合格给出可读的丢弃原因。 */
export function validateCandidate(raw: unknown): ValidatedCandidate | CandidateIssue {
  if (!raw || typeof raw !== "object") return { reason: "候选不是对象" };
  const record = raw as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content.trim().replace(/\s+/gu, " ") : "";
  if (content.length === 0) return { reason: "正文为空" };
  if (content.length > LEARNING_RULES.maxContentChars) {
    return { reason: `正文超过 ${LEARNING_RULES.maxContentChars} 字` };
  }
  if (/^(好的|收到|明白|我将|我会|接下来|下面)/u.test(content)) return { reason: "只是承诺或客套，不是事实" };
  if (containsSecret(content)) return { reason: "疑似包含密钥或凭据" };

  const triggersRaw = Array.isArray(record.triggers) ? record.triggers : [];
  const triggers = triggersRaw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\s+/gu, " ").slice(0, LEARNING_RULES.maxTriggerChars))
    .filter((item) => item.length > 0 && !containsSecret(item))
    .slice(0, LEARNING_RULES.maxTriggers);

  const importanceRaw = record.importance;
  const importance =
    typeof importanceRaw === "number" && Number.isFinite(importanceRaw)
      ? Math.max(1, Math.min(10, Math.floor(importanceRaw)))
      : 5;

  const rationale =
    typeof record.rationale === "string"
      ? record.rationale.trim().replace(/\s+/gu, " ").slice(0, LEARNING_RULES.maxRationaleChars)
      : "";

  return { content, triggers, importance, rationale };
}

/** 去重语料：已有记忆文件的条目行 + 还没确认的提案，避免同一件事被反复提案。 */
export function buildDedupeEntries(memoryText: string, pending: readonly MemoryProposal[]): string[] {
  const lines = memoryText
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return [...lines, ...pending.map((proposal) => proposal.content)];
}
