import { describe, expect, it } from "vitest";
import type { Member } from "../../src/core/types";
import type { ActivityEvent, RunningView } from "./activity-model";
import {
  TRACE_ACCENTS,
  buildToolRuns,
  buildTraceActors,
  formatToolArgs,
  latestClause,
  traceAccentFor,
  traceLookFor,
} from "./run-trace-model";

function member(id: string, overrides: Partial<Member> = {}): Member {
  return {
    id,
    roomId: "room_main",
    name: id,
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

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "a1",
    memberId: "m_main",
    memberName: "主智能体",
    kind: "tool",
    title: "调用 file_write",
    at: 100,
    ...overrides,
  };
}

describe("运行轨迹形象", () => {
  it("主智能体是指挥形象，子成员按技能与简介分到调研/开发/写作", () => {
    expect(traceLookFor(member("m_main"))).toBe("planner");
    expect(traceLookFor(member("m_sub", { skillNames: ["code-review"] }))).toBe("coder");
    expect(traceLookFor(member("m_sub", { brief: "负责竞品调研与资料检索" }))).toBe("researcher");
    expect(traceLookFor(member("m_sub", { skillNames: ["docx"], brief: "写报告" }))).toBe("writer");
    expect(traceLookFor(member("m_sub", { brief: "打杂" }))).toBe("member");
  });

  it("配色按成员 ID 稳定落在固定色板里", () => {
    const alice = member("u_alice");
    expect(traceAccentFor(alice)).toBe(traceAccentFor(alice));
    expect(TRACE_ACCENTS).toContain(traceAccentFor(alice));
    expect(TRACE_ACCENTS).toContain(traceAccentFor(member("u_bob")));
  });

  it("气泡只取最后一句完整表述并做长度控制", () => {
    expect(latestClause("先看目录。\n再核对指标！最后写结论。")).toBe("最后写结论。");
    expect(latestClause("没有标点的长句".repeat(20), 12)).toHaveLength(13);
  });
});

describe("成员运行轨迹", () => {
  it("实时运行优先于历史活动，工具与推理分别决定状态和气泡", () => {
    const main = member("m_main", { status: "running" });
    const activity = [event({ id: "old", kind: "final", title: "交付完成", at: 50 })];
    const running: Record<string, RunningView> = {
      m_main: {
        startedAt: 500,
        text: "",
        reasoning: "先确认范围。再调用工具核对资料。",
        tools: ["file_write"],
      },
    };
    const [actor] = buildTraceActors([main], activity, running);
    expect(actor?.mood).toBe("working");
    expect(actor?.thought).toBe("工具 · file_write");
    expect(actor?.startedAt).toBe(500);
    expect(actor?.milestones.map((item) => item.id)).toEqual(["old"]);

    const thinking = buildTraceActors(
      [main],
      activity,
      { m_main: { startedAt: 500, text: "", reasoning: "先确认范围。再核对资料。", tools: [] } },
    )[0];
    expect(thinking?.mood).toBe("thinking");
    expect(thinking?.thought).toBe("再核对资料。");
  });

  it("空闲成员按最近活动区分交付/出错/取消，运行中的排在前面", () => {
    const main = member("m_main", { status: "running" });
    const sub = member("m_sub", { status: "error" });
    const activity = [
      event({ id: "m1", memberId: "m_main", kind: "start", title: "开始运行", at: 10 }),
      event({ id: "s1", memberId: "m_sub", kind: "error", title: "运行失败", at: 20 }),
    ];
    const actors = buildTraceActors([sub, main], activity, {
      m_main: { startedAt: 30, text: "正在写结论", reasoning: "", tools: [] },
    });
    expect(actors[0]?.member.id).toBe("m_main");
    expect(actors[0]?.mood).toBe("working");
    expect(actors[0]?.thought).toBe("正在组织交付…");
    expect(actors[1]?.mood).toBe("error");

    const done = buildTraceActors(
      [member("m_sub")],
      [event({ id: "f1", memberId: "m_sub", kind: "final", title: "交付完成", detail: "结论已落盘。", at: 30 })],
      {},
    )[0];
    expect(done?.mood).toBe("done");
    expect(done?.thought).toBe("结论已落盘。");

    const cancelled = buildTraceActors([member("m_sub", { status: "cancelled" })], [], {})[0];
    expect(cancelled?.mood).toBe("cancelled");
  });

  it("轨迹带只保留该成员最近的事件并统计工具/发言/失败", () => {
    const activity: ActivityEvent[] = Array.from({ length: 12 }, (_, index) =>
      event({
        id: `e${index}`,
        kind: index === 11 ? "error" : index % 2 === 0 ? "tool" : "message",
        at: index,
      }),
    );
    const [actor] = buildTraceActors([member("m_main")], activity, {}, 5);
    expect(actor?.milestones.map((item) => item.id)).toEqual(["e1", "e3", "e5", "e7", "e9", "e11"]);
    expect(actor?.toolRuns.map((run) => run.id)).toEqual(["e2", "e4", "e6", "e8", "e10"]);
    expect(actor?.counts).toEqual({ tool: 6, message: 5, error: 1 });
    expect(actor?.lastAt).toBe(11);
  });
});

describe("工具轨迹", () => {
  it("按工具名把调用与结果配对，命令行工具优先展示完整命令", () => {
    const events: ActivityEvent[] = [
      event({
        id: "c1",
        kind: "tool",
        title: "调用 run_command",
        detail: JSON.stringify({ command: "npm test", cwd: "files" }),
        at: 1,
      }),
      event({ id: "r1", kind: "tool-result", title: "run_command 返回", detail: "12 passed", ok: true, at: 2 }),
      event({
        id: "c2",
        kind: "tool",
        title: "调用 file_write",
        detail: JSON.stringify({ path: "report.md", append: true }),
        at: 3,
      }),
      event({ id: "r2", kind: "tool-result", title: "file_write 报错", detail: "文件已存在", ok: false, at: 4 }),
      event({ id: "r3", kind: "tool-result", title: "web_fetch 返回", detail: "孤立的返回", ok: true, at: 5 }),
    ];
    const runs = buildToolRuns(events);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({
      name: "run_command",
      args: "$ npm test (cwd: files)",
      ok: true,
      result: "12 passed",
    });
    expect(runs[1]).toMatchObject({ name: "file_write", args: "report.md（追加）", ok: false });
    expect(runs[2]).toMatchObject({ name: "web_fetch", args: "", ok: true, result: "孤立的返回" });
  });

  it("常见工具参数格式化成一眼能看懂的一行", () => {
    expect(formatToolArgs("file_search", JSON.stringify({ query: "结论", path: "reports" }))).toBe(
      "结论 @ reports",
    );
    expect(formatToolArgs("run_skill_script", JSON.stringify({ skill: "docx", args: ["a.md"] }))).toBe(
      "▸ docx a.md",
    );
    expect(formatToolArgs("task_update", JSON.stringify({ task_id: "task_1", status: "done" }))).toBe(
      "task_1 → done",
    );
    expect(formatToolArgs("unknown_tool", "not json")).toBe("not json");
  });
});
