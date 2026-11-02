/**
 * 技能分类：内置技能按名称固定归类，用户技能可自选分类。
 * 分类 id 用于存储与 API，label 用于界面展示；新增分类时保持 id 稳定。
 */
export const SKILL_CATEGORY_IDS = [
  "planning",
  "research",
  "data",
  "engineering",
  "product",
  "design",
  "web",
  "agent",
  "other",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORY_IDS)[number];

export const DEFAULT_SKILL_CATEGORY: SkillCategory = "other";

export interface SkillCategoryInfo {
  id: SkillCategory;
  label: string;
  hint: string;
}

export const SKILL_CATEGORIES: readonly SkillCategoryInfo[] = [
  { id: "planning", label: "协同与规划", hint: "任务拆解、计划、分工与复盘" },
  { id: "research", label: "调研与写作", hint: "资料检索、事实核查、摘要与改写" },
  { id: "data", label: "数据分析", hint: "统计、SQL、指标、预测与实验分析" },
  { id: "engineering", label: "开发与测试", hint: "架构、接口、调试、测试与代码审查" },
  { id: "product", label: "产品与文档", hint: "需求、用户故事、会议纪要与文档" },
  { id: "design", label: "设计与可视化", hint: "界面、图表、无障碍与视觉产出" },
  { id: "web", label: "网页与检索", hint: "联网搜索、正文抓取与网页研究" },
  { id: "agent", label: "智能体与技能", hint: "技能设计、角色设定与提示词工程" },
  { id: "other", label: "其他", hint: "尚未归类的技能" },
] as const;

export const SKILL_CATEGORY_SET: ReadonlySet<string> = new Set(SKILL_CATEGORY_IDS);

/** 内置技能 → 分类。未收录的内置技能归入「其他」。 */
export const BUILTIN_SKILL_CATEGORIES: Readonly<Record<string, SkillCategory>> = {
  "task-breakdown": "planning",
  brainstorming: "planning",
  "implementation-plan": "planning",
  "parallel-dispatch": "planning",
  retro: "planning",

  "research-brief": "research",
  "grounded-citations": "research",
  "blocked-page-recovery": "research",
  "competitor-news-monitor": "research",
  "arxiv-research": "research",
  "competitive-analysis": "research",
  summarize: "research",
  humanizer: "research",
  "data-storytelling": "research",

  "data-analysis": "data",
  eda: "data",
  "statistical-analysis": "data",
  "experiment-design": "data",
  "product-analytics": "data",
  "sql-analysis": "data",
  "data-quality": "data",
  "kpi-dashboard": "data",
  forecasting: "data",
  "analytics-tracking": "data",
  "saas-metrics": "data",

  spike: "engineering",
  "debug-investigation": "engineering",
  "code-review": "engineering",
  verification: "engineering",
  "test-plan": "engineering",
  "api-design": "engineering",
  "architecture-review": "engineering",
  "error-handling": "engineering",
  adr: "engineering",
  "simplify-code": "engineering",
  healthcheck: "engineering",

  prd: "product",
  "user-story": "product",
  postmortem: "product",
  "document-to-action-items": "product",
  "meeting-action-items": "product",
  "docx-writer": "product",
  "docx-track-changes": "product",
  "docx-formula": "product",

  "docx-reader": "research",

  "diagram-maker": "design",
  "claude-design": "design",
  "accessibility-audit": "design",

  "web-search": "web",
  "web-fetch": "web",
  "web-browse": "web",

  "skill-creator": "agent",
  "role-designer": "agent",
  oracle: "agent",
  "prompt-engineering": "agent",
};

const CATEGORY_ALIASES: Readonly<Record<string, SkillCategory>> = {
  ...Object.fromEntries(SKILL_CATEGORIES.map((item) => [item.id, item.id])),
  ...Object.fromEntries(SKILL_CATEGORIES.map((item) => [item.label, item.id])),
  "task": "planning",
  workflow: "planning",
  writing: "research",
  docs: "product",
  documentation: "product",
  dev: "engineering",
  coding: "engineering",
  code: "engineering",
  testing: "engineering",
  ops: "engineering",
  analysis: "data",
  analytics: "data",
  statistics: "data",
  visualization: "design",
  ui: "design",
  social: "research",
  misc: "other",
  general: "other",
};

export function isSkillCategory(value: unknown): value is SkillCategory {
  return typeof value === "string" && SKILL_CATEGORY_SET.has(value);
}

/** 接受分类 id、中文标签或常见别名；无法识别时返回 undefined。 */
export function normalizeSkillCategory(raw: unknown): SkillCategory | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return CATEGORY_ALIASES[key] ?? (SKILL_CATEGORY_SET.has(key) ? (key as SkillCategory) : undefined);
}

export function builtinCategoryOf(name: string): SkillCategory {
  return BUILTIN_SKILL_CATEGORIES[name] ?? DEFAULT_SKILL_CATEGORY;
}

/**
 * 导入的 SKILL.md 常常没有 category：按名称与描述做保守归类，
 * 命中不了就归入「其他」，用户可在编辑里改。
 */
export function inferSkillCategory(name: string, description: string): SkillCategory {
  const text = `${name} ${description}`.toLowerCase();
  const rules: [SkillCategory, RegExp][] = [
    ["web", /\b(web|search|fetch|browse|crawl|scrap|url|http)\b|网页|搜索|抓取|联网|浏览器/],
    ["data", /\b(data|sql|analytic|statistic|forecast|metric|kpi|dashboard|etl)\b|数据|统计|指标|报表|预测/],
    [
      "engineering",
      /\b(code|debug|test|review|api|architect|refactor|deploy|performance)\b|代码|调试|测试|架构|接口|重构|部署/,
    ],
    ["design", /\b(design|diagram|figma|ui|ux|visual|a11y|accessibility)\b|设计|图表|可视化|无障碍|界面/],
    ["product", /\b(prd|product|roadmap|user story|meeting)\b|需求|产品|用户故事|路线图|会议|纪要/],
    ["research", /\b(research|arxiv|paper|cite|citation|competitive|summar)\b|调研|研究|论文|引用|竞品|摘要/],
    ["planning", /\b(plan|brainstorm|retro|task|dispatch|workflow)\b|计划|拆解|头脑风暴|复盘|分工|流程/],
    ["agent", /\b(skill|agent|prompt|role)\b|技能|智能体|角色|提示词/],
  ];
  for (const [category, pattern] of rules) {
    if (pattern.test(text)) return category;
  }
  return DEFAULT_SKILL_CATEGORY;
}
