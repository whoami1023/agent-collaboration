import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_SKILLS } from "../src/skills/builtin-anthropic-skills";
import { BUILTIN_SHARED_SKILLS, BUILTIN_SKILLS_VERSION } from "../src/skills/builtin";
import { builtinCategoryOf } from "../src/skills/categories";
import { SkillLibrary } from "../src/skills/library";
import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
} from "../src/skills/skill-files";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anthropic-skills-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Anthropic 内置技能", () => {
  it("只预装三个技能，来源与许可标注完整，且不与既有内置重名", () => {
    expect(ANTHROPIC_SKILLS.map((seed) => seed.name).sort()).toEqual([
      "internal-comms",
      "pdf",
      "theme-factory",
    ]);
    const allNames = BUILTIN_SHARED_SKILLS.map((seed) => seed.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    for (const seed of ANTHROPIC_SKILLS) {
      expect(seed.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(seed.source).toMatch(/^GitHub · anthropics\/skills · /);
      expect(seed.source).toContain("Apache-2.0");
      expect(seed.description.trim().length).toBeGreaterThan(0);
      expect(seed.description.length).toBeLessThanOrEqual(160);
      expect(seed.instructions.length).toBeGreaterThan(500);
      expect(seed.instructions).toContain("##");
    }
  });

  it("附带文件数量与体积都在内置技能上限内", () => {
    for (const seed of ANTHROPIC_SKILLS) {
      const files = seed.files ?? [];
      expect(files.length).toBeGreaterThan(0);
      expect(files.length).toBeLessThanOrEqual(MAX_SKILL_FILES);
      let total = 0;
      for (const file of files) {
        const bytes = Buffer.byteLength(file.content, "utf8");
        expect(bytes).toBeLessThanOrEqual(MAX_SKILL_FILE_BYTES);
        total += bytes;
      }
      expect(total).toBeLessThanOrEqual(MAX_SKILL_BUNDLE_BYTES);
    }

    const pdf = ANTHROPIC_SKILLS.find((seed) => seed.name === "pdf");
    const pdfPaths = new Set((pdf?.files ?? []).map((file) => file.path));
    expect(pdfPaths.has("scripts/check_fillable_fields.py")).toBe(true);
    expect(pdfPaths.has("scripts/fill_fillable_fields.py")).toBe(true);
    expect(pdfPaths.has("scripts/fill_pdf_form_with_annotations.py")).toBe(true);
    // 需要 poppler 渲染的脚本不预装，避免给出本机跑不通的能力
    expect(pdfPaths.has("scripts/convert_pdf_to_images.py")).toBe(false);
    expect(pdfPaths.has("scripts/create_validation_image.py")).toBe(false);

    const themes = ANTHROPIC_SKILLS.find((seed) => seed.name === "theme-factory");
    expect((themes?.files ?? []).filter((file) => file.path.startsWith("themes/"))).toHaveLength(10);

    const comms = ANTHROPIC_SKILLS.find((seed) => seed.name === "internal-comms");
    expect((comms?.files ?? []).filter((file) => file.path.startsWith("examples/"))).toHaveLength(5);
  });

  it("说明里只使用本运行时存在的工具与入口", () => {
    const pdf = ANTHROPIC_SKILLS.find((seed) => seed.name === "pdf");
    expect(pdf?.instructions).toContain("run_skill_script");
    expect(pdf?.instructions).toContain('"cwd": "."');
    expect(pdf?.instructions).toContain("file_read");
    expect(pdf?.instructions).not.toContain("Display the");

    const comms = ANTHROPIC_SKILLS.find((seed) => seed.name === "internal-comms");
    expect(comms?.instructions).toContain("read_skill_file");
    expect(comms?.instructions).toContain("file_read");
    expect(comms?.instructions).toContain("room_history");
  });

  it("启动后预装为共享技能并落到正确分类", async () => {
    expect(BUILTIN_SKILLS_VERSION).toBeGreaterThanOrEqual(10);
    const library = new SkillLibrary(join(dir, "anthropic-skills.json"));
    await library.init();
    const shared = library.listShared();
    for (const seed of ANTHROPIC_SKILLS) {
      const skill = shared.find((item) => item.name === seed.name);
      expect(skill).toBeDefined();
      expect(skill?.builtin).toBe(true);
      expect(skill?.category).toBe(builtinCategoryOf(seed.name));
      expect(skill?.files?.length).toBe(seed.files?.length);
    }
    expect(builtinCategoryOf("internal-comms")).toBe("product");
    expect(builtinCategoryOf("theme-factory")).toBe("design");
    expect(builtinCategoryOf("pdf")).toBe("research");
  });
});
