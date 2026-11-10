/**
 * 每个工具的结果该怎么处理：套不套外部内容边界、要不要掩码、要不要标注指令改写。
 *
 * 用表而不是在每个工具里写 if：新增工具默认按内部结果处理（什么都不做），
 * 只有明确登记为外部来源的工具才会被包边界。这样"忘了登记"只会少一层提醒，
 * 不会把智能体自己的错误消息当成外部数据糊上一段免责声明。
 */
import { guardExternalContent } from "./envelope";
import { redactSecrets } from "./redact";
import { clipForContext, CONTEXT_BUDGET_BYTES, formatByteSize, type ToolOutputStore } from "./offload";

export interface ToolContentPolicy {
  /** 设定后：结果按外部内容套边界，标签就是这个来源名。 */
  source?: string;
  /** 结果里出现疑似密钥时掩码（命令输出与脚本打印最常见）。 */
  redact: boolean;
}

const POLICIES: Record<string, ToolContentPolicy> = {
  web_fetch: { source: "web_fetch", redact: true },
  web_search: { source: "web_search", redact: true },
  // 上传的文件同样是外部内容：里面完全可以藏一段"忽略先前指令"。
  file_read: { source: "file_read", redact: true },
  // 检索片段在工具里逐段套了信封；这里只做脱敏，避免把工具自己的行号说明也关进信封。
  file_search: { redact: true },
  run_command: { source: "run_command", redact: true },
  // run_batch 自己完成脱敏、存档、选段与信封，这里是短回复，不再二次处理。
  run_batch: { redact: false },
  run_skill_script: { source: "run_skill_script", redact: true },
  // 技能正文是**要照着做的说明**，不能套"不是指令"的边界；但脚本输出与附带文件要脱敏。
  read_skill_file: { redact: true },
  use_skill: { redact: true },
  // 记忆与群聊记录是房内的内容，只做掩码。
  memory_get: { redact: true },
  memory_search: { redact: true },
  room_history: { redact: true },
  // 输出存档工具自己负责给选中的原文段包边界（见 output-tools.ts），
  // 这里再包一层会把「继续用 output_read 读」这类工具说明也关进"不是指令"里。
  output_search: { redact: false },
  output_read: { redact: false },
};

const DEFAULT_POLICY: ToolContentPolicy = { redact: false };

/** 这些前缀是我们自己工具发的话，不是外部数据，不套边界。 */
const INTERNAL_NOTICE_PREFIXES = [
  "错误：",
  "工具执行失败",
  "更新失败",
  "写入失败",
  "读取失败",
  "登记失败",
  "启动失败",
  "没有找到",
];

/** 存档与检索工具的结果不再二次存档，否则会自己套自己。run_batch 自己在调用内完成存档与选段。 */
const OFFLOAD_SKIP = new Set(["output_search", "output_read", "run_batch"]);

const ARG_PREVIEW_KEYS = ["command", "path", "url", "query", "skill", "name", "cwd", "task_id", "id"];

export function policyFor(toolName: string): ToolContentPolicy {
  return POLICIES[toolName] ?? DEFAULT_POLICY;
}

export function isInternalToolNotice(text: string): boolean {
  const head = text.trimStart().slice(0, 12);
  return INTERNAL_NOTICE_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 参数摘要：只说清「这份输出是哪次调用产生的」，不把完整参数再存一份。 */
export function describeToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ARG_PREVIEW_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) parts.push(`${key}=${clipText(value.trim(), 120)}`);
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && value.trim()) {
        parts.push(`${key}=${clipText(value.trim(), 80)}`);
        if (parts.length >= 4) break;
      }
    }
  }
  return clipText(parts.join(" "), 240);
}

/** 选片用的查询词：本轮用户请求 + 这次工具调用的意图。 */
function offloadQuery(userPrompt: string | undefined, toolName: string, args: Record<string, unknown>): string {
  return [userPrompt && userPrompt.trim() ? userPrompt.trim() : "", toolIntent(toolName, args)]
    .filter((part) => part.length > 0)
    .join("\n");
}

function toolIntent(toolName: string, args: Record<string, unknown>): string {
  const pick = (key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  switch (toolName) {
    case "run_command":
      return pick("command");
    case "run_skill_script": {
      const scriptArgs = Array.isArray(args["args"])
        ? (args["args"] as unknown[]).filter((item): item is string => typeof item === "string")
        : [];
      return [pick("skill"), pick("path"), ...scriptArgs].filter(Boolean).join(" ");
    }
    case "file_read":
    case "file_write":
      return pick("path");
    case "web_fetch":
      return pick("url");
    case "web_search":
    case "memory_search":
      return [pick("query"), Array.isArray(args["queries"]) ? (args["queries"] as unknown[]).join(" ") : ""]
        .filter(Boolean)
        .join(" ");
    case "read_skill_file":
      return [pick("skill"), pick("path")].filter(Boolean).join(" ");
    default:
      return describeToolArgs(args);
  }
}

export function redactionNote(replaced: number, families: string[]): string {
  return `（提示：本结果里已掩掉 ${replaced} 处疑似密钥（${families.join(
    "、",
  )}）。原始值仍在文件里，需要引用时让用户自己查看，不要试图还原。）`;
}

/**
 * 工具结果的统一出口（同步版）。外部来源套边界、疑似密钥掩码。
 * 保留给不接存档的单测与轻量调用点；生产路径走 transformToolResult。
 */
export function applyToolResultPolicy(toolName: string, raw: string): string {
  const policy = policyFor(toolName);
  const redacted = policy.redact ? redactSecrets(raw) : { text: raw, replaced: 0, families: [] };
  let out = redacted.text;
  if (redacted.replaced > 0) out = `${out}\n\n${redactionNote(redacted.replaced, redacted.families)}`;
  if (!policy.source || isInternalToolNotice(out)) return out;
  return guardExternalContent(policy.source, out);
}

export interface ToolResultTransformContext {
  /** 未接存档时只做脱敏与外部内容信封。 */
  store?: ToolOutputStore;
  memberId?: string;
  roomId?: string;
  runId?: string;
  /** 本轮触发消息（用户请求或成员汇报），作为片段筛选的查询词。 */
  query?: string;
}

export function createToolResultTransform(context: ToolResultTransformContext) {
  return (toolName: string, raw: string, args: Record<string, unknown> = {}): Promise<string> =>
    transformToolResult(toolName, raw, args, context);
}

/**
 * 异步版统一出口：脱敏 → 大输出落盘选片 → 外部内容信封。
 * 存档失败不抛错：退回「头尾截断 + 说明」，不让一次 I/O 故障把整轮运行打断。
 */
export async function transformToolResult(
  toolName: string,
  raw: string,
  args: Record<string, unknown>,
  context: ToolResultTransformContext,
): Promise<string> {
  const policy = policyFor(toolName);
  const redacted = policy.redact ? redactSecrets(raw) : { text: raw, replaced: 0, families: [] };
  const note = redacted.replaced > 0 ? redactionNote(redacted.replaced, redacted.families) : "";
  const internal = isInternalToolNotice(raw);
  const store = context.store;

  if (
    store &&
    !internal &&
    !OFFLOAD_SKIP.has(toolName) &&
    context.memberId &&
    context.roomId &&
    store.shouldOffload(redacted.text)
  ) {
    const record = await store.capture({
      tool: toolName,
      roomId: context.roomId,
      memberId: context.memberId,
      ...(context.runId ? { runId: context.runId } : {}),
      argsPreview: describeToolArgs(args),
      text: redacted.text,
    });
    if (record) {
      const selection = store.selectForContext(
        record,
        redacted.text,
        offloadQuery(context.query, toolName, args),
      );
      // 只把选中的原文段关进信封；存档 id 与「怎么取回其余部分」是工具自己的说明，留在信封外。
      const excerpts = policy.source
        ? guardExternalContent(policy.source, selection.excerpts)
        : selection.excerpts;
      const header =
        `（${record.tool} 的输出 ${formatByteSize(record.bytes)}、${record.lines} 行，超过单次展示上限；` +
        `完整内容已存档 ${record.id}，下面只放与本次任务最相关的 ${selection.spans.length} 段）`;
      const omitted = Math.max(0, record.lines - selection.coveredLines);
      const footer =
        `（${omitted > 0 ? `其余 ${omitted} 行未展示。` : ""}` +
        `用 output_search(query="关键词", id="${record.id}") 检索这份输出，` +
        `或 output_read(id="${record.id}", start_line=…, end_line=…) 按行读取。）`;
      return [header, excerpts, footer, note].filter((part) => part.length > 0).join("\n\n");
    }
    // 存档失败：头尾截断，别把整份大输出灌进上下文。
    const clipped = clipForContext(redacted.text, CONTEXT_BUDGET_BYTES);
    const body = policy.source ? guardExternalContent(policy.source, clipped) : clipped;
    return [
      body,
      "（工具输出较大，本次存档失败；上面只保留了开头与结尾，请缩小输出范围后重跑。）",
      note,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  let out = redacted.text;
  if (policy.source && !internal) out = guardExternalContent(policy.source, out);
  if (note) out = `${out}\n\n${note}`;
  return out;
}
