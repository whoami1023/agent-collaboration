// 结构化提问：校验、逐题作答、全部答完回灌，以及 ask_user 工具落消息。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QuestionStore,
  answerLabel,
  formatAnswerMessage,
  formatQuestionMessage,
  parseQuestionFields,
  type QuestionField,
} from "../src/room/questions";
import { RoomBus } from "../src/room/bus";
import { ensureMainMember } from "../src/agent/orchestrator";
import { buildQuestionTools } from "../src/agent/question-tools";
import { ToolSuspensionSignal } from "../src/agent/loop";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import type { Member } from "../src/core/types";

const signal = new AbortController().signal;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fields(): QuestionField[] {
  return [
    {
      id: "scope",
      question: "报告范围选哪个？",
      options: [
        { id: "brief", label: "只要摘要" },
        { id: "full", label: "完整报告", recommended: true },
      ],
    },
    {
      id: "audience",
      question: "主要读者是谁？",
      options: [
        { id: "exec", label: "管理层" },
        { id: "team", label: "执行团队" },
      ],
    },
  ];
}

function member(): Member {
  return {
    id: "m_main",
    roomId: "room_test",
    name: "主智能体",
    role: "main",
    status: "idle",
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

describe("问题校验", () => {
  it("接受 1–4 个问题、2–4 个选项与一个推荐项", () => {
    const parsed = parseQuestionFields(fields());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.questions).toHaveLength(2);
      expect(parsed.questions[0]!.options[1]!.recommended).toBe(true);
    }
  });

  it("拒绝越界的数量、id、题干、选项与多个推荐项", () => {
    expect(parseQuestionFields([]).ok).toBe(false);
    expect(parseQuestionFields("x").ok).toBe(false);
    expect(
      parseQuestionFields([
        { id: "bad id", question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      ]).ok,
    ).toBe(false);
    expect(
      parseQuestionFields([
        { id: "q1", question: "x".repeat(501), options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      ]).ok,
    ).toBe(false);
    expect(
      parseQuestionFields([{ id: "q1", question: "q", options: [{ id: "a", label: "A" }] }]).ok,
    ).toBe(false);
    expect(
      parseQuestionFields([
        {
          id: "q1",
          question: "q",
          options: [
            { id: "a", label: "A", recommended: true },
            { id: "b", label: "B", recommended: true },
          ],
        },
      ]).ok,
    ).toBe(false);
    const five = Array.from({ length: 5 }, (_, index) => ({
      id: `q${index}`,
      question: "q",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    }));
    expect(parseQuestionFields(five).ok).toBe(false);
  });
});

describe("QuestionStore", () => {
  it("逐题作答，全部答完才结算；完成后不再接受答案", () => {
    const store = new QuestionStore("room_test");
    const item = store.ask({
      messageId: "msg_q",
      askerId: "m_main",
      askerName: "主智能体",
      title: "确认口径",
      questions: fields(),
    });
    expect(item.status).toBe("open");

    const first = store.answer(item.id, "scope", { optionId: "full" }, "u1");
    expect(first.status).toBe("recorded");
    if (first.status === "recorded") expect(first.complete).toBe(false);
    expect(store.get(item.id)?.status).toBe("open");

    const second = store.answer(item.id, "audience", { text: "董事会" }, "u1");
    expect(second.status).toBe("recorded");
    if (second.status === "recorded") expect(second.complete).toBe(true);
    const done = store.get(item.id)!;
    expect(done.status).toBe("answered");
    expect(done.answeredBy).toBe("u1");
    expect(done.transitions.map((entry) => entry.to)).toEqual(["open", "answered"]);

    expect(store.answer(item.id, "scope", { optionId: "brief" }, "u1")).toMatchObject({
      status: "not-applicable",
    });
  });

  it("完成前允许改写；未知选项、空回答与未知字段被拒", () => {
    const store = new QuestionStore("room_test");
    const item = store.ask({
      messageId: "msg_q",
      askerId: "m_main",
      askerName: "主智能体",
      questions: fields(),
    });
    expect(store.answer(item.id, "scope", { optionId: "nope" }, "u1").status).toBe("not-applicable");
    expect(store.answer(item.id, "scope", { text: "  " }, "u1").status).toBe("not-applicable");
    expect(store.answer(item.id, "missing", { optionId: "brief" }, "u1").status).toBe("not-applicable");

    store.answer(item.id, "scope", { optionId: "brief" }, "u1");
    store.answer(item.id, "scope", { optionId: "full" }, "u1");
    expect(store.get(item.id)?.answers["scope"]?.optionId).toBe("full");
  });

  it("取消未答问题；快照可水合且坏行被丢弃", () => {
    let clock = 1;
    const store = new QuestionStore("room_test", { now: () => clock++ });
    const item = store.ask({
      messageId: "msg_q",
      askerId: "m_main",
      askerName: "主智能体",
      questions: fields(),
    });
    store.answer(item.id, "scope", { optionId: "brief" }, "u1");
    const snapshot = store.snapshot();
    expect(store.cancelOpen("system", "会话已清除")).toBe(1);
    expect(store.get(item.id)?.status).toBe("canceled");

    const restored = new QuestionStore("room_test");
    restored.hydrate([...snapshot, { bad: true }, null]);
    expect(restored.list()).toHaveLength(1);
    expect(restored.get(item.id)?.answers["scope"]?.optionId).toBe("brief");
    expect(restored.get(item.id)?.questions).toHaveLength(2);
  });

  it("格式化：提问消息列出选项，回答消息给出逐题答案", () => {
    const store = new QuestionStore("room_test");
    const item = store.ask({
      messageId: "msg_q",
      askerId: "m_main",
      askerName: "主智能体",
      title: "确认口径",
      questions: fields(),
      unblocks: "继续写报告",
    });
    const questionText = formatQuestionMessage(item);
    expect(questionText).toContain("【需要你回答】确认口径");
    expect(questionText).toContain("继续写报告");
    expect(questionText).toContain("完整报告（推荐）");
    expect(questionText).toContain("请在问题卡片里选择选项");

    store.answer(item.id, "scope", { optionId: "full" }, "u1");
    store.answer(item.id, "audience", { text: "董事会" }, "u1");
    const answered = store.get(item.id)!;
    expect(answerLabel(answered, answered.questions[1]!)).toBe("董事会");
    const answerText = formatAnswerMessage(answered);
    expect(answerText).toContain("【结构化回答】对「确认口径」的回答");
    expect(answerText).toContain("完整报告");
    expect(answerText).toContain("董事会");
  });
});

describe("ask_user 工具与回答回灌", () => {
  it("工具落一条 question 消息并以挂起信号收束本轮", async () => {
    const bus = new RoomBus("room_test", "测试群");
    ensureMainMember(bus);
    const store = new QuestionStore("room_test");
    const tool = buildQuestionTools({ bus, member: member(), questions: store })[0]!;
    const pending = tool.execute(
      {
        title: "确认口径",
        questions: fields(),
        unblocks: "继续写报告",
        urgency: "urgent",
      },
      signal,
    );
    await expect(pending).rejects.toBeInstanceOf(ToolSuspensionSignal);
    const signalPayload = await pending.catch((err: unknown) =>
      err instanceof ToolSuspensionSignal ? err.suspension : null,
    );
    const open = store.open();
    expect(open).toHaveLength(1);
    expect(open[0]?.urgency).toBe("urgent");
    const message = bus.listMessages(10).at(-1)!;
    expect(message.kind).toBe("question");
    expect(message.text).toContain("【需要你回答】确认口径");
    expect(open[0]?.messageId).toBe(message.id);
    expect(signalPayload).toMatchObject({
      kind: "awaiting_user",
      questionId: open[0]?.id,
      messageId: message.id,
    });
  });

  it("不合法的提问直接拒绝，不落消息", async () => {
    const bus = new RoomBus("room_test", "测试群");
    ensureMainMember(bus);
    const store = new QuestionStore("room_test");
    const tool = buildQuestionTools({ bus, member: member(), questions: store })[0]!;
    const out = await tool.execute({ questions: [{ id: "q", question: "q" }] }, signal);
    expect(out).toContain("错误");
    expect(store.list()).toHaveLength(0);
    expect(bus.listMessages(10)).toHaveLength(0);
  });

  it("workspace 回答最后一题时把答案作为用户消息 @ 提问者", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-questions-"));
    tempDirs.push(dir);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const registry = new WorkspaceRegistry(join(dir, "workspaces"), skills);
    const ws = await registry.get({ id: "u_q", displayName: "提问用户", role: "admin" });
    const room = ws.room();
    const questionMessage = room.bus.append({
      senderId: "m_main",
      senderName: "主智能体",
      senderKind: "member",
      kind: "question",
      text: "【需要你回答】确认口径",
      mentions: [],
      depthTurn: 0,
    });
    const item = room.questions.ask({
      messageId: questionMessage.id,
      askerId: "m_main",
      askerName: "主智能体",
      title: "确认口径",
      questions: fields(),
    });

    const partial = await ws.answerQuestion(
      "room_main",
      item.id,
      "scope",
      { optionId: "full" },
      "u_q",
    );
    expect(partial.question.status).toBe("open");
    expect(partial.message).toBeNull();
    const before = room.bus.listMessages(50).length;

    const completed = await ws.answerQuestion(
      "room_main",
      item.id,
      "audience",
      { text: "董事会" },
      "u_q",
    );
    expect(completed.question.status).toBe("answered");
    expect(completed.resumed).toBe(false);
    expect(completed.message?.resumeQuestionId).toBeUndefined();
    expect(completed.message?.senderKind).toBe("user");
    expect(completed.message?.mentions).toContain("m_main");
    expect(completed.message?.text).toContain("完整报告");
    expect(completed.message?.text).toContain("董事会");
    expect(room.bus.listMessages(50).length).toBe(before + 1);

    await registry.closeAll();
  });
});
