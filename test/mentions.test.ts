import { describe, expect, it } from "vitest";
import type { Member } from "../src/core/types";
import { parseMentionNames, resolveMentions } from "../src/room/mentions";

function member(id: string, name: string): Member {
  return {
    id,
    roomId: "r",
    name,
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
  };
}

describe("mentions", () => {
  it("解析中文与英文提及并去重", () => {
    expect(parseMentionNames("@研究员 和 @主智能体，再看看 @研究员")).toEqual(["研究员", "主智能体"]);
  });

  it("按成员名解析成 id，忽略未知名称", () => {
    const members = [member("m1", "研究员"), member("m2", "Writer")];
    expect(resolveMentions("@研究员 @writer @不存在", members)).toEqual({
      ids: ["m1", "m2"],
      names: ["研究员", "writer"],
    });
  });

  it("不会把邮箱误判为提及", () => {
    expect(parseMentionNames("联系 me@example.com")).toEqual([]);
  });
});
