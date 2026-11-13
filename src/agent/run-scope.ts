import { PLAN_WRITABLE_PREFIX, RUN_SCOPE_LABELS } from "../core/types";
import type { RunScopeKind } from "../core/types";
import type { ToolImpl } from "./loop";

/**
 * 运行姿态表：本轮注册哪些工具（白名单）以及文件写入限制在哪个前缀。
 *
 * 用白名单而不是黑名单：以后新增加入工具默认进不了计划轮，闸门不会因为「加了个新工具」而漏风。
 * 移植自 Hermes 的 plan mode（`agent/plan_prompt.py`），差别在于 Hermes 只改提示词、
 * 靠模型自觉，这里把约束落到工具注册上，所以「计划轮不会真的动手」是可验证的事实。
 */
const RUN_SCOPES: Record<RunScopeKind, { tools: ReadonlySet<string>; writablePrefix?: string }> = {
  plan: {
    tools: new Set([
      "use_skill",
      "read_skill_file",
      "room_history",
      "memory_search",
      "memory_get",
      "web_search",
      "web_fetch",
      "file_list",
      "file_read",
      "file_search",
      "task_list",
      "task_create",
      "file_write",
      "output_search",
      "output_read",
      "knowledge_search",
      "knowledge_read",
      "knowledge_list",
    ]),
    writablePrefix: PLAN_WRITABLE_PREFIX,
  },
};

/**
 * 姿态收窄掉的工具被模型再次调用时的回执。要说「本轮姿态不挂这个工具」而不是「没有名为 X 的工具」：
 * 后者会被模型理解成工具坏了，既可能反复重试，也可能把它当成故障汇报给用户。
 */
export function scopeToolUnavailable(scope: RunScopeKind, name: string): string {
  const rule = RUN_SCOPES[scope];
  return (
    `错误：${RUN_SCOPE_LABELS[scope]}里不挂载 ${name}，工具本身没坏，是这一轮的姿态不允许。` +
    `本轮可用工具：${[...rule.tools].join("、")}。` +
    (rule.writablePrefix
      ? `要改动的部分先写进 ${rule.writablePrefix} 下的计划文件和任务卡，等用户批准后再另开一轮执行。`
      : `要改动的部分先列在汇报里，等用户批准后再另开一轮执行。`)
  );
}

export function applyRunScope(tools: ToolImpl[], scope: RunScopeKind | undefined): ToolImpl[] {
  if (!scope) return tools;
  const rule = RUN_SCOPES[scope];
  const kept = tools.filter((tool) => rule.tools.has(tool.schema.name));
  const prefix = rule.writablePrefix;
  if (!prefix) return kept;
  return kept.map((tool) => (tool.schema.name === "file_write" ? restrictWrites(tool, scope, prefix) : tool));
}

/** 被闸门挡下的工具调用要说什么：既报错，也告诉模型正确的做法是什么。 */
function refusal(scope: RunScopeKind, prefix: string, path: string): string {
  return (
    `错误：本轮是${RUN_SCOPE_LABELS[scope]}，只能读，不能改动 ${prefix} 之外的任何东西。` +
    `要把产出落成文件就写进 ${prefix}（如 ${prefix}2026-01-01-topic.md），` +
    `其余改动请在汇报里列出，等用户批准后再做。收到路径：${path || "（空）"}`
  );
}

function restrictWrites(tool: ToolImpl, scope: RunScopeKind, prefix: string): ToolImpl {
  return {
    ...tool,
    execute: async (args, signal) => {
      const raw = args["path"];
      const normalized = normalizeRelativePath(typeof raw === "string" ? raw : "");
      if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
        return refusal(scope, prefix, typeof raw === "string" ? raw : "");
      }
      return tool.execute({ ...args, path: normalized }, signal);
    },
  };
}

/**
 * 归一化到 `a/b.md` 形式：统一分隔符、去掉 `./`，并拒绝任何 `..` 片段——
 * 否则 `plans/../x.md` 会绕过前缀检查写到外面。大小写保留，只在比较时忽略。
 */
function normalizeRelativePath(value: string): string {
  const parts = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").split("/");
  if (parts.some((part) => part === "..")) return "";
  return parts.filter((part) => part.length > 0 && part !== ".").join("/");
}
