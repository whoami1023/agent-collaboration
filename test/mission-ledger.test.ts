// 任务台账：只统计同一任务链的任务卡；无进展累积到阈值才要求重规划，出现进展或全部完成就复位。
import { describe, expect, it } from "vitest";
import { MissionStore } from "../src/agent/mission-ledger";
import type { RoomMessage, TaskCard } from "../src/core/types";

function root(text = "写一份调研报告"): RoomMessage {
  return {
    id: "msg_root",
    roomId: "room_test",
    seq: 1,
    ts: 0,
    senderId: "user",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text,
    mentions: [],
    mentionsRaw: [],
  };
}

function task(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "task_1",
    roomId: "room_test",
    title: "写调研报告",
    detail: "",
    chainRootId: "msg_root",
    ownerId: "m_writer",
    status: "todo",
    deps: [],
    artifacts: [],
    messageIds: [],
    createdBy: "m_main",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("MissionStore", () => {
  it("只有同一任务链的任务卡参与进展判定，无进展累积到阈值才要求重规划", () => {
    let clock = 1_000;
    const store = new MissionStore("room_test", {
      now: () => clock,
      stallThreshold: 3,
      maxReplans: 2,
    });
    const mission = store.begin(root());
    expect(mission.goal).toContain("调研报告");

    const first = task({ status: "todo" });
    store.observe({ chainRootId: mission.id, tasks: [first, task({ id: "other", chainRootId: "msg_other" })] });
    expect(store.get(mission.id)?.runsSinceProgress).toBe(0);

    // 任务状态与成果都没变：连续三轮才算一次停滞。
    for (let index = 0; index < 3; index += 1) {
      clock += 10;
      store.observe({ chainRootId: mission.id, tasks: [first] });
    }
    expect(store.get(mission.id)?.replanPending).toBe(true);
    expect(store.get(mission.id)?.stalls).toBe(1);

    const context = store.takeContext(mission.id, [first])!;
    expect(context).toContain("【任务台账】");
    expect(context).toContain("未完成：写调研报告");
    expect(context).toContain("停滞重规划");
    expect(store.get(mission.id)?.replanPending).toBe(false);
    expect(store.get(mission.id)?.replans).toBe(1);

    // 第二次停滞周期用掉最后一次自动重规划；再停滞就进入「多次重规划仍无进展」。
    for (let index = 0; index < 3; index += 1) {
      clock += 10;
      store.observe({ chainRootId: mission.id, tasks: [first] });
    }
    store.takeContext(mission.id, [first]);
    for (let index = 0; index < 3; index += 1) {
      clock += 10;
      store.observe({ chainRootId: mission.id, tasks: [first] });
    }
    expect(store.get(mission.id)?.exhausted).toBe(true);
    const exhausted = store.takeContext(mission.id, [first])!;
    expect(exhausted).toContain("多次重规划仍无进展");

    // 任务完成后台账标记完成，重规划状态清空。
    clock += 10;
    store.observe({ chainRootId: mission.id, tasks: [task({ status: "done", updatedAt: 99 })] });
    const record = store.get(mission.id)!;
    expect(record.status).toBe("completed");
    expect(record.replanPending).toBe(false);
    expect(record.exhausted).toBe(false);
  });

  it("任务状态或成果变化算进展，并把停滞周期清零", () => {
    const store = new MissionStore("room_test", { stallThreshold: 1, maxReplans: 2, now: () => 1 });
    const mission = store.begin(root());
    const base = task({ status: "doing", updatedAt: 10 });
    store.observe({ chainRootId: mission.id, tasks: [base] });
    store.observe({ chainRootId: mission.id, tasks: [base] });
    expect(store.get(mission.id)?.replanPending).toBe(true);
    store.takeContext(mission.id, [base]);

    const progressed = task({
      status: "done",
      updatedAt: 20,
      artifacts: [
        { name: "报告.md", path: "报告.md", addedAt: 20, addedBy: "m_writer" },
      ],
    });
    store.observe({ chainRootId: mission.id, tasks: [progressed] });
    const record = store.get(mission.id)!;
    expect(record.runsSinceProgress).toBe(0);
    expect(record.replans).toBe(0);
    expect(record.exhausted).toBe(false);
    const context = store.takeContext(mission.id, [progressed])!;
    expect(context).toContain("已完成");
  });

  it("没有任务卡的纯问答不参与停滞判定；快照可恢复", () => {
    const store = new MissionStore("room_test", { stallThreshold: 1 });
    const mission = store.begin(root("今天天气怎么样"));
    for (let index = 0; index < 5; index += 1) {
      store.observe({ chainRootId: mission.id, tasks: [] });
    }
    expect(store.get(mission.id)?.replanPending).toBe(false);

    const restored = new MissionStore("room_test");
    restored.hydrate(store.snapshot());
    expect(restored.get(mission.id)?.goal).toBe("今天天气怎么样");
    expect(restored.get(mission.id)?.runs).toBe(5);
  });
});
