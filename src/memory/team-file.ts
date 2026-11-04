import fs from "node:fs/promises";
import path from "node:path";
import type { Member } from "../core/types";
import { hashText } from "./chunking";

/**
 * 主智能体的「成员能力档案」（TEAM.md）。
 * 新建成员或引用模板为成员时写入，移除成员、调整技能授权时同步，
 * 让主智能体在分派前就知道每个子智能体会做什么——花名册只有名字与状态，能力细节在这个文件里。
 *
 * 自动维护规则：每个条目首行带 `<!-- member:<id> auto:<hash> -->` 标记，
 * 标记里的 hash 是「上一次自动写入的正文」指纹。同步时正文指纹仍与标记一致 → 视为未被改动，刷新；
 * 不一致 → 用户或智能体手改过，整段原样保留。没有成员标记的段落（用户自己写的说明）永不删除。
 */

export const TEAM_FILE_NAME = "TEAM.md";

/** 注入系统提示词时的长度上限：成员再多也不能吃掉主智能体的上下文。 */
export const TEAM_PROMPT_MAX_CHARS = 4000;

const MARKER_PREFIX = "<!-- member:";

function markerHash(body: string): string {
  return hashText(body).slice(0, 12);
}

function skillsLine(member: Member): string {
  if (member.skillNames === undefined) return "- 技能：跟随技能库，全部可用技能都能用";
  if (member.skillNames.length === 0) return "- 技能：未启用任何技能（只能靠自己查与写）";
  return `- 技能：${member.skillNames.join("、")}`;
}

/** 一个成员的自动正文；能力描述取创建时用户填写的功能描述。 */
function renderBody(member: Member): string {
  const brief = member.brief?.trim() || "由用户创建的成员，能力描述待补充。";
  const created = new Date(member.createdAt).toISOString().slice(0, 10);
  const lines = [`- 能力：${brief}`, skillsLine(member)];
  if (member.templateTitle) lines.push(`- 来源：模板「${member.templateTitle}」`);
  lines.push(`- 创建：${created}`);
  return lines.join("\n");
}

function renderSection(member: Member): string {
  const body = renderBody(member);
  return `## @${member.name} ${MARKER_PREFIX}${member.id} auto:${markerHash(body)} -->\n\n${body}`;
}

function preamble(roomName: string, mainAgentName: string): string {
  return `# TEAM.md - 成员能力档案

本文件记录${roomName}里每个子智能体会做什么，由系统在创建、移除成员或调整技能授权时自动维护。
@${mainAgentName} 分派任务前先对照这里：一个 \`## @成员名\` 段落就是一个人的能力清单，
「能力」是创建时用户写的职责描述，「技能」是它当前可用的技能白名单。

段落里那行看不见的 \`<!-- member:… auto:… -->\` 标记用于区分自动内容与人工内容：
没有被改动过的自动段落会随成员配置刷新，你手改过的段落保持原样不再被覆盖。
想补充对某个成员的实测印象（擅长什么、哪里容易出错），直接在那一段下面加自己的行。`;
}

interface ParsedSection {
  header: string;
  memberId: string | null;
  auto: string | null;
  body: string;
}

/** 按二级标题切段；标题行之前的文字整段留作前言，原样写回。 */
function parse(text: string): { preamble: string; sections: ParsedSection[] } {
  const lines = text.split("\n");
  const head: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  const bodyLines: string[] = [];
  const markerOf = (header: string): Pick<ParsedSection, "memberId" | "auto"> => {
    const match = /<!--\s*member:([^\s>]+)(?:\s+auto:([0-9a-f]+))?\s*-->/.exec(header);
    return match ? { memberId: match[1], auto: match[2] ?? null } : { memberId: null, auto: null };
  };
  const flush = () => {
    if (!current) return;
    sections.push({ ...current, body: bodyLines.join("\n").trim() });
    bodyLines.length = 0;
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      const marker = markerOf(line);
      current = { header: line, memberId: marker.memberId, auto: marker.auto, body: "" };
      continue;
    }
    if (current) bodyLines.push(line);
    else head.push(line);
  }
  flush();
  return { preamble: head.join("\n").trim(), sections };
}

export interface TeamFileResult {
  changed: boolean;
  added: number;
  updated: number;
  removed: number;
}

/**
 * 同步 TEAM.md：补齐缺失成员、刷新未被改动过的自动段落、删除已移除成员的段落。
 * 文件不存在时按当前成员一次性生成。
 */
export async function syncTeamFile(
  workspaceDir: string,
  members: readonly Member[],
  context: { roomName: string; mainAgentName: string },
): Promise<TeamFileResult> {
  const absPath = path.join(workspaceDir, TEAM_FILE_NAME);
  const subMembers = members.filter((member) => member.role !== "main");
  let existing = "";
  try {
    existing = await fs.readFile(absPath, "utf8");
  } catch {
    existing = "";
  }
  if (!existing.trim()) {
    const blocks = [preamble(context.roomName, context.mainAgentName)];
    for (const member of subMembers) blocks.push(renderSection(member));
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(absPath, `${blocks.join("\n\n")}\n`, "utf8");
    return { changed: true, added: subMembers.length, updated: 0, removed: 0 };
  }

  const parsed = parse(existing);
  const byId = new Map(subMembers.map((member) => [member.id, member]));
  const used = new Set<string>();
  const kept: string[] = [];
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const section of parsed.sections) {
    // 用户自己写的段落、或指向已不存在成员的段落之外的未知标记：不参与同步，也不误删人工内容。
    if (!section.memberId) {
      kept.push(`${section.header}\n\n${section.body}`);
      continue;
    }
    const member = byId.get(section.memberId);
    if (!member) {
      removed += 1;
      continue;
    }
    used.add(member.id);
    const fresh = renderSection(member);
    // 标记里的 auto 与当前正文指纹一致 = 这段还是自动生成的，可以刷新；不一致说明被手改过。
    const untouched = section.auto !== null && section.auto === markerHash(section.body);
    if (untouched) {
      if (fresh !== `${section.header}\n\n${section.body}`) updated += 1;
      kept.push(fresh);
    } else {
      kept.push(`${section.header}\n\n${section.body}`);
    }
  }
  for (const member of subMembers) {
    if (used.has(member.id)) continue;
    kept.push(renderSection(member));
    added += 1;
  }
  const body = kept.length === 0 ? "" : `\n\n${kept.join("\n\n")}`;
  const next = `${parsed.preamble || preamble(context.roomName, context.mainAgentName)}${body}\n`;
  if (next === existing) return { changed: false, added: 0, updated: 0, removed };
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(absPath, next, "utf8");
  return { changed: true, added, updated, removed };
}

/**
 * 读取 TEAM.md 供主智能体系统提示词注入：只取第一个二级标题之后的成员段落
 * （文件头部的写法说明对模型没有信息量），超长截断；文件缺失或还没有成员时返回 undefined。
 */
export async function readTeamFileForPrompt(workspaceDir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(workspaceDir, TEAM_FILE_NAME), "utf8");
  } catch {
    return undefined;
  }
  const start = text.indexOf("\n## ");
  const body = (start === -1 ? "" : text.slice(start + 1)).trim();
  if (!body) return undefined;
  // 自动标记只服务于文件同步，注入提示词时去掉，省 token 也不给模型看无关注释。
  const forPrompt = body.replace(/[ \t]*<!--\s*member:[^>]*-->[ \t]*/g, "");
  if (forPrompt.length <= TEAM_PROMPT_MAX_CHARS) return forPrompt;
  return `${forPrompt.slice(0, TEAM_PROMPT_MAX_CHARS)}\n…（成员很多，档案已截断；上面没列出的成员先问用户或看花名册）`;
}
