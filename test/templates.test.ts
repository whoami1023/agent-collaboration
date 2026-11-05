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
import {
  TEMPLATE_EXPORT_FORMAT,
  TEMPLATE_EXPORT_VERSION,
  TemplateLibrary,
} from "../src/templates/template-library";

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

  it("导出个人模板：只带设定字段，内置与他人的个人模板不可导出", async () => {
    const personal = await library.create(alice, { ...personalInput, key: "localized-translator" });
    const document = library.exportFor(alice, personal.id);
    expect(document.format).toBe(TEMPLATE_EXPORT_FORMAT);
    expect(document.version).toBe(TEMPLATE_EXPORT_VERSION);
    expect(document.template).toMatchObject({
      key: "localized-translator",
      title: personalInput.title,
      category: "research",
      description: personalInput.description,
      brief: personalInput.brief,
      suggestedName: "翻译",
      emoji: "🌍",
      vibe: "咬文嚼字",
      workstyle: ["术语先建表，全篇保持一致。"],
      skillNames: ["humanizer", "summarize"],
    });
    expect("id" in document.template).toBe(false);
    expect("scope" in document.template).toBe(false);
    expect("ownerId" in document.template).toBe(false);
    expect(Number.isNaN(Date.parse(document.exportedAt))).toBe(false);

    const builtin = library.listBuiltin()[0]!;
    expect(() => library.exportFor(admin, builtin.id)).toThrow(/只能导出个人模板/);
    const bobs = await library.create(bob, personalInput);
    expect(() => library.exportFor(alice, bobs.id)).toThrow(/只能使用自己的个人模板/);
  });

  it("导入导出往返：兼容导出格式、裸对象与数组，标识撞车自动改名", async () => {
    const source = await library.create(alice, { ...personalInput, key: "translator" });
    const document = library.exportFor(alice, source.id);
    const content = JSON.stringify(document);

    // 同账号再导入同一份文件：标识被占，自动加序号并提示。
    const [again] = await library.importMany(alice, {
      files: [{ filename: "template-translator.json", content }],
    });
    expect(again?.ok).toBe(true);
    expect(again?.created).toHaveLength(1);
    expect(again?.created[0]?.key).toBe("translator-2");
    expect(again?.created[0]?.title).toBe(source.title);
    expect(again?.created[0]?.ownerId).toBe(alice.id);
    expect(again?.warnings[0]).toContain("已被占用");
    expect(again?.warnings[0]).toContain("translator-2");

    // 其他账号导入同一份文件：标识可用，内容原样落地。
    const [bobs] = await library.importMany(bob, {
      files: [{ filename: "template-translator.json", content }],
    });
    expect(bobs?.created[0]?.key).toBe("translator");
    expect(bobs?.created[0]?.skillNames).toEqual(["humanizer", "summarize"]);
    expect(library.listPersonal(bob.id)).toHaveLength(1);
    expect(library.listPersonal(alice.id)).toHaveLength(2);

    // 裸对象、裸数组和 { templates: [...] } 批量格式都能导入。
    const result = await library.importMany(alice, {
      files: [
        {
          filename: "bare.json",
          content: JSON.stringify({ ...document.template, key: "bare-one", title: "裸对象模板" }),
        },
        {
          filename: "array.json",
          content: JSON.stringify([{ ...document.template, key: "array-one", title: "数组模板" }]),
        },
        {
          filename: "bundle.json",
          content: JSON.stringify({ templates: [{ ...document.template, key: "bundle-one", title: "批量模板" }] }),
        },
      ],
    });
    expect(result.map((item) => item.created.map((record) => record.key))).toEqual([
      ["bare-one"],
      ["array-one"],
      ["bundle-one"],
    ]);
    expect(result.every((item) => item.ok && item.errors.length === 0)).toBe(true);

    const reloaded = new TemplateLibrary(templateFile());
    await reloaded.init();
    expect(reloaded.listPersonal(bob.id).map((record) => record.key)).toEqual(["translator"]);
    expect(reloaded.listPersonal(alice.id)).toHaveLength(5);
  });

  it("导入校验：坏文件与坏条目逐条报错，好的照样导入", async () => {
    const invalidJson = await library.importMany(alice, {
      files: [{ filename: "bad.json", content: "{ not json" }],
    });
    expect(invalidJson[0]?.ok).toBe(false);
    expect(invalidJson[0]?.errors[0]).toContain("JSON");

    const wrongFormat = await library.importMany(alice, {
      files: [{ filename: "x.json", content: JSON.stringify({ format: "other", template: personalInput }) }],
    });
    expect(wrongFormat[0]?.errors[0]).toContain("format");

    const futureVersion = await library.importMany(alice, {
      files: [
        {
          filename: "x.json",
          content: JSON.stringify({
            format: TEMPLATE_EXPORT_FORMAT,
            version: TEMPLATE_EXPORT_VERSION + 1,
            template: personalInput,
          }),
        },
      ],
    });
    expect(futureVersion[0]?.errors[0]).toContain("版本");

    const mixed = await library.importMany(alice, {
      files: [
        {
          filename: "mix.json",
          content: JSON.stringify([{ title: "" }, { ...personalInput, key: "mixed-good" }]),
        },
        { filename: "empty.json", content: "[]" },
      ],
    });
    expect(mixed[0]?.created.map((record) => record.key)).toEqual(["mixed-good"]);
    expect(mixed[0]?.ok).toBe(true);
    expect(mixed[0]?.errors[0]).toContain("模板名称");
    expect(mixed[1]?.ok).toBe(false);
    expect(mixed[1]?.errors[0]).toContain("没有模板");

    await expect(library.importMany(alice, { files: [] })).rejects.toMatchObject({ status: 400 });
    await expect(
      library.importMany(alice, {
        files: Array.from({ length: 21 }, (_, index) => ({
          filename: `${index}.json`,
          content: JSON.stringify(personalInput),
        })),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      library.importMany(alice, {
        files: [{ filename: "many.json", content: JSON.stringify(Array.from({ length: 51 }, () => personalInput)) }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    // 被拒的批量请求没有留下任何模板。
    expect(library.listPersonal(alice.id)).toHaveLength(1);
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
