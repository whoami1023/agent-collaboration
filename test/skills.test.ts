import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompts";
import { buildTools } from "../src/agent/tools";
import type { Member, PublicUser } from "../src/core/types";
import { RoomBus } from "../src/room/bus";
import { BUILTIN_SHARED_SKILLS, BUILTIN_SKILLS_VERSION } from "../src/skills/builtin";
import { SkillLibrary } from "../src/skills/library";
import {
  isSkillSelected,
  normalizeSkillFilter,
  resolveSkillSelection,
  selectSkillsForMember,
} from "../src/skills/selection";
import { Workboard } from "../src/workboard/board";

let dir: string;
let library: SkillLibrary;

const admin: PublicUser = {
  id: "u_admin",
  username: "owner",
  displayName: "老板",
  role: "admin",
  createdAt: 0,
  mainAgentId: "m_main",
  roomId: "room_main",
};
const alice: PublicUser = { ...admin, id: "u_alice", username: "alice", displayName: "Alice", role: "user" };
const bob: PublicUser = { ...admin, id: "u_bob", username: "bob", displayName: "Bob", role: "user" };
const mainMember: Member = {
  id: "m_main",
  roomId: "room_main",
  name: "主智能体",
  role: "main",
  status: "idle",
  depth: 0,
  spawnedBy: null,
  controlScope: "children",
  contextMode: "isolated",
  systemPrompt: "",
  providerId: "default",
  createdAt: 0,
  lastActiveAt: 0,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-skills-"));
  library = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await library.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SkillLibrary", () => {
  it("共享技能仅管理员可建且全员可用，个人技能互不可见", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "research-brief",
      description: "三段式简报",
      instructions: "# 调研\n先给结论。",
    });
    expect(library.listForAgent(alice.id).map((skill) => skill.name)).toContain("research-brief");
    expect(library.listForAgent(bob.id).map((skill) => skill.name)).toContain("research-brief");
    await expect(
      library.create(alice, {
        scope: "shared",
        name: "x-skill",
        description: "x",
        instructions: "x",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const aliceSkill = await library.create(alice, {
      name: "my-notes",
      description: "个人笔记",
      instructions: "# 笔记\n只给 Alice 用。",
    });
    expect(library.listPersonal(alice.id).map((skill) => skill.id)).toEqual([aliceSkill.id]);
    expect(library.listPersonal(bob.id)).toHaveLength(0);
    expect(library.listForAgent(alice.id).map((skill) => skill.name)).toContain("my-notes");
    expect(library.listForAgent(bob.id).map((skill) => skill.name)).not.toContain("my-notes");
    expect(library.readForAgent(alice.id, "my-notes")?.instructions).toContain("只给 Alice 用");
    expect(library.readForAgent(bob.id, "my-notes")).toBeUndefined();
    expect(library.readForAgent(alice.id, "$research-brief")?.name).toBe("research-brief");
  });

  it("个人技能仅所有者可改删，共享技能仅管理员可改删", async () => {
    const shared = await library.create(admin, {
      scope: "shared",
      name: "shared-skill",
      description: "共享",
      instructions: "共享说明",
    });
    const aliceSkill = await library.create(alice, {
      name: "alice-skill",
      description: "Alice 的技能",
      instructions: "说明",
    });

    await expect(
      library.update(alice, shared.id, { description: "篡改" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(library.remove(alice, shared.id)).rejects.toMatchObject({ status: 403 });
    await expect(
      library.update(bob, aliceSkill.id, { description: "篡改" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(library.remove(bob, aliceSkill.id)).rejects.toMatchObject({ status: 403 });

    const updated = await library.update(alice, aliceSkill.id, {
      description: "更新后的描述",
    });
    expect(updated.description).toBe("更新后的描述");
    await library.remove(admin, shared.id);
    expect(library.listShared()).toHaveLength(0);
    await library.remove(alice, aliceSkill.id);
    expect(library.listPersonal(alice.id)).toHaveLength(0);
  });

  it("校验名称、描述、说明，并在同一范围内拒绝重名", async () => {
    await expect(
      library.create(alice, { name: "Bad Name", description: "x", instructions: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      library.create(alice, { name: "ok", description: "   ", instructions: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      library.create(alice, { name: "ok", description: "x", instructions: "" }),
    ).rejects.toMatchObject({ status: 400 });

    await library.create(alice, { name: "ok", description: "x", instructions: "y" });
    await expect(
      library.create(alice, { name: "OK", description: "x", instructions: "y" }),
    ).rejects.toMatchObject({ status: 409 });
    await library.create(bob, { name: "ok", description: "x", instructions: "y" });
    await library.create(admin, {
      scope: "shared",
      name: "ok",
      description: "x",
      instructions: "y",
    });
    expect(library.listShared()).toHaveLength(1);
  });

  it("系统提示词只列当前用户可用技能，并要求先读取说明", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "research-brief",
      description: "三段式简报",
      instructions: "# 调研",
    });
    await library.create(alice, {
      name: "my-notes",
      description: "个人笔记",
      instructions: "# 笔记",
    });
    await library.create(bob, {
      name: "bob-only",
      description: "Bob 的私有技能",
      instructions: "# Bob",
    });

    const prompt = buildSystemPrompt({
      roomName: "测试群",
      member: mainMember,
      members: [mainMember],
      parentName: null,
      taskTitles: new Map(),
      limits: { maxChildrenPerAgent: 3, maxSpawnDepth: 3, maxConcurrent: 4 },
      skills: library.listForAgent(alice.id).map(({ name, description, scope }) => ({
        name,
        description,
        scope,
      })),
    });
    expect(prompt).toContain("research-brief");
    expect(prompt).toContain("my-notes");
    expect(prompt).toContain("use_skill");
    expect(prompt).not.toContain("bob-only");
  });

  it("use_skill 按用户可见性返回技能说明", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "research-brief",
      description: "三段式简报",
      instructions: "# 调研\n先给结论。",
    });
    const tool = buildTools(mainMember, {
      bus: new RoomBus("room_main", "测试群"),
      board: new Workboard("room_main"),
      skills: library,
      userId: alice.id,
    }).find((candidate) => candidate.schema.name === "use_skill");
    if (!tool) throw new Error("缺少 use_skill 工具");
    const signal = new AbortController().signal;

    const found = await tool.execute({ name: "research-brief" }, signal);
    expect(found).toContain("先给结论");
    expect(found).toContain("共享");

    const missing = await tool.execute({ name: "bob-only" }, signal);
    expect(missing).toContain("没有可用的技能");
  });

  it("首次启动安装全部内置共享技能，重启不会重复安装", async () => {
    const seeded = new SkillLibrary(join(dir, "seeded.json"));
    await seeded.init();
    const shared = seeded.listShared();
    expect(shared).toHaveLength(BUILTIN_SHARED_SKILLS.length);
    expect(shared.every((skill) => skill.builtin === true && skill.scope === "shared")).toBe(true);
    for (const skill of shared) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeLessThanOrEqual(160);
      expect(skill.instructions.trim().length).toBeGreaterThan(0);
      expect(skill.source).toBeTruthy();
    }
    expect(shared.map((skill) => skill.name)).toContain("task-breakdown");
    expect(shared.map((skill) => skill.name)).toContain("summarize");
    expect(shared.map((skill) => skill.name)).toContain("oracle");
    expect(shared.map((skill) => skill.name)).toContain("skill-creator");
    const oracle = seeded.readForAgent(alice.id, "oracle");
    expect(oracle?.builtin).toBe(true);
    expect(oracle?.instructions).toContain("复核");
    expect(oracle?.instructions).not.toContain("spawn_member");
    expect(seeded.listPersonal(alice.id)).toHaveLength(0);

    const again = new SkillLibrary(join(dir, "seeded.json"));
    await again.init();
    expect(again.listShared()).toHaveLength(BUILTIN_SHARED_SKILLS.length);
    expect(new Set(again.listShared().map((skill) => skill.id)).size).toBe(
      BUILTIN_SHARED_SKILLS.length,
    );
  });

  it("内置技能会补进已有技能库，且不覆盖管理员已建的同名技能", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "summarize",
      description: "自定义摘要",
      instructions: "保留我的版本",
    });
    const upgraded = new SkillLibrary(join(dir, "skills.json"));
    await upgraded.init();
    const shared = upgraded.listShared();
    expect(shared).toHaveLength(BUILTIN_SHARED_SKILLS.length);
    expect(shared.filter((skill) => skill.builtin === true)).toHaveLength(
      BUILTIN_SHARED_SKILLS.length - 1,
    );
    const summarize = shared.find((skill) => skill.name === "summarize");
    expect(summarize?.instructions).toBe("保留我的版本");
    expect(shared.map((skill) => skill.name)).toContain("oracle");
  });

  it("旧技能库按版本刷新内置说明", async () => {
    const file = join(dir, "migrate.json");
    const seeded = new SkillLibrary(file);
    await seeded.init();
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      skills: Array<{ name: string; instructions: string }>;
      builtinVersion?: number;
    };
    delete raw.builtinVersion;
    const oracle = raw.skills.find((skill) => skill.name === "oracle");
    if (!oracle) throw new Error("缺少内置技能");
    oracle.instructions = "旧说明：用 spawn_member 做复核";

    const reloaded = new SkillLibrary(file);
    await reloaded.init();
    const refreshed = reloaded.readForAgent(alice.id, "oracle");
    expect(refreshed?.instructions).toContain("复核");
    expect(refreshed?.instructions).not.toContain("spawn_member");
    const persisted = JSON.parse(await readFile(file, "utf8")) as { builtinVersion?: number };
    expect(persisted.builtinVersion).toBe(BUILTIN_SKILLS_VERSION);
  });

  it("内置技能禁止改名，删除后重启不会复活", async () => {
    const seeded = new SkillLibrary(join(dir, "seeded2.json"));
    await seeded.init();
    const target = seeded.listShared().find((skill) => skill.name === "task-breakdown");
    if (!target) throw new Error("缺少内置技能");
    await expect(
      seeded.update(admin, target.id, { name: "renamed" }),
    ).rejects.toMatchObject({ status: 400 });
    const updated = await seeded.update(admin, target.id, {
      description: "管理员改过的描述",
    });
    expect(updated.description).toBe("管理员改过的描述");
    await seeded.remove(admin, target.id);
    expect(seeded.listShared().map((skill) => skill.name)).not.toContain("task-breakdown");

    const reloaded = new SkillLibrary(join(dir, "seeded2.json"));
    await reloaded.init();
    expect(reloaded.listShared().map((skill) => skill.name)).not.toContain("task-breakdown");
    expect(reloaded.listShared()).toHaveLength(BUILTIN_SHARED_SKILLS.length - 1);
  });

  it("重启后个人技能仍在", async () => {
    await library.create(alice, {
      name: "persist",
      description: "持久化",
      instructions: "说明",
    });
    const reloaded = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await reloaded.init();
    expect(reloaded.listPersonal(alice.id).map((skill) => skill.name)).toEqual(["persist"]);
  });
});

describe("SkillLibrary 导入 SKILL.md", () => {
  const skillMd = (name: string, description: string, body = "# 步骤\n先给结论。") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

  it("导入写成个人技能，标记来源，坏文件只影响自己", async () => {
    const results = await library.importMany(alice, {
      scope: "personal",
      files: [
        { filename: "pdf-forms/SKILL.md", content: skillMd("pdf-forms", "填写 PDF 表单") },
        { filename: "broken/SKILL.md", content: "---\nname: broken\n---\n\n正文" },
      ],
    });
    expect(results.map((item) => item.ok)).toEqual([true, false]);
    expect(results[0]).toMatchObject({ action: "created", skill: { name: "pdf-forms" } });
    expect(results[1]?.error).toContain("description is required");
    const imported = library.listPersonal(alice.id);
    expect(imported.map((skill) => skill.name)).toEqual(["pdf-forms"]);
    expect(imported[0]).toMatchObject({ imported: true, source: "导入自 pdf-forms/SKILL.md" });
    expect(imported[0]?.instructions).toBe("# 步骤\n先给结论。");
  });

  it("重名默认失败，勾选覆盖才更新；非管理员不能导入共享", async () => {
    await library.importMany(alice, {
      files: [{ filename: "a.md", content: skillMd("dup", "第一版") }],
    });
    const clash = await library.importMany(alice, {
      files: [{ filename: "a.md", content: skillMd("dup", "第二版") }],
    });
    expect(clash[0]).toMatchObject({ ok: false });
    expect(clash[0]?.error).toContain("覆盖");

    const overwritten = await library.importMany(alice, {
      overwrite: true,
      files: [{ filename: "a.md", content: skillMd("dup", "第二版", "# 新说明") }],
    });
    expect(overwritten[0]).toMatchObject({ ok: true, action: "updated" });
    expect(library.listPersonal(alice.id)).toHaveLength(1);
    expect(library.readForAgent(alice.id, "dup")?.description).toBe("第二版");

    await expect(
      library.importMany(alice, {
        scope: "shared",
        files: [{ filename: "a.md", content: skillMd("s", "x") }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    const asShared = await library.importMany(admin, {
      scope: "shared",
      files: [{ filename: "a.md", content: skillMd("s", "共享导入") }],
    });
    expect(asShared[0]).toMatchObject({ ok: true, skill: { scope: "shared" } });
    expect(library.listForAgent(bob.id).map((skill) => skill.name)).toContain("s");
  });

  it("名称写法不规范会被规范化，超长字段截断并给出警告", async () => {
    const results = await library.importMany(alice, {
      files: [
        {
          filename: "Weekly Report.SKILL.md",
          content: skillMd("Weekly Report", "x".repeat(200)),
        },
      ],
    });
    const first = results[0];
    expect(first?.ok).toBe(true);
    expect(first?.skill?.name).toBe("weekly-report");
    expect(first?.skill?.description).toHaveLength(160);
    expect((first?.warnings ?? []).join("\n")).toContain("规范化");
    expect((first?.warnings ?? []).join("\n")).toContain("截断");
  });

  it("声明宿主机依赖的技能带警告导入，正文缺失的文件不会写库", async () => {
    const results = await library.importMany(alice, {
      files: [
        {
          filename: "needs-shell/SKILL.md",
          content:
            '---\nname: needs-shell\ndescription: 用 rg 搜代码\nmetadata: {"openclaw":{"requires":{"bins":["rg"]}}}\n---\n\n正文',
        },
        { filename: "empty/SKILL.md", content: "---\nname: empty\ndescription: x\n---\n\n" },
      ],
    });
    expect((results[0]?.warnings ?? []).join("\n")).toContain("宿主机工具");
    expect(results[1]?.ok).toBe(false);
    expect(library.listPersonal(alice.id).map((skill) => skill.name)).toEqual(["needs-shell"]);

    const reloaded = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await reloaded.init();
    expect(reloaded.listPersonal(alice.id)[0]).toMatchObject({
      name: "needs-shell",
      imported: true,
    });
  });

  it("空列表、超过 20 份、非字符串内容都被拒绝", async () => {
    await expect(library.importMany(alice, { files: [] })).rejects.toMatchObject({ status: 400 });
    await expect(
      library.importMany(alice, {
        files: Array.from({ length: 21 }, (_unused, index) => ({
          filename: `a${index}.md`,
          content: skillMd(`a${index}`, "x"),
        })),
      }),
    ).rejects.toMatchObject({ status: 400 });
    const bad = await library.importMany(alice, {
      files: [{ filename: "x.md", content: 42 }],
    });
    expect(bad[0]).toMatchObject({ ok: false, error: "SKILL.md 内容为空" });
  });

  it("同一次导入里的两份同名技能：第二份按覆盖规则处理", async () => {
    const results = await library.importMany(alice, {
      overwrite: true,
      files: [
        { filename: "one/SKILL.md", content: skillMd("same", "第一份") },
        { filename: "two/SKILL.md", content: skillMd("same", "第二份") },
      ],
    });
    expect(results.map((item) => item.action)).toEqual(["created", "updated"]);
    expect(library.listPersonal(alice.id)).toHaveLength(1);
    expect(library.readForAgent(alice.id, "same")?.description).toBe("第二份");
  });
});

describe("技能附带文件（脚本 / 资料）", () => {
  const skillMd = (name: string, description: string, body = "# 步骤\n先给结论。") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

  function statusOf(run: () => unknown): number | undefined {
    try {
      run();
      return undefined;
    } catch (err) {
      return (err as { status?: number }).status;
    }
  }

  it("新建与编辑可以带附带文件，路径排序、体积按字节记", async () => {
    const skill = await library.create(alice, {
      name: "pdf-forms",
      description: "填写 PDF 表单",
      instructions: "# 步骤\n运行 scripts/fill.py",
      files: [
        { path: "scripts/fill.py", content: "print('ok')\n" },
        { path: "references/schema.md", content: "# 字段\nname" },
      ],
    });
    expect(skill.files?.map((file) => file.path)).toEqual([
      "references/schema.md",
      "scripts/fill.py",
    ]);
    expect(skill.files?.[0]?.size).toBe(Buffer.byteLength("# 字段\nname"));
    expect(skill.files?.[1]?.content).toBe("print('ok')\n");

    const replaced = await library.update(alice, skill.id, {
      files: [{ path: "scripts/run.sh", content: "echo 1\n" }],
    });
    expect(replaced.files?.map((file) => file.path)).toEqual(["scripts/run.sh"]);

    const untouched = await library.update(alice, skill.id, { description: "换个描述" });
    expect(untouched.files?.map((file) => file.path)).toEqual(["scripts/run.sh"]);

    const cleared = await library.update(alice, skill.id, { files: [] });
    expect(cleared.files).toBeUndefined();

    const reloaded = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await reloaded.init();
    expect(reloaded.listPersonal(alice.id)[0]?.files).toBeUndefined();
  });

  it("附带文件路径必须留在技能目录内，SKILL.md 不能重复存", async () => {
    const rejected = [
      "../etc/passwd",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "SKILL.md",
      "scripts/SKILL.md",
      "scripts/a<b>.py",
    ];
    for (const path of rejected) {
      await expect(
        library.create(alice, {
          name: `gate-${rejected.indexOf(path)}`,
          description: "x",
          instructions: "y",
          files: [{ path, content: "z" }],
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      library.create(alice, {
        name: "gate-nul",
        description: "x",
        instructions: "y",
        files: [{ path: "scripts/a.py", content: "a\u0000b" }],
      }),
    ).rejects.toMatchObject({ status: 400 });

    const binary = await library.create(alice, {
      name: "gate-binary",
      description: "x",
      instructions: "y",
      files: [{ path: "assets/logo.png", content: "aGVsbG8=", encoding: "base64" }],
    });
    expect(binary.files?.[0]).toMatchObject({ encoding: "base64", size: 5 });
  });

  it("单个技能的附带文件数量与总量有上限", async () => {
    await expect(
      library.create(alice, {
        name: "too-many",
        description: "x",
        instructions: "y",
        files: Array.from({ length: 41 }, (_unused, index) => ({
          path: `scripts/f${index}.py`,
          content: "x",
        })),
      }),
    ).rejects.toMatchObject({ status: 400 });

    const big = "x".repeat(300 * 1024);
    await expect(
      library.create(alice, {
        name: "too-big",
        description: "x",
        instructions: "y",
        files: [{ path: "references/huge.md", content: big }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("readFile 只把正文给属主或共享库成员", async () => {
    const personal = await library.create(alice, {
      name: "mine",
      description: "x",
      instructions: "y",
      files: [{ path: "scripts/a.py", content: "print(1)" }],
    });
    expect(library.readFile(alice, personal.id, "scripts/a.py").content).toBe("print(1)");
    expect(library.readFile(alice, personal.id, "SCRIPTS/A.PY").content).toBe("print(1)");
    expect(statusOf(() => library.readFile(bob, personal.id, "scripts/a.py"))).toBe(403);
    expect(statusOf(() => library.readFile(alice, personal.id, "../../x"))).toBe(400);
    expect(statusOf(() => library.readFile(alice, personal.id, "scripts/nope.py"))).toBe(404);
    expect(statusOf(() => library.readFile(alice, personal.id, undefined))).toBe(400);
    expect(statusOf(() => library.readFile(alice, "sk_missing", "scripts/a.py"))).toBe(404);

    const shared = await library.create(admin, {
      scope: "shared",
      name: "ours",
      description: "x",
      instructions: "y",
      files: [{ path: "references/b.md", content: "# b" }],
    });
    expect(library.readFile(bob, shared.id, "references/b.md").content).toBe("# b");
  });

  it("use_skill 列出附带文件，read_skill_file 按路径读正文", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "pdf-forms",
      description: "填写 PDF 表单",
      instructions: "# 步骤\n运行 scripts/fill.py",
      files: [
        { path: "scripts/fill.py", content: "print('ok')" },
        { path: "assets/logo.png", content: "aGk=", encoding: "base64" },
      ],
    });
    const tools = buildTools(mainMember, {
      bus: new RoomBus("room_main", "测试群"),
      board: new Workboard("room_main"),
      skills: library,
      userId: alice.id,
    });
    const use = tools.find((tool) => tool.schema.name === "use_skill");
    const read = tools.find((tool) => tool.schema.name === "read_skill_file");
    if (!use || !read) throw new Error("缺少 use_skill / read_skill_file 工具");
    const signal = new AbortController().signal;

    const brief = await use.execute({ name: "pdf-forms" }, signal);
    expect(brief).toContain("scripts/fill.py");
    expect(brief).toContain("read_skill_file");

    expect(await read.execute({ skill: "pdf-forms", path: "scripts/fill.py" }, signal)).toContain(
      "print('ok')",
    );
    expect(await read.execute({ skill: "pdf-forms", path: "assets/logo.png" }, signal)).toContain(
      "二进制",
    );
    const missing = await read.execute({ skill: "pdf-forms", path: "scripts/nope.py" }, signal);
    expect(missing).toContain("scripts/fill.py");
    expect(await read.execute({ skill: "ghost", path: "a" }, signal)).toContain("没有可用的技能");
    expect(await read.execute({ skill: "pdf-forms", path: " " }, signal)).toContain("path 不能为空");
  });

  it("导入技能目录：SKILL.md 与脚本一起入库，噪音与坏路径被跳过", async () => {
    const results = await library.importMany(alice, {
      files: [
        { filename: "pdf-forms/SKILL.md", content: skillMd("pdf-forms", "填写 PDF 表单") },
        { filename: "pdf-forms/scripts/fill.py", content: "print('ok')" },
        { filename: "pdf-forms/references/schema.md", content: "# 字段" },
        { filename: "pdf-forms/assets/icon.png", content: "aGk=", encoding: "base64" },
        { filename: "pdf-forms/__MACOSX/._SKILL.md", content: "junk" },
        { filename: "pdf-forms/.DS_Store", content: "junk" },
        { filename: "pdf-forms/scripts/a<b>.py", content: "junk" },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    const warnings = (results[0]?.warnings ?? []).join("\n");
    expect(warnings).toContain("附带 3 个文件");
    expect(warnings).toContain("已跳过 scripts/a<b>.py");

    const skill = library.readForAgent(alice.id, "pdf-forms");
    expect(skill?.files?.map((file) => file.path)).toEqual([
      "assets/icon.png",
      "references/schema.md",
      "scripts/fill.py",
    ]);
    expect(skill?.files?.find((file) => file.path === "scripts/fill.py")?.content).toBe(
      "print('ok')",
    );
    expect(skill?.files?.find((file) => file.path === "assets/icon.png")).toMatchObject({
      encoding: "base64",
      size: 2,
    });
  });

  it("嵌套技能目录：文件归到最近的 SKILL.md", async () => {
    await library.importMany(alice, {
      files: [
        { filename: "outer/SKILL.md", content: skillMd("outer", "外层技能") },
        { filename: "outer/scripts/outer.py", content: "outer" },
        { filename: "outer/inner/SKILL.md", content: skillMd("inner", "内层技能") },
        { filename: "outer/inner/scripts/inner.py", content: "inner" },
      ],
    });
    expect(library.readForAgent(alice.id, "outer")?.files?.map((file) => file.path)).toEqual([
      "scripts/outer.py",
    ]);
    expect(library.readForAgent(alice.id, "inner")?.files?.map((file) => file.path)).toEqual([
      "scripts/inner.py",
    ]);
  });

  it("覆盖导入：带文件则替换，不带文件保留原有并提示", async () => {
    await library.importMany(alice, {
      files: [
        { filename: "dup/SKILL.md", content: skillMd("dup", "第一版") },
        { filename: "dup/scripts/a.py", content: "a" },
      ],
    });
    const kept = await library.importMany(alice, {
      overwrite: true,
      files: [{ filename: "dup/SKILL.md", content: skillMd("dup", "第二版") }],
    });
    expect(kept[0]?.ok).toBe(true);
    expect((kept[0]?.warnings ?? []).join("\n")).toContain("保持不变");
    expect(library.readForAgent(alice.id, "dup")?.files?.map((file) => file.path)).toEqual([
      "scripts/a.py",
    ]);

    await library.importMany(alice, {
      overwrite: true,
      files: [
        { filename: "dup/SKILL.md", content: skillMd("dup", "第三版") },
        { filename: "dup/scripts/b.py", content: "b" },
      ],
    });
    expect(library.readForAgent(alice.id, "dup")?.files?.map((file) => file.path)).toEqual([
      "scripts/b.py",
    ]);
  });

  it("目录里没有 SKILL.md、或单次文件过多都会被拒", async () => {
    await expect(
      library.importMany(alice, {
        files: [
          { filename: "loose/SKILL.md.js", content: "x" },
          { filename: "loose/scripts/a.py", content: "a" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("SKILL.md") });
    await expect(
      library.importMany(alice, {
        files: Array.from({ length: 201 }, (_unused, index) => ({
          filename: `bulk${index}.md`,
          content: "x",
        })),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // 单文件不苛求文件名：整份就是技能说明
    const single = await library.importMany(alice, {
      files: [{ filename: "weekly-report.md", content: skillMd("weekly-report", "周报") }],
    });
    expect(single[0]).toMatchObject({ ok: true, skill: { name: "weekly-report" } });
  });
});

describe("成员级技能白名单", () => {
  it("语义与 OpenClaw 一致：undefined=全部，[]=全禁用，大小写与重复归一", () => {
    expect(normalizeSkillFilter(undefined)).toBeUndefined();
    expect(normalizeSkillFilter(null)).toBeUndefined();
    expect(normalizeSkillFilter([" A ", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeSkillFilter([])).toEqual([]);

    const skills = [{ name: "a" }, { name: "b" }, { name: "c" }];
    expect(selectSkillsForMember(skills, undefined).map((skill) => skill.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(selectSkillsForMember(skills, ["B"]).map((skill) => skill.name)).toEqual(["b"]);
    expect(selectSkillsForMember(skills, [])).toEqual([]);
    expect(isSkillSelected(undefined, "x")).toBe(true);
    expect(isSkillSelected([], "x")).toBe(false);
  });

  it("接口校验：null 表示全部，未知技能整体拒绝", () => {
    expect(resolveSkillSelection(null, ["a"])).toBeUndefined();
    expect(resolveSkillSelection([], ["a"])).toEqual([]);
    expect(resolveSkillSelection(["A"], ["a"])).toEqual(["a"]);
    expect(() => resolveSkillSelection(["missing"], ["a"])).toThrow("不在该账号的可用技能里");
    expect(() => resolveSkillSelection("a", ["a"])).toThrow("必须是技能名数组");
    expect(() => resolveSkillSelection([1], ["a"])).toThrow("必须是技能名");
  });

  it("提示词只列勾选项，use_skill / read_skill_file 拒绝未勾选技能", async () => {
    await library.create(admin, {
      scope: "shared",
      name: "research-brief",
      description: "三段式简报",
      instructions: "# 调研\n先给结论。",
    });
    await library.create(admin, {
      scope: "shared",
      name: "summarize",
      description: "摘要",
      instructions: "# 摘要\n压缩成要点。",
    });
    const restricted: Member = { ...mainMember, skillNames: ["research-brief"] };
    const tools = buildTools(restricted, {
      bus: new RoomBus("room_main", "测试群"),
      board: new Workboard("room_main"),
      skills: library,
      userId: alice.id,
    });
    const use = tools.find((tool) => tool.schema.name === "use_skill");
    const read = tools.find((tool) => tool.schema.name === "read_skill_file");
    if (!use || !read) throw new Error("缺少 use_skill / read_skill_file 工具");
    const signal = new AbortController().signal;

    expect(await use.execute({ name: "research-brief" }, signal)).toContain("先给结论");
    const blockedUse = String(await use.execute({ name: "summarize" }, signal));
    expect(blockedUse).toContain("未对 @主智能体 启用");
    expect(blockedUse).toContain("research-brief");
    expect(blockedUse).not.toContain("summarize、");
    expect(String(await read.execute({ skill: "summarize", path: "x.md" }, signal))).toContain(
      "未对 @主智能体 启用",
    );

    const prompt = buildSystemPrompt({
      roomName: "测试群",
      member: restricted,
      members: [restricted],
      parentName: null,
      taskTitles: new Map(),
      limits: { maxChildrenPerAgent: 3, maxSpawnDepth: 3, maxConcurrent: 4 },
      skills: selectSkillsForMember(library.listForAgent(alice.id), restricted.skillNames).map(
        ({ name, description, scope }) => ({ name, description, scope }),
      ),
    });
    expect(prompt).toContain("research-brief");
    expect(prompt).not.toContain("summarize");

    const none: Member = { ...mainMember, skillNames: [] };
    const noneTool = buildTools(none, {
      bus: new RoomBus("room_main", "测试群"),
      board: new Workboard("room_main"),
      skills: library,
      userId: alice.id,
    }).find((tool) => tool.schema.name === "use_skill");
    expect(String(await noneTool?.execute({ name: "research-brief" }, signal))).toContain(
      "没有启用任何技能",
    );
  });
});
