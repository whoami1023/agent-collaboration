// 交付闸门：done 只能引用本轮真实发生过的事实。
// 分三层验：台账本身、闸门判定、以及 task_* 工具是否把闸门接在了唯一路径上。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  commandHandle,
  recordFileChanges,
  stampFiles,
  verifyAcceptance,
} from "../src/agent/evidence";
import { buildTools } from "../src/agent/tools";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { Workboard } from "../src/workboard/board";
import { RoomBus } from "../src/room/bus";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceFiles } from "../src/files/workspace-files";
import { defaultSettings, type Settings } from "../src/core/settings";
import { DEFAULT_LIMITS, type Member, type TaskCard, type TaskEvidenceKind } from "../src/core/types";
import type { ToolImpl } from "../src/agent/loop/loop";

const tempDirs: string[] = [];
const signal = new AbortController().signal;

/** 把 signal 绑到工具上，调用点只写参数：测试关心的是闸门，不是每行都传一遍中止信号。 */
function bindTools(tools: ToolImpl[]) {
  return new Map(
    tools.map((tool) => [
      tool.schema.name,
      {
        schema: tool.schema,
        execute: (input: Record<string, unknown>) => tool.execute(input, signal),
      },
    ]),
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
    contextMode: "fork",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
  };
}

function task(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "task_1",
    roomId: "room_test",
    title: "写出年度报告",
    detail: "",
    ownerId: null,
    status: "doing",
    deps: [],
    artifacts: [],
    messageIds: [],
    createdBy: "m_main",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function makeRig() {
  const dir = await mkdtemp(join(tmpdir(), "ac-gate-"));
  tempDirs.push(dir);
  const bus = new RoomBus("room_test", "测试群");
  const board = new Workboard("room_test");
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  const files = new WorkspaceFiles(dir);
  const ledger = new EvidenceLedger();
  return { bus, board, skills, files, ledger, dir };
}

function toolsOf(rig: Awaited<ReturnType<typeof makeRig>>) {
  const tools = buildTools(member(), {
    bus: rig.bus,
    board: rig.board,
    skills: rig.skills,
    userId: "u_test",
    files: rig.files,
    evidence: rig.ledger,
  });
  return bindTools(tools);
}

describe("证据台账", () => {
  it("文件句柄统一去掉 files/ 前缀，模型怎么写都能核上", () => {
    const ledger = new EvidenceLedger();
    ledger.record("file", "files/reports/a.md", "写入 1.2 KB");
    expect(ledger.find("file", "reports/a.md")?.detail).toBe("写入 1.2 KB");
    expect(ledger.find("file", "files/reports/a.md")).toBeDefined();
  });

  it("命令指纹只压空白并截断，同一条长命令换行写法不同也算一次", () => {
    const long = "python build.py   --out\\\n  reports/a.docx " + "x".repeat(300);
    const handle = commandHandle(long);
    expect(handle).toBe(commandHandle(handle.replace(/\s+/g, "   ")));
    expect(handle.length).toBeLessThanOrEqual(200);
    expect(handle).toContain("python build.py --out");
  });

  it("台账有条数上限，留下的总是最近的事实", () => {
    const ledger = new EvidenceLedger(5);
    for (let index = 0; index < 9; index += 1) {
      ledger.record("file", `f${index}.md`, `第 ${index} 次`);
    }
    const handles = ledger.list().map((record) => record.handle);
    expect(handles).toEqual(["f4.md", "f5.md", "f6.md", "f7.md", "f8.md"]);
  });

  it("续跑时装回未完成卡上的证据，已完成与失败的卡不参与", () => {
    const ledger = new EvidenceLedger();
    // task_d 的 kind 是旧版本/手改档案里可能出现的野值：装回时必须整条丢掉，不能当成有效证据。
    ledger.seed([
      task({ id: "task_a", status: "doing", evidence: [{ kind: "file", handle: "draft.md", detail: "", at: 1 }] }),
      task({ id: "task_b", status: "done", evidence: [{ kind: "file", handle: "closed.md", detail: "", at: 1 }] }),
      task({ id: "task_c", status: "failed", evidence: [{ kind: "file", handle: "dead.md", detail: "", at: 1 }] }),
      task({ id: "task_d", status: "todo", evidence: [{ kind: "nope" as TaskEvidenceKind, handle: "bad.md", detail: "", at: 1 }] }),
    ]);
    expect(ledger.find("file", "draft.md")).toBeDefined();
    expect(ledger.find("file", "closed.md")).toBeUndefined();
    expect(ledger.list()).toHaveLength(1);
  });

  it("回写卡片时按 kind+handle 去重，卡片上的证据也有上限", () => {
    const ledger = new EvidenceLedger();
    ledger.record("file", "new.md", "本轮写出");
    ledger.record("file", "old.md", "本轮也写出");
    const stored = ledger.mergeInto([
      { kind: "file", handle: "old.md", detail: "上一段进展", at: 1 },
      { kind: "command", handle: "pytest", detail: "跑过", at: 1 },
    ]);
    expect(stored.map((record) => record.handle)).toEqual(["old.md", "pytest", "new.md"]);
    const crowded = ledger.mergeInto(
      Array.from({ length: 60 }, (_, index) => ({
        kind: "file" as const,
        handle: `keep-${index}.md`,
        detail: "",
        at: 1,
      })),
    );
    expect(crowded).toHaveLength(40);
    // 截断只砍卡片上的历史，本轮台账的事实始终留在尾部。
    expect(crowded.slice(-2).map((record) => record.handle)).toEqual(["new.md", "old.md"]);
  });

  it("命令改动过的文件也算证据：脚本产物同样能过闸门", () => {
    const before = new Map([["old.md", "10:20"]]);
    const ledger = new EvidenceLedger();
    const changed = recordFileChanges(ledger, before, {
      files: [
        { path: "old.md", kind: "file", updatedAt: 10, sizeBytes: 20 },
        { path: "out/report.docx", kind: "file", updatedAt: 7, sizeBytes: 4096 },
        { path: ".skill-runtime/tmp.py", kind: "file", updatedAt: 7, sizeBytes: 10 },
      ],
      truncated: false,
      root: "/tmp",
    } as never, "由 run_command 产出");
    expect(changed).toEqual(["out/report.docx"]);
    expect(ledger.find("file", "out/report.docx")?.detail).toBe("由 run_command 产出");
  });

  it("文件指纹只认正文，目录不进指纹表", () => {
    const stamps = stampFiles({
      files: [
        { path: "a.md", kind: "file", updatedAt: 10, sizeBytes: 20 },
        { path: "dir", kind: "directory", updatedAt: 10, sizeBytes: 0 },
      ],
      truncated: false,
      root: "/tmp",
    } as never);
    expect([...stamps.entries()]).toEqual([["a.md", "10:20"]]);
  });
});

describe("验收闸门判定", () => {
  it("没有验收条款的任务不受闸门约束", async () => {
    const verdict = await verifyAcceptance({
      task: task(),
      ledger: new EvidenceLedger(),
      fileExists: async () => false,
    });
    expect(verdict.ok).toBe(true);
  });

  it("写了验收条款却不给证据：拒绝，并把本轮台账摊开给它看", async () => {
    const ledger = new EvidenceLedger();
    ledger.record("file", "draft.md", "写入 20 行");
    const verdict = await verifyAcceptance({
      task: task({ acceptance: "files/report.md 存在" }),
      ledger,
      fileExists: async () => true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("不该放行");
    expect(verdict.reason).toContain("verify_kind");
    expect(verdict.reason).toContain("draft.md");
    expect(verdict.reason).toContain("不要用自述冒充核验");
  });

  it("证据类型不认识时拒绝", async () => {
    const verdict = await verifyAcceptance({
      task: task({ acceptance: "报告存在" }),
      ledger: new EvidenceLedger(),
      verifyKind: "vibes",
      verifyHandle: "感觉不错",
      fileExists: async () => true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("不该放行");
    expect(verdict.reason).toContain("file / command / artifact");
  });

  it("台账里查不到的证据一律拒绝：这就是自述与事实的分界", async () => {
    const verdict = await verifyAcceptance({
      task: task({ acceptance: "报告存在" }),
      ledger: new EvidenceLedger(),
      verifyKind: "file",
      verifyHandle: "report.md",
      fileExists: async () => true,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("不该放行");
    expect(verdict.reason).toContain("本轮台账里查不到");
  });

  it("登记过但文件已经不在：调用成功不等于任务成功", async () => {
    const ledger = new EvidenceLedger();
    ledger.record("file", "report.md", "写入 3 KB");
    const verdict = await verifyAcceptance({
      task: task({ acceptance: "report.md 存在" }),
      ledger,
      verifyKind: "file",
      verifyHandle: "report.md",
      fileExists: async () => false,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("不该放行");
    expect(verdict.reason).toContain("回读时文件已经不在了");
  });

  it("命令类证据不需要回读文件，跑成功过即可放行", async () => {
    const ledger = new EvidenceLedger();
    ledger.record("command", "pytest -q", "退出码 0");
    const verdict = await verifyAcceptance({
      task: task({ acceptance: "跑过 pytest 且退出码 0" }),
      ledger,
      verifyKind: "command",
      verifyHandle: "pytest  -q",
      fileExists: async () => false,
    });
    expect(verdict).toEqual({
      ok: true,
      verifiedBy: { kind: "command", handle: "pytest -q" },
      detail: "退出码 0",
    });
  });

  it("成果类证据要能对上卡片上还在的成果", async () => {
    const ledger = new EvidenceLedger();
    ledger.record("artifact", "年度报告.docx", "已登记");
    const gone = await verifyAcceptance({
      task: task({ acceptance: "交付年度报告" }),
      ledger,
      verifyKind: "artifact",
      verifyHandle: "年度报告.docx",
      fileExists: async () => true,
      artifactExists: async () => false,
    });
    expect(gone.ok).toBe(false);
    const ok = await verifyAcceptance({
      task: task({ acceptance: "交付年度报告" }),
      ledger,
      verifyKind: "artifact",
      verifyHandle: "年度报告.docx",
      fileExists: async () => true,
      artifactExists: async () => true,
    });
    expect(ok.ok).toBe(true);
  });
});

describe("task 工具上的闸门", () => {
  it("task_create 把验收条款登记进卡片，超长直接退回", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    const create = tools.get("task_create");
    expect(create).toBeDefined();
    const receipt = await create!.execute({ title: "年度报告", acceptance: "files/report.md 存在且含第 3 章" });
    expect(receipt).toContain("验收条款已登记");
    const card = rig.board.list()[0];
    expect(card?.acceptance).toBe("files/report.md 存在且含第 3 章");
    const tooLong = await create!.execute({ title: "另一件事", acceptance: "长".repeat(301) });
    expect(tooLong).toContain("最多 300 字");
    expect(rig.board.list()).toHaveLength(1);
  });

  it("带验收条款的任务想直接标 done 会被退回，卡片保持进行中", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "年度报告", acceptance: "files/report.md 存在" });
    const id = rig.board.list()[0]!.id;
    const receipt = await tools.get("task_update")!.execute({ task_id: id, status: "done" });
    expect(receipt).toContain("verify_kind");
    expect(rig.board.get(id)?.status).toBe("todo");
    expect(rig.board.get(id)?.completion).toBeUndefined();
  });

  it("证据成立才放行，并把凭据与本轮台账一起留在卡上", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "年度报告", acceptance: "files/report.md 存在" });
    const id = rig.board.list()[0]!.id;
    await rig.files.write("report.md", Buffer.from("# 年度报告"));
    rig.ledger.record("file", "files/report.md", "写入 12 字节");
    const receipt = await tools.get("task_update")!.execute({
      task_id: id,
      status: "done",
      verify_kind: "file",
      verify_handle: "report.md",
    });
    expect(receipt).toContain("已核验通过并标记完成");
    const card = rig.board.get(id);
    expect(card?.status).toBe("done");
    expect(card?.completion?.verifiedBy).toEqual({ kind: "file", handle: "report.md" });
    expect(card?.evidence?.map((record) => record.handle)).toContain("report.md");
  });

  it("file_write 成功即入账：模型不需要额外登记证据也能过闸门", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "年度报告", acceptance: "files/report.md 存在" });
    const id = rig.board.list()[0]!.id;
    await tools.get("file_write")!.execute({ path: "report.md", content: "# 报告\n正文" });
    const receipt = await tools.get("task_update")!.execute({
      task_id: id,
      status: "done",
      verify_kind: "file",
      verify_handle: "files/report.md",
    });
    expect(receipt).toContain("已核验通过并标记完成");
  });

  it("登记成果指向不存在的文件时拒绝：不能靠登记伪造证据", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "年度报告" });
    const id = rig.board.list()[0]!.id;
    const receipt = await tools.get("task_attach_artifact")!.execute({
      task_id: id,
      name: "年度报告.md",
      path: "files/never-written.md",
    });
    expect(receipt).toContain("登记失败");
    expect(rig.board.get(id)?.artifacts).toHaveLength(0);
    expect(rig.ledger.list("file")).toHaveLength(0);
  });

  it("成果写成了文件：两条证据都入账，artifact 与 file 都能过闸门", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "年度报告", acceptance: "交付年度报告.md" });
    const id = rig.board.list()[0]!.id;
    await tools.get("file_write")!.execute({ path: "年度报告.md", content: "正文" });
    const receipt = await tools.get("task_attach_artifact")!.execute({
      task_id: id,
      name: "年度报告.md",
      path: "年度报告.md",
    });
    expect(receipt).toContain("已登记成果");
    expect(rig.ledger.find("artifact", "年度报告.md")).toBeDefined();
    const byArtifact = await tools.get("task_update")!.execute({
      task_id: id,
      status: "done",
      verify_kind: "artifact",
      verify_handle: "年度报告.md",
    });
    expect(byArtifact).toContain("已核验通过并标记完成");
  });

  it("task_list 让智能体看得见哪张卡需要证据、哪张已经核过", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "要验收的", acceptance: "files/a.md 存在" });
    await tools.get("task_create")!.execute({ title: "过程性的" });
    const withGate = rig.board.list()[0]!;
    await rig.files.write("a.md", Buffer.from("内容"));
    rig.ledger.record("file", "files/a.md", "写入 6 字节");
    await tools.get("task_update")!.execute({
      task_id: withGate.id,
      status: "done",
      verify_kind: "file",
      verify_handle: "a.md",
    });
    const listing = await tools.get("task_list")!.execute({});
    expect(listing).toContain(withGate.id);
    expect(listing).toContain("已核验：file a.md");
    expect(listing).not.toContain("有验收条款（done 需证据）");

    await tools.get("task_create")!.execute({ title: "还没交付的", acceptance: "files/b.md 存在" });
    expect(await tools.get("task_list")!.execute({})).toContain("有验收条款（done 需证据）");
  });

  it("普通进展更新也会把本轮台账留在卡上，供「继续」唤醒后核验", async () => {
    const rig = await makeRig();
    const tools = toolsOf(rig);
    await tools.get("task_create")!.execute({ title: "年度报告", acceptance: "files/report.md 存在" });
    const id = rig.board.list()[0]!.id;
    await tools.get("file_write")!.execute({ path: "report.md", content: "第一节" });
    await tools.get("task_update")!.execute({ task_id: id, status: "doing", detail: "写完第一节" });
    const card = rig.board.get(id);
    expect(card?.status).toBe("doing");
    expect(card?.evidence?.map((record) => record.handle)).toContain("report.md");

    // 换一次运行：新台账从卡片装回证据，续跑的 done 依然要核得上。
    const resumed = new EvidenceLedger();
    resumed.seed([card!]);
    expect(resumed.find("file", "report.md")).toBeDefined();
  });

  it("没有台账时闸门不接管：任务卡照常可以人工推进", async () => {
    const rig = await makeRig();
    const tools = bindTools(
      buildTools(member(), {
        bus: rig.bus,
        board: rig.board,
        skills: rig.skills,
        userId: "u_test",
        files: rig.files,
      }),
    );
    const create = tools.get("task_create")!;
    await create.execute({ title: "年度报告", acceptance: "files/report.md 存在" });
    const id = rig.board.list()[0]!.id;
    const update = tools.get("task_update")!;
    expect(await update.execute({ task_id: id, status: "done" })).toContain("已更新");
  });
});

describe("闸门在真实运行里", () => {
  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error("等待超时");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("空口 done 先被退回，模型产出文件后带证据再标才通过", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-gate-orch-"));
    tempDirs.push(dir);
    const bus = new RoomBus("room_test", "测试群");
    const board = new Workboard("room_test");
    ensureMainMember(bus);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const settings: Settings = {
      ...defaultSettings(),
      providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }],
      limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 8, runTimeoutMs: 5000 },
    };
    const toolResults: string[] = [];
    let phase = 0;
    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => settings,
      skills,
      ownerId: "u_test",
      files: new WorkspaceFiles(dir),
      mockHandler: () => {
        // 每次返回一步：先建带验收条款的卡 → 空口标 done → 被退回去写文件 → 带证据再标。
        phase += 1;
        if (phase === 1) {
          return {
            toolCalls: [
              {
                name: "task_create",
                args: { title: "年度报告", acceptance: "files/report.md 存在且含结论" },
              },
            ],
          };
        }
        const taskId = board.list()[0]!.id;
        if (phase === 2) {
          return { toolCalls: [{ name: "task_update", args: { task_id: taskId, status: "done" } }] };
        }
        if (phase === 3) {
          return {
            toolCalls: [{ name: "file_write", args: { path: "report.md", content: "# 年度报告\n结论：闸门只认证据。" } }],
          };
        }
        if (phase === 4) {
          return {
            toolCalls: [
              {
                name: "task_update",
                args: { task_id: taskId, status: "done", verify_kind: "file", verify_handle: "report.md" },
              },
            ],
          };
        }
        return { text: "报告已写入 files/report.md，任务卡已按证据核验完成。" };
      },
    });
    bus.subscribe((event) => {
      if (event.type === "run" && event.event.type === "tool-result") {
        toolResults.push(event.event.content);
      }
    });

    orchestrator.sendUserMessage("写一份年度报告，验收标准是 report.md 里有结论");
    await waitFor(() => board.list()[0]?.status === "done");
    await waitFor(() => orchestrator.activeRuns === 0);

    const refusal = toolResults.find((item) => item.includes("请传 verify_kind"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("验收条款");
    // 退回时台账是空的，回执必须把「本轮什么都没有」这件事如实告诉模型。
    expect(refusal).toContain("本轮台账是空的");
    expect(await readFile(join(dir, "files", "report.md"), "utf8")).toContain("闸门只认证据");

    const card = board.get(board.list()[0]!.id)!;
    expect(card.completion?.verifiedBy).toEqual({ kind: "file", handle: "report.md" });
    expect(card.evidence?.map((record) => record.handle)).toContain("report.md");
  });
});
