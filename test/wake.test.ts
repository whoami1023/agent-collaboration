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
    modelRef: "default",
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

  it("用户 @ 子成员时只唤醒被点的人，主智能体不再抢答", () => {
    const decision = decideWakes(
      message({ text: "@研究员 先说你的思路", mentions: [researcher.id] }),
      [main, researcher],
    );
    expect(decision.wakes).toEqual([researcher.id]);
  });

  it("用户只 @ 主智能体时只唤醒主智能体", () => {
    const decision = decideWakes(
      message({ text: "@主智能体 你来处理", mentions: [main.id] }),
      [main, researcher],
    );
    expect(decision.wakes).toEqual([main.id]);
  });

  it("用户同时 @ 子成员和主智能体时两者都唤醒", () => {
    const decision = decideWakes(
      message({ text: "@研究员 @主智能体 一起看看", mentions: [researcher.id, main.id] }),
      [main, researcher],
    );
    expect(decision.wakes.sort()).toEqual([main.id, researcher.id].sort());
  });

  it("子成员的报告会唤醒创建它的父级", () => {
    const decision = decideWakes(
      message({ senderId: researcher.id, senderName: researcher.name, senderKind: "member", kind: "announce" }),
      [main, researcher],
    );
    expect(decision.wakes).toEqual([main.id]);
  });

  it("用户显式只 @ 子成员的链路里，子成员汇报不再唤醒主智能体", () => {
    const decision = decideWakes(
      message({
        senderId: researcher.id,
        senderName: researcher.name,
        senderKind: "member",
        kind: "announce",
        chainRootId: "msg_user",
      }),
      [main, researcher],
      "delegate",
      { skipParentWake: true },
    );
    expect(decision.wakes).toEqual([]);
  });

  it("自己 @ 自己不会触发运行", () => {
    const decision = decideWakes(
      message({ senderId: main.id, senderName: main.name, senderKind: "member", mentions: [main.id] }),
      [main],
    );
    expect(decision.wakes).toEqual([]);
  });
});

describe("free mode wake decisions", () => {
  it("自由交流允许同级成员直接 @ 对方", () => {
    const decision = decideWakes(
      message({
        senderId: researcher.id,
        senderName: researcher.name,
        senderKind: "member",
        mentions: [writer.id],
      }),
      [main, researcher, writer],
      "free",
    );
    expect(decision.wakes).toEqual([writer.id]);
    expect(decision.skipped).toEqual([]);
  });

  it("自由交流下成员报告不直接唤醒父级，交给收集器统一总结", () => {
    const decision = decideWakes(
      message({
        senderId: researcher.id,
        senderName: researcher.name,
        senderKind: "member",
        kind: "announce",
      }),
      [main, researcher],
      "free",
    );
    expect(decision.wakes).toEqual([]);
  });

  it("自由交流下用户 @ 子成员也只唤醒被点的人", () => {
    const decision = decideWakes(
      message({ text: "@研究员 先说说你的思路", mentions: [researcher.id] }),
      [main, researcher],
      "free",
    );
    expect(decision.wakes).toEqual([researcher.id]);
  });
});
