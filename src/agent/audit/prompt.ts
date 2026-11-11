/**
 * 审计提示词：只按任务验收条款核对，只依据证据，不允许把成员自述当证据。
 * 输出严格 JSON，解析失败时调用方直接放弃本次审计（不催办、不落缓存）。
 */
import {
  AUDIT_LIMITS,
  isAuditVerdict,
  type AuditCriterionResult,
  type AuditVerdict,
} from "./types";

export interface AuditPromptInput {
  taskTitle: string;
  taskDetail: string;
  acceptance: string;
  taskStatus: string;
  memberName: string;
  messages: Array<{ senderName: string; text: string }>;
  activities: Array<{ time: string; kind: string; title: string; detail?: string }>;
  files: Array<{ path: string; summary?: string; content?: string }>;
}

export const AUDIT_SYSTEM_PROMPT =
  "你是一名独立的任务审计员。你只依据给出的证据核对验收条款，不采纳任何自我声明。";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function buildAuditPrompt(input: AuditPromptInput): { system: string; user: string } {
  const messages = input.messages
    .map((message) => `- ${message.senderName}：${clip(message.text, 500)}`)
    .join("\n");
  const activities = input.activities
    .map(
      (activity) =>
        `- [${activity.time}] ${activity.kind} · ${clip(activity.title, 120)}${
          activity.detail ? `：${clip(activity.detail, 220)}` : ""
        }`,
    )
    .join("\n");
  const files = input.files
    .map(
      (file) =>
        `=== 文件：${file.path}${file.summary ? `（${clip(file.summary, 160)}）` : ""} ===\n${
          file.content ? clip(file.content, 2_000) : "（未提供正文）"
        }`,
    )
    .join("\n\n");

  const user = [
    "请核对下面任务的验收条款是否已经完成。",    "",
    `任务：${clip(input.taskTitle, 200)}`,
    `当前状态：${input.taskStatus}`,
    `任务说明：${clip(input.taskDetail, 1_200) || "（无）"}`,
    `验收条款：\n${clip(input.acceptance, 2_000)}`,
    "",
    `执行成员：${input.memberName}`,
    "",
    "=== 成员最近发言 ===",
    messages || "（无）",
    "",
    "=== 工具与思考活动（时间顺序） ===",
    activities || "（无）",
    "",
    "=== 成果文件摘录 ===",
    files || "（无成果文件）",
    "",
    "判定规则：",
    "1. 把验收条款拆成 1–8 条可独立核对的标准；只从「验收条款」出发，不额外发明要求。",
    "2. 只有证据明确、直接证明完成时才判 pass；证据缺失判 fail；证据含糊判 unsure。",
    "3. 成员的自我声明不是证据，必须能在发言、工具结果或成果文件里找到依据。",
    "4. 对 fail / unsure 给出具体、可执行的修复建议。",
    "",
    "只输出 JSON，不要解释、不要 Markdown 代码块：",
    '{"criteria":[{"criterion":"验收标准","verdict":"pass|fail|unsure","evidence":"证据引用","fix_hint":"失败时的修复建议"}]}',
  ].join("\n");

  return {
    system: AUDIT_SYSTEM_PROMPT,
    user: user.length > AUDIT_LIMITS.maxEvidenceChars
      ? `${user.slice(0, AUDIT_LIMITS.maxEvidenceChars)}…`
      : user,
  };
}

const VERDICT_ALIASES: Record<string, AuditVerdict> = {
  pass: "pass",
  passed: "pass",
  ok: "pass",
  done: "pass",
  通过: "pass",
  完成: "pass",
  fail: "fail",
  failed: "fail",
  失败: "fail",
  未通过: "fail",
  unsure: "unsure",
  uncertain: "unsure",
  ambiguous: "unsure",
  存疑: "unsure",
  不确定: "unsure",
};

function extractJson(raw: string): unknown {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const starts = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, keys: readonly string[], max: number): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").trim().slice(0, max);
    }
  }
  return "";
}

function normalizeVerdict(value: unknown): AuditVerdict | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return VERDICT_ALIASES[key] ?? (isAuditVerdict(key) ? key : null);
}

/**
 * 解析模型输出。兼容两种形态：`{criteria:[...]}` 与直接数组；
 * 也接受模型只给一个总判定（按一条验收条款处理）。
 */
export function parseAuditResponse(
  raw: string,
  acceptance: string,
): AuditCriterionResult[] | null {
  const parsed = extractJson(raw);
  if (parsed === null) return null;
  const object = !Array.isArray(parsed) && parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null;
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(object?.["criteria"])
      ? (object!["criteria"] as unknown[])
      : object
        ? [object]
        : [];

  const criteria: AuditCriterionResult[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const verdict = normalizeVerdict(record["verdict"]);
    if (!verdict) continue;
    const criterion =
      readString(record, ["criterion", "requirement", "text", "acceptance"], 300) ||
      clip(acceptance, 300);
    if (!criterion) continue;
    const evidence = readString(record, ["evidence", "proof", "quote"], AUDIT_LIMITS.maxCriterionEvidence);
    const fixHint = readString(
      record,
      ["fix_hint", "fixHint", "hint", "suggestion"],
      AUDIT_LIMITS.maxFixHint,
    );
    criteria.push({
      id: criteria.length + 1,
      criterion,
      verdict,
      evidence,
      ...(fixHint ? { fixHint } : {}),
    });
    if (criteria.length >= AUDIT_LIMITS.maxCriteria) break;
  }
  return criteria.length > 0 ? criteria : null;
}
