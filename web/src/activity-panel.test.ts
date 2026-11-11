import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Member } from "../../src/core/types";
import type { AuditRecord } from "../../src/agent/audit/types";
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

function render(
  run: { startedAt: number; text: string; reasoning?: string; tools: string[] },
  audits: AuditRecord[] = [],
): string {
  return renderToStaticMarkup(
    createElement(ActivityPanel, {
      members: [member()],
      activity: [],
      audits,
      runs: { m_main: run },
    }),
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

  it("任务审计卡显示结论、催办次数与修复建议", () => {
    const audit: AuditRecord = {
      id: "audit_1",
      roomId: "room_main",
      taskId: "task_1",
      taskTitle: "写一份调研报告",
      memberId: "m_main",
      memberName: "主智能体",
      at: Date.now(),
      verdict: "fail",
      summary: { passed: 1, failed: 1, unsure: 0, total: 2 },
      criteria: [
        { id: 1, criterion: "报告存在", verdict: "pass", evidence: "files/report.md" },
        {
          id: 2,
          criterion: "报告里有结论段",
          verdict: "fail",
          evidence: "没有结论",
          fixHint: "补一段结论",
        },
      ],
      stateHash: "h1",
      sources: { messages: 2, tools: 1, files: ["files/report.md"] },
      action: "nudge",
      interventionCount: 1,
      maxInterventions: 2,
      taskSolved: false,
      modelRef: "demo/mock",
      fixHint: "补一段结论",
    };
    const markup = render(
      { startedAt: Date.now(), text: "", tools: [] },
      [audit],
    );
    expect(markup).toContain("任务审计");
    expect(markup).toContain("有问题");
    expect(markup).toContain("通过 1/2");
    expect(markup).toContain("已催办 1/2");
    expect(markup).toContain("补一段结论");
    expect(markup).toContain("报告里有结论段");
  });
});
