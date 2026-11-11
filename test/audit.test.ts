// 持续审计：提示词解析、进度账本与服务的有界催办。
import { describe, expect, it, vi } from "vitest";
import { AuditService } from "../src/agent/audit/service";
import { AuditStore } from "../src/agent/audit/store";
import { parseAuditResponse } from "../src/agent/audit/prompt";
import type { AuditRecord } from "../src/agent/audit/types";
import type { Member } from "../src/core/types";
import { defaultSettings } from "../src/core/settings";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";

function member(): Member {
  return {
    id: "m_sub",
    roomId: "room_audit",
    name: "研究员",
    role: "sub",
    status: "idle",
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function record(id: string, at: number): AuditRecord {
  return {
    id,
    roomId: "room_audit",
    taskId: "task_1",
    taskTitle: "写报告",
    memberId: "m_sub",
    memberName: "研究员",
    at,
    verdict: "fail",
    summary: { passed: 0, failed: 1, unsure: 0, total: 1 },
    criteria: [{ id: 1, criterion: "报告存在", verdict: "fail", evidence: "未找到" }],
    stateHash: `h${id}`,
    sources: { messages: 1, tools: 1, files: [] },
    action: "none",
    interventionCount: 0,
    maxInterventions: 2,
    taskSolved: false,
    modelRef: "test/mock",
  };
}

describe("审计账本", () => {
  it("保存记录与每任务进度，按上限裁剪，清空时一并清进度", () => {
    const store = new AuditStore("room_audit", 2);
    store.add(record("a", 1));
    store.add(record("b", 2));
    store.add(record("c", 3));
    expect(store.list().map((item) => item.id)).toEqual(["b", "c"]);
    store.setState("task_1", {
      taskId: "task_1",
      bestPassed: 1,
      nudges: 1,
      totalNudges: 1,
      noProgress: 0,
      lastHash: "h2",
    });
    expect(store.hasState("task_1", "h2")).toBe(true);

    const restored = new AuditStore("room_audit");
    restored.hydrate(store.snapshot());
    expect(restored.list().map((item) => item.id)).toEqual(["b", "c"]);
    expect(restored.stateOf("task_1")?.bestPassed).toBe(1);
    expect(restored.clear()).toBe(2);
    expect(restored.stateOf("task_1")).toBeUndefined();
  });
});

describe("审计输出解析", () => {
  it("接受代码块包裹、中文判定与 fix_hint", () => {
    const criteria = parseAuditResponse(
      '```json\n{"criteria":[{"criterion":"报告存在","verdict":"通过","evidence":"files/a.md"},{"criterion":"含结论","verdict":"失败","evidence":"只有目录","fix_hint":"补结论段"}]}\n```',
      "报告存在；含结论",
    );
    expect(criteria?.map((item) => item.verdict)).toEqual(["pass", "fail"]);
    expect(criteria?.[1]?.fixHint).toBe("补结论段");
  });

  it("接受单对象总判定，拒绝无法解析或无判定的输出", () => {
    const single = parseAuditResponse(
      '{"verdict":"unsure","evidence":"证据不足","criterion":"报告存在"}',
      "报告存在",
    );
    expect(single?.[0]?.verdict).toBe("unsure");
    expect(parseAuditResponse("我审完了，都没问题", "报告存在")).toBeNull();
    expect(parseAuditResponse('{"criteria":[{"criterion":"x","verdict":"maybe"}]}', "x")).toBeNull();
  });
});

function makeRig(respond: () => string) {
  const bus = new RoomBus("room_audit", "审计测试");
  const board = new Workboard("room_audit");
  const target = member();
  bus.addMember(target);
  const task = board.create({
    title: "写报告",
    detail: "输出一份带结论的报告",
    acceptance: "报告文件存在；报告里有结论段",
    createdBy: "u_test",
    ownerId: target.id,
  });
  const records: AuditRecord[] = [];
  const nudges: string[] = [];
  const escalations: AuditRecord[] = [];
  let clock = 1_000;
  const store = new AuditStore("room_audit");
  const complete = vi.fn(async () => ({ text: respond(), modelRef: "test/mock" }));
  const service = new AuditService({
    roomId: "room_audit",
    store,
    board,
    bus,
    getSettings: () => defaultSettings(),
    getModelDeps: () => ({ settings: defaultSettings() }),
    activityByMember: () => [],
    requestNudge: (_memberId, text) => {
      nudges.push(text);
      return true;
    },
    requestEscalation: (audit) => escalations.push(audit),
    onRecord: (audit) => records.push(audit),
    now: () => (clock += 1),
    complete,
  });
  return { bus, board, target, task, records, nudges, escalations, store, service, complete };
}

const FAIL_JSON =
  '{"criteria":[{"criterion":"报告文件存在","verdict":"fail","evidence":"未找到 files/report.md","fix_hint":"先写出报告文件"},{"criterion":"报告里有结论段","verdict":"unsure","evidence":"没有正文可查"}]}';
const PASS_JSON =
  '{"criteria":[{"criterion":"报告文件存在","verdict":"pass","evidence":"files/report.md 已落盘"},{"criterion":"报告里有结论段","verdict":"pass","evidence":"结论段在第 3 节"}]}';

describe("持续审计服务", () => {
  it("失败先催办，同一证据不重复审计", async () => {
    const rig = makeRig(() => FAIL_JSON);
    await rig.service.afterRun({ memberId: rig.target.id, runId: "run_1", taskId: rig.task.id });
    expect(rig.records).toHaveLength(1);
    const audit = rig.records[0]!;
    expect(audit.summary).toEqual({ passed: 0, failed: 1, unsure: 1, total: 2 });
    expect(audit.action).toBe("nudge");
    expect(audit.interventionCount).toBe(1);
    expect(rig.nudges[0]).toContain("报告里");
    expect(rig.nudges[0]).toContain("先写出报告文件");
    expect(rig.complete).toHaveBeenCalledTimes(1);

    await rig.service.afterRun({ memberId: rig.target.id, taskId: rig.task.id });
    expect(rig.complete).toHaveBeenCalledTimes(1);
    expect(rig.records).toHaveLength(1);
  });

  it("连续无进展达到上限时升级人工，不再催办", async () => {
    const rig = makeRig(() => FAIL_JSON);
    for (let round = 0; round < 3; round += 1) {
      rig.bus.append({
        senderId: rig.target.id,
        senderName: rig.target.name,
        senderKind: "member",
        kind: "announce",
        text: `第 ${round} 轮说明`,
      });
      await rig.service.afterRun({ memberId: rig.target.id, taskId: rig.task.id });
    }
    expect(rig.records.map((item) => item.action)).toEqual(["nudge", "nudge", "escalate"]);
    expect(rig.nudges).toHaveLength(2);
    expect(rig.escalations).toHaveLength(1);
    expect(rig.escalations[0]?.taskId).toBe(rig.task.id);
    expect(rig.store.stateOf(rig.task.id)?.noProgress).toBe(2);
  });

  it("验收全部通过时不催办并清零进度", async () => {
    const rig = makeRig(() => PASS_JSON);
    await rig.service.afterRun({ memberId: rig.target.id, taskId: rig.task.id });
    const audit = rig.records[0]!;
    expect(audit.verdict).toBe("pass");
    expect(audit.taskSolved).toBe(true);
    expect(audit.action).toBe("none");
    expect(rig.nudges).toHaveLength(0);
    expect(rig.store.stateOf(rig.task.id)).toMatchObject({ nudges: 0, noProgress: 0 });
  });

  it("没有验收条款、任务已完成或模型输出不可解析时都不落记录", async () => {
    const rig = makeRig(() => "not json");
    const plain = rig.board.create({ title: "随便聊聊", createdBy: "u_test", ownerId: rig.target.id });
    await rig.service.afterRun({ memberId: rig.target.id, taskId: plain.id });
    expect(rig.complete).not.toHaveBeenCalled();

    await rig.service.afterRun({ memberId: rig.target.id, taskId: rig.task.id });
    expect(rig.records).toHaveLength(0);

    rig.board.update(rig.task.id, { status: "done" });
    await rig.service.afterRun({ memberId: rig.target.id, taskId: rig.task.id });
    expect(rig.complete).toHaveBeenCalledTimes(1);
  });
});
