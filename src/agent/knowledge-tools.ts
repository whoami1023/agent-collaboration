import type { KnowledgeService } from "../knowledge/service";
import {
  PAGE_TYPE_LABELS,
  type KnowledgeBaseMeta,
  type KnowledgeSearchHit,
} from "../knowledge/types";
import type { ToolImpl } from "./loop";
import { toolFailureText } from "./tool-errors";

const MAX_READ_CHARS = 20_000;

function readArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 工具层只认库名或 ID；不传且只有一个库时用它，多个库就明确要求点名。 */
async function resolveBase(
  knowledge: KnowledgeService,
  ref: string | undefined,
): Promise<KnowledgeBaseMeta | string> {
  const bases = await knowledge.listBases();
  if (bases.length === 0) {
    return toolFailureText("not_found", "当前工作区还没有知识库", {
      next: "请用户在左侧「知识库」新建并导入材料，之后再来检索。",
    });
  }
  const base = await knowledge.findBase(ref);
  if (base) return base;
  if (!ref && bases.length > 1) {
    return toolFailureText(
      "invalid_argument",
      `有 ${bases.length} 个知识库，请用 base 参数指定一个`,
      { next: `可选：${bases.map((item) => `${item.name}（${item.id}）`).join("、")}` },
    );
  }
  return toolFailureText("not_found", `找不到知识库「${ref}」`, {
    next: `可选：${bases.map((item) => item.name).join("、")}`,
  });
}

function formatHits(hits: KnowledgeSearchHit[]): string {
  const byBase = new Map<string, { name: string; hits: KnowledgeSearchHit[] }>();
  for (const hit of hits) {
    const entry = byBase.get(hit.baseId) ?? { name: hit.baseName, hits: [] };
    entry.hits.push(hit);
    byBase.set(hit.baseId, entry);
  }
  const lines: string[] = [];
  for (const { name, hits: group } of byBase.values()) {
    lines.push(`知识库「${name}」命中 ${group.length} 页：`);
    for (const hit of group) {
      lines.push(
        `- ${hit.path}｜${hit.title}（${PAGE_TYPE_LABELS[hit.type]}）${hit.snippet ? `\n  ${hit.snippet}` : ""}`,
      );
    }
  }
  lines.push("", "读全文用 knowledge_read（传 path；多库时再传 base）。");
  return lines.join("\n");
}

export function buildKnowledgeTools(knowledge: KnowledgeService): ToolImpl[] {
  return [
    {
      retry: "safe",
      schema: {
        name: "knowledge_search",
        description:
          "在知识库里检索用户既往整理过的页面（关键词匹配标题、标签与正文）。需要旧资料、既有结论或此前导入的材料时先查这里，再去联网或重新分析。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "检索词，可用中文或英文短语" },
            base: {
              type: "string",
              description: "知识库名称或 ID；只有一个知识库时可省略，省略时检索全部知识库",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const query = readArg(args, "query");
        if (!query) return toolFailureText("invalid_argument", "query 不能为空");
        const baseRef = readArg(args, "base");
        let baseId: string | undefined;
        if (baseRef) {
          const base = await resolveBase(knowledge, baseRef);
          if (typeof base === "string") return base;
          baseId = base.id;
        }
        const result = await knowledge.searchDetailed(query, baseId);
        if (result.hits.length === 0) {
          return `（知识库中没有匹配「${query}」的页面）${
            result.warning ? `\n（${result.warning}）` : ""
          }`;
        }
        const excerpts: string[] = [];
        for (const hit of result.hits.slice(0, 3)) {
          try {
            const page = await knowledge.readPage(hit.baseId, hit.path);
            const body =
              page.body.length > 1_200 ? `${page.body.slice(0, 1_200)}\n（已截断）` : page.body;
            excerpts.push(`【${hit.path}】\n${body}`);
          } catch {
            // 页面在检索后消失：跳过摘录，命中列表仍可用。
          }
        }
        return [
          formatHits(result.hits),
          result.warning ? `（${result.warning}）` : "",
          excerpts.length > 0
            ? `相关正文摘录（先读这些，不够再用 knowledge_read 读全文）：\n\n${excerpts.join("\n\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      retry: "safe",
      schema: {
        name: "knowledge_read",
        description:
          "读取知识库页面的正文（含 frontmatter 之外的 Markdown）。先用 knowledge_search 或 knowledge_list 拿到 path。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "页面路径，如 concepts/xyz.md（来自检索结果）" },
            base: { type: "string", description: "知识库名称或 ID；只有一个知识库时可省略" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const path = readArg(args, "path");
        if (!path) return toolFailureText("invalid_argument", "path 不能为空");
        const base = await resolveBase(knowledge, readArg(args, "base"));
        if (typeof base === "string") return base;
        let page;
        try {
          page = await knowledge.readPage(base.id, path);
        } catch {
          const hits = await knowledge.search(path.replace(/\.md$/i, ""), base.id);
          return toolFailureText("not_found", `知识库「${base.name}」里没有页面 ${path}`, {
            next:
              hits.length > 0
                ? `相近页面：${hits.slice(0, 5).map((hit) => hit.path).join("、")}`
                : "先用 knowledge_list 查看页面清单。",
          });
        }
        const header = [
          `知识库「${base.name}」· ${page.path}`,
          `标题：${page.title}｜类型：${PAGE_TYPE_LABELS[page.type]}｜标签：${page.tags.join("、") || "无"}｜更新：${page.updated}`,
          page.links.length > 0 ? `链接：${page.links.join("、")}` : "",
          "---",
        ].filter(Boolean);
        const body =
          page.body.length > MAX_READ_CHARS
            ? `${page.body.slice(0, MAX_READ_CHARS)}\n\n（页面较长，已截断；其余部分请让用户在面板里查看）`
            : page.body;
        return [...header, body].join("\n");
      },
    },
    {
      retry: "safe",
      schema: {
        name: "knowledge_list",
        description:
          "查看知识库概况：不传 base 时列出所有知识库与规模；传 base 时列出该库的页面清单（可按类型筛选）。",
        parameters: {
          type: "object",
          properties: {
            base: { type: "string", description: "知识库名称或 ID；省略时列出所有知识库" },
            type: {
              type: "string",
              description: `只看某一类页面：${Object.keys(PAGE_TYPE_LABELS).join(" / ")}`,
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const baseRef = readArg(args, "base");
        if (!baseRef) {
          const bases = await knowledge.listBases();
          if (bases.length === 0) return "（当前工作区还没有知识库）";
          return [
            `知识库 ${bases.length} 个：`,
            ...bases.map(
              (base) =>
                `- ${base.name}（ID ${base.id}）：${base.pageCount} 页 / ${base.sourceCount} 份来源${
                  base.pendingCount > 0 ? ` / ${base.pendingCount} 份整理中` : ""
                }${base.description ? `；${base.description}` : ""}`,
            ),
          ].join("\n");
        }
        const base = await resolveBase(knowledge, baseRef);
        if (typeof base === "string") return base;
        const typeFilter = readArg(args, "type");
        let pages = await knowledge.listPages(base.id);
        if (typeFilter) {
          pages = pages.filter((page) => page.type === typeFilter);
        }
        if (pages.length === 0) {
          return `（知识库「${base.name}」没有${typeFilter ? `「${typeFilter}」类型的` : ""}页面）`;
        }
        const shown = pages.slice(0, 60);
        const lines = shown.map(
          (page) =>
            `- ${page.path}｜${page.title}（${PAGE_TYPE_LABELS[page.type]}）${
              page.summary ? `：${page.summary}` : ""
            }`,
        );
        return [
          `知识库「${base.name}」共 ${pages.length} 页${
            pages.length > shown.length ? `，只显示前 ${shown.length} 页` : ""
          }${typeFilter ? `（筛选：${typeFilter}）` : ""}：`,
          ...lines,
        ].join("\n");
      },
    },
  ];
}
