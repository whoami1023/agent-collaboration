import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import KnowledgePagePreview, {
  stripFrontmatter,
  wikilinksToMarkdown,
} from "./KnowledgePagePreview";

const RAW = [
  "---",
  "type: concept",
  "title: 中心编排",
  "tags: [协同]",
  "---",
  "",
  "# 中心编排",
  "",
  "主智能体拆解任务并分派，详见 [[concepts/对等会话|对等会话]]。",
].join("\n");

describe("知识页预览", () => {
  it("剥离 frontmatter，只渲染正文", () => {
    expect(stripFrontmatter(RAW)).toContain("# 中心编排");
    expect(stripFrontmatter(RAW)).not.toContain("type: concept");
    const html = renderToStaticMarkup(
      createElement(KnowledgePagePreview, { raw: RAW, onOpen: () => undefined }),
    );
    expect(html).toContain("主智能体拆解任务并分派");
    expect(html).not.toContain("type: concept");
  });

  it("wikilink 转成可在面板内跳转的锚点", () => {
    expect(wikilinksToMarkdown("见 [[concepts/对等会话]]")).toContain(
      "(#wiki:concepts%2F%E5%AF%B9%E7%AD%89%E4%BC%9A%E8%AF%9D)",
    );
    expect(wikilinksToMarkdown("见 [[concepts/对等会话|对等会话]]")).toContain("[对等会话](#wiki:");
    const html = renderToStaticMarkup(
      createElement(KnowledgePagePreview, { raw: RAW, onOpen: () => undefined }),
    );
    expect(html).toContain("href=\"#wiki:concepts%2F%E5%AF%B9%E7%AD%89%E4%BC%9A%E8%AF%9D\"");
    expect(html).toContain(">对等会话</a>");
  });
});
