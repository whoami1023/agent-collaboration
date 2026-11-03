import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLibrary } from "../src/skills/library";
import type { MatchableSkill } from "../src/skills/matching";
import {
  categoryScoresForText,
  selectSkillsForText,
  tokenizeForMatch,
} from "../src/skills/matching";

let dir: string;
let library: SkillLibrary;

/** 真实内置技能库（含分类），比手写桩更贴近新建成员时看到的清单。 */
function usableSkills(): MatchableSkill[] {
  return library.listForAgent("u_admin").map((skill) => ({
    name: skill.name,
    description: skill.description,
    category: skill.category,
  }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-skill-match-"));
  library = new SkillLibrary(join(dir, "skills.json"));
  await library.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tokenizeForMatch", () => {
  it("英文按词切并粗略还原单复数", () => {
    const tokens = tokenizeForMatch("Reviews APIs");
    expect(tokens).toContain("reviews");
    expect(tokens).toContain("review");
    expect(tokens).toContain("api");
    expect(tokens).not.toContain("a");
  });

  it("连字符技能名既保留整体也拆出单词", () => {
    const tokens = tokenizeForMatch("web-fetch");
    expect(tokens).toContain("web-fetch");
    expect(tokens).toContain("web");
    expect(tokens).toContain("fetch");
  });

  it("中文按二元组切，短词整词保留", () => {
    expect(tokenizeForMatch("数据")).toContain("数据");
    expect(tokenizeForMatch("帮我写一份周报")).toContain("周报");
  });

  it("丢弃英文停用词与无信息的单字", () => {
    expect(tokenizeForMatch("the and for with")).toEqual([]);
    expect(tokenizeForMatch("a 猫")).toEqual([]);
  });
});

describe("categoryScoresForText", () => {
  it("一句话对各分类的倾向有强有弱", () => {
    const scores = categoryScoresForText("抓取网页正文，顺便做个报表");
    expect((scores.get("web") ?? 0) > (scores.get("data") ?? 0)).toBe(true);
  });

  it("与技能无关的描述没有任何分类倾向", () => {
    expect(categoryScoresForText("替我盯着咖啡机").size).toBe(0);
  });
});

describe("selectSkillsForText", () => {
  it("联网调研类描述只挑对口的几个技能", () => {
    const skills = usableSkills();
    const picked = selectSkillsForText(
      "负责联网搜索资料，抓取网页正文，给出带引用的调研结论",
      skills,
    );
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.length).toBeLessThan(skills.length);
    expect(picked).toEqual(expect.arrayContaining(["web-search", "web-fetch", "web-browse"]));
  });

  it("开发类描述不会带出联网或文档技能", () => {
    const picked = selectSkillsForText("审查代码、排查缺陷、补测试并设计接口", usableSkills());
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.filter((name) => ["web-search", "docx-writer"].includes(name))).toEqual([]);
    expect(picked).toContain("code-review");
  });

  it("结果数量可控", () => {
    const picked = selectSkillsForText("分析数据、做统计报表和指标看板", usableSkills(), { max: 3 });
    expect(picked.length).toBeLessThanOrEqual(3);
  });

  it("描述里点名技能时优先选中它", () => {
    expect(selectSkillsForText("就用 docx-writer 写文档", usableSkills())[0]).toBe("docx-writer");
  });

  it("完全无关的描述返回空数组，交给调用方决定", () => {
    expect(selectSkillsForText("替我盯着咖啡机温度", usableSkills())).toEqual([]);
    expect(selectSkillsForText("", usableSkills())).toEqual([]);
    expect(selectSkillsForText("代码审查", [])).toEqual([]);
  });
});
