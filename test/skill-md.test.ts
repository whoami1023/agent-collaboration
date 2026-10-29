import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_MD_BYTES,
  parseFrontmatterBlock,
  parseSkillMarkdown,
  skillNameFromFile,
  SkillMarkdownError,
  stripFrontmatterBlock,
} from "../src/skills/skill-md";

describe("SKILL.md frontmatter 解析", () => {
  it("读取 name / description，正文作为技能说明", () => {
    const parsed = parseSkillMarkdown(
      ["---", "name: pdf-forms", 'description: "填好 PDF 表单"', "user-invocable: false", "---", "", "# 步骤", "1. 打开文件"].join("\n"),
      { filename: "pdf-forms/SKILL.md" },
    );
    expect(parsed.name).toBe("pdf-forms");
    expect(parsed.description).toBe("填好 PDF 表单");
    expect(parsed.userInvocable).toBe(false);
    expect(parsed.modelInvocable).toBe(true);
    expect(parsed.instructions).toBe("# 步骤\n1. 打开文件");
    expect(parsed.warnings).toEqual([]);
  });

  it("缺 name 时回退到技能目录名，缺 description 才报错", () => {
    const fallback = parseSkillMarkdown("---\ndescription: 只做兜底\n---\n正文", {
      filename: "weekly-report/SKILL.md",
    });
    expect(fallback.name).toBe("weekly-report");
    expect(() => parseSkillMarkdown("---\nname: only-name\n---\n正文")).toThrow(SkillMarkdownError);
    expect(() => parseSkillMarkdown("---\nname: only-name\n---\n正文")).toThrow(
      /description is required/,
    );
    expect(() => parseSkillMarkdown("---\ndescription: 只有描述\n---\n正文")).toThrow(
      /name is required/,
    );
  });

  it("没有 frontmatter 的普通 Markdown 不是技能；文件名只做 name 的兜底", () => {
    expect(() => parseSkillMarkdown("# 只是 Markdown", { filename: "notes.md" })).toThrow(
      /description is required/,
    );
    expect(skillNameFromFile("skills/PDF Forms/SKILL.md")).toBe("pdf-forms");
    expect(skillNameFromFile("SKILL.md")).toBe("skill");
    expect(skillNameFromFile("")).toBe("");
  });

  it("含冒号的描述不再让整份 frontmatter 报废（OpenClaw 的恢复策略）", () => {
    const parsed = parseSkillMarkdown(
      [
        "---",
        "name: colon-case",
        "description: 结论先行: 三段式周报, 关注: 风险",
        "homepage: https://example.com/a",
        "---",
        "",
        "正文",
      ].join("\n"),
    );
    expect(parsed.description).toBe("结论先行: 三段式周报, 关注: 风险");
    expect(parsed.homepage).toBe("https://example.com/a");
  });

  it("frontmatter 未闭合会报错，而不是把正文当成元数据", () => {
    expect(() => parseSkillMarkdown("---\nname: broken\ndescription: x\n\n正文")).toThrow(
      /UNTERMINATED_FRONTMATTER/,
    );
  });

  it("metadata 里的 requires / install 变成导入警告，而不是被丢掉", () => {
    const parsed = parseSkillMarkdown(
      [
        "---",
        "name: needs-shell",
        "description: 需要本机工具",
        'metadata: {"openclaw":{"requires":{"bins":["rg"]},"install":[{"kind":"brew","formula":"ripgrep"}]}}',
        "---",
        "",
        "正文",
      ].join("\n"),
    );
    expect(parsed.warnings.join("\n")).toContain("宿主机工具");
  });

  it("disable-model-invocation 会提示只能用户显式调用", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: manual\ndescription: x\ndisable-model-invocation: true\n---\n\n正文",
    );
    expect(parsed.modelInvocable).toBe(false);
    expect(parsed.warnings.join("\n")).toContain("disable-model-invocation");
  });

  it("空正文、空内容、超过 256 KB 都会拒绝", () => {
    expect(() => parseSkillMarkdown("")).toThrow(SkillMarkdownError);
    expect(() => parseSkillMarkdown("---\nname: a\ndescription: b\n---\n\n  \n")).toThrow(
      /正文为空/,
    );
    const huge = `---\nname: a\ndescription: b\n---\n\n${"x".repeat(MAX_SKILL_MD_BYTES)}`;
    expect(() => parseSkillMarkdown(huge)).toThrow(/256 KB/);
  });

  it("stripFrontmatterBlock 兼容 CRLF 与 BOM", () => {
    const body = stripFrontmatterBlock("\ufeff---\r\nname: a\r\ndescription: b\r\n---\r\r\n# 标题\r\n内容");
    expect(body).toBe("# 标题\n内容");
  });

  it("注释值不会被行兜底解析救回来", () => {
    const parsed = parseFrontmatterBlock("---\nname: # 只是注释\ndescription: 真描述\n---\n\n正文");
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter["name"]).toBeUndefined();
    expect(parsed.frontmatter["description"]).toBe("真描述");
  });
});
