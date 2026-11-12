import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Member } from "../../src/core/types";
import type { ActivityEvent } from "./activity-model";
import { RunTracePanel } from "./RunTracePanel";

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "m_main",
    roomId: "room_main",
    name: "主智能体",
    role: "main",
    status: "running",
    depth: 0,
    spawnedBy: null,
    controlScope: "children",
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

function activity(): ActivityEvent[] {
  return [
    { id: "a1", memberId: "m_main", memberName: "主智能体", kind: "start", title: "开始运行", at: 1 },
    {
      id: "a2",
      memberId: "m_main",
      memberName: "主智能体",
      kind: "tool",
      title: "调用 file_write",
      at: 2,
    },
    {
      id: "a3",
      memberId: "m_main",
      memberName: "主智能体",
      kind: "final",
      title: "交付完成",
      detail: "结论已落盘。",
      at: 3,
    },
  ];
}

function busyActivity(): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (let index = 1; index <= 5; index += 1) {
    events.push({
      id: `tool-${index}`,
      memberId: "m_main",
      memberName: "主智能体",
      kind: "tool",
      title: `调用 tool_${index}`,
      detail: JSON.stringify({ path: `files/${index}.md` }),
      at: index * 10,
    });
    events.push({
      id: `result-${index}`,
      memberId: "m_main",
      memberName: "主智能体",
      kind: "tool-result",
      title: `tool_${index} 返回`,
      detail: `结果 ${index}`,
      ok: true,
      at: index * 10 + 1,
    });
  }
  for (let index = 1; index <= 6; index += 1) {
    events.push({
      id: `think-${index}`,
      memberId: "m_main",
      memberName: "主智能体",
      kind: "thinking",
      title: `思考 ${index}`,
      at: 100 + index,
    });
  }
  return events;
}

describe("运行轨迹面板", () => {
  it("实时运行显示角色气泡、运行中数量与轨迹带", () => {
    const markup = renderToStaticMarkup(
      createElement(RunTracePanel, {
        members: [member()],
        activity: activity(),
        runs: {
          m_main: { startedAt: Date.now(), text: "", reasoning: "", tools: ["file_write"] },
        },
        roomName: "老板的作战室",
        roomId: "room_main",
        onClose: () => undefined,
      }),
    );
    expect(markup).toContain("运行轨迹");
    expect(markup).toContain("1 个运行中");
    expect(markup).toContain("@主智能体");
    expect(markup).toContain("工具 · file_write");
    expect(markup).toContain('data-look="planner"');
    expect(markup).toContain("trace-fig-root working");
    expect(markup).toContain("trace-fig-arm working");
    expect(markup).toContain("轨迹带");
    expect(markup).toContain("工具轨迹");
    expect(markup).toContain("file_write");
    expect(markup).toContain("交付完成");
    expect(markup).toContain("工具 1 · 发言 1");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("运行现场，可上下滑动查看全部成员");
  });

  it("等待回答时顶部与角色状态都标出挂起", () => {
    const markup = renderToStaticMarkup(
      createElement(RunTracePanel, {
        members: [member({ status: "waiting" })],
        activity: [],
        runs: {},
        roomName: "作战室",
        roomId: "room_main",
        onClose: () => undefined,
      }),
    );
    expect(markup).toContain("1 个等你回答");
    expect(markup).toContain("等你回答");
    expect(markup).toContain('data-mood="waiting"');
    expect(markup).toContain("trace-wait-fx");
  });

  it("轨迹带默认只展示最近几条，避免把运行现场挤小", () => {
    const markup = renderToStaticMarkup(
      createElement(RunTracePanel, {
        members: [member({ status: "idle" })],
        activity: busyActivity(),
        runs: {},
        roomName: "作战室",
        roomId: "room_main",
        onClose: () => undefined,
      }),
    );
    expect(markup).toContain("最近 3 / 5 次");
    expect(markup).toContain("最近 4 / 6 个");
    expect(markup).toContain("tool_5");
    expect(markup).not.toContain("tool_1");
    expect(markup).toContain("展开全部");
  });

  it("空闲成员显示最近一次交付，空房间显示占位文案", () => {
    const done = renderToStaticMarkup(
      createElement(RunTracePanel, {
        members: [member({ status: "idle" })],
        activity: activity(),
        runs: {},
        roomName: "作战室",
        roomId: "room_main",
        onClose: () => undefined,
      }),
    );
    expect(done).toContain("已交付");
    expect(done).toContain("结论已落盘。");

    const empty = renderToStaticMarkup(
      createElement(RunTracePanel, {
        members: [],
        activity: [],
        runs: {},
        roomName: "作战室",
        roomId: "room_main",
        onClose: () => undefined,
      }),
    );
    expect(empty).toContain("房间里还没有成员。");
  });
});
