import { describe, expect, it } from "vitest";
import type { Member, RoomMessage } from "../src/core/types";
import { decideWakes } from "../src/room/wake";

function member(partial: Partial<Member> & { id: string; name: string }): Member {
  return {
    roomId: "r",
    role: "sub",
    status: "idle",
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    providerId: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...partial,
  };
}

function message(partial: Partial<RoomMessage>): RoomMessage {
  return {
    id: "msg_1",
    roomId: "r",
    seq: 1,
    ts: 0,
    senderId: "user",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text: "",
    mentions: [],
    mentionsRaw: [],
    ...partial,
  };
}

const main = member({ id: "m_main", name: "主智能体", role: "main", depth: 0, spawnedBy: null });
const researcher = member({ id: "m_a", name: "研究员" });
const writer = member({ id: "m_b", name: "写手" });

describe("wake decisions", () => {
  it("用户消息总是唤醒主智能体", () => {
    const decision = decideWakes(message({ text: "你好" }), [main, researcher]);
    expect(decision.wakes).toEqual(["m_main"]);
  });

  it("主智能体 @ 成员会派活", () => {
    const decision = decideWakes(
      message({ senderId: main.id, senderName: main.name, senderKind: "member", mentions: [researcher.id] }),
      [main, researcher],
    );
    expect(decision.wakes).toEqual([researcher.id]);
  });

  it("成员之间互相 @ 被拒绝，只能找主智能体", () => {
    const toSibling = decideWakes(
      message({ senderId: researcher.id, senderName: researcher.name, senderKind: "member", mentions: [writer.id] }),
      [main, researcher, writer],
    );
    expect(toSibling.wakes).toEqual([]);
    expect(toSibling.skipped[0]?.reason).toContain("互相派活");

    const toMain = decideWakes(
      message({ senderId: researcher.id, senderName: researcher.name, senderKind: "member", mentions: [main.id] }),
      [main, researcher],
    );
    expect(toMain.wakes).toEqual([main.id]);
  });

  it("子成员的报告会唤醒创建它的父级", () => {
    const decision = decideWakes(
      message({ senderId: researcher.id, senderName: researcher.name, senderKind: "member", kind: "announce" }),
      [main, researcher],
    );
    expect(decision.wakes).toEqual([main.id]);
  });

  it("自己 @ 自己不会触发运行", () => {
    const decision = decideWakes(
      message({ senderId: main.id, senderName: main.name, senderKind: "member", mentions: [main.id] }),
      [main],
    );
    expect(decision.wakes).toEqual([]);
  });
});
