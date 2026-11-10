/**
 * 工具失败契约（移植 gbrain `docs/protocol/AGENT_OPERATOR_v1.md` 的错误信封）：
 * 工具失败不再只是一句散文，而是带稳定 code、可选的 why / next / verify。
 *
 * 适配：
 * - 文本第一行仍然以「错误：」开头，`looksLikeFailure`、`isInternalToolNotice`
 *   以及既有测试不用改口径；结构化字段追加在后续行，模型照常可读。
 * - code 同时通过 `onToolResult` 的第三参数（以及 SSE `tool-result` 事件）
 *   交给循环与 UI；模型看到的文本里只在有补充说明时才写 code，避免噪音。
 */

export const TOOL_ERROR_CATALOG = {
  invalid_argument: { retriable: false, summary: "参数缺失或不合法" },
  not_found: { retriable: false, summary: "目标不存在" },
  permission_denied: { retriable: false, summary: "没有权限或超出允许范围" },
  unavailable: { retriable: true, summary: "依赖暂时不可用" },
  rate_limited: { retriable: true, summary: "被上游限流" },
  conflict: { retriable: false, summary: "与已有状态冲突" },
  unknown_tool: { retriable: false, summary: "本轮没有挂载这个工具" },
  tool_exception: { retriable: true, summary: "工具内部异常" },
  command_failed: { retriable: false, summary: "命令以非零退出码结束" },
  tool_failed: { retriable: false, summary: "工具执行失败" },
  guardrail_block: { retriable: false, summary: "护栏拦截了这次调用" },
  guardrail_halt: { retriable: false, summary: "护栏中止了本轮运行" },
} as const;

export type ToolErrorCode = keyof typeof TOOL_ERROR_CATALOG;

export interface ToolErrorDetails {
  /** 为什么失败：给模型判断根因，不重复 message。 */
  why?: string;
  /** 下一步该做什么：换参数、换路径、换方法，或如实报告受阻。 */
  next?: string;
  /** 怎么确认已修好：退出码、文件路径、可回读的状态。 */
  verify?: string;
}

export class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly details: ToolErrorDetails;

  constructor(code: ToolErrorCode, message: string, details: ToolErrorDetails = {}) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.details = details;
  }
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

/** 生成模型可读的失败文本；第一行保持既有「错误：」口径。 */
export function toolErrorText(failure: ToolFailure): string {
  const lines = [`错误：${sanitizeLine(failure.message)}`];
  const { why, next, verify } = failure.details;
  if (!why && !next && !verify) {
    return lines.join("\n");
  }
  lines.push(`错误码：${failure.code}`);
  if (why) lines.push(`原因：${sanitizeLine(why)}`);
  if (next) lines.push(`下一步：${sanitizeLine(next)}`);
  if (verify) lines.push(`核验：${sanitizeLine(verify)}`);
  return lines.join("\n");
}

export function toolFailureText(
  code: ToolErrorCode,
  message: string,
  details: ToolErrorDetails = {},
): string {
  return toolErrorText(new ToolFailure(code, message, details));
}

const FAILURE_HEAD_PREFIXES = [
  "错误：",
  "工具执行失败",
  "更新失败",
  "写入失败",
  "读取失败",
  "登记失败",
  "启动失败",
  "执行失败",
  "调用失败",
];

const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|限流|请求过于频繁/i;

export interface ToolResultStatus {
  ok: boolean;
  code?: ToolErrorCode;
}

function failureHead(text: string): string {
  return text.trimStart().slice(0, 16);
}

function looksLikeFailure(text: string): boolean {
  const head = failureHead(text);
  if (FAILURE_HEAD_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return true;
  }
  const exit = /退出码：(\d+)/.exec(text);
  return exit !== null && exit[1] !== "0";
}

/** JSON 形态的工具结果（memory_* 用）：只做浅层检测，不解析整份大结果。 */
function jsonFailureCode(text: string): ToolErrorCode | undefined {
  const head = text.trimStart();
  if (!head.startsWith("{")) return undefined;
  if (/"disabled"\s*:\s*true/u.test(head.slice(0, 512))) return "unavailable";
  if (/"status"\s*:\s*"not_found"/u.test(head.slice(0, 512))) return "not_found";
  if (/"status"\s*:\s*"error"/u.test(head.slice(0, 512))) return "tool_failed";
  return undefined;
}

/** 从文本里读回显式 code（有结构化补充说明时才会写）。 */
export function parseToolErrorCode(text: string): ToolErrorCode | undefined {
  const match = /错误码：([a-z_]+)/u.exec(text);
  if (!match) return undefined;
  return match[1] && match[1] in TOOL_ERROR_CATALOG ? (match[1] as ToolErrorCode) : undefined;
}

function inferToolErrorCode(text: string): ToolErrorCode {
  const code = parseToolErrorCode(text);
  if (code) return code;
  const json = jsonFailureCode(text);
  if (json) return json;
  if (RATE_LIMIT_RE.test(text)) return "rate_limited";
  if (
    /未启用|未对[^\n]*启用|没有启用|不允许|禁止|越出工作区|只允许|没有权限|权限不足|denied|forbidden/i.test(
      text,
    )
  ) {
    return "permission_denied";
  }
  if (/不存在|找不到|没有名为|没有可用的|没有文件|没有这个|not found/i.test(text)) {
    return "not_found";
  }
  if (/不能为空|必须|只能是|不合法|无效|格式|最多|至少|不能同时|missing|invalid/i.test(text)) {
    return "invalid_argument";
  }
  if (/冲突|已存在|重复|conflict/i.test(text)) return "conflict";
  if (/超时|不可用|未配置|网络|连接失败|timeout|ECONN|ENOTFOUND|fetch failed/i.test(text)) {
    return "unavailable";
  }
  if (/退出码：[1-9]/u.test(text)) return "command_failed";
  return "tool_failed";
}

/** 把一眼工具结果归类成 UI / 循环可消费的状态。 */
export function classifyToolResult(text: string): ToolResultStatus {
  const json = jsonFailureCode(text);
  if (json) {
    return { ok: false, code: json };
  }
  if (!looksLikeFailure(text)) {
    return { ok: true };
  }
  return { ok: false, code: inferToolErrorCode(text) };
}

export function isToolFailureStatus(status: ToolResultStatus | undefined): boolean {
  return status !== undefined && status.ok === false;
}

export function toolErrorIsRetriable(code: ToolErrorCode | undefined): boolean {
  return code !== undefined && TOOL_ERROR_CATALOG[code].retriable;
}
