// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/subagents/spawn/subagent-task-name.ts, MIT licensed (Copyright (c) 2026 OpenClaw Foundation).

// 本项目的成员名即派发引用（@名字），承担 OpenClaw taskName 的角色与校验语义。
const MEMBER_NAME_RE = /^[\p{L}\p{N}_-]{1,12}$/u;
const RESERVED_MEMBER_NAMES = new Set(["用户", "系统"]);

export function normalizeMemberName(
  value: unknown,
): { name?: string; error?: undefined } | { name?: undefined; error: string } {
  const name = typeof value === "string" ? value.replace(/^@+/, "").trim() : "";
  if (!name) {
    return { error: "成员名不能为空。" };
  }
  if (!MEMBER_NAME_RE.test(name)) {
    return { error: `成员名 "${name}" 不合法：只能使用 1-12 个中英文、数字、下划线或短横线。` };
  }
  if (RESERVED_MEMBER_NAMES.has(name)) {
    return { error: `成员名 "${name}" 是保留名称，不能作为成员名。` };
  }
  return { name };
}
