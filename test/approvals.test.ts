import { describe, expect, it } from "vitest";
import { defaultSettings, type Settings } from "../src/core/settings";
import type { ToolImpl } from "../src/agent/loop";
import { RoomBus } from "../src/room/bus";
import { QuestionStore } from "../src/room/questions";
import { ApprovalGate } from "../src/room/approvals";

const tool: ToolImpl = {
  schema: { name: "run_command", description: "run", parameters: { type: "object", properties: {} } },
  execute: async () => "ok",
};

function setup() {
  const bus = new RoomBus("room_main", "作战室");
  const questions = new QuestionStore("room_main");
  let settings: Settings = defaultSettings();
  // 测试覆盖「询问」路径：默认已改为直接允许，这里显式改回。
  settings.approvals.categories.command = "ask";
  const gate = new ApprovalGate({
    roomId: "room_main",
    bus,
    questions,
    getSettings: () => settings,
    setSettings: async (next) => {
      settings = next;
    },
  });
  return { bus, questions, gate, getSettings: () => settings };
}

function call(id: string, command = "npm test") {
  return { id, name: "run_command", args: { command } };
}

describe("执行前审批", () => {
  it("命令默认询问，生成审批卡并挂起", async () => {
    const { bus, questions, gate } = setup();
    const result = await gate.check({
      runId: "run_1",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c1"),
      tool,
    });
    expect(result.action).toBe("suspend");
    const question = questions.list()[0]!;
    expect(question.approval?.tool).toBe("run_command");
    expect(question.approval?.preview).toContain("npm test");
    expect(question.questions[0]!.options.map((item) => item.id)).toEqual([
      "allow_once",
      "allow_conversation",
      "allow_always",
      "deny",
    ]);
    expect(bus.listMessages()[0]?.kind).toBe("question");
    expect(gate.canResume("run_1", call("c1"))).toBe(true);
  });

  it("仅本次允许后重放该调用；拒绝则不执行", async () => {
    const { questions, gate } = setup();
    await gate.check({
      runId: "run_1",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c1"),
      tool,
    });
    const question = questions.list()[0]!;
    questions.answer(question.id, "decision", { optionId: "allow_once" }, "u");
    await expect(
      gate.check({
        runId: "run_1",
        memberId: "m_main",
        memberName: "主智能体",
        call: call("c1"),
        tool,
      }),
    ).resolves.toEqual({ action: "allow" });

    await gate.check({
      runId: "run_2",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c2"),
      tool,
    });
    const denied = questions.list().at(-1)!;
    questions.answer(denied.id, "decision", { optionId: "deny" }, "u");
    const result = await gate.check({
      runId: "run_2",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c2"),
      tool,
    });
    expect(result.action).toBe("deny");
  });

  it("本会话允许只对同类同作用域生效；始终允许会写入设置", async () => {
    const { questions, gate, getSettings } = setup();
    await gate.check({
      runId: "run_1",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c1", "npm test"),
      tool,
    });
    questions.answer(questions.list()[0]!.id, "decision", { optionId: "allow_conversation" }, "u");
    await gate.check({
      runId: "run_1",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c1", "npm test"),
      tool,
    });
    const sameScope = await gate.check({
      runId: "run_2",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c2", "npm run build"),
      tool,
    });
    expect(sameScope.action).toBe("allow");

    await gate.check({
      runId: "run_3",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c3", "python analyze.py"),
      tool,
    });
    questions.answer(questions.list().at(-1)!.id, "decision", { optionId: "allow_always" }, "u");
    await gate.check({
      runId: "run_3",
      memberId: "m_main",
      memberName: "主智能体",
      call: call("c3", "python analyze.py"),
      tool,
    });
    expect(getSettings().approvals.rules).toHaveLength(1);
    expect(getSettings().approvals.rules[0]?.scope).toBe("python");
  });
});
