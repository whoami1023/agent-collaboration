// 持久工作队列：状态机、恢复、派生健康度，以及编排器的领取/结算与重启续跑。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_WORK_ITEMS,
  PENDING_STALL_MS,
  RUNNING_STALL_MS,
  WORK_RECOVERY_WINDOW_MS,
  WorkQueue,
} from "../src/room/work-queue";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceFiles } from "../src/files/workspace-files";
import { defaultSettings, type Settings } from "../src/core/settings";
import { DEFAULT_LIMITS, type RoomMessage } from "../src/core/types";
import { RunJournalStore } from "../src/agent/run-journal";
import type { LlmMessage, ToolCall } from "../src/provider/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg_1",
    roomId: "room_test",
    seq: 1,
    ts: 0,
    senderId: "user",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text: "做一件小事",
    mentions: [],
    mentionsRaw: [],
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("WorkQueue：状态机与持久化", () => {
  it("入队、领取、完成：迁移日志完整，活跃行按触发消息去重", () => {
    let clock = 1_000;
    const queue = new WorkQueue("room_test", { now: () => clock });
    const first = queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: message() });
    expect(first?.state).toBe("pending");
    expect(first?.transitions.map((item) => item.to)).toEqual(["pending"]);

    // 同一条触发消息不会重复建行；换一条消息才可以。
    expect(queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: message() })).toBeNull();
    const second = queue.enqueue({
      memberId: "m_main",
      memberName: "主智能体",
      trigger: message({ id: "msg_2", seq: 2, text: "第二件事" }),
    });
    expect(second).not.toBeNull();
    expect(queue.list()).toHaveLength(2);

    clock = 2_000;
    const claimed = queue.claim(first!.id);
    expect(claimed?.state).toBe("in_progress");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimedAt).toBe(2_000);

    clock = 3_000;
    const done = queue.complete(first!.id, "做完了");
    expect(done?.state).toBe("done");
    expect(done?.outcome).toEqual({ status: "ok", text: "做完了" });
    expect(done?.transitions.map((item) => item.to)).toEqual(["pending", "in_progress", "done"]);
    expect(queue.claim(first!.id)).toBeNull();
  });

  it("失败与取消都保留终局理由；取消可按成员或整队执行", () => {
    const queue = new WorkQueue("room_test");
    const a = queue.enqueue({ memberId: "m_a", memberName: "甲", trigger: message() })!;
    const b = queue.enqueue({
      memberId: "m_b",
      memberName: "乙",
      trigger: message({ id: "msg_2", seq: 2 }),
    })!;
    queue.claim(a.id);
    expect(queue.fail(a.id, "模型接口失败")?.outcome).toEqual({ status: "error", error: "模型接口失败" });

    queue.claim(b.id);
    expect(queue.cancel(b.id, "用户停止")?.state).toBe("canceled");
    expect(queue.fail(b.id, "迟到失败")).toBeNull();

    const c = queue.enqueue({
      memberId: "m_b",
      memberName: "乙",
      trigger: message({ id: "msg_3", seq: 3 }),
    })!;
    expect(queue.cancelForMember("m_b", "成员已移除")).toBe(1);
    expect(c.state).toBe("canceled");

    const d = queue.enqueue({
      memberId: "m_a",
      memberName: "甲",
      trigger: message({ id: "msg_4", seq: 4 }),
    })!;
    expect(queue.cancelOpen("会话已清除")).toBe(1);
    expect(d.state).toBe("canceled");
  });

  it("进程中断把 in_progress 接回 pending，恢复次数累加且保留尝试数", () => {
    const queue = new WorkQueue("room_test");
    const item = queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: message() })!;
    queue.claim(item.id);
    expect(queue.recoverInterrupted()).toBe(1);
    const recovered = queue.get(item.id)!;
    expect(recovered.state).toBe("pending");
    expect(recovered.recoveries).toBe(1);
    expect(recovered.attempts).toBe(1);
    expect(recovered.claimedAt).toBeUndefined();
    expect(recovered.transitions.at(-1)?.note).toContain("进程中断");
    queue.claim(item.id);
    expect(queue.get(item.id)?.attempts).toBe(2);
  });

  it("派生健康度：排队与运行过久分别标记，终局项不再计时", () => {
    let clock = 1_000;
    const queue = new WorkQueue("room_test", { now: () => clock });
    const pending = queue.enqueue({ memberId: "m_a", memberName: "甲", trigger: message() })!;
    const running = queue.enqueue({
      memberId: "m_b",
      memberName: "乙",
      trigger: message({ id: "msg_2", seq: 2 }),
    })!;
    queue.claim(running.id);
    const finished = queue.enqueue({
      memberId: "m_c",
      memberName: "丙",
      trigger: message({ id: "msg_3", seq: 3 }),
    })!;
    queue.claim(finished.id);
    queue.complete(finished.id, "完成");

    clock = 1_000 + PENDING_STALL_MS + 1;
    let health = new Map(queue.health().map((item) => [item.id, item]));
    expect(health.get(pending.id)?.derived).toBe("unclaimed-stalled");
    expect(health.get(running.id)?.derived).toBe("working");

    clock = 1_000 + RUNNING_STALL_MS + 1;
    health = new Map(queue.health().map((item) => [item.id, item]));
    expect(health.get(running.id)?.derived).toBe("running-stalled");
    expect(health.get(finished.id)?.derived).toBe("finished");
    expect(health.get(finished.id)?.ageMs).toBe(0);
  });

  it("快照可水合、坏行被丢弃、终局行按容量裁剪且不丢活跃行", () => {
    let clock = 1;
    const queue = new WorkQueue("room_test", { now: () => clock++, maxItems: 2 });
    for (let index = 0; index < 5; index += 1) {
      const item = queue.enqueue({
        memberId: "m_main",
        memberName: "主智能体",
        trigger: message({ id: `msg_${index}`, seq: index }),
      })!;
      queue.claim(item.id);
      queue.complete(item.id, `done ${index}`);
    }
    const active = queue.enqueue({
      memberId: "m_main",
      memberName: "主智能体",
      trigger: message({ id: "msg_active", seq: 99 }),
    })!;
    const snapshot = queue.snapshot();
    expect(snapshot.filter((item) => item.state === "done")).toHaveLength(2);
    expect(snapshot.some((item) => item.id === active.id)).toBe(true);
    expect(snapshot.length).toBeLessThanOrEqual(MAX_WORK_ITEMS);

    const restored = new WorkQueue("room_test");
    restored.hydrate([...snapshot, { garbage: true }, null]);
    expect(restored.list()).toHaveLength(snapshot.length);
    expect(restored.get(active.id)?.state).toBe("pending");
    expect(restored.get(active.id)?.trigger.text).toBe("做一件小事");

    // 快照是副本：改它不影响队列本身。
    snapshot[0]!.state = "canceled";
    expect(queue.list().find((item) => item.id === snapshot[0]!.id)?.state).not.toBe("canceled");
  });

  it("运行日志 id 只挂活跃行，随快照保留且可续跑", () => {
    const queue = new WorkQueue("room_test");
    const active = queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: message() })!;
    const done = queue.enqueue({
      memberId: "m_main",
      memberName: "主智能体",
      trigger: message({ id: "msg_2", seq: 2 }),
    })!;
    queue.claim(done.id);
    queue.complete(done.id, "已完成");

    expect(queue.attachRun(active.id, "run_a")?.runId).toBe("run_a");
    expect(queue.attachRun(active.id, "run_a")?.runId).toBe("run_a");
    expect(queue.attachRun(done.id, "run_late")).toBeNull();
    expect(queue.attachRun("work_missing", "run_x")).toBeNull();

    const restored = new WorkQueue("room_test");
    restored.hydrate(queue.snapshot());
    expect(restored.get(active.id)?.runId).toBe("run_a");

    // 续跑换新 id 时覆盖旧值，下一次中断按新日志找断点。
    expect(queue.attachRun(active.id, "run_b")?.runId).toBe("run_b");
  });
});

describe("编排器接入持久队列", () => {
  async function makeRig(overrides: { settings?: Settings; queue?: WorkQueue } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "ac-workqueue-"));
    tempDirs.push(dir);
    const bus = new RoomBus("room_test", "测试群");
    const board = new Workboard("room_test");
    ensureMainMember(bus);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const settings: Settings = overrides.settings ?? {
      ...defaultSettings(),
      providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }],
      limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 4, runTimeoutMs: 5_000 },
    };
    return { bus, board, skills, files: new WorkspaceFiles(dir), settings, queue: overrides.queue };
  }

  it("运行成功把队列行结算为 done，终局文本随行保留", async () => {
    const rig = await makeRig();
    const queue = new WorkQueue("room_test");
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: (request) =>
        request.messages[0]?.content.includes("里的主智能体") ? { text: "任务完成" } : { text: "收到" },
    });
    orchestrator.sendUserMessage("做一件事");
    await waitFor(() => queue.list().some((item) => item.state === "done"));
    const item = queue.list()[0]!;
    expect(item.memberId).toBe("m_main");
    expect(item.attempts).toBe(1);
    expect(item.outcome).toEqual({ status: "ok", text: "任务完成" });
  });

  it("运行失败把队列行结算为 failed 并保留错误", async () => {
    const rig = await makeRig();
    const queue = new WorkQueue("room_test");
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: () => {
        throw new Error("provider boom");
      },
    });
    orchestrator.sendUserMessage("做一件会失败的事");
    await waitFor(() => queue.list().some((item) => item.state === "failed"));
    expect(queue.list()[0]?.outcome?.status).toBe("error");
    expect(queue.list()[0]?.outcome?.error).toContain("provider boom");
  });

  it("整轮超时结算为 failed，而不是取消", async () => {
    const rig = await makeRig({
      settings: {
        ...defaultSettings(),
        providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }],
        limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 4, runTimeoutMs: 300 },
      },
    });
    const queue = new WorkQueue("room_test");
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return { text: "迟到的完成" };
      },
    });
    orchestrator.sendUserMessage("慢慢做");
    await waitFor(() => queue.list().some((item) => item.state === "failed"), 8_000);
    expect(queue.list()[0]?.outcome?.error).toContain("超时");
  });

  it("/stop 会取消未完成的队列行，并写明理由", async () => {
    const rig = await makeRig();
    const queue = new WorkQueue("room_test");
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { text: "完成" };
      },
    });
    orchestrator.sendUserMessage("停下来");
    await waitFor(() => queue.list().some((item) => item.state === "in_progress"));
    orchestrator.stopAllRuns();
    expect(queue.list()[0]?.state).toBe("canceled");
    expect(queue.list()[0]?.outcome?.error).toBe("用户停止");
  });

  it("启动恢复：中断的 in_progress 回到 pending 后由 resumeQueue 接着跑完", async () => {
    const rig = await makeRig();
    const trigger = rig.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: "重启后继续",
      depthTurn: 0,
    });
    const queue = new WorkQueue("room_test");
    const item = queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger })!;
    queue.claim(item.id);
    queue.recoverInterrupted();

    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: () => ({ text: "恢复完成" }),
    });
    expect(orchestrator.resumeQueue()).toBe(1);
    await waitFor(() => queue.get(item.id)?.state === "done");
    expect(queue.get(item.id)?.attempts).toBe(2);
    expect(queue.get(item.id)?.outcome?.text).toBe("恢复完成");
  });

  it("重启续跑：已完成的调用不重跑，未确认的副作用调用明确提示", async () => {
    const rig = await makeRig();
    const journalDir = await mkdtemp(join(tmpdir(), "ac-workqueue-journal-"));
    tempDirs.push(journalDir);
    const journals = new RunJournalStore(journalDir);
    const trigger = rig.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: "重启后继续",
      depthTurn: 0,
    });
    const queue = new WorkQueue("room_test");
    const item = queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger })!;

    // 模拟上一进程：写完 a.txt 后、b.txt 的结果落盘前被杀。
    const runId = "run_resume_e2e";
    const doneCall: ToolCall = { id: "call_done", name: "file_write", args: { path: "a.txt" } };
    const lostCall: ToolCall = { id: "call_lost", name: "file_write", args: { path: "b.txt" } };
    const recorder = journals.start({
      roomId: "room_test",
      runId,
      memberId: "m_main",
      workItemId: item.id,
      initialMessages: [{ role: "user", content: "重启后继续" }],
    })!;
    recorder.assistant(0, "", [doneCall]);
    recorder.toolResult(0, doneCall, "已写入 a.txt", { ok: true });
    recorder.assistant(1, "", [lostCall]);

    queue.claim(item.id);
    queue.attachRun(item.id, runId);
    queue.recoverInterrupted();

    const requests: LlmMessage[][] = [];
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      journals,
      mockHandler: (request) => {
        requests.push(request.messages);
        return { text: "续跑完成" };
      },
    });
    expect(orchestrator.resumeQueue()).toBe(1);
    await waitFor(() => queue.get(item.id)?.state === "done");

    // 续跑只多了一次模型调用；旧结果作为上下文送回，未确认调用被明确标注。
    expect(requests).toHaveLength(1);
    const contents = requests[0]!.map((entry) => `${entry.role}:${entry.content}`);
    expect(contents).toContain("tool:已写入 a.txt");
    expect(contents.some((entry) => entry.startsWith("tool:") && entry.includes("无法确认"))).toBe(true);
    expect(queue.get(item.id)?.outcome?.text).toBe("续跑完成");
    expect(journals.load(runId)?.done).toBe(true);
  });

  it("时间旅行：从检查点分叉只保留前缀历史，并接上新指令跑完", async () => {
    const rig = await makeRig();
    const journalDir = await mkdtemp(join(tmpdir(), "ac-workqueue-fork-"));
    tempDirs.push(journalDir);
    const journals = new RunJournalStore(journalDir);
    const firstCall: ToolCall = { id: "call_1", name: "file_read", args: { path: "a.md" } };
    const secondCall: ToolCall = { id: "call_2", name: "file_read", args: { path: "b.md" } };
    const source = journals.start({
      roomId: "room_test",
      runId: "run_source",
      memberId: "m_main",
      initialMessages: [{ role: "user", content: "整理两份资料" }],
    })!;
    source.assistant(0, "", [firstCall]);
    source.toolResult(0, firstCall, "第一份资料", { ok: true });
    source.assistant(1, "", [secondCall]);
    source.toolResult(1, secondCall, "第二份资料", { ok: true });
    source.finish({ status: "ok", text: "整理完成", steps: 2 });

    const queue = new WorkQueue("room_test");
    const requests: LlmMessage[][] = [];
    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      journals,
      mockHandler: (request) => {
        requests.push(request.messages);
        return { text: "分支完成" };
      },
    });

    const forked = orchestrator.forkFromCheckpoint("run_source", 1, "只用第一份资料重写");
    expect(forked.runId).not.toBe("run_source");
    await waitFor(() => queue.list().some((item) => item.state === "done"));

    expect(requests).toHaveLength(1);
    const sent = requests[0]!.map((message) => message.content).join("\n");
    expect(sent).toContain("第一份资料");
    expect(sent).toContain("只用第一份资料重写");
    expect(sent).not.toContain("第二份资料");
    expect(queue.list()[0]?.outcome?.text).toBe("分支完成");

    // 新分支有自己的终局；源日志原样保留。
    expect(journals.load(forked.runId)?.done).toBe(true);
    expect(journals.load(forked.runId)?.steps).toBe(2);
    expect(journals.load("run_source")?.terminal?.text).toBe("整理完成");
  });

  it("同一成员有多条待办时逐条恢复，后一条不会在前一条运行时被吞掉", async () => {
    const rig = await makeRig();
    const first = rig.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: "第一件事",
      depthTurn: 0,
    });
    const second = rig.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: "第二件事",
      depthTurn: 0,
    });
    const queue = new WorkQueue("room_test");
    queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: first });
    queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: second });

    const orchestrator = new Orchestrator({
      bus: rig.bus,
      board: rig.board,
      getSettings: () => rig.settings,
      skills: rig.skills,
      ownerId: "u_test",
      files: rig.files,
      workQueue: queue,
      mockHandler: () => ({ text: "逐条完成" }),
    });
    // 一次只恢复一条，第二条在第一条收尾后由 drain 接着排。
    expect(orchestrator.resumeQueue()).toBe(1);
    await waitFor(() => queue.list().every((item) => item.state === "done"));
    expect(queue.list()).toHaveLength(2);
    expect(queue.list().every((item) => item.attempts === 1)).toBe(true);
  });

  it("恢复闸门：超过窗口、多次中断、成员不在册都明确结算", () => {
    const rigBus = new RoomBus("room_test", "测试群");
    ensureMainMember(rigBus);
    const queue = new WorkQueue("room_test");
    const old = queue.enqueue({ memberId: "m_main", memberName: "主智能体", trigger: message() })!;
    old.createdAt = Date.now() - WORK_RECOVERY_WINDOW_MS - 1;
    const repeated = queue.enqueue({
      memberId: "m_main",
      memberName: "主智能体",
      trigger: message({ id: "msg_2", seq: 2 }),
    })!;
    repeated.recoveries = 3;
    const orphan = queue.enqueue({
      memberId: "m_missing",
      memberName: "已移除",
      trigger: message({ id: "msg_3", seq: 3 }),
    })!;

    const orchestrator = new Orchestrator({
      bus: rigBus,
      board: new Workboard("room_test"),
      getSettings: () => defaultSettings(),
      skills: { listForAgent: () => [], list: () => [] } as unknown as SkillLibrary,
      ownerId: "u_test",
      workQueue: queue,
    });
    expect(orchestrator.resumeQueue()).toBe(0);
    expect(queue.get(old.id)?.state).toBe("failed");
    expect(queue.get(old.id)?.outcome?.error).toContain("恢复窗口");
    expect(queue.get(repeated.id)?.state).toBe("failed");
    expect(queue.get(repeated.id)?.outcome?.error).toContain("停止自动续跑");
    expect(queue.get(orphan.id)?.state).toBe("canceled");
  });
});
