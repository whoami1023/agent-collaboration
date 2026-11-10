import {
  MAX_TEXT_BYTES,
  WorkspaceFileError,
  type WorkspaceFiles,
} from "../files/workspace-files";
import type { EvidenceLedger } from "./evidence";
import type { ToolImpl } from "./loop";
import { toolFailureText } from "./tool-errors";

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
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
          "读取文件工作区里的文本文件。用户上传的资料、其他成员写出的成果都可以读；二进制文件只能提示大小。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件相对路径，如 reports/a.md" },
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
        try {
          const file = await files.read(relPath, { maxBytes: MAX_TEXT_BYTES });
          if (file.preview === "image") {
            return `文件 ${file.path} 是图片（${formatSize(file.sizeBytes)}），无法作为文本读取；请让用户在右侧「文件工作区」预览或下载。`;
          }
          if (file.binary) {
            return `文件 ${file.path} 是二进制内容（${formatSize(file.sizeBytes)}），无法作为文本读取；请让用户下载查看。`;
          }
          return `文件 ${file.path}（${formatSize(file.sizeBytes)}）：\n\n${file.content}${
            file.truncated ? "\n\n（内容超过 1 MB，已截断）" : ""
          }`;
        } catch (err) {
          return fileFailure(err, "read");
        }
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
