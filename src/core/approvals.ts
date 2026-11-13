// 执行前审批：把「有副作用的工具调用」变成用户可批准、可拒绝、可记住的动作。
//
// 机制借鉴 CopilotKit/OpenBot 的 approvals（MIT）：
// 固定高风险分类先问 → 已保存的允许规则 → 本会话授权 → 分类默认；
// 拒绝永远优先，允许只对同类动作生效。这里按本项目的工具集收成三类，保持纯函数。

import { newId } from "./ids";

export const APPROVAL_CATEGORIES = ["command", "delete", "write"] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

export const APPROVAL_BEHAVIORS = ["allow", "ask", "deny"] as const;
export type ApprovalBehavior = (typeof APPROVAL_BEHAVIORS)[number];

export interface ApprovalRule {
  id: string;
  tool: string;
  category: ApprovalCategory;
  /** 同类工具的作用域：命令取首个词、技能脚本取技能名、删除取资源 id。空串表示整个工具。 */
  scope: string;
  label?: string;
  createdAt: number;
}

export interface ApprovalSettings {
  categories: Record<ApprovalCategory, ApprovalBehavior>;
  /** 「始终允许」：只对同一工具 + 分类 + 作用域生效。 */
  rules: ApprovalRule[];
}

export const DEFAULT_APPROVALS: ApprovalSettings = {
  categories: { command: "ask", delete: "ask", write: "allow" },
  rules: [],
};

/** 本会话授权：只在本房间内、对同一工具 + 分类 + 作用域生效，不落盘。 */
export interface ApprovalGrant {
  tool: string;
  category: ApprovalCategory;
  scope: string;
}

export interface ApprovalAction {
  category: ApprovalCategory;
  tool: string;
  scope: string;
  /** 给用户看的动作名，如「运行命令」。 */
  label: string;
  /** 具体要做什么：命令、脚本路径、文件路径等。 */
  preview: string;
}

const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  command: "运行命令",
  delete: "删除内容",
  write: "写入文件",
};

function text(value: unknown, max = 240): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function firstWord(command: string): string {
  return command.split(/\s+/).find(Boolean)?.toLowerCase().slice(0, 40) ?? "command";
}

/**
 * 识别一次工具调用的审批分类。返回 null = 只读或不需要审批的动作。
 * 分类只认工具名与参数，不看内容里的字样，避免「文件内容提到删除」被误判。
 */
export function classifyApprovalAction(
  tool: string,
  args: Record<string, unknown>,
): ApprovalAction | null {
  if (tool === "run_command") {
    const command = text(args["command"], 2_000);
    if (!command) return null;
    return {
      category: "command",
      tool,
      scope: firstWord(command),
      label: CATEGORY_LABELS.command,
      preview: command,
    };
  }
  if (tool === "run_batch") {
    const commands = Array.isArray(args["commands"])
      ? args["commands"].filter((item): item is string => typeof item === "string")
      : [];
    if (commands.length === 0) return null;
    return {
      category: "command",
      tool,
      scope: "batch",
      label: "批量运行命令",
      preview: commands.join("\n"),
    };
  }
  if (tool === "run_skill_script") {
    const skill = text(args["skill"], 80);
    const path = text(args["path"], 200);
    return {
      category: "command",
      tool,
      scope: skill || "skill",
      label: "运行技能脚本",
      preview: [skill && `技能：${skill}`, path && `脚本：${path}`].filter(Boolean).join("\n") || "技能脚本",
    };
  }
  if (tool === "file_write") {
    const path = text(args["path"], 240);
    return {
      category: "write",
      tool,
      scope: path.split("/").slice(0, -1).join("/") || "files",
      label: CATEGORY_LABELS.write,
      preview: path || "文件工作区",
    };
  }
  if (tool === "cron" && text(args["action"]) === "remove") {
    return {
      category: "delete",
      tool,
      scope: text(args["job_id"], 80) || "cron",
      label: "删除定时任务",
      preview: text(args["job_id"], 120) || "定时任务",
    };
  }
  return null;
}

export function approvalRuleMatches(rule: ApprovalRule, action: ApprovalAction): boolean {
  return (
    rule.tool === action.tool &&
    rule.category === action.category &&
    (rule.scope === "" || rule.scope === action.scope)
  );
}

export function grantMatches(grant: ApprovalGrant, action: ApprovalAction): boolean {
  return (
    grant.tool === action.tool &&
    grant.category === action.category &&
    grant.scope === action.scope
  );
}

/**
 * 决策顺序：拒绝永不放开 → 始终允许 → 本会话允许 → 分类默认。
 * 返回 ask 时调用方创建审批卡；允许只对同一类型、同一作用域生效。
 */
export function decideApproval(
  settings: ApprovalSettings,
  action: ApprovalAction,
  grants: readonly ApprovalGrant[] = [],
): ApprovalBehavior {
  const base = settings.categories[action.category];
  if (base === "deny") return "deny";
  if (settings.rules.some((rule) => approvalRuleMatches(rule, action))) return "allow";
  if (grants.some((grant) => grantMatches(grant, action))) return "allow";
  return base;
}

/** 审批卡上的四个选项；id 就是答案里记录的 optionId。 */
export const APPROVAL_OPTIONS = [
  { id: "allow_once", label: "仅本次允许" },
  { id: "allow_conversation", label: "本会话内允许同类操作" },
  { id: "allow_always", label: "始终允许（保存为规则）" },
  { id: "deny", label: "拒绝" },
] as const;
export type ApprovalOptionId = (typeof APPROVAL_OPTIONS)[number]["id"];

export function isApprovalOption(value: unknown): value is ApprovalOptionId {
  return typeof value === "string" && APPROVAL_OPTIONS.some((option) => option.id === value);
}

function categoryOf(value: unknown): ApprovalCategory | undefined {
  return typeof value === "string" && (APPROVAL_CATEGORIES as readonly string[]).includes(value)
    ? (value as ApprovalCategory)
    : undefined;
}

function behaviorOf(value: unknown): ApprovalBehavior | undefined {
  return typeof value === "string" && (APPROVAL_BEHAVIORS as readonly string[]).includes(value)
    ? (value as ApprovalBehavior)
    : undefined;
}

export const APPROVAL_LIMITS = { rules: 50, label: 120, scope: 120, tool: 64 } as const;

/**
 * 校验并归一化设置里的审批补丁。`rules` 是完整替换（UI 保存当前清单）；
 * 未提供的分类保持原值；未知字段直接报错，避免静默丢配置。
 */
export function sanitizeApprovals(input: unknown, current: ApprovalSettings): ApprovalSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("approvals 必须是对象");
  }
  const record = input as Record<string, unknown>;
  const known = ["categories", "rules"];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw new Error(`未知的审批字段 ${key}`);
  }
  const categories: Record<ApprovalCategory, ApprovalBehavior> = { ...current.categories };
  if (record["categories"] !== undefined) {
    if (record["categories"] === null || typeof record["categories"] !== "object" || Array.isArray(record["categories"])) {
      throw new Error("approvals.categories 必须是对象");
    }
    for (const [key, value] of Object.entries(record["categories"] as Record<string, unknown>)) {
      const category = categoryOf(key);
      if (!category) throw new Error(`未知的审批分类 ${key}`);
      const behavior = behaviorOf(value);
      if (!behavior) throw new Error(`审批分类 ${key} 只能是 ${APPROVAL_BEHAVIORS.join(" / ")}`);
      categories[category] = behavior;
    }
  }
  let rules = current.rules;
  if (record["rules"] !== undefined) {
    if (!Array.isArray(record["rules"])) throw new Error("approvals.rules 必须是数组");
    if (record["rules"].length > APPROVAL_LIMITS.rules) {
      throw new Error(`审批规则最多 ${APPROVAL_LIMITS.rules} 条`);
    }
    const seen = new Set<string>();
    rules = [];
    for (const raw of record["rules"]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("审批规则必须是对象");
      const entry = raw as Record<string, unknown>;
      const tool = text(entry["tool"], APPROVAL_LIMITS.tool);
      if (!tool) throw new Error("审批规则缺少工具名");
      const category = categoryOf(entry["category"]);
      if (!category) throw new Error(`审批规则 ${tool} 的分类不合法`);
      const scope = text(entry["scope"], APPROVAL_LIMITS.scope);
      const key = `${tool}\u0000${category}\u0000${scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = text(entry["label"], APPROVAL_LIMITS.label) || undefined;
      const createdAt = typeof entry["createdAt"] === "number" ? entry["createdAt"] : Date.now();
      rules.push({
        id: typeof entry["id"] === "string" && entry["id"].trim() ? entry["id"].trim().slice(0, 64) : newId("apr"),
        tool,
        category,
        scope,
        ...(label ? { label } : {}),
        createdAt,
      });
    }
  }
  return { categories, rules };
}

export function approvalRuleFor(action: ApprovalAction, now: number): ApprovalRule {
  return {
    id: newId("apr"),
    tool: action.tool,
    category: action.category,
    scope: action.scope,
    label: `${action.label}：${action.preview.replace(/\s+/g, " ").slice(0, 60)}`,
    createdAt: now,
  };
}
