import type { Member } from "../core/types";
import { DEFAULT_MAIN_CREED_LEADS, DEFAULT_MEMBER_WORKSTYLE } from "../memory/bootstrap-files";
import { inferSkillCategory, type SkillCategory } from "../skills/categories";
import { TEMPLATE_LIMITS } from "./template-library";

/**
 * 把一个已有成员导出成个人模板草稿（成员 → 模板）。
 * 纯文本推导：成员档案（SOUL.md / IDENTITY.md）里用户改过的内容会被带进草稿，
 * 因此这里只解析，不读盘，也不写模板库——落盘由调用方走 TemplateLibrary.create。
 */
export interface MemberTemplateSource {
  member: Member;
  /** 该成员的 SOUL.md 全文（子成员取 agents/<id>/SOUL.md，主智能体取工作区根部）。 */
  soul?: string;
  /** 该成员的 IDENTITY.md 全文。 */
  identity?: string;
  /** 成员当初引用的来源模板分类；查不到则按名称与描述推断。 */
  categoryHint?: SkillCategory;
}

/** 草稿的形状与 TemplateInput 一致（上限也一致），前端可直接灌进新建表单。 */
export interface MemberTemplateDraft {
  title: string;
  description: string;
  suggestedName: string;
  category: SkillCategory;
  brief: string;
  emoji?: string;
  vibe?: string;
  workstyle?: string[];
  skillNames?: string[];
}

/** 档案里没写清楚时用的兜底描述，保证模板的必填项都能过校验。 */
const FALLBACK_BRIEF = "由成员导出的模板：职责待补充。";

/** 生成档案时写入的默认气质，不算成员自己的特征，不进模板。 */
const PLACEHOLDER_VIBES = new Set([
  "直接、先查证再开口",
  "冷静、直接、先查证再开口",
  "待填写",
]);

const PLACEHOLDER_EMOJIS = new Set(["待挑选", "待填写"]);

/** 每个成员档案都会自动带上的收尾约定，属于运行时纪律而非模板设定。 */
const GENERATED_WORKSTYLE_PREFIXES = ["对外发送、删除、覆盖这类不可逆动作"];

function sectionBody(markdown: string, titles: string[]): string {
  const lines = markdown.split(/\r?\n/);
  const wanted = new Set(titles);
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const header = /^##\s+(.+?)\s*$/.exec(line);
    if (header) {
      if (inside) break;
      inside = wanted.has(header[1]);
      continue;
    }
    if (inside && line.trim() !== "---") collected.push(line);
  }
  return collected
    .join("\n")
    .trim()
    .replace(/^-\s+/gm, "");
}

function bulletLines(markdown: string, title: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const header = /^##\s+(.+?)\s*$/.exec(line);
    if (header) {
      if (inside) break;
      inside = header[1] === title;
      continue;
    }
    if (!inside) continue;
    const bullet = /^-\s+(.+?)\s*$/.exec(line.trim());
    if (bullet) collected.push(bullet[1]);
  }
  return collected;
}

function identityField(markdown: string, label: string): string {
  const matched = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.+?)\\s*$`, "m").exec(markdown);
  const value = matched?.[1]?.trim() ?? "";
  return value.startsWith("待") ? "" : value;
}

/** 档案正文里的 \`**加粗**\` 只是排版标记，带进模板会打断一句话。 */
function stripEmphasis(text: string): string {
  return text.replaceAll("**", "");
}

/**
 * 主智能体的设定写在 SOUL.md 的「基本信条」里。逐条剔除新建工作区时预置的那几条，
 * 剩下的才是他自己（或用户替他）改出来的内容；全被剔除时返回空串，交给兜底描述。
 */
function creedBody(markdown: string): string {
  return sectionBody(markdown, ["基本信条"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !DEFAULT_MAIN_CREED_LEADS.some((lead) => line.startsWith(lead)))
    .join("\n\n");
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trimEnd() : value;
}

/** 一句话描述：取职责描述的第一句（中文句号/换行），过长就截断。 */
function firstSentence(brief: string): string {
  const single = brief.split(/[。！？\n]/).find((part) => part.trim().length > 0) ?? brief;
  return clip(single.trim(), TEMPLATE_LIMITS.description);
}

export function draftTemplateFromMember(source: MemberTemplateSource): MemberTemplateDraft {
  const { member } = source;
  const soul = source.soul ?? "";
  const identity = source.identity ?? "";

  // 子成员的职责在 SOUL.md 的「角色」，主智能体没有「角色」段，退到「基本信条」的非预置条目。
  const brief = clip(
    stripEmphasis(
      member.brief?.trim() || sectionBody(soul, ["角色"]) || creedBody(soul) || FALLBACK_BRIEF,
    ),
    TEMPLATE_LIMITS.brief,
  );

  const vibe = identityField(identity, "Vibe");
  const emoji = identityField(identity, "Emoji");
  const workstyle = bulletLines(soul, "工作方式")
    .map(stripEmphasis)
    .filter((line) => !DEFAULT_MEMBER_WORKSTYLE.includes(line))
    .filter((line) => !GENERATED_WORKSTYLE_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .filter((line) => line.length <= TEMPLATE_LIMITS.workstyleLine)
    .slice(0, TEMPLATE_LIMITS.workstyle);

  // 成员没有显式白名单（undefined）时留空：模板不带技能清单＝引用后跟随技能库全部技能。
  // 显式全禁用（[]）在模板里没有对应表达，同样落成空。
  const skillNames =
    member.skillNames && member.skillNames.length > 0
      ? member.skillNames.slice(0, TEMPLATE_LIMITS.skillNames)
      : undefined;

  const name = clip(member.name, TEMPLATE_LIMITS.title);
  return {
    title: name || "成员模板",
    description: firstSentence(brief),
    suggestedName: clip(member.name, TEMPLATE_LIMITS.suggestedName),
    category: source.categoryHint ?? inferSkillCategory(member.name, brief),
    brief,
    ...(vibe && !PLACEHOLDER_VIBES.has(vibe) ? { vibe: clip(vibe, TEMPLATE_LIMITS.vibe) } : {}),
    ...(emoji && !PLACEHOLDER_EMOJIS.has(emoji) ? { emoji: clip(emoji, TEMPLATE_LIMITS.emoji) } : {}),
    ...(workstyle.length > 0 ? { workstyle } : {}),
    ...(skillNames && skillNames.length > 0 ? { skillNames } : {}),
  };
}
