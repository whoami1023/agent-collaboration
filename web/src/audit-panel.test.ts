import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditRecord } from "../../src/agent/audit/types";
import { AuditPanel } from "./AuditPanel";

function audit(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
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
    ...overrides,
  };
}

describe("任务审计面板", () => {
  it("空状态说明触发条件与持久化", () => {
    const markup = renderToStaticMarkup(createElement(AuditPanel, { audits: [] }));
    expect(markup).toContain("还没有审计记录");
    expect(markup).toContain("验收条款");
    expect(markup).toContain("刷新或重启后仍在");
  });

  it("展示总体计数与审计卡，最新的排在前面", () => {
    const old = audit({ id: "a_old", at: 1, verdict: "fail" });
    const fresh = audit({
      id: "a_new",
      at: 2,
      verdict: "pass",
      action: "none",
      taskSolved: true,
      summary: { passed: 2, failed: 0, unsure: 0, total: 2 },
    });
    const markup = renderToStaticMarkup(createElement(AuditPanel, { audits: [old, fresh] }));
    expect(markup).toContain("通过 1");
    expect(markup).toContain("有问题 1");
    expect(markup).toContain("验收通过");
    expect(markup).toContain("全部达成");
    expect(markup).toContain("已催办 1/2");
    expect(markup.indexOf("audit-card pass")).toBeLessThan(markup.indexOf("audit-card fail"));
  });
});
