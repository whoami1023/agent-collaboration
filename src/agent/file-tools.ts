import {
  MAX_LINE_PAGE_LINES,
  MAX_TEXT_BYTES,
  WorkspaceFileError,
  type WorkspaceFiles,
} from "../files/workspace-files";
import type { EvidenceLedger } from "./evidence";
import type { ToolImpl } from "./loop";
import { toolFailureText } from "./tool-errors";
import { guardExternalContent } from "./content/envelope";
import { rankTextChunks } from "./content/offload";

/** 超过这个大小就不再整份读：先检索或分页，避免把大文件灌进上下文。 */
export const MAX_DIRECT_READ_BYTES = 64 * 1024;
/** 文件检索的扫描上限：单文件 256 KB、总量 8 MB、最多 200 个文件。 */
const MAX_SEARCH_FILES = 200;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 8 * 1024 * 1024;
/** 检索默认返回 6 段，同一文件最多 2 段，避免一份大文档挤掉其他来源。 */
const MAX_SEARCH_HITS = 6;
const MAX_SEARCH_HITS_PER_FILE = 2;

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/** 行号参数：缺省返回 undefined，非正整数返回 "invalid"。 */
function readLineNumber(args: Record<string, unknown>, key: string): number | "invalid" | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return "invalid";
  return Math.round(value);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function normalizePrefix(raw: string | undefined): string {
  return (raw ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** 把工作区文件错误映射成稳定的 code 与下一步建议。 */
function fileFailure(err: unknown, action: "read" | "write"): string {
  const status = err instanceof WorkspaceFileError ? err.status : 0;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404) {
    return toolFailureText("not_found", message, {
      next: "先用 file_list 查看文件工作区里的真实路径，再按原路径重试。",
    });
  }
  if (status === 409) {
    return toolFailureText("conflict", message, {
      next:
        action === "write"
          ? "确实要替换就传 overwrite=true；要在末尾续写就传 append=true。"
          : "换一个目标路径，或先读取现有内容确认是否要覆盖。",
    });
  }
  if (status === 413) {
    return toolFailureText("invalid_argument", message, {
      next: "把内容拆成多个文件分节写入，或先精简再提交。",
    });
  }
  if (status === 400 && /越出|不允许|符号链接/u.test(message)) {
    return toolFailureText("permission_denied", message, {
      next: "只能使用 files/ 下的相对路径，并避开符号链接。",
    });
  }
  if (status === 400) {
    return toolFailureText("invalid_argument", message, {
      next: "检查路径：使用不以 / 开头的相对路径，如 reports/a.md。",
    });
  }
  return toolFailureText("tool_failed", `${action === "read" ? "读取" : "写入"}失败：${message}`, {
    next: "先回读确认文件是否已存在；仍失败就如实报告错误原文，不要反复重试同一调用。",
  });
}

export function buildFileTools(files: WorkspaceFiles, evidence?: EvidenceLedger): ToolImpl[] {
  return [
    {
      schema: {
        name: "file_list",
        description:
          "查看文件工作区里的文件清单。用户上传的文件和你写出的成果都在这里（右侧「文件」标签页）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "可选：只看某个子目录，如 reports" },
          },
          required: [],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const prefix = normalizePrefix(readString(args, "path"));
        const listing = await files.list();
        const visible = prefix
          ? listing.files.filter(
              (file) => file.path === prefix || file.path.startsWith(`${prefix}/`),
            )
          : listing.files;
        if (visible.length === 0) {
          return prefix
            ? `文件工作区里没有 ${prefix}/ 下的内容。可用 file_list 不带参数查看全部文件。`
            : "文件工作区目前是空的。用户上传文件或用 file_write 写出成果后，文件会出现在这里。";
        }
        const lines = visible.map((file) =>
          file.kind === "dir"
            ? `- ${file.path}/`
            : `- ${file.path}（${formatSize(file.sizeBytes)}${file.updatedAt ? ` · ${formatTime(file.updatedAt)}` : ""}）`,
        );
        const note = listing.truncated ? "\n\n（清单已达到 500 项上限，请用 path 参数缩小范围）" : "";
        return `文件工作区（相对路径，根目录为 files/）：\n${lines.join("\n")}${note}`;
      },
    },
    {
      schema: {
        name: "file_read",
        description:
          "读取文件工作区里的文本文件。大于 64 KB 的文件不再整份读取：先用 file_search 定位，或传 start_line/end_line 分页读。二进制与图片只能提示大小。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件相对路径，如 reports/a.md" },
            start_line: { type: "number", description: "可选：起始行号（1 起始），与 end_line 一起分页读取" },
            end_line: { type: "number", description: "可选：结束行号（含）；不传则按单页上限尽量多读" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const relPath = readString(args, "path");
        if (!relPath) {
          return toolFailureText("invalid_argument", "path 不能为空", {
            next: "传入文件工作区里的相对路径，如 reports/a.md。",
          });
        }
        const startLine = readLineNumber(args, "start_line");
        const endLine = readLineNumber(args, "end_line");
        if (startLine === "invalid" || endLine === "invalid") {
          return toolFailureText("invalid_argument", "start_line / end_line 必须是大于 0 的整数", {
            next: "行号从 1 开始；例如 start_line=101, end_line=200。",
          });
        }
        if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
          return toolFailureText("invalid_argument", "end_line 不能小于 start_line", {
            next: "交换两个行号，或只传 start_line 让工具按页读取。",
          });
        }
        try {
          // 先用 1 字节探出大小与图片类型，避免为了判断「要不要整份读」先读一遍全文。
          const head = await files.read(relPath, { maxBytes: 1 });
          if (head.preview === "image") {
            return `文件 ${head.path} 是图片（${formatSize(head.sizeBytes)}），无法作为文本读取；请让用户在右侧「文件工作区」预览或下载。`;
          }
          const wantsRange = startLine !== undefined || endLine !== undefined;
          if (!wantsRange && head.sizeBytes > MAX_DIRECT_READ_BYTES) {
            return toolFailureText(
              "invalid_argument",
              `文件 ${head.path} 有 ${formatSize(head.sizeBytes)}，超过单次整份读取上限 ${formatSize(MAX_DIRECT_READ_BYTES)}`,
              {
                why: "整份读会占满上下文，后面的工作就没有空间了。",
                next: `先用 file_search(query="关键词", path="${head.path}") 定位相关段落，或 file_read(path="${head.path}", start_line=1, end_line=200) 分页读取。`,
                verify: "分页读取会给出本页行号与下一页的起点。",
              },
            );
          }
          if (wantsRange) {
            const page = await files.readLines(relPath, {
              ...(startLine !== undefined ? { startLine } : {}),
              ...(endLine !== undefined ? { endLine } : {}),
            });
            if (page.binary) {
              return `文件 ${page.path} 是二进制内容（${formatSize(page.sizeBytes)}），无法作为文本读取；请让用户下载查看。`;
            }
            const lastLine = Math.max(page.startLine, page.endLine);
            const body = page.text || "（该范围内没有内容）";
            const hint = page.more
              ? `（还有更多内容：file_read(path="${page.path}", start_line=${page.endLine + 1}, end_line=${
                  page.endLine + MAX_LINE_PAGE_LINES
                })）`
              : "（已读到末尾。）";
            return `文件 ${page.path}（${formatSize(page.sizeBytes)}）第 ${page.startLine}–${lastLine} 行：\n\n${body}\n\n${hint}`;
          }
          const file = await files.read(relPath, { maxBytes: MAX_TEXT_BYTES });
          if (file.binary) {
            return `文件 ${file.path} 是二进制内容（${formatSize(file.sizeBytes)}），无法作为文本读取；请让用户下载查看。`;
          }
          return `文件 ${file.path}（${formatSize(file.sizeBytes)}）：\n\n${file.content}${
            file.truncated ? "\n\n（内容超过 1 MB，已截断；请用 start_line/end_line 分页读取完整内容）" : ""
          }`;
        } catch (err) {
          return fileFailure(err, "read");
        }
      },
    },
    {
      schema: {
        name: "file_search",
        description:
          "在文件工作区的文本文件里检索内容，返回命中的文件、行区间与片段。适合先定位再分页读取，不必把大文件整份读进上下文。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "检索词：错误原文、字段名、章节标题或关键短语，越具体越好",
            },
            path: { type: "string", description: "可选：只搜某个子目录或文件，如 reports 或 reports/a.md" },
            limit: { type: "number", description: "可选：返回段数，默认 6，最多 10" },
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
        const prefix = normalizePrefix(readString(args, "path"));
        const rawLimit = args["limit"];
        const limit =
          typeof rawLimit === "number" && Number.isFinite(rawLimit)
            ? Math.min(10, Math.max(1, Math.round(rawLimit)))
            : MAX_SEARCH_HITS;
        const listing = await files.list();
        const candidates = listing.files
          .filter(
            (file) =>
              file.kind === "file" &&
              (!prefix || file.path === prefix || file.path.startsWith(`${prefix}/`)),
          )
          .slice(0, MAX_SEARCH_FILES);
        const hits: Array<{
          path: string;
          span: { startLine: number; endLine: number };
          score: number;
          text: string;
          partial: boolean;
        }> = [];
        let totalBytes = 0;
        for (const candidate of candidates) {
          if (totalBytes >= MAX_SEARCH_TOTAL_BYTES) break;
          const file = await files
            .read(candidate.path, { maxBytes: MAX_SEARCH_FILE_BYTES })
            .catch(() => undefined);
          if (!file || file.binary || file.preview !== "text") continue;
          totalBytes += Buffer.byteLength(file.content, "utf8");
          for (const chunk of rankTextChunks(file.content, query).slice(0, MAX_SEARCH_HITS_PER_FILE)) {
            hits.push({
              path: file.path,
              span: chunk.span,
              score: chunk.score,
              text: chunk.text,
              partial: file.truncated,
            });
          }
        }
        hits.sort(
          (a, b) =>
            b.score - a.score ||
            a.path.localeCompare(b.path) ||
            a.span.startLine - b.span.startLine,
        );
        const top = hits.slice(0, limit);
        if (top.length === 0) {
          return (
            `没有找到匹配的文件内容（关键词：${query}${prefix ? `，范围 ${prefix}` : ""}）。` +
            "可以换更短的关键词，或用 file_list 按文件名查找。"
          );
        }
        const filesHit = new Set(top.map((hit) => hit.path)).size;
        const blocks = top.map((hit) => {
          const label =
            `--- ${hit.path} 第 ${hit.span.startLine}–${hit.span.endLine} 行` +
            `${hit.partial ? "（大文件仅检索前 256 KB）" : ""} ---`;
          return `${label}\n${guardExternalContent("file_search", hit.text)}`;
        });
        return [
          `在工作区 ${filesHit} 个文件里找到 ${top.length} 段（关键词：${query}）：`,
          ...blocks,
          '（要看相邻上下文用 file_read(path="…", start_line=…, end_line=…)。）',
        ].join("\n\n");
      },
    },
    {
      schema: {
        name: "file_write",
        description:
          "把文本成果写进文件工作区，用户可在右侧「文件」标签页查看和下载。用于报告、方案、纪要、数据表、代码等产出；长文档可用 append 分节续写。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件相对路径，如 reports/summary.md；子目录会自动创建" },
            content: { type: "string", description: "完整文本内容（UTF-8）" },
            overwrite: { type: "boolean", description: "文件已存在时是否覆盖，默认 false" },
            append: {
              type: "boolean",
              description: "追加到文件末尾；不存在则新建。用于长文档分节续写，与 overwrite 互斥",
            },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const relPath = readString(args, "path");
        if (!relPath) {
          return toolFailureText("invalid_argument", "path 不能为空", {
            next: "传入目标文件的相对路径，如 reports/a.md。",
          });
        }
        const content = readText(args, "content");
        if (content === undefined) {
          return toolFailureText("invalid_argument", "content 不能为空", {
            next: "把要写入的完整文本放进 content；长文档可分段用 append 续写。",
          });
        }
        const append = args["append"] === true;
        const overwrite = args["overwrite"] === true;
        if (append && overwrite) return "错误：append 与 overwrite 不能同时使用";
        const sizeBytes = Buffer.byteLength(content, "utf8");
        if (sizeBytes > MAX_TEXT_BYTES) {
          return toolFailureText(
            "invalid_argument",
            `文本文件不能超过 ${MAX_TEXT_BYTES / 1024} KB`,
            { next: "把内容拆成多个文件，或用 append 分节续写。" },
          );
        }
        if (append) {
          const current = await files.read(relPath, { maxBytes: 1 }).catch(() => undefined);
          if (current && current.sizeBytes + sizeBytes > MAX_TEXT_BYTES) {
            return toolFailureText(
              "invalid_argument",
              `追加后文本文件会超过 ${MAX_TEXT_BYTES / 1024} KB`,
              { next: "拆成多个文件，或先精简现有内容再追加。" },
            );
          }
        }
        try {
          const saved = await files.write(relPath, Buffer.from(content, "utf8"), {
            overwrite,
            append,
          });
          // 交付闸门的证据：只有真的落盘成功才记账，路径用规范化后的相对路径。
          evidence?.record(
            "file",
            saved.path,
            `${append ? "追加" : "写入"} ${formatSize(saved.sizeBytes)}，${content.split("\n").length} 行`,
          );
          return `${append ? "已追加到" : "已写入"} files/${saved.path}（${formatSize(saved.sizeBytes)}，${content.split("\n").length} 行）。` +
            "用户可在右侧「文件工作区」查看和下载。";
        } catch (err) {
          return fileFailure(err, "write");
        }
      },
    },
  ];
}
