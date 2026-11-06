/**
 * 顾问挑选（MoA 群聊版）：从**在册成员**里按花名册顺序取前 N 个当参谋，动手的那个自己不参自己。
 *
 * 这里刻意不做任何「哪种任务找哪种人」的判断——顾问就是房间里的成员，
 * 它的职责档案（`brief`）就是它的参谋视角。加一类任务不需要改这个文件。
 */

import type { Member } from "../../core/types";

/** 一次最多同时问 8 个顾问（Hermes 的 `min(8, total)` 并发上限）。 */
export const MAX_ADVISOR_WORKERS = 8;

export function pickAdvisors(
  acting: Member,
  members: readonly Member[],
  limit: number,
): Member[] {
  const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_ADVISOR_WORKERS);
  const picked: Member[] = [];
  for (const member of members) {
    if (picked.length >= cap) break;
    if (member.id === acting.id) continue;
    if (member.status === "cancelled") continue;
    picked.push(member);
  }
  return picked;
}
