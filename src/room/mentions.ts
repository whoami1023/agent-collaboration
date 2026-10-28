import type { Member } from "../core/types";

const MENTION_RE = /@([\p{L}\p{N}_-]{1,32})/gu;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function parseMentionNames(text: string): string[] {
  const cleaned = text.replace(EMAIL_RE, " ");
  const names: string[] = [];
  for (const match of cleaned.matchAll(MENTION_RE)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

export interface ResolvedMentions {
  ids: string[];
  names: string[];
}

export function resolveMentions(text: string, members: Member[]): ResolvedMentions {
  const ids: string[] = [];
  const names: string[] = [];
  for (const name of parseMentionNames(text)) {
    const hit = members.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (hit && !ids.includes(hit.id)) {
      ids.push(hit.id);
      names.push(name);
    }
  }
  return { ids, names };
}
