import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompts";
import { buildTools } from "../src/agent/tools";
import { DEFAULT_LIMITS, type Member, type PublicUser } from "../src/core/types";
import { RoomBus } from "../src/room/bus";
import { BUILTIN_SHARED_SKILLS } from "../src/skills/builtin";
import { SkillLibrary } from "../src/skills/library";
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
      limits: DEFAULT_LIMITS,
      skills: library,
      userId: alice.id,
      spawn: async () => "unused",
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
    expect(oracle?.instructions).toContain("spawn_member");
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
