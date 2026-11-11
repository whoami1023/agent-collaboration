/**
 * ask_user：把「需要用户决定」变成结构化提问，而不是群里一段容易被忽略的文字。
 *
 * 提出后本轮先收尾；用户答完全部问题，答案会作为一条用户消息 @ 提问者回到群里，
 * 由现有唤醒链路接着跑——提问本身不阻塞运行槽位。
 */
import type { Member } from "../core/types";
import type { RoomBus } from "../room/bus";
import {
  MAX_QUESTION_CHARS,
  parseQuestionFields,
  QUESTION_URGENCIES,
  type QuestionStore,
  type QuestionUrgency,
} from "../room/questions";
import type { ToolImpl } from "./loop";
import { toolFailureText } from "./tool-errors";

export interface QuestionToolDeps {
  bus: RoomBus;
  member: Member;
  questions: QuestionStore;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildQuestionTools(deps: QuestionToolDeps): ToolImpl[] {
  return [
    {
      // 重复提问会在房间里生成重复的问题卡。
      retry: "never",
      schema: {
        name: "ask_user",
        description:
          "向用户提出需要决定的结构化问题：1–4 个问题、每问 2–4 个选项，可标一个推荐项。提出后先收尾本轮；用户答完后你会被重新唤醒继续，不要在收到回答前按猜测往下做。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "可选：这组问题的标题，如「报告口径确认」" },
            questions: {
              type: "array",
              description: "要问的问题（1–4 个）",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "问题 id：1–40 位字母、数字、- 或 _" },
                  question: { type: "string", description: "题干，不超过 500 字" },
                  options: {
                    type: "array",
                    description: "选项（2–4 个）",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", description: "选项 id" },
                        label: { type: "string", description: "选项文字，不超过 75 字" },
                        recommended: { type: "boolean", description: "可选：标为推荐项（每题最多一个）" },
                      },
                      required: ["id", "label"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["id", "question", "options"],
                additionalProperties: false,
              },
            },
            unblocks: { type: "string", description: "可选：回答后能解锁什么，帮助用户判断优先级" },
            urgency: {
              type: "string",
              enum: ["routine", "urgent", "critical"],
              description: "可选：紧急度，默认 routine",
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const parsed = parseQuestionFields(args["questions"]);
        if (!parsed.ok) {
          return toolFailureText("invalid_argument", parsed.error, {
            next: "按 1–4 个问题、每问 2–4 个选项的格式重试；题干不超过 500 字，选项不超过 75 字。",
          });
        }
        const urgencyRaw = readString(args, "urgency");
        if (urgencyRaw !== undefined && !(QUESTION_URGENCIES as readonly string[]).includes(urgencyRaw)) {
          return toolFailureText("invalid_argument", `urgency 只能是 ${QUESTION_URGENCIES.join(" / ")}`, {
            next: "不紧急就省略 urgency。",
          });
        }
        const title = readString(args, "title");
        const unblocks = readString(args, "unblocks");
        const lines = [`【需要你回答】${(title ?? parsed.questions[0]!.question).slice(0, MAX_QUESTION_CHARS)}`];
        if (unblocks) lines.push(`回答后可以继续：${unblocks.slice(0, MAX_QUESTION_CHARS)}`);
        parsed.questions.forEach((field, index) => {
          lines.push(`${index + 1}. ${field.question}`);
          for (const option of field.options) {
            lines.push(`   - ${option.label}${option.recommended ? "（推荐）" : ""}`);
          }
        });
        lines.push("请在问题卡片里选择选项，或写下你的回答。");
        const message = deps.bus.append({
          senderId: deps.member.id,
          senderName: deps.member.name,
          senderKind: "member",
          kind: "question",
          text: lines.join("\n"),
          mentions: [],
          depthTurn: 0,
        });
        const item = deps.questions.ask({
          messageId: message.id,
          askerId: deps.member.id,
          askerName: deps.member.name,
          ...(title ? { title } : {}),
          questions: parsed.questions,
          ...(urgencyRaw ? { urgency: urgencyRaw as QuestionUrgency } : {}),
          ...(unblocks ? { unblocks } : {}),
        });
        return (
          `已向用户提出 ${item.questions.length} 个问题（提问 ${item.id}）。` +
          "本轮请先收尾，不要重复提问，也不要在收到回答前按猜测继续；用户答完后你会被重新唤醒。"
        );
      },
    },
  ];
}
