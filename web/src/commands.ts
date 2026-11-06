import {
  DEFAULT_LIMITS,
  ROOM_ROUTING_LABELS,
  type Limits,
  type Member,
  type RoomMessage,
  type RoomMode,
  type RoomRoutingMode,
  type RunScopeKind,
  type TaskCard,
} from "../../src/core/types";
import type { MaskedSettings } from "./api";

export interface SlashCommandDef {
  name: string;
  usage: string;
  summary: string;
  /** 该命令是否接受参数；不接受参数的命令带着参数输入会被挡下，不给错的执行。 */
  acceptsArgs?: boolean;
  /**
   * 该命令把这一轮收窄成某种运行姿态：命令文字照常发给智能体，但服务端按姿态表挑工具清单
   * 与唤醒规则。这是「命令 → 姿态」的一张表，加一种姿态只改这里，不改命令分发逻辑。
   */
  runScope?: RunScopeKind;
}

/** 前端本地命令表：解析、帮助文案与可用性共用一份，避免散落的正则。 */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "help", usage: "/help", summary: "查看可用命令与说明" },
  {
    name: "plan",
    usage: "/plan <要规划的事>",
    summary: "计划轮：只读地把这一轮的活查清楚、写成 plans/ 下的计划与任务卡，等你批准再执行",
    acceptsArgs: true,
    runScope: "plan",
  },
  {
    name: "new",
    usage: "/new",
    summary: "开启新会话：归档当前聊天记录与任务卡，接下来的任务与之前无关（文件工作区保留）",
  },
  { name: "clear", usage: "/clear", summary: "归档并清空作战室（聊天记录、任务卡、文件成果），可在右侧归档区恢复" },
  { name: "stop", usage: "/stop", summary: "中止当前作战室里所有正在运行的成员" },
  { name: "status", usage: "/status", summary: "查看成员、任务、模型与运行状态" },
  {
    name: "model",
    usage: "/model [@成员] [模型引用]",
    summary: "查看可选模型与成员当前模型；带引用即为该成员切换模型",
    acceptsArgs: true,
  },
  {
    name: "context",
    usage: "/context",
    summary: "查看群聊窗口、上下文预算与记忆检索配置",
  },
];

export type ParsedSlashInput =
  | { kind: "command"; command: SlashCommandDef; args: string }
  | { kind: "unknown"; name: string; args: string }
  | null;

/** 只把 `/命令` 形式交给命令层；普通文本返回 null，仍按聊天消息发送。 */
export function parseSlashCommand(raw: string): ParsedSlashInput {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s:]+)(?::|\s+|$)([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  if (!name) return null;
  const args = (match[2] ?? "").trim();
  const command = SLASH_COMMANDS.find((item) => item.name === name);
  return command ? { kind: "command", command, args } : { kind: "unknown", name, args };
}

/**
 * 输入框里正在编辑的命令片段：只有消息开头、尚未进入参数才算。
 * 返回 null 表示不该弹提示（普通聊天、`//` 或已输入参数）。
 */
export function getSlashQuery(raw: string): string | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const body = trimmed.slice(1);
  if (/[\s:]/.test(body)) return null;
  return body.toLowerCase();
}

const NON_MATCHING_RANK = 4;

/** 与 OpenClaw 相同的思路：名称精确 > 前缀 > 包含 > 说明命中，同档保持注册表顺序。 */
function slashRelevance(command: SlashCommandDef, query: string): number {
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return command.summary.toLowerCase().includes(query) ? 3 : NON_MATCHING_RANK;
}

export function suggestSlashCommands(query: string): SlashCommandDef[] {
  const lower = query.toLowerCase();
  if (!lower) return SLASH_COMMANDS.slice();
  return SLASH_COMMANDS.map((command, order) => ({
    command,
    order,
    rank: slashRelevance(command, lower),
  }))
    .filter((item) => item.rank < NON_MATCHING_RANK)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((item) => item.command);
}

export interface CommandData {
  roomName: string;
  mode: RoomMode;
  routing: RoomRoutingMode;
  members: Member[];
  messages: RoomMessage[];
  tasks: TaskCard[];
  settings: MaskedSettings | null;
  workspaceFileCount: number | null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

const TASK_LABELS: Array<[TaskCard["status"], string]> = [
  ["todo", "待办"],
  ["doing", "进行中"],
  ["blocked", "阻塞"],
  ["done", "完成"],
  ["failed", "失败"],
];

/** 与 RoomBus.window 相同的取舍规则，用当前已加载的消息做估算。 */
function estimateWindow(
  messages: RoomMessage[],
  maxChars: number,
): { count: number; chars: number } {
  const picked: RoomMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const cost = message.text.length + 80;
    if (picked.length > 0 && used + cost > maxChars) break;
    picked.unshift(message);
    used += cost;
  }
  return {
    count: picked.length,
    chars: picked.reduce((total, message) => total + message.text.length, 0),
  };
}

export function buildStatusReport(data: CommandData): string {
  const running = data.members.filter((member) => member.status === "running").length;
  const idle = data.members.filter((member) => member.status === "idle").length;
  const error = data.members.filter((member) => member.status === "error").length;
  const cancelled = data.members.filter((member) => member.status === "cancelled").length;

  const memberParts = [`运行中 ${running}`, `空闲 ${idle}`];
  if (error > 0) memberParts.push(`异常 ${error}`);
  if (cancelled > 0) memberParts.push(`已取消 ${cancelled}`);

  const taskParts = TASK_LABELS.map(
    ([status, label]) =>
      [label, data.tasks.filter((task) => task.status === status).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`);

  const settings = data.settings;
  const defaultRef = settings?.selection.defaultModel ?? "";
  const defaultProvider = settings?.providers.find(
    (item) => defaultRef.split("/")[0] === item.id,
  );
  const missingKey =
    defaultProvider !== undefined &&
    defaultProvider.api !== "mock" &&
    defaultProvider.auth === "api-key" &&
    !defaultProvider.hasApiKey;
  const model = !defaultRef
    ? "未配置"
    : `${defaultRef}${missingKey ? "（未配置密钥）" : ""}`;

  const lines = [
    "作战室状态",
    `· 房间：${data.roomName}`,
    `· 协作模式：${data.mode === "free" ? "自由交流（成员直接讨论，主智能体收集总结）" : "委派（主智能体拆解分派）"}`,
    `· 取人方式：${ROOM_ROUTING_LABELS[data.routing]}`,
    `· 成员：${data.members.length}（${memberParts.join(" · ")}）`,
    `· 消息：已加载 ${data.messages.length} 条（服务端最多返回 300 条）`,
    `· 任务：${data.tasks.length}${taskParts.length > 0 ? `（${taskParts.join(" · ")}）` : ""}`,
  ];
  if (data.workspaceFileCount !== null) {
    lines.push(`· 文件工作区：${data.workspaceFileCount} 个文件`);
  }
  lines.push(`· 模型：${model}`);
  return lines.join("\n");
}

export function buildContextReport(data: CommandData): string {
  const limits: Partial<Limits> = data.settings?.limits ?? {};
  const maxChars = numberOr(limits.maxRoomWindowChars, 12_000);
  const window = estimateWindow(data.messages, maxChars);
  const contextTokens = numberOr(limits.contextWindowTokens, 0);
  const stepLimit = numberOr(limits.maxStepsPerRun, DEFAULT_LIMITS.maxStepsPerRun);
  const timeout = numberOr(limits.runTimeoutMs, DEFAULT_LIMITS.runTimeoutMs);
  const concurrency = numberOr(limits.maxConcurrent, DEFAULT_LIMITS.maxConcurrent);
  const transcriptBytes =
    typeof limits.maxActiveTranscriptBytes === "string" ||
    typeof limits.maxActiveTranscriptBytes === "number"
      ? String(limits.maxActiveTranscriptBytes)
      : null;

  return [
    "上下文组装（只读估算）",
    `· 群聊窗口：最近 ${window.count} 条 / 约 ${window.chars} 字符，上限 ${maxChars} 字符`,
    contextTokens > 0
      ? `· 上下文预算：${contextTokens} tokens，超出后自动压缩并提示`
      : "· 上下文预算：未启用自动压缩",
    `· 模型视图字节上限：${transcriptBytes ?? "未设置"}`,
    `· 运行限制：最多 ${stepLimit} 步工具调用、单次超时 ${formatDuration(timeout)}、并发 ${concurrency}`,
    "· 记忆召回：运行前按消息检索 MEMORY.md、USER.md、memory/**/*.md 与群聊转录，命中才注入",
    "· 历史记录：消息不会自动删除；/new 把上一会话归档起来（文件保留），/clear 连文件成果一起归档，随时可恢复",
    "",
    "说明：字符与 token 为前端估算，实际上下文由服务端按运行时预算裁剪。",
  ].join("\n");
}

export interface ModelCommandPlan {
  kind: "list" | "set";
  /** 目标成员 id；`/model <ref>` 省略时落到主智能体。 */
  memberId?: string;
  ref?: string;
  error?: string;
}

/**
 * 解析 `/model` 的参数：
 * `@成员名 <ref>` 或 `<成员名> <ref>` 改指定成员，单个 ref 改主智能体，空参数列清单。
 */
export function parseModelCommand(args: string, members: Member[]): ModelCommandPlan {
  const text = args.trim();
  if (!text) return { kind: "list" };
  const [first, second, ...rest] = text.split(/\s+/);
  const looksLikeRef = !rest.length && (first?.includes("/") || first === "default");
  if (second === undefined || looksLikeRef) {
    const ref = looksLikeRef ? first : text;
    const main = members.find((member) => member.role === "main");
    if (!main) return { kind: "list", error: "没有找到主智能体" };
    return { kind: "set", memberId: main.id, ref };
  }
  const wanted = (first ?? "").replace(/^@/, "");
  const target = members.find((member) => member.name.toLowerCase() === wanted.toLowerCase());
  if (!target) return { kind: "list", error: `没有找到成员 @${wanted}` };
  if (target.role === "main") return { kind: "list", error: "主智能体直接用 /model <模型引用>" };
  return { kind: "set", memberId: target.id, ref: [second, ...rest].join(" ") };
}

/** `/model` 的清单：默认模型、可选引用、每个成员当前用哪个。 */
export function buildModelReport(data: CommandData): string {
  const settings = data.settings;
  const lines = ["模型"];
  if (!settings) {
    lines.push("· 设置还没加载完，稍后再试");
    return lines.join("\n");
  }
  lines.push(`· 默认：${settings.selection.defaultModel}`);
  if (settings.selection.fallbacks.length > 0) {
    lines.push(`· 备用：${settings.selection.fallbacks.join("、")}`);
  }
  const aliases = Object.entries(settings.selection.aliases);
  if (aliases.length > 0) {
    lines.push(`· 别名：${aliases.map(([key, value]) => `${key}→${value}`).join("、")}`);
  }
  for (const provider of settings.providers) {
    if (provider.models.length === 0) {
      lines.push(`· ${provider.id}：还没有登记模型`);
      continue;
    }
    lines.push(
      `· ${provider.id}（${provider.api}）：${provider.models
        .map((model) =>
          model.contextWindow ? `${model.id} · ${Math.round(model.contextWindow / 1000)}k` : model.id,
        )
        .join("、")}${provider.hasApiKey || provider.api === "mock" || provider.auth === "none" ? "" : "（未配置密钥）"}`,
    );
  }
  lines.push(
    `· 成员：${data.members
      .map((member) => `${member.name}→${member.modelRef}`)
      .join("、")}`,
  );
  lines.push("", "用法：/model <模型引用> 改主智能体；/model @成员 <模型引用> 改某个成员。");
  return lines.join("\n");
}

export function buildHelpReport(): string {
  const posted = SLASH_COMMANDS.filter((command) => command.runScope);
  const local = SLASH_COMMANDS.filter((command) => !command.runScope);
  const line = (command: SlashCommandDef) => `· ${command.usage} — ${command.summary}`;
  return [
    "可用命令",
    ...(local.length > 0 ? ["", "本机执行，不会作为聊天消息发给智能体：", ...local.map(line)] : []),
    ...(posted.length > 0
      ? ["", "发给智能体的一轮，命令文字照常是这一轮的议题，只是工具集被收窄：", ...posted.map(line)]
      : []),
    "",
    "/new 只把聊天记录与任务卡归档起来，文件工作区、成员与智能体记忆都不动，适合换一个新任务；/clear 连文件成果一起归档。",
    "/clear 与 /stop 会影响正在运行的成员；两者归档的内容都能在右侧「归档」恢复，智能体记忆不受影响。",
    "/plan 那一轮里智能体只能读、只能写 plans/ 下的计划文件、只能建任务卡，@ 成员也不会唤醒他们；批准之后再用普通消息让它开工。",
  ].join("\n");
}
