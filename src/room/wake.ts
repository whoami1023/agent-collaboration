import type { Member, RoomMessage, RoomMode, RoomRoutingMode } from "../core/types";
import {
  citedPeerIds,
  everyonePicks,
  rotateBy,
  ROUTING_LIMITS,
  routingCandidates,
  routingNeeded,
} from "./routing";

export interface WakeDecision {
  wakes: string[];
  skipped: Array<{ memberId: string; reason: string }>;
}

/**
 * 房间的分流上下文（由 Orchestrator 每次派发时算好传进来）。
 * 全部字段可选且缺省等于旧行为：没开分流的房间，唤醒规则和升级前逐字节一致。
 */
export interface WakeRouting {
  /** 房间取人方式；缺省 `lead`，即「没点名就交给主智能体」。 */
  routing?: RoomRoutingMode;
  /** `auto` 下分流调用挑出来的人；没挑或没挑出来就不传，回落到 lead。 */
  picks?: readonly string[];
  /** 本轮（最近一条用户消息之后）还没开过口的成员 ID。 */
  unspoken?: readonly string[];
  /**
   * 用户这条消息只点名了非主成员：子成员汇报后不再自动唤醒主智能体。
   * 只压制隐式父级回收，不挡成员在汇报里显式 @ 主智能体求助。
   */
  skipParentWake?: boolean;
}

export function decideWakes(
  message: RoomMessage,
  members: Member[],
  mode: RoomMode = "delegate",
  wakeRouting: WakeRouting = {},
): WakeDecision {
  const wakes = new Set<string>();
  const skipped: Array<{ memberId: string; reason: string }> = [];
  const sender = members.find((m) => m.id === message.senderId);
  const main = members.find((m) => m.role === "main");
  const routing = wakeRouting.routing ?? "lead";

  for (const memberId of message.mentions) {
    const target = members.find((m) => m.id === memberId);
    if (!target || target.status === "cancelled") continue;
    if (memberId === message.senderId) {
      skipped.push({ memberId, reason: "自己 @ 自己，忽略" });
      continue;
    }
    // 运行姿态闸门：计划轮（以及以后任何只读姿态）里智能体发出的 @ 不唤醒成员。
    // 用户自己发的 /plan 消息仍可唤醒主智能体去出计划，挡的是这一轮把活真的派下去。
    if (message.runScope && message.senderKind !== "user") {
      skipped.push({ memberId, reason: "本轮是计划轮（只读），@ 不会唤醒成员；等用户批准后再派活" });
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
    // 自由交流模式下同级成员可以直接 @ 对方讨论；委派模式仍要求协调经过主智能体。
    if (mode === "free") {
      wakes.add(memberId);
      continue;
    }
    skipped.push({ memberId, reason: "成员之间不能互相派活，协调必须经过主智能体" });
  }

  const candidates = routingCandidates(message, members);

  // 显式 @ 优先：用户点了谁就只叫谁。主智能体兜底/分流只处理一条都没点名的用户消息，
  // 否则 @ 子成员时主智能体会跟着抢答。
  if (
    message.senderKind === "user" &&
    message.mentions.length === 0 &&
    main &&
    main.id !== message.senderId
  ) {
    // 分流只对「一条都没点名的用户消息」生效：用户自己 @ 过人，就按用户的意思办。
    const picked = routingNeeded(message, routing, candidates)
      ? (wakeRouting.picks ?? []).filter((id) => candidates.some((member) => member.id === id))
      : [];
    if (routing === "everyone" && message.mentions.length === 0) {
      // 全员：在场的人都收到这条，不相关的成员回 pass 保持沉默；主智能体仍然在场兜底。
      // 先把兜底的位置留出来，剩下的名额按轮转发给其他成员——一条消息最多 maxPicks 个人同时开工。
      wakes.add(main.id);
      const slots = ROUTING_LIMITS.maxPicks - wakes.size;
      const others = candidates.filter((member) => member.id !== main.id);
      for (const id of slots > 0 ? everyonePicks(others, message.seq).slice(0, slots) : []) {
        wakes.add(id);
      }
    } else if (picked.length > 0) {
      // 挑到人就不叫主智能体了：每条消息都补一份「综合汇报」正是分流要省掉的开销。
      // 轮转顺序决定谁先抢到并发槽位，避免总让同一个人先开口。
      for (const id of rotateBy(picked, message.seq).slice(0, ROUTING_LIMITS.maxPicks)) {
        wakes.add(id);
      }
    } else {
      wakes.add(main.id);
    }
  }

  // 提质规则（移植 Hermes 的 _unaddressed_member_mentions）：成员发言里点了某位还没开口的同伴
  // 的名字却没 @ 到，就把它拉进下一轮——顺嘴提的那位通常正是该接话的人。
  // 只在房间确实允许成员之间互相接话时生效（自由交流，或开了分流）；计划轮不参与。
  const unspoken = new Set(wakeRouting.unspoken ?? []);
  if (
    message.senderKind === "member" &&
    !message.runScope &&
    unspoken.size > 0 &&
    (mode === "free" || routing !== "lead") &&
    wakes.size < ROUTING_LIMITS.maxPicks
  ) {
    const skip = new Set<string>([...wakes, message.senderId]);
    for (const member of members) if (!unspoken.has(member.id)) skip.add(member.id);
    for (const id of citedPeerIds(message.text, candidates, skip)) wakes.add(id);
  }

  // 自由交流不逐条唤醒父级：由 Orchestrator 在讨论安静后统一收集，避免主智能体打断讨论。
  // 用户显式只 @ 子成员时同理：这轮由被点的人负责，不再让主智能体补一条汇总。
  if (
    mode === "delegate" &&
    message.kind === "announce" &&
    sender?.spawnedBy &&
    !wakeRouting.skipParentWake
  ) {
    const parent = members.find((m) => m.id === sender.spawnedBy);
    if (parent && parent.status !== "cancelled") wakes.add(parent.id);
  }

  return { wakes: [...wakes], skipped };
}
