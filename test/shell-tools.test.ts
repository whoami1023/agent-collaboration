import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildShellTools } from "../src/agent/shell-tools";
import type { Member, PublicUser } from "../src/core/types";
import { WorkspaceFiles } from "../src/files/workspace-files";
import { SkillLibrary } from "../src/skills/library";

let dir: string;
let files: WorkspaceFiles;
let library: SkillLibrary;
let tools: Map<string, ReturnType<typeof buildShellTools>[number]>;
const signal = new AbortController().signal;

const admin: PublicUser = {
  id: "u_admin",
  username: "owner",
  displayName: "老板",
  role: "admin",
  createdAt: 0,
  mainAgentId: "m_main",
  roomId: "room_main",
};

const member: Member = {
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

async function setup(overrides: Partial<Member> = {}): Promise<void> {
  tools = new Map(
    buildShellTools({
      files,
      skills: library,
      userId: admin.id,
      member: { ...member, ...overrides },
    }).map((tool) => [tool.schema.name, tool]),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-shell-"));
  files = new WorkspaceFiles(dir);
  library = new SkillLibrary(join(dir, "skills.json"));
  await library.init();
  await setup();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("run_command", () => {
  it("在工作区执行命令并保留产出文件", async () => {
    const tool = tools.get("run_command")!;
    const out = await tool.execute(
      { command: `node -e "require('fs').writeFileSync('out.txt','ok')"` },
      signal,
    );
    expect(out).toContain("退出码：0");
    expect(out).toContain("工作目录：files/");
    expect((await files.read("out.txt")).content).toBe("ok");
  });

  it("cwd 不能跳出文件工作区", async () => {
    const tool = tools.get("run_command")!;
    expect(await tool.execute({ command: "echo hi", cwd: ".." }, signal)).toContain(
      "cwd 必须位于文件工作区内",
    );
  });

  it("超时会终止进程并说明原因", async () => {
    const tool = tools.get("run_command")!;
    const out = await tool.execute(
      { command: `node -e "setTimeout(() => {}, 5000)"`, timeout_ms: 500 },
      signal,
    );
    expect(out).toContain("执行超过");
    expect(out).toContain("已终止进程树");
  });

  it("输出超过上限时截断", async () => {
    const tool = tools.get("run_command")!;
    const out = await tool.execute(
      { command: `node -e "process.stdout.write('x'.repeat(40000))"` },
      signal,
    );
    expect(out).toContain("已截断");
  });
});

describe("run_skill_script", () => {
  async function createScriptSkill(): Promise<void> {
    await library.create(admin, {
      scope: "shared",
      name: "demo-script",
      description: "测试用技能脚本",
      instructions: "# 测试\n\n用 run_skill_script 执行 scripts/hello.mjs。",
      files: [
        {
          path: "scripts/hello.mjs",
          content:
            "import fs from 'node:fs';\n" +
            "console.log('hi', process.argv.slice(2).join('|'));\n" +
            "fs.writeFileSync('result.txt', 'done');\n",
        },
      ],
    });
  }

  it("展开技能文件、传入参数并保留产出", async () => {
    await createScriptSkill();
    const tool = tools.get("run_skill_script")!;
    const out = await tool.execute(
      { skill: "demo-script", path: "scripts/hello.mjs", args: ["a", "b"] },
      signal,
    );
    expect(out).toContain("退出码：0");
    expect(out).toContain("hi a|b");
    expect(out).toContain("files/.skill-runtime/demo-script");
    const result = await readFile(
      join(files.rootDir, ".skill-runtime", "demo-script", "result.txt"),
      "utf8",
    );
    expect(result).toBe("done");
  });

  it("未授权技能与不存在的脚本都拒绝执行", async () => {
    await createScriptSkill();
    await setup({ skillNames: [] });
    expect(
      await tools
        .get("run_skill_script")!
        .execute({ skill: "demo-script", path: "scripts/hello.mjs" }, signal),
    ).toContain("未对");

    await setup();
    const missing = await tools
      .get("run_skill_script")!
      .execute({ skill: "demo-script", path: "scripts/nope.py" }, signal);
    expect(missing).toContain("没有文件");
  });

  it("解释器缺失时返回启动失败而不是堆栈", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "py-script",
      description: "Python 脚本缺失解释器的处理",
      instructions: "# 测试\n\n运行 scripts/run.py。",
      files: [{ path: "scripts/run.py", content: "print('hello')\n" }],
    });
    const previous = process.env.PYTHON;
    process.env.PYTHON = "definitely-not-a-python-binary-xyz";
    try {
      const out = await tools
        .get("run_skill_script")!
        .execute({ skill: "py-script", path: "scripts/run.py" }, signal);
      expect(out).toContain("启动失败");
      expect(out).toContain("确认可执行文件已安装");
    } finally {
      if (previous === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = previous;
    }
  });

  it("不支持的文件类型给出明确提示", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "data-skill",
      description: "非脚本文件不能执行",
      instructions: "# 测试\n\n读取 data.json。",
      files: [{ path: "data.json", content: "{\"a\":1}" }],
    });
    const out = await tools
      .get("run_skill_script")!
      .execute({ skill: "data-skill", path: "data.json" }, signal);
    expect(out).toContain("不支持直接执行");
  });
});
