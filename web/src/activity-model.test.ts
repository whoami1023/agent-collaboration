import { describe, expect, it } from "vitest";
import type { Member } from "../../src/core/types";
import {
  appendActivity,
  summarizeExecution,
  type ActivityEvent,
} from "./activity-model";

function member(id: string, name: string, overrides: Partial<Member> = {}): Member {
  return {
    id,
    roomId: "room_main",
    name,
    role: id === "m_main" ? "main" : "sub",
    status: "idle",
    depth: id === "m_main" ? 0 : 1,
    spawnedBy: id === "m_main" ? null : "m_main",
    controlScope: id === "m_main" ? "children" : "none",
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

describe("活动合并", () => {
  it("按 id 去重、按时间排序并裁剪", () => {
    const a: ActivityEvent = {
      id: "a",
      memberId: "m_main",
      memberName: "主智能体",
      kind: "tool",
      title: "调用 file_read",
      at: 3,
    };
    const b: ActivityEvent = { ...a, id: "b", at: 1 };
    const c: ActivityEvent = { ...a, id: "c", at: 2 };
    const merged = appendActivity([a], [b, c, { ...a, title: "重复 id 覆盖" }], 2);
    expect(merged.map((event) => event.id)).toEqual(["c", "a"]);
    expect(merged[1]?.title).toBe("重复 id 覆盖");
  });
});

describe("成员执行摘要", () => {
  it("运行中优先显示实时工具与文本，空闲成员保留最近活动与计数", () => {
    const main = member("m_main", "主智能体");
    const sub = member("m_sub", "研究员", { status: "error" });
    const activity: ActivityEvent[] = [
      { id: "1", memberId: "m_sub", memberName: "研究员", kind: "tool", title: "调用 run_command", at: 1 },
      { id: "2", memberId: "m_sub", memberName: "研究员", kind: "error", title: "运行失败", at: 2 },
      { id: "3", memberId: "m_sub", memberName: "研究员", kind: "message", title: "发言", at: 3 },
    ];
    const summary = summarizeExecution(
      [main, sub],
      activity,
      {
        m_main: {
          startedAt: 500,
          text: "正在核对数据",
          reasoning: "先确认口径，再抽样核对。",
          tools: ["file_read", "file_search"],
        },
      },
      Date.now(),
    );
    expect(summary[0]?.status).toBe("running");
    expect(summary[0]?.currentTool).toBe("file_search");
    expect(summary[0]?.startedAt).toBe(500);
    expect(summary[0]?.text).toContain("核对");
    expect(summary[0]?.reasoning).toContain("先确认口径");
    expect(summary[1]?.status).toBe("error");
    expect(summary[1]?.counts).toEqual({ tool: 1, message: 1, error: 1 });
    expect(summary[1]?.spark).toHaveLength(3);
    expect(summary[1]?.last?.kind).toBe("message");
  });

  it("成员被取消时没有 run 也显示 cancelled", () => {
    const cancelled = member("m_sub", "研究员", { status: "cancelled" });
    expect(summarizeExecution([cancelled], [], {}, Date.now())[0]?.status).toBe("cancelled");
  });
});
