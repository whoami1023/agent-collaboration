import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePythonLaunch, resetPythonLaunchCache } from "../src/agent/python-launcher";
import { buildShellTools } from "../src/agent/shell-tools";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { DEFAULT_LIMITS, type Member, type PublicUser } from "../src/core/types";
import { SETTINGS_VERSION, type Settings } from "../src/core/settings";
import { BUILTIN_SHARED_SKILLS, BUILTIN_SKILLS_VERSION } from "../src/skills/builtin";
import { builtinCategoryOf } from "../src/skills/categories";
import { SkillLibrary } from "../src/skills/library";
import { normalizeSkillFiles } from "../src/skills/skill-files";
import { WorkspaceFiles } from "../src/files/workspace-files";

const DOCX_NAMES = ["docx-writer", "docx-reader", "docx-track-changes", "docx-formula"];

// skipIf 在收集用例时就求值，所以解释器探测必须放在模块顶层（没有 Python 的环境整组跳过）
resetPythonLaunchCache();
const pythonLaunch = await resolvePythonLaunch();

function seedOf(name: string) {
  const seed = BUILTIN_SHARED_SKILLS.find((skill) => skill.name === name);
  expect(seed, `内置技能 ${name} 应随系统预装`).toBeDefined();
  return seed!;
}

describe("docx 内置技能", () => {
  it("四个 Word 技能都在内置清单里、各自带脚本并落到正确分类", () => {
    for (const name of DOCX_NAMES) {
      const seed = seedOf(name);
      expect(seed.files?.length ?? 0).toBeGreaterThan(0);
      expect(seed.description.length).toBeGreaterThan(10);
      expect(seed.instructions).toContain("# ");
    }
    expect(builtinCategoryOf("docx-writer")).toBe("product");
    expect(builtinCategoryOf("docx-reader")).toBe("research");
    expect(builtinCategoryOf("docx-track-changes")).toBe("product");
    expect(builtinCategoryOf("docx-formula")).toBe("product");
    expect(BUILTIN_SKILLS_VERSION).toBe(8);
  });

  it("脚本路径全在技能目录内，且整套内置技能都过技能附带文件校验", () => {
    for (const seed of BUILTIN_SHARED_SKILLS) {
      if (!seed.files?.length) continue;
      const normalized = normalizeSkillFiles(
        seed.files.map((file) => ({ path: file.path, content: file.content })),
      );
      expect(normalized.length).toBe(seed.files.length);
      for (const file of seed.files) {
        expect(file.path.startsWith("scripts/")).toBe(true);
        expect(file.path.endsWith(".py")).toBe(true);
      }
    }
  });

  it("每个脚本都是完整的 Python：以 docstring 开头、有 main 或类定义、没有模板串转义残留", () => {
    for (const name of DOCX_NAMES) {
      for (const file of seedOf(name).files ?? []) {
        expect(file.content.startsWith('"""'), `${name}/${file.path} 应以 docstring 开头`).toBe(true);
        expect(file.content).toContain("from __future__ import annotations");
        // 模板字符串转义漏了就会留下这两个字面量
        expect(file.content).not.toContain("\\\\`");
        expect(file.content).not.toContain("\\${");
      }
    }
    // 反斜杠密集的地方最容易暴露模板串转义问题
    expect(seedOf("docx-formula").files![0].content).toContain("\\frac{a}{b}");
    expect(seedOf("docx-formula").files![0].content).toContain('name == "sqrt"');
  });

  it("上游 MIT 出处写在脚本里，公开仓库能追溯", () => {
    const derived = ["docx-track-changes", "docx-formula"];
    for (const name of derived) {
      const seed = seedOf(name);
      expect(seed.source).toContain("MIT");
      expect(seed.source).toContain("wintersdragon-c/office-docx-skills");
      for (const file of seed.files ?? []) {
        expect(file.content).toContain("wintersdragon-c/office-docx-skills");
        expect(file.content).toContain("MIT");
      }
    }
  });
});

describe("docx 脚本真能在本机跑（用内置技能里存的源码）", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ac-docx-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function materialize(name: string): Promise<string> {
    const target = join(dir, name);
    await mkdir(target, { recursive: true });
    for (const file of seedOf(name).files ?? []) {
      await writeFile(join(target, file.path.split("/").pop() ?? file.path), file.content, "utf8");
    }
    return target;
  }

  function run(scriptDir: string, script: string, args: string[]) {
    return spawnSync(pythonLaunch!.command, [...pythonLaunch!.args, join(scriptDir, script), ...args], {
      cwd: scriptDir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", NO_COLOR: "1" },
    });
  }

  it.skipIf(!pythonLaunch)("markdown → docx → 自检 → 读取 → 公式，全链路都是预装脚本", async () => {
    const writer = await materialize("docx-writer");
    const reader = await materialize("docx-reader");
    const formula = await materialize("docx-formula");
    const markdown = [
      "# 一、概述",
      "",
      "这是**加粗**与 *斜体* 与 `code` 混排的中文段落 ABC 123。",
      "",
      "| 项目 | 数值 |",
      "| --- | --- |",
      "| 成本 | 7 |",
      "",
      "## （二）细节",
      "",
      "- 第一",
      "- 第二",
    ].join("\n");
    await writeFile(join(writer, "草稿.md"), markdown, "utf8");

    const built = run(writer, "docx_from_md.py", ["草稿.md", "成稿.docx", "--profile", "cn-paper", "--title", "示例"]);
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout).toContain("已生成");

    const inspected = run(writer, "docx_inspect.py", ["成稿.docx", "--json"]);
    expect(inspected.status, inspected.stderr).toBe(0);
    const report = JSON.parse(inspected.stdout);
    expect(report.table_count).toBe(1);
    expect(report.paragraph_count).toBeGreaterThan(5);
    expect(report.pages[0]).toContain("21.0×29.7 cm");
    expect(report.fonts.join("\n")).toContain("宋体");
    expect(report.fonts.join("\n")).toContain("Times New Roman");

    const extracted = run(reader, "docx_extract.py", ["../docx-writer/成稿.docx", "--numbers"]);
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout).toContain("# 一、概述");
    expect(extracted.stdout).toContain("| 项目 | 数值 |");
    expect(extracted.stdout).toContain("¶");

    const withFormula = run(formula, "formula_writer.py", [
      join(writer, "成稿.docx"),
      "--latex",
      "E = \\frac{mc^2}{2} + \\sqrt{x+y}",
      "--number",
      "(1)",
    ]);
    expect(withFormula.status, withFormula.stderr).toBe(0);
    const afterMath = JSON.parse(run(writer, "docx_inspect.py", ["成稿.docx", "--json"]).stdout);
    expect(afterMath.math_count).toBe(1);
  });

  it.skipIf(!pythonLaunch)("修订脚本产出的 .docx 能被自检与核对脚本认出", async () => {
    const writer = await materialize("docx-writer");
    const tracker = await materialize("docx-track-changes");
    await writeFile(join(writer, "稿件.md"), "# 一、概述\n\n这里是概述正文，用于修订测试。\n", "utf8");
    const built = run(writer, "docx_from_md.py", ["稿件.md", "稿件.docx"]);
    expect(built.status, built.stderr).toBe(0);

    await writeFile(
      join(tracker, "edits.json"),
      JSON.stringify([{ find: "概述", replace: "一、概述（已修订）" }]),
      "utf8",
    );
    const edited = run(tracker, "tracked_changes.py", [
      join(writer, "稿件.docx"),
      "修订.docx",
      "--author",
      "审阅人",
      "--edits",
      "edits.json",
    ]);
    expect(edited.status, edited.stderr).toBe(0);
    expect(edited.stdout).toContain("合计修订");

    const verified = run(tracker, "verify_tracked_changes.py", ["修订.docx", "--author", "审阅人", "--expect", "1"]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("插入 1 处");

    const refused = run(tracker, "tracked_changes.py", [
      join(writer, "稿件.docx"),
      join(writer, "稿件.docx"),
      "--edits",
      "edits.json",
    ]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("不能覆盖原稿");
  });
});

describe("预装的 Word 技能能直接被智能体调用", () => {
  const admin: PublicUser = {
    id: "u_admin",
    username: "owner",
    displayName: "老板",
    role: "admin",
    createdAt: 0,
    mainAgentId: "m_main",
    roomId: "room_main",
  };
  const main: Member = {
    id: "m_main",
    roomId: "room_main",
    name: "主智能体",
    role: "main",
    status: "idle",
    depth: 0,
    spawnedBy: null,
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    providerId: "p1",
    createdAt: 0,
    lastActiveAt: 0,
  };
  const signal = new AbortController().signal;

  let dir: string;
  let files: WorkspaceFiles;
  let library: SkillLibrary;
  let run: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    resetPythonLaunchCache();
    dir = await mkdtemp(join(tmpdir(), "ac-docx-runtime-"));
    files = new WorkspaceFiles(dir);
    library = new SkillLibrary(join(dir, "skills.json"));
    await library.init(); // 内置技能在这里随系统预装，测试不手工创建任何 docx 技能
    const tools = new Map(
      buildShellTools({ files, skills: library, userId: admin.id, member: main }).map((tool) => [
        tool.schema.name,
        tool,
      ]),
    );
    run = (args) => tools.get("run_skill_script")!.execute(args, signal);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!pythonLaunch)(
    "file_write 的草稿 → run_skill_script 出 .docx，成果就在文件工作区里",
    async () => {
      await files.write("草稿.md", Buffer.from("# 一、概述\n\n这是预装 Word 技能的端到端验证。\n\n## （二）细节\n\n- 第一\n- 第二\n", "utf8"), { overwrite: true });

      const built = await run({
        skill: "docx-writer",
        path: "scripts/docx_from_md.py",
        args: ["草稿.md", "成稿.docx", "--profile", "cn-paper"],
        cwd: ".",
      });
      expect(built).toContain("退出码：0");
      expect(built).toContain("已生成 成稿.docx");
      expect(built).toContain("工作目录：files/");

      const listing = await files.list();
      expect(listing.files.some((entry) => entry.path === "成稿.docx")).toBe(true);
      const docx = await readFile(join(files.rootDir, "成稿.docx"));
      expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(docx.length).toBeGreaterThan(5_000);

      // 技能说明里让智能体用 docx-writer 的自检脚本复核（跨技能引用同一个内置技能）
      const inspected = await run({
        skill: "docx-writer",
        path: "scripts/docx_inspect.py",
        args: ["成稿.docx"],
        cwd: ".",
      });
      expect(inspected).toContain("退出码：0");
      expect(inspected).toContain("21.0×29.7 cm");

      const extracted = await run({
        skill: "docx-reader",
        path: "scripts/docx_extract.py",
        args: ["成稿.docx", "--numbers"],
        cwd: ".",
      });
      expect(extracted).toContain("退出码：0");
      expect(extracted).toContain("一、概述");
    },
  );

  it("技能说明里的 cwd 是必需的：省略时读不到工作区草稿", async () => {
    await files.write("草稿.md", Buffer.from("# 一、概述\n\n正文。\n", "utf8"), { overwrite: true });
    const missing = await run({
      skill: "docx-writer",
      path: "scripts/docx_from_md.py",
      args: ["草稿.md", "成稿.docx"],
    });
    expect(missing).toContain("退出码：2");
    expect(missing).toContain("找不到源文件");
    expect((await files.list()).files.some((entry) => entry.path === "成稿.docx")).toBe(false);
  });

  it.skipIf(!pythonLaunch)(
    "主智能体一次真实运行就能用预装技能把草稿写成 Word 成果",
    async () => {
      const bus = new RoomBus("room_docx", "Word 验证群");
      const board = new Workboard("room_docx");
      ensureMainMember(bus);
      const settings: Settings = {
        settingsVersion: SETTINGS_VERSION,
        providers: [{ id: "demo", kind: "mock", model: "mock" }],
        activeProviderId: "demo",
        limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 8, runTimeoutMs: 60_000 },
      };
      const orchestrator = new Orchestrator({
        bus,
        board,
        getSettings: () => settings,
        skills: library,
        ownerId: admin.id,
        files,
        mockHandler: (request) => {
          const steps = request.messages.filter((message) => message.role === "assistant").length;
          if (steps === 0) return { toolCalls: [{ name: "use_skill", args: { name: "docx-writer" } }] };
          if (steps === 1) {
            return {
              toolCalls: [
                {
                  name: "file_write",
                  args: { path: "草稿.md", content: "# 一、概述\n\n由主智能体用预装 Word 技能生成。\n", overwrite: true },
                },
              ],
            };
          }
          if (steps === 2) {
            return {
              toolCalls: [
                {
                  name: "run_skill_script",
                  args: {
                    skill: "docx-writer",
                    path: "scripts/docx_from_md.py",
                    args: ["草稿.md", "季度总结.docx", "--profile", "cn-paper"],
                    cwd: ".",
                  },
                },
              ],
            };
          }
          if (steps === 3) return { toolCalls: [{ name: "file_list", args: {} }] };
          return { text: "已生成 季度总结.docx，中文论文档排版（A4、宋体 + Times New Roman）。" };
        },
      });

      orchestrator.sendUserMessage("@主智能体 用 docx-writer 把概述写成一份 Word");
      const started = Date.now();
      while (!bus.listMessages().some((message) => message.text.includes("已生成 季度总结.docx"))) {
        if (Date.now() - started > 45_000) throw new Error("主智能体运行超时未产出 Word");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const docx = await readFile(join(files.rootDir, "季度总结.docx"));
      expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
      orchestrator.stop();
    },
  );
});
