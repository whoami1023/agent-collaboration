import { describe, expect, it } from "vitest";
import type { Member, RoomMessage } from "../src/core/types";
import { buildSystemPrompt, formatRoomWindow, type PromptContext } from "../src/agent/prompts";

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "m_main",
    roomId: "room_main",
    name: "主智能体",
    role: "main",
    status: "idle",
    depth: 0,
    spawnedBy: null,
    controlScope: "children",
    contextMode: "fork",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  const main = member();
  return {
    roomName: "测试作战室",
    member: main,
    members: [main],
    parentName: null,
    taskTitles: new Map(),
    mode: "delegate",
    limits: {
      maxChildrenPerAgent: 5,
      maxSpawnDepth: 5,
      maxConcurrent: 8,
      maxStepsPerRun: 24,
    },
    skills: [],
    ...overrides,
  };
}

describe("交付文档契约", () => {
  it("有文件工具时注入通用成文规则，覆盖各类文体而不是只针对报告", () => {
    const prompt = buildSystemPrompt(
      context({ availableTools: new Set(["file_list", "file_write", "file_read"]) }),
    );
    expect(prompt).toContain("交付文档（给别人看的成稿）");
    expect(prompt).toContain("方案、纪要、说明书、论文、合同、手册、简报");
    expect(prompt).toContain("读者是谁、拿它做什么决定");
    expect(prompt).toContain("术语首次出现给定义");
    expect(prompt).toContain("md5/字节数/行尾");
    expect(prompt).toContain("append 续写");
  });

  it("没有文件工具时不注入成文规则", () => {
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main", brief: "调研" });
    const prompt = buildSystemPrompt(
      context({ member: sub, members: [member(), sub], parentName: "主智能体", availableTools: new Set() }),
    );
    expect(prompt).not.toContain("交付文档（给别人看的成稿）");
  });

  it("成员被要求写文档时，群聊汇报与成稿正文分开", () => {
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main" });
    const prompt = buildSystemPrompt(
      context({
        member: sub,
        members: [member(), sub],
        parentName: "主智能体",
        availableTools: new Set(["file_write"]),
      }),
    );
    expect(prompt).toContain("群聊汇报必须包含");
    expect(prompt).toContain("不要把工作简报当成交付物");
  });

  it("主智能体负责统稿，而不是拼接成员汇报", () => {
    const prompt = buildSystemPrompt(context({ availableTools: new Set(["file_write"]) }));
    expect(prompt).toContain("成稿与统稿");
    expect(prompt).toContain("不要直接把成员汇报拼成文档");
    expect(prompt).toContain("统一口径、术语与时间");
  });

  it("成员交回的产物在群聊窗口里标为汇报，不再与成稿混用「报告」", () => {
    const message: RoomMessage = {
      id: "msg_1",
      roomId: "room_main",
      seq: 3,
      ts: 0,
      senderId: "m_sub",
      senderName: "研究员",
      senderKind: "member",
      kind: "announce",
      text: "结论：…",
      mentions: [],
      mentionsRaw: [],
    };
    const window = formatRoomWindow([message]);
    expect(window).toContain("汇报");
    expect(window).not.toContain("· 报告");
  });
});
