// 按「功能描述」挑选合适的技能：新建成员时不再一股脑启用全部技能，
// 而是像人招人那样，看职责挑顺手的那几件工具。
//
// 打分思路（三档信号，从强到弱）：
//   · 技能名命中描述里的词：名字是最强的意图信号，整词与拆词（web-fetch → web/fetch）都算；
//   · 分类倾向：描述与该技能分类的名称+说明（如「网页与检索 · 联网搜索、正文抓取」）的重合度，
//     这是跨语言的关键——中文描述不会出现 fetch，但会出现「正文抓取」；
//   · 技能描述命中：补足 "分析销售数据" 这类间接说法。
// 每一档都有上限，避免「描述写得长」本身变成加分项，把无关技能挤进前列。
// 中英文混排：英文按单词切（连字符、点、下划线也切），中文按二元组（bigram）切，不依赖分词库。

import {
  CATEGORY_MATCH_RULES,
  DEFAULT_SKILL_CATEGORY,
  SKILL_CATEGORIES,
  type SkillCategory,
} from "./categories";

export interface MatchableSkill {
  name: string;
  description: string;
  category?: SkillCategory;
}

const MAX_TOKENS = 240;
/** 单档信号上限：控制「长描述刷分」，也让名字命中能真正压过泛泛的分类命中。 */
const NAME_CAP = 8;
const CATEGORY_CAP = 6;
const DESCRIPTION_CAP = 4;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "使用",
  "能够",
  "可以",
  "负责",
  "进行",
  "相关",
  "以及",
]);

/** 英文按单词（含连字符拆词）、中文按 bigram 切；只留长度≥2 的词，去重后截断。 */
export function tokenizeForMatch(raw: string): string[] {
  const text = raw.toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token.length < 2 || STOP_WORDS.has(token) || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._-]*/g)) {
    const word = match[0];
    push(word);
    // web-fetch → web + fetch：技能名多为连字符短语，拆开才能和普通句子对上。
    for (const part of word.split(/[._-]+/)) {
      if (part.length === word.length) continue;
      push(part);
      const stem = stemOf(part);
      if (stem.length >= 3 && stem !== part) push(stem);
    }
    const stem = stemOf(word);
    if (stem.length >= 3 && stem !== word) push(stem);
  }
  for (const match of text.matchAll(/[一-龥]+/g)) {
    const run = match[0];
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2));
    if (run.length <= 4) push(run);
  }
  return tokens.slice(0, MAX_TOKENS);
}

/** 粗略还原词形：searches → search、testing → test、reviews → review。 */
function stemOf(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us)$/.test(word)) return word;
  const trimmed = word.replace(/(ss|es|ing|ed)s?$/, "$1");
  if (trimmed !== word) return trimmed;
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

/** 分类名与提示语本身也切词：中文描述靠这一档对上英文技能名。 */
const CATEGORY_TOKENS: ReadonlyMap<SkillCategory, string[]> = new Map(
  SKILL_CATEGORIES.map((info) => [info.id, tokenizeForMatch(`${info.label} ${info.hint}`)]),
);

/**
 * 描述整体与各分类的倾向度（0 分表示毫无关系）。
 * 用分值而非集合：一句「抓网页做数据报表」对 web 是强倾向、对 data 是弱倾向。
 */
export function categoryScoresForText(text: string): Map<SkillCategory, number> {
  const tokens = tokenizeForMatch(text);
  const scores = new Map<SkillCategory, number>();
  if (tokens.length === 0) return scores;
  const tokenSet = new Set(tokens);
  for (const [category, categoryTokens] of CATEGORY_TOKENS) {
    let score = 0;
    for (const token of categoryTokens) {
      if (tokenSet.has(token)) score += 2;
      else if (tokens.some((other) => other.includes(token) || token.includes(other))) score += 1;
      if (score >= CATEGORY_CAP) break;
    }
    if (score > 0) scores.set(category, Math.min(score, CATEGORY_CAP));
  }
  return scores;
}

/** 描述整体命中了哪些分类（关键词表口径）：给界面、模板等只要「有没有」的地方用。 */
export function categoriesForText(text: string): Set<SkillCategory> {
  const lower = text.toLowerCase();
  const hits = new Set<SkillCategory>();
  for (const [category, pattern] of CATEGORY_MATCH_RULES) {
    if (pattern.test(lower)) hits.add(category);
  }
  return hits;
}

function skillCategory(skill: MatchableSkill): SkillCategory {
  if (skill.category && skill.category !== DEFAULT_SKILL_CATEGORY) return skill.category;
  const text = `${skill.name} ${skill.description}`.toLowerCase();
  for (const [category, pattern] of CATEGORY_MATCH_RULES) {
    if (pattern.test(text)) return category;
  }
  return DEFAULT_SKILL_CATEGORY;
}

function overlap(tokens: string[], textTokens: string[], tokenSet: Set<string>): number {
  let score = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) score += 1;
    else if (textTokens.some((other) => other.includes(token) || token.includes(other))) score += 0.5;
  }
  return score;
}

/**
 * 返回按匹配度排序的技能名（最多 `max` 个）。
 * 一个都没过分就返回空数组——调用方据此保持「不启用任何技能」，不要擅自塞满技能库。
 */
export function selectSkillsForText(
  text: string,
  skills: readonly MatchableSkill[],
  options: { max?: number; minScore?: number } = {},
): string[] {
  const max = options.max ?? 6;
  const minScore = options.minScore ?? 6;
  const textTokens = tokenizeForMatch(text);
  if (!textTokens.length || skills.length === 0) return [];
  const tokenSet = new Set(textTokens);
  const categoryScores = categoryScoresForText(text);
  const lowerText = text.toLowerCase();

  const scored: { name: string; score: number }[] = [];
  for (const skill of skills) {
    const nameScore = capped(
      overlap(tokenizeForMatch(skill.name), textTokens, tokenSet) * 4,
      NAME_CAP,
    );
    const descriptionScore = capped(
      overlap(tokenizeForMatch(skill.description), textTokens, tokenSet) * 2,
      DESCRIPTION_CAP,
    );
    // 描述里直接点名技能（web-fetch）时整词命中，给最强的一档。
    const literal = lowerText.includes(skill.name.toLowerCase()) ? 6 : 0;
    const signal = nameScore + descriptionScore + literal;
    // 只靠分类相似不算数：否则「做数据」这种一句话会把整个分类都塞给成员。
    if (signal < 1) continue;
    const score = signal + (categoryScores.get(skillCategory(skill)) ?? 0);
    if (score >= minScore) scored.push({ name: skill.name, score });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map((item) => item.name);
}

function capped(value: number, cap: number): number {
  return Math.min(value, cap);
}
