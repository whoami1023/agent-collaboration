import type { Member, RoomMessage } from "../core/types";

export interface WakeDecision {
  wakes: string[];
  skipped: Array<{ memberId: string; reason: string }>;
}

export function decideWakes(message: RoomMessage, members: Member[]): WakeDecision {
  const wakes = new Set<string>();
  const skipped: Array<{ memberId: string; reason: string }> = [];
  const sender = members.find((m) => m.id === message.senderId);
  const main = members.find((m) => m.role === "main");

  for (const memberId of message.mentions) {
    const target = members.find((m) => m.id === memberId);
    if (!target || target.status === "cancelled") continue;
    if (memberId === message.senderId) {
      skipped.push({ memberId, reason: "自己 @ 自己，忽略" });
      continue;
    }
    if (message.senderKind === "user") {
      wakes.add(memberId);
      continue;
    }
    if (sender?.role === "main") {
      wakes.add(memberId);
      continue;
    }
    // 移植的血缘规则：controlScope=children 的协调成员对其子成员的点名属于下派，
    // 不算同级互派；announce 仍只沿 spawnedBy 交回（见文件末尾）。
    if (sender?.controlScope === "children") {
      wakes.add(memberId);
      continue;
    }
    if (target.role === "main") {
      wakes.add(memberId);
      continue;
    }
    skipped.push({ memberId, reason: "成员之间不能互相派活，协调必须经过主智能体" });
  }

  if (message.senderKind === "user" && main && main.id !== message.senderId) {
    wakes.add(main.id);
  }

  if (message.kind === "announce" && sender?.spawnedBy) {
    const parent = members.find((m) => m.id === sender.spawnedBy);
    if (parent && parent.status !== "cancelled") wakes.add(parent.id);
  }

  return { wakes: [...wakes], skipped };
}
