import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { ensureMainMember } from "../src/agent/orchestrator";
import { buildTools } from "../src/agent/tools";
import { SkillLibrary } from "../src/skills/library";
import { MemorySearchManager } from "../src/memory/manager";
import { RecallLedger } from "../src/memory/recall-ledger";
import { buildMaintenanceTools, runMaintenanceScan } from "../src/memory/maintenance";
import { buildMemoryPromptSection } from "../src/memory/prompt";
import type { Member } from "../src/core/types";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-maintenance-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MEMORY_MD = [
  "# 长期记忆",
  "",
  "- 正常事实 Alpha <!-- trigger: alpha --> <!-- importance: 6 --> <!-- id: mem_alpha -->",
  "- 正常事实 Beta <!-- trigger: beta --> <!-- importance: 5 --> <!-- id: mem_beta -->",
  "- 过期事实 Gamma <!-- trigger: gamma --> <!-- valid-until: 2020-01-01 --> <!-- id: mem_gamma -->",
  "- 已撤回事实 Delta <!-- trigger: delta --> <!-- id: mem_delta --> <!-- retracted: 2020-01-02 用户否认 -->",
  "- 新事实 Epsilon <!-- trigger: epsilon --> <!-- id: mem_epsilon --> <!-- supersedes: mem_alpha -->",
].join("\n");

const signal = new AbortController().signal;

function memoryFor(bus: RoomBus): MemorySearchManager {
  return new MemorySearchManager({ workspaceDir: dir, bus });
}

async function seedLedger(bus: RoomBus): Promise<RecallLedger> {
  const ledger = new RecallLedger(join(dir, "recall-ledger.jsonl"));
  const context = { roomId: bus.roomId, agentId: "m_main", runId: "run_1" };
  const alpha = { path: "MEMORY.md", startLine: 3, entryId: "mem_alpha", score: 0.9 };
  const beta = { path: "MEMORY.md", startLine: 4, entryId: "mem_beta", score: 0.8 };
  const gamma = { path: "MEMORY.md", startLine: 5, entryId: "mem_gamma", score: 0.7 };
  ledger.record(ledger.volunteeredEvents(context, "alpha 问题", [alpha]));
  ledger.record(ledger.volunteeredEvents(context, "alpha 又问一次", [alpha]));
  ledger.record(ledger.usedEvents(context, [alpha]));
  ledger.record(ledger.volunteeredEvents(context, "beta 问题", [beta]));
  ledger.record(ledger.volunteeredEvents(context, "gamma 问题", [gamma]));
  ledger.record(ledger.usedEvents(context, [gamma]));
  await ledger.flush();
  return ledger;
}

describe("维护巡检", () => {
  it("汇总记忆新鲜度、召回引用率与任务卡问题", async () => {
    await writeFile(join(dir, "MEMORY.md"), MEMORY_MD, "utf8");
    const bus = new RoomBus("room_main", "测试作战室");
    const main = ensureMainMember(bus);
    const board = new Workboard("room_main");

    const healthy = board.create({
      title: "健康任务",
      createdBy: main.id,
      ownerId: main.id,
      acceptance: "产出 a.md",
    });
    board.update(healthy.id, {
      status: "done",
      completion: { verifiedBy: { kind: "file", handle: "a.md" }, at: Date.now() },
    });
    const stalled = board.create({ title: "停滞任务", createdBy: main.id, ownerId: main.id });
    board.update(stalled.id, { status: "doing" });
    board.create({ title: "缺依赖", createdBy: main.id, deps: ["task_missing"] });
    board.create({ title: "孤儿任务", createdBy: main.id, ownerId: "m_ghost" });
    const unverified = board.create({
      title: "未核验完成",
      createdBy: main.id,
      acceptance: "产出 b.md",
    });
    board.update(unverified.id, { status: "done" });

    const ledger = await seedLedger(bus);
    const now = Date.now() + 25 * 60 * 60 * 1000;
    const report = await runMaintenanceScan({ memory: memoryFor(bus), board, bus, ledger, now });

    expect(report.memory).toMatchObject({ entries: 5, retracted: 1, stale: 1, superseded: 1 });
    expect(report.memory.findings.map((finding) => finding.issue).sort()).toEqual([
      "retracted",
      "stale",
      "superseded",
    ]);
    expect(report.recall).toMatchObject({ events: 6, volunteered: 4, used: 2 });
    expect(report.recall.unused).toHaveLength(1);
    expect(report.recall.unused[0]).toMatchObject({
      path: "MEMORY.md",
      startLine: 4,
      entryId: "mem_beta",
      volunteered: 1,
      used: 0,
    });
    expect(report.tasks.total).toBe(5);
    expect(report.tasks.counts).toEqual({
      stalled: 1,
      missing_dependency: 1,
      orphaned_owner: 1,
      unverified_completion: 1,
    });
    expect(report.tasks.findings).toHaveLength(4);
    expect(report.summary).toContain("从未被引用 1 条");
  }, 30_000);

  it("compact 显式开启才压缩账本，未使用统计仍按压缩前计算", async () => {
    await writeFile(join(dir, "MEMORY.md"), MEMORY_MD, "utf8");
    const bus = new RoomBus("room_main", "测试作战室");
    ensureMainMember(bus);
    const board = new Workboard("room_main");
    const ledger = await seedLedger(bus);

    const report = await runMaintenanceScan({
      memory: memoryFor(bus),
      board,
      bus,
      ledger,
      compactLedgerTo: 2,
    });

    expect(report.recall.compacted).toEqual({ kept: 2, dropped: 4 });
    expect(report.recall.unused).toHaveLength(1);
    expect(await ledger.list()).toHaveLength(2);
  }, 30_000);

  it("maintenance_scan 参数错误走 invalid_argument，正常调用返回巡检报告", async () => {
    await writeFile(join(dir, "MEMORY.md"), MEMORY_MD, "utf8");
    const bus = new RoomBus("room_main", "测试作战室");
    ensureMainMember(bus);
    const board = new Workboard("room_main");
    const ledger = await seedLedger(bus);
    const memory = memoryFor(bus);
    const [tool] = buildMaintenanceTools({ memory, board, bus, ledger });

    const invalid = await tool!.execute({ keep: 0 }, signal);
    expect(invalid).toContain("错误码：invalid_argument");

    const result = JSON.parse(await tool!.execute({ stall_hours: 1 }, signal));
    expect(result.status).toBe("ok");
    expect(result.recall.events).toBe(6);
    expect(result.memory.entries).toBe(5);
  }, 30_000);

  it("只对主智能体注册维护巡检，子成员看不到", async () => {
    await writeFile(join(dir, "MEMORY.md"), MEMORY_MD, "utf8");
    const bus = new RoomBus("room_main", "测试作战室");
    const main = ensureMainMember(bus);
    const sub: Member = {
      ...main,
      id: "m_sub",
      name: "子成员",
      role: "sub",
      depth: 1,
      spawnedBy: main.id,
    };
    bus.addMember(sub);
    const board = new Workboard("room_main");
    const memory = memoryFor(bus);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();

    const mainTools = buildTools(main, { bus, board, skills, userId: "u_test", memory });
    const subTools = buildTools(sub, { bus, board, skills, userId: "u_test", memory });
    expect(mainTools.some((tool) => tool.schema.name === "maintenance_scan")).toBe(true);
    expect(subTools.some((tool) => tool.schema.name === "maintenance_scan")).toBe(false);
  }, 30_000);

  it("系统提示只在挂载 maintenance_scan 时注入维护巡检指引", () => {
    const without = buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(without.join("\n")).not.toContain("## 维护巡检");

    const withMaintenance = buildMemoryPromptSection({
      availableTools: new Set(["memory_search", "maintenance_scan"]),
    });
    const text = withMaintenance.join("\n");
    expect(text).toContain("## 维护巡检");
    expect(text).toContain("maintenance_scan");
    expect(text).toContain("compact=true");
  });
});
