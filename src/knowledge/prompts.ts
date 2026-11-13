import type { KnowledgeBaseMeta, KnowledgePageMeta } from "./types";
import { PAGE_TYPE_DIRS, PAGE_TYPE_LABELS } from "./types";

/** 新库的默认用途文件：用户可以改，改完下一轮摄入就按新约束走。 */
export const DEFAULT_PURPOSE = `# 知识库用途

- 记录这个知识库服务什么工作：要回答哪些问题、给谁看、哪些内容值得长期保留。
- 一段材料值不值得整理成页面，以这里写的边界为准；不相关的内容只留来源摘要。
`;

function typeTable(): string {
  return Object.entries(PAGE_TYPE_DIRS)
    .map(([type, dir]) => `| ${PAGE_TYPE_LABELS[type as keyof typeof PAGE_TYPE_LABELS]} | ${dir}/ |`)
    .join("\n");
}

/** 新库的默认 schema：页面类型、目录与命名约束。系统按它校正模型给的路径。 */
export const DEFAULT_SCHEMA = `# 页面规则

| 类型 | 目录 |
| --- | --- |
${typeTable()}

- 文件名用中文或英文小写，词间用连字符，例如 \`entities/openclaw.md\`、\`concepts/上下文预算.md\`。
- 每页必须有 YAML frontmatter：\`type\`、\`title\`、\`tags\`、\`related\`、\`sources\`、\`created\`、\`updated\`。
- 来源材料只读保存在 \`raw/sources/\`，不要试图改写；wiki 页面是对材料的整理与综合。
- 同一主题优先更新已有页面，不要为同义名称新建重复页面。
- 页面之间用 \`[[路径]]\` 互链；不确定的说法标「存疑」，有冲突时在相关页面写明两种说法及出处。
`;

export const KNOWLEDGE_ANALYSIS_SYSTEM = `你是知识库的结构化分析器。你的唯一任务是读完材料后给出整理计划，输出一个 JSON 对象。

硬性要求：
- 只输出 JSON，不要 Markdown 围栏以外的解释，不要调用工具，不要声称已经写入任何文件。
- 只依据给定材料与已有页面判断，不要补充材料里没有的事实；不确定的内容写进 uncertainties。
- 页面路径使用「目录/文件名.md」，目录只能是 sources、entities、concepts、queries、comparisons、syntheses、notes。
- 已有页面已经覆盖同一主题时，优先规划「更新」而不是新建重复页。
- 来源摘要页固定为 sources/<来源短名>.md，必须出现在 pages 列表里，action 为 create 或 update。
- 只有确实需要人工判断时才产出 reviews（0–3 条）：材料互相矛盾、概念命名冲突、或明显缺口需要补资料。不需要就给空数组。
  - kind：create-page（值得单独建页但材料不足）、research（需要补充外部资料）、skip（建议忽略）。
  - research 必须给出搜索引擎友好的 query；create-page / skip 可以不填 query。

JSON 形状：
{
  "summary": "3-6 句话概括材料讲了什么、结论是什么",
  "key_points": ["可独立成立的事实或结论", "..."],
  "entities": [{"name": "实体名", "kind": "人物/组织/产品/地点/事件", "note": "为什么值得单独成页"}],
  "concepts": [{"name": "概念名", "note": "该概念在本材料里的含义"}],
  "uncertainties": ["材料没讲清或互相矛盾的地方"],
  "pages": [
    {
      "path": "entities/example.md",
      "type": "entity",
      "title": "页面标题",
      "tags": ["标签"],
      "related": ["concepts/example.md"],
      "action": "create 或 update",
      "brief": "这页要写什么、与已有页面是什么关系"
    }
  ],
  "reviews": [
    {
      "kind": "create-page 或 research 或 skip",
      "title": "一句话说明要看什么",
      "reason": "为什么需要人判断",
      "query": "research 时的检索词"
    }
  ]
}`;

export const KNOWLEDGE_GENERATION_SYSTEM = `你是知识库的撰写者。根据分析计划与原始材料写出 wiki 页面，输出若干 FILE 块。

硬性要求：
- 每个文件都必须完整：YAML frontmatter + Markdown 正文。不要只写片段，也不要输出 diff。
- 只写给定材料能支持的内容；推断要标明「推断」，材料没讲清的写进「存疑」小节。
- 来源 ID 必须原样写进 frontmatter 的 sources 列表，不要改写 ID。
- 页面之间用 [[路径]] 互链；链接目标必须是计划里列出的页面或已有页面。
- 不要输出 index.md、log.md、overview.md；这三个文件由系统生成。
- 不要声称执行了命令或访问了网络；你只做整理与写作。
- 输出格式严格如下，块与块之间不要夹解释：

---FILE: entities/example.md---
---
type: entity
title: 示例
tags: [标签]
related: [concepts/example.md]
sources: [src_xxxxxxxxxxxx]
created: 2026-01-01
updated: 2026-01-01
---
# 示例

正文……
---END FILE---`;

export interface AnalysisInput {
  base: KnowledgeBaseMeta;
  sourceId: string;
  sourceTitle: string;
  sourceText: string;
  indexText: string;
  purpose: string;
  schema: string;
  existingPages: KnowledgePageMeta[];
  today: string;
  truncated: boolean;
}

export function buildAnalysisPrompt(input: AnalysisInput): string {
  const { base, sourceId, sourceTitle, sourceText, indexText, purpose, schema, existingPages, today, truncated } =
    input;
  const existing =
    existingPages.length > 0
      ? existingPages
          .slice(0, 40)
          .map((page) => `- ${page.path} — ${page.title}（${PAGE_TYPE_LABELS[page.type]}，更新于 ${page.updated}）`)
          .join("\n")
      : "- （暂无页面）";
  return [
    `知识库：${base.name}`,
    base.description ? `说明：${base.description}` : "",
    "",
    "## 用途约束（purpose.md）",
    purpose.trim() || "（未填写，按通用知识整理）",
    "",
    "## 页面规则（schema.md）",
    schema.trim(),
    "",
    "## 已有页面",
    existing,
    "",
    "## 当前内容索引",
    indexText.trim() || "（索引为空）",
    "",
    "## 本次材料",
    `来源 ID：${sourceId}`,
    `标题：${sourceTitle}`,
    `日期：${today}`,
    truncated ? `注意：材料超过单次处理上限，以下内容已截断，只能基于可见部分整理。` : "",
    "```text",
    sourceText,
    "```",
    "",
    "请按规定 JSON 形状输出整理计划。来源摘要页请使用路径 sources/" +
      `${sourceId.replace(/^src_/, "source-")}.md（文件名可读即可，但必须落在 sources/ 下）。`,
  ].join("\n");
}

export interface GenerationInput {
  base: KnowledgeBaseMeta;
  sourceId: string;
  sourceTitle: string;
  sourceText: string;
  analysis: unknown;
  referencePages: Array<{ meta: KnowledgePageMeta; body: string }>;
  today: string;
  truncated: boolean;
}

export function buildGenerationPrompt(input: GenerationInput): string {
  const { base, sourceId, sourceTitle, sourceText, analysis, referencePages, today, truncated } = input;
  const references = referencePages
    .map(
      (page) =>
        `### 已有页面：${page.meta.path}（${page.meta.title}）\n` +
        "```markdown\n" +
        page.body +
        "\n```",
    )
    .join("\n\n");
  return [
    `知识库：${base.name}`,
    `来源 ID：${sourceId}`,
    `来源标题：${sourceTitle}`,
    `日期：${today}`,
    truncated ? "注意：材料超过单次处理上限，以下内容已截断。" : "",
    "",
    "## 整理计划（JSON）",
    "```json",
    JSON.stringify(analysis, null, 2),
    "```",
    references ? `\n## 需要更新或参考的既有页面\n${references}` : "",
    "",
    "## 原始材料",
    "```text",
    sourceText,
    "```",
    "",
    "请按计划的页面清单输出完整 FILE 块。frontmatter 的 sources 一律写上面的来源 ID；",
    "来源摘要页要与原始材料同名同主题，作为其他页面的入口。",
  ].join("\n");
}

export interface SourceSummaryInput {
  sourceId: string;
  sourceTitle: string;
  summary: string;
  keyPoints: string[];
  uncertainties: string[];
  pagePaths: string[];
  today: string;
}

/** 来源摘要兜底：模型漏写来源页时，用分析结果拼一份最小但可用的摘要页。 */
export function buildSourceSummaryPage(input: SourceSummaryInput): string {
  const { sourceId, sourceTitle, summary, keyPoints, uncertainties, pagePaths, today } = input;
  const lines = [
    "---",
    "type: source",
    `title: ${JSON.stringify(sourceTitle)}`,
    "tags: [来源摘要]",
    `related: [${pagePaths.map((path) => JSON.stringify(path)).join(", ")}]`,
    `sources: [${sourceId}]`,
    `created: ${today}`,
    `updated: ${today}`,
    "---",
    "",
    `# ${sourceTitle}`,
    "",
    "> 这是系统生成的来源摘要页；原始材料作为只读文件保存在知识库的 raw/sources/ 下。",
    "",
    "## 摘要",
    "",
    summary.trim() || "（模型未给出摘要，请打开原始材料核对。）",
  ];
  if (keyPoints.length > 0) {
    lines.push("", "## 要点");
    for (const point of keyPoints) lines.push(`- ${point}`);
  }
  if (pagePaths.length > 0) {
    lines.push("", "## 关联页面");
    for (const path of pagePaths) lines.push(`- [[${path.replace(/\.md$/i, "")}]]`);
  }
  if (uncertainties.length > 0) {
    lines.push("", "## 存疑");
    for (const item of uncertainties) lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

export const KNOWLEDGE_RESEARCH_PLAN_SYSTEM = `你是知识库的研究计划器。根据研究主题、知识库用途与现有总览，给出 2–3 条搜索引擎友好的查询。

硬性要求：
- 只输出 JSON：{"queries": ["查询 1", "查询 2"]}，不要解释、不要 Markdown 围栏。
- 查询要具体：包含领域词、时间范围或对比对象，避免「是什么」这类泛问。
- 不要重复同义查询；优先补知识库里缺的角度。`;

export function buildResearchPlanPrompt(input: {
  topic: string;
  purpose: string;
  overview: string;
}): string {
  const overview = input.overview.trim().slice(0, 2_000);
  return [
    `研究主题：${input.topic}`,
    "",
    "## 知识库用途（purpose.md）",
    input.purpose.trim() || "（未填写）",
    "",
    "## 当前总览（overview.md 节选）",
    overview || "（知识库还没有页面）",
    "",
    "请给出 2–3 条查询，覆盖：主题的核心事实、与现有页面的差异/冲突、以及一个值得补充的新角度。",
  ].join("\n");
}
