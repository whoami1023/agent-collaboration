import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublicUser } from "../src/core/types";
import { SkillLibrary } from "../src/skills/library";
import {
  BUILTIN_AGENT_TEMPLATES,
  BUILTIN_TEMPLATES_VERSION,
} from "../src/templates/agent-templates";
import { TemplateLibrary } from "../src/templates/template-library";

let dir: string;
let library: TemplateLibrary;

const admin: PublicUser = {
  id: "u_admin",
  username: "owner",
  displayName: "老板",
  role: "admin",
  createdAt: 0,
  mainAgentId: "m_main",
  roomId: "room_main",
};
const alice: PublicUser = {
  ...admin,
  id: "u_alice",
  username: "alice",
  displayName: "Alice",
  role: "user",
};
const bob: PublicUser = {
  ...admin,
  id: "u_bob",
  username: "bob",
  displayName: "Bob",
  role: "user",
};

function templateFile(): string {
  return join(dir, "templates.json");
}

const personalInput = {
  title: "本地化翻译",
  description: "把中文材料翻成地道英文，保留术语表。",
  brief: "负责中英互译：先建术语表，再逐段翻译，产出对照表与终稿。",
  category: "research",
  suggestedName: "翻译",
  emoji: "🌍",
  vibe: "咬文嚼字",
  workstyle: ["术语先建表，全篇保持一致。"],
  skillNames: ["humanizer", "summarize"],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-templates-"));
  library = new TemplateLibrary(templateFile());
  await library.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TemplateLibrary", () => {
  it("内置模板随启动预装，全员可见且普通账号不能改删", async () => {
    const builtins = library.listBuiltin();
    expect(builtins).toHaveLength(BUILTIN_AGENT_TEMPLATES.length);
    expect(builtins.every((record) => record.builtin)).toBe(true);
    expect(builtins.every((record) => record.scope === "builtin")).toBe(true);

    const target = builtins.find((record) => record.key === "deep-researcher");
    expect(target?.skillNames).toContain("web-search");
    expect(target?.workstyle?.length ?? 0).toBeGreaterThan(0);
    await expect(library.update(alice, target!.id, { title: "改名" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(library.remove(alice, target!.id)).rejects.toMatchObject({ status: 403 });
    // 管理员可以删内置模板，删除后记入 removedBuiltins，重启不再预装回来。
    const removed = await library.remove(admin, target!.id);
    expect(removed.key).toBe("deep-researcher");
    expect(library.listBuiltin().some((record) => record.key === "deep-researcher")).toBe(false);

    const reloaded = new TemplateLibrary(templateFile());
    await reloaded.init();
    expect(reloaded.listBuiltin().some((record) => record.key === "deep-researcher")).toBe(false);
    expect(reloaded.listBuiltin()).toHaveLength(BUILTIN_AGENT_TEMPLATES.length - 1);
  });

  it("个人模板互不可见，可增删改", async () => {
    const created = await library.create(alice, personalInput);
    expect(created.scope).toBe("personal");
    expect(created.ownerId).toBe(alice.id);
    expect(created.key).toBe("template");
    expect(created.skillNames).toEqual(["humanizer", "summarize"]);
    expect(library.listPersonal(alice.id)).toHaveLength(1);
    expect(library.listPersonal(bob.id)).toHaveLength(0);
    expect(library.listFor(bob.id).some((record) => record.id === created.id)).toBe(false);

    const updated = await library.update(alice, created.id, {
      title: "技术文档翻译",
      skillNames: ["summarize"],
      workstyle: [],
      vibe: "",
    });
    expect(updated.title).toBe("技术文档翻译");
    expect(updated.skillNames).toEqual(["summarize"]);
    expect(updated.workstyle).toBeUndefined();
    expect(updated.vibe).toBeUndefined();

    await expect(library.update(bob, created.id, { title: "抢改" })).rejects.toMatchObject({
      status: 403,
    });
    expect(() => library.getFor(bob, created.id)).toThrow(/只能使用自己的个人模板/);
    expect(() => library.getFor(bob, "tpl_missing")).toThrow(/模板不存在/);

    await library.remove(alice, created.id);
    expect(library.listPersonal(alice.id)).toHaveLength(0);

    const reloaded = new TemplateLibrary(templateFile());
    await reloaded.init();
    expect(reloaded.listPersonal(alice.id)).toHaveLength(0);
  });

  it("未填标识时按标题生成，同主冲突自动加序号", async () => {
    const first = await library.create(alice, { ...personalInput, key: "my-translator" });
    expect(first.key).toBe("my-translator");
    await expect(
      library.create(alice, { ...personalInput, key: "my-translator" }),
    ).rejects.toMatchObject({ status: 400 });
    // 内置模板占用的标识也不能再用作个人模板。
    await expect(
      library.create(alice, { ...personalInput, key: "data-analyst" }),
    ).rejects.toMatchObject({ status: 400 });

    // 中文标题转不出 ASCII slug：兜底成 template，同一账号再建时加序号。
    const generated = await library.create(alice, personalInput);
    expect(generated.key).toBe("template");
    const secondGenerated = await library.create(alice, { ...personalInput, title: "另一个模板" });
    expect(secondGenerated.key).toBe("template-2");
    const otherOwner = await library.create(bob, personalInput);
    expect(otherOwner.key).toBe("template");
  });

  it("输入校验：必填、长度与分类", async () => {
    await expect(library.create(alice, { ...personalInput, title: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      library.create(alice, { ...personalInput, title: "名".repeat(41) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(library.create(alice, { ...personalInput, brief: "" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      library.create(alice, { ...personalInput, brief: "描".repeat(801) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      library.create(alice, { ...personalInput, category: "nonsense" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      library.create(alice, { ...personalInput, workstyle: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      library.create(alice, { ...personalInput, skillNames: "humanizer" }),
    ).rejects.toMatchObject({ status: 400 });

    const minimal = await library.create(alice, {
      title: "极简模板",
      description: "只有必填项。",
      brief: "只做一件事：按派发要求输出结论。",
    });
    expect(minimal.category).toBe("other");
    expect(minimal.suggestedName).toBe("极简模板");
    expect(minimal.skillNames).toBeUndefined();
  });

  it("删号只清本人的个人模板，内置与他人的不受影响", async () => {
    const mine = await library.create(alice, { ...personalInput, key: "alice-only" });
    const theirs = await library.create(bob, { ...personalInput, key: "bob-only" });
    const before = library.listBuiltin().length;

    expect(await library.removeOwnedBy(alice.id)).toBe(1);
    expect(library.listPersonal(alice.id)).toHaveLength(0);
    expect(library.listPersonal(bob.id).map((record) => record.id)).toEqual([theirs.id]);
    expect(library.listBuiltin()).toHaveLength(before);
    expect(library.getFor(bob, theirs.id).key).toBe("bob-only");
    expect(() => library.getFor(alice, mine.id)).toThrow(/模板不存在/);
    expect(await library.removeOwnedBy("u_nobody")).toBe(0);

    const reloaded = new TemplateLibrary(templateFile());
    await reloaded.init();
    expect(reloaded.listPersonal(alice.id)).toHaveLength(0);
    expect(reloaded.listPersonal(bob.id)).toHaveLength(1);
  });

  it("版本升级刷新内置正文，管理员改过的内置模板同样被覆盖回内置内容", async () => {
    const raw = JSON.parse(await readFile(templateFile(), "utf8")) as {
      templates: Array<Record<string, unknown>>;
      builtinVersion?: number;
    };
    const target = raw.templates.find((record) => record["key"] === "data-analyst");
    expect(target).toBeTruthy();
    target!["title"] = "旧版数据分析师";
    target!["description"] = "旧描述";
    raw.builtinVersion = BUILTIN_TEMPLATES_VERSION - 1;
    await writeFile(templateFile(), JSON.stringify(raw), "utf8");

    const upgraded = new TemplateLibrary(templateFile());
    await upgraded.init();
    const refreshed = upgraded.listBuiltin().find((record) => record.key === "data-analyst");
    const seed = BUILTIN_AGENT_TEMPLATES.find((item) => item.key === "data-analyst");
    expect(refreshed?.title).toBe(seed?.title);
    expect(refreshed?.description).toBe(seed?.description);
    expect(refreshed?.workstyle).toEqual(seed?.workstyle);

    const persisted = JSON.parse(await readFile(templateFile(), "utf8")) as {
      builtinVersion?: number;
    };
    expect(persisted.builtinVersion).toBe(BUILTIN_TEMPLATES_VERSION);
  });

  it("内置模板引用的技能名都存在于内置技能库", async () => {
    const skills = new SkillLibrary(join(dir, "skills.json"));
    await skills.init();
    const available = new Set(skills.listShared().map((skill) => skill.name));
    const missing = BUILTIN_AGENT_TEMPLATES.flatMap((template) =>
      template.skillNames
        .filter((name) => !available.has(name))
        .map((name) => `${template.key} -> ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("内置模板分类与技能库分类口径一致，且每项都有可用的 emoji 与工作方式", () => {
    for (const template of BUILTIN_AGENT_TEMPLATES) {
      expect(template.brief.length).toBeLessThanOrEqual(800);
      expect(template.description.length).toBeLessThanOrEqual(160);
      expect(template.suggestedName.length).toBeLessThanOrEqual(12);
      expect(template.workstyle.length).toBeGreaterThan(0);
      expect(template.skillNames.length).toBeGreaterThan(0);
      expect(template.key).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
    }
    const keys = BUILTIN_AGENT_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
