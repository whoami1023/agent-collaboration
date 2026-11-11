import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Member } from "../../src/core/types";
import { MembersPanel } from "./MembersPanel";

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
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: "deepseek/deepseek-chat",
    createdAt: 0,
    lastActiveAt: Date.parse("2026-11-11T10:20:00Z"),
    ...overrides,
  };
}

function render(extra: { members?: Member[]; isGroupRoom?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(MembersPanel, {
      members: extra.members ?? [
        member(),
        member({
          id: "m_writer",
          name: "写手",
          role: "sub",
          status: "running",
          modelRef: "default",
          skillNames: ["docx-writer"],
          templateTitle: "技术写作者",
        }),
      ],
      runs: {
        m_writer: { startedAt: 1, text: "", reasoning: "", tools: ["file_write"] },
      },
      activity: [
        {
          id: "a2",
          memberId: "m_writer",
          memberName: "写手",
          kind: "tool",
          title: "调用 file_write",
          detail: '{"path":"接口说明.md"}',
          at: 2,
        },
      ],
      isGroupRoom: extra.isGroupRoom ?? false,
      onOpenMember: () => undefined,
      onCancel: () => undefined,
      onRemove: () => undefined,
      onInvite: () => undefined,
      onNewMember: () => undefined,
      onClose: () => undefined,
    }),
  );
}

describe("成员右栏", () => {
  it("展示成员状态、模型、技能与最近工具，运行中的成员可取消", () => {
    const markup = render();
    expect(markup).toContain("成员");
    expect(markup).toContain("2 位");
    expect(markup).toContain("@主智能体");
    expect(markup).toContain("@写手");
    expect(markup).toContain("运行中");
    expect(markup).toContain("deepseek/deepseek-chat");
    expect(markup).toContain("默认模型");
    expect(markup).toContain("1 个技能");
    expect(markup).toContain("来自模板「技术写作者」");
    expect(markup).toContain("工具 1 · 发言 0 · 最近 file_write");
    expect(markup).toContain('data-look="writer"');
    expect(markup).toContain('data-mood="working"');
    expect(markup).toContain("trace-fig-root working");
    expect(markup).toContain("取消");
  });

  it("群聊里提供拉成员进群入口；空房间给出占位", () => {
    expect(render({ isGroupRoom: true })).toContain("拉成员进群");
    expect(render({ isGroupRoom: true })).toContain("群成员");
    expect(render({ members: [], isGroupRoom: false })).toContain("房间里还没有成员。");
  });
});
