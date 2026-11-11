// 服务端执行轨迹：消息/run 事件记录、去重、裁剪与中断标记。
import { describe, expect, it } from "vitest";
import type { AgentEvent, RoomMessage } from "../src/core/types";
import { ActivityStore } from "../src/room/activity-log";

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg_1",
    roomId: "room_test",
    seq: 1,
    ts: 1_000,
    senderId: "user",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text: "帮我看看",
    mentions: [],
    mentionsRaw: [],
    ...overrides,
  };
}

describe("ActivityStore", () => {
  it("记录用户与成员消息，系统提示跳过，同一消息不重复", () => {
    const changes: string[] = [];
    const store = new ActivityStore("room_test", { onChange: (event) => changes.push(event.id) });
    const user = store.recordMessage(message());
    expect(user?.kind).toBe("user");
    expect(user?.memberName).toBe("用户");
    expect(store.recordMessage(message())).toBeNull();
    expect(
      store.recordMessage(
        message({
          id: "msg_2",
          seq: 2,
          senderId: "m_main",
          senderName: "主智能体",
          senderKind: "member",
          kind: "announce",
          text: "结论在这里",
        }),
      )?.kind,
    ).toBe("message");
    expect(
      store.recordMessage(message({ id: "msg_3", seq: 3, senderKind: "system", kind: "system" })),
    ).toBeNull();
    expect(store.list()).toHaveLength(2);
    expect(changes).toHaveLength(2);
  });

  it("run 事件映射为开始/工具/结果/完成/失败/中止，delta 不记录", () => {
    const store = new ActivityStore("room_test");
    const events: AgentEvent[] = [
      { type: "run-start", runId: "run_1", memberId: "m_main" },
      { type: "delta", runId: "run_1", memberId: "m_main", text: "…" },
      { type: "tool", runId: "run_1", memberId: "m_main", name: "file_read", args: { path: "a.md" } },
      {
        type: "tool-result",
        runId: "run_1",
        memberId: "m_main",
        name: "file_read",
        content: "正文",
        ok: false,
      },
      { type: "run-final", runId: "run_1", memberId: "m_main", text: "完成" },
      { type: "run-error", runId: "run_2", memberId: "m_main", error: "接口失败" },
      { type: "run-aborted", runId: "run_3", memberId: "m_main", reason: "timeout" },
    ];
    for (const event of events) store.recordRunEvent(event, "主智能体");
    const recorded = store.list();
    expect(recorded.map((event) => event.kind)).toEqual([
      "start",
      "tool",
      "tool-result",
      "final",
      "error",
      "aborted",
    ]);
    expect(recorded[1]?.detail).toContain("a.md");
    expect(recorded[2]?.ok).toBe(false);
    expect(recorded[5]?.title).toContain("超时");
  });

  it("播种历史消息时按 msg id 去重并遵守上限", () => {
    const store = new ActivityStore("room_test");
    const messages = Array.from({ length: 8 }, (_, index) =>
      message({ id: `m${index}`, seq: index, ts: index, text: `消息 ${index}` }),
    );
    expect(store.seedMessages(messages, new Map(), 5)).toBe(5);
    expect(store.seedMessages(messages, new Map(), 5)).toBe(0);
    expect(store.list()).toHaveLength(5);
    expect(store.list()[0]?.at).toBe(3);
  });

  it("按条数与字节裁剪，保留最新事件", () => {
    let clock = 1;
    const store = new ActivityStore("room_test", { now: () => clock++, maxEvents: 3 });
    for (let index = 0; index < 6; index += 1) store.recordRunEvent({
      type: "run-start",
      runId: `run_${index}`,
      memberId: "m_main",
    }, "主智能体");
    expect(store.list()).toHaveLength(3);
    expect(store.list().at(-1)?.runId).toBe("run_5");

    const small = new ActivityStore("room_test", { maxBytes: 220 });
    for (let index = 0; index < 5; index += 1) {
      small.recordMessage(
        message({ id: `m${index}`, seq: index, ts: index, text: "x".repeat(80) }),
      );
    }
    expect(small.list().length).toBeLessThan(5);
    expect(small.list().at(-1)?.id).toBe("msg_m4");
  });

  it("推理增量只落一条「思考」事件，后续增量更新摘要", () => {
    const changes: number[] = [];
    const store = new ActivityStore("room_test", { onChange: (event) => changes.push(event.at) });
    store.recordRunEvent({ type: "run-start", runId: "run_1", memberId: "m_main" }, "主智能体");
    store.recordRunEvent(
      { type: "reasoning", runId: "run_1", memberId: "m_main", text: "先看环境。" },
      "主智能体",
    );
    store.recordRunEvent(
      {
        type: "reasoning",
        runId: "run_1",
        memberId: "m_main",
        text: "先看环境。\n再核对资料。",
      },
      "主智能体",
    );
    const thinking = store.list().filter((event) => event.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.id).toBe("thinking_run_1");
    expect(thinking[0]?.detail).toBe("先看环境。 再核对资料。");
    expect(thinking[0]?.runId).toBe("run_1");
    expect(changes).toHaveLength(3);

    store.recordRunEvent({ type: "run-start", runId: "run_2", memberId: "m_main" }, "主智能体");
    store.recordRunEvent(
      { type: "reasoning", runId: "run_2", memberId: "m_main", text: "另一轮" },
      "主智能体",
    );
    expect(store.list().filter((event) => event.kind === "thinking")).toHaveLength(2);
  });

  it("水合丢弃坏行；中断标记带触发文本", () => {
    const store = new ActivityStore("room_test");
    store.hydrate([
      { id: "a", memberId: "m_main", memberName: "主智能体", kind: "tool", title: "调用", at: 2 },
      { id: "bad", memberId: "m_main", kind: "nope", at: 3 },
      null,
      { id: "b", memberId: "m_main", kind: "final", at: 1 },
    ]);
    expect(store.list().map((event) => event.id)).toEqual(["b", "a"]);

    const interrupted = store.recordInterruption({
      memberId: "m_main",
      memberName: "主智能体",
      triggerText: "做一次巡检",
    });
    expect(interrupted.kind).toBe("aborted");
    expect(interrupted.title).toContain("进程中断");
    expect(interrupted.detail).toContain("做一次巡检");
  });
});
