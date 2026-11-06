/**
 * 建议视角（移植 Hermes 的 `_reference_messages` / `_trim_messages_for_reference`）。
 *
 * 顾问拿到的不是执行成员的完整上下文，而是一份刻意削薄的材料：
 * 系统提示词一概不给（那是执行者的角色设定，不是事实）、房间里的系统播报不给（那是界面噪音）、
 * 单条消息按「头部 + 尾部 + 中间省略」截断——长篇汇报的结论通常在头尾，中间是大段过程。
 */

import type { RoomMessage } from "../../core/types";
import { clock } from "../prompts";

export const ADVISOR_VIEW_LIMITS = {
  /** 最多回看 20 条：参谋要的是来龙去脉，不是全部流水。 */
  recentMessages: 20,
  /** 单条材料的头尾预算：合起来 4000 字，超过就掐中间。 */
  headChars: 2_000,
  tailChars: 2_000,
  /** 整份材料的预算：超了从最旧的开始丢，任务本身永远保留。 */
  totalChars: 20_000,
} as const;

/** 掐中间留头尾，并如实写出省略了多少字——让顾问知道材料不完整。 */
export function truncateMiddle(
  text: string,
  headChars: number = ADVISOR_VIEW_LIMITS.headChars,
  tailChars: number = ADVISOR_VIEW_LIMITS.tailChars,
): string {
  const limit = headChars + tailChars;
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, headChars)}\n[…… 中间省略 ${omitted} 字 ……]\n${text.slice(-tailChars)}`;
}

/** 房间消息 → 顾问视角的一行；系统播报与空消息直接不要。 */
function advisorLine(message: RoomMessage): string | undefined {
  if (message.senderKind === "system") return undefined;
  const text = message.text.trim();
  if (!text) return undefined;
  const who =
    message.senderKind === "user"
      ? `${message.senderName || "用户"}（用户）`
      : `@${message.senderName}`;
  return `[${clock(message.ts)}] ${who}：${truncateMiddle(text)}`;
}

/**
 * 组装递给顾问的材料：先按条数取最近的，再按总字数预算从最旧的开始丢。
 * 任务那条（`taskLine`）永远在最前面且不受预算挤压——把问题本身挤没了，建议就没有意义。
 */
export function buildAdvisoryView(params: {
  messages: readonly RoomMessage[];
  taskLine: string;
}): string {
  const picked: string[] = [];
  let used = params.taskLine.length;
  const window = params.messages
    .slice(-ADVISOR_VIEW_LIMITS.recentMessages)
    .map(advisorLine)
    .filter((line): line is string => !!line);
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const line = window[index];
    if (!line) continue;
    if (used + line.length > ADVISOR_VIEW_LIMITS.totalChars) break;
    picked.unshift(line);
    used += line.length;
  }
  const dropped = window.length - picked.length;
  const head = dropped > 0 ? `（更早 ${dropped} 条已省略）\n` : "";
  return `${params.taskLine}\n\n${head}${picked.length > 0 ? `群聊最近的记录：\n${picked.join("\n")}` : ""}`;
}
