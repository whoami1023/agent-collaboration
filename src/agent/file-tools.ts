import {
  MAX_TEXT_BYTES,
  WorkspaceFileError,
  type WorkspaceFiles,
} from "../files/workspace-files";
import type { ToolImpl } from "./loop";

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

export function buildFileTools(files: WorkspaceFiles): ToolImpl[] {
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
        if (!relPath) return "错误：path 不能为空";
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
          return `读取失败：${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      schema: {
        name: "file_write",
        description:
          "把文本成果写进文件工作区，用户可在右侧「文件」标签页查看和下载。用于报告、数据表、代码等产出。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件相对路径，如 reports/summary.md；子目录会自动创建" },
            content: { type: "string", description: "完整文本内容（UTF-8）" },
            overwrite: { type: "boolean", description: "文件已存在时是否覆盖，默认 false" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const relPath = readString(args, "path");
        if (!relPath) return "错误：path 不能为空";
        const content = readText(args, "content");
        if (content === undefined) return "错误：content 不能为空";
        const sizeBytes = Buffer.byteLength(content, "utf8");
        if (sizeBytes > MAX_TEXT_BYTES) {
          return `错误：文本文件不能超过 ${MAX_TEXT_BYTES / 1024} KB；更大的内容请拆成多个文件。`;
        }
        try {
          const saved = await files.write(relPath, Buffer.from(content, "utf8"), {
            overwrite: args["overwrite"] === true,
          });
          return `已写入 files/${saved.path}（${formatSize(saved.sizeBytes)}，${content.split("\n").length} 行）。` +
            "用户可在右侧「文件工作区」查看和下载。";
        } catch (err) {
          if (err instanceof WorkspaceFileError && err.status === 409) {
            return `写入失败：${err.message}。如果确实要替换，请传入 overwrite=true。`;
          }
          return `写入失败：${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}
