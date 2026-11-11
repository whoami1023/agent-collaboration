import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Member } from "../../src/core/types";
import { ActivityPanel } from "./ActivityPanel";

function member(): Member {
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
  };
}

function render(run: { startedAt: number; text: string; reasoning?: string; tools: string[] }): string {
  return renderToStaticMarkup(
    createElement(ActivityPanel, { members: [member()], activity: [], runs: { m_main: run } }),
  );
}

describe("执行面板的实时行", () => {
  it("运行中没有新工具时显示推理摘要", () => {
    const markup = render({
      startedAt: Date.now(),
      text: "",
      reasoning: "先确认口径，再抽样核对。",
      tools: [],
    });
    expect(markup).toContain("思考 · 先确认口径，再抽样核对。");
    expect(markup).toContain("运行中");
  });

  it("调用工具时优先显示工具名", () => {
    const markup = render({
      startedAt: Date.now(),
      text: "",
      reasoning: "先确认口径。",
      tools: ["file_read"],
    });
    expect(markup).toContain("工具 · file_read");
    expect(markup).not.toContain("思考 · 先确认口径。");
  });
});
