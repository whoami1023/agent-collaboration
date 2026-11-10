/**
 * 工具输出存档的两个只读工具：检索与按行读取。
 *
 * 存档本身由 content/offload.ts 负责；这里只做参数校验、成员隔离与展示格式。
 * 选中的原文段在这里逐个套外部内容信封——它们来自网页、文件或命令输出，
 * 不能因为多转了一道存档就失去「只作为资料」的边界。
 */
import type { ToolImpl } from "../loop";
import { toolFailureText } from "../tool-errors";
import { guardExternalContent } from "./envelope";
import { formatByteSize, formatSpanLabel, isOutputId, type OutputSearchSort, type ToolOutputStore } from "./offload";

const SORTS: OutputSearchSort[] = ["relevance", "recent", "fused"];

export interface OutputToolDeps {
  store: ToolOutputStore;
  /** 存档按成员隔离：只在这个成员自己的输出里检索与读取。 */
  memberId: string;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLine(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.round(value));
}

export function buildOutputTools(deps: OutputToolDeps): ToolImpl[] {
  return [
    {
      schema: {
        name: "output_search",
        description:
          "在工具输出存档里检索。单次输出过大时，上下文只保留相关片段，完整内容存档为 out_xxx；用它找到其余部分，再用 output_read 读取相邻行。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "检索词：错误原文、函数名、字段名或关键短语，越具体越好",
            },
            id: { type: "string", description: "可选：只检索某一份存档，如 out_ab12cd34ef56" },
            limit: { type: "number", description: "可选：返回段数，默认 5，最多 10" },
            sort: {
              type: "string",
              enum: SORTS,
              description:
                "可选：排序方式。fused（默认）综合相关度与新近；relevance 只看相关度；recent 只看哪份输出更新",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const query = readString(args, "query");
        if (!query) {
          return toolFailureText("invalid_argument", "query 不能为空", {
            next: "传一个具体关键词、错误原文或字段名。",
          });
        }
        const id = readString(args, "id");
        if (id !== undefined && !isOutputId(id)) {
          return toolFailureText("invalid_argument", `存档 id 不合法：${id}`, {
            next: "存档 id 形如 out_ab12cd34ef56，从大输出提示或输出列表里取。",
          });
        }
        const limit = typeof args["limit"] === "number" ? (args["limit"] as number) : undefined;
        const rawSort = readString(args, "sort");
        if (rawSort !== undefined && !SORTS.includes(rawSort as OutputSearchSort)) {
          return toolFailureText("invalid_argument", `sort 只能是 ${SORTS.join(" / ")}`, {
            next: "不确定时省略 sort，默认会综合相关度与输出新近程度。",
          });
        }
        const hits = await deps.store.search(deps.memberId, query, {
          ...(id ? { id } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(rawSort ? { sort: rawSort as OutputSearchSort } : {}),
        });
        if (hits.length === 0) {
          return (
            `没有找到匹配的工具输出（关键词：${query}${id ? `，存档 ${id}` : ""}）。` +
            "可以换更短的关键词，或直接用 output_read 按 id 读取。"
          );
        }
        const records = new Set(hits.map((hit) => hit.record.id));
        const blocks = hits.map(
          (hit) =>
            `${formatSpanLabel(hit.record.id, hit.span)}（${hit.record.tool}，共 ${hit.record.lines} 行）\n` +
            guardExternalContent("tool_output", hit.text),
        );
        return [
          `在 ${records.size} 份工具输出里找到 ${hits.length} 段（关键词：${query}）：`,
          ...blocks,
          "（需要相邻上下文时用 output_read(id=\"…\", start_line=…, end_line=…)。）",
        ].join("\n\n");
      },
    },
    {
      schema: {
        name: "output_read",
        description:
          "按行读取一份工具输出存档（out_xxx）。不传行号时从第 1 行开始，单次最多返回约 16 KB；结果末尾会给出继续读取的下一行。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "存档 id，如 out_ab12cd34ef56" },
            start_line: { type: "number", description: "可选：起始行号（1 起始），默认 1" },
            end_line: { type: "number", description: "可选：结束行号（含）；省略时按字节上限尽量多读" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const id = readString(args, "id");
        if (!id) {
          return toolFailureText("invalid_argument", "id 不能为空", {
            next: "从大输出提示或 output_search 结果里取存档 id。",
          });
        }
        if (!isOutputId(id)) {
          return toolFailureText("invalid_argument", `存档 id 不合法：${id}`, {
            next: "存档 id 形如 out_ab12cd34ef56。",
          });
        }
        const result = await deps.store.read(
          deps.memberId,
          id,
          readLine(args, "start_line"),
          readLine(args, "end_line"),
        );
        if (!result) {
          return toolFailureText(
            "not_found",
            `没有找到工具输出存档 ${id}（可能已超过保留期限，或不属于当前成员）`,
            { next: "用 output_search 确认仍可用的存档 id，或重跑产生这份输出的命令。" },
          );
        }
        const body = guardExternalContent("tool_output", result.text);
        const nextLine = result.more ? result.endLine + 1 : undefined;
        return [
          `${id}（${result.record.tool}，共 ${result.record.lines} 行，${formatByteSize(
            result.record.bytes,
          )}）第 ${result.startLine}–${result.endLine} 行：`,
          body,
          nextLine
            ? `（本次读取到第 ${result.endLine} 行；继续读：output_read(id="${id}", start_line=${nextLine})）`
            : "（已读到末尾。）",
        ].join("\n\n");
      },
    },
  ];
}
