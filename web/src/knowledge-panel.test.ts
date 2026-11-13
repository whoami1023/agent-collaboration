import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import KnowledgePanel from "./KnowledgePanel";

describe("KnowledgePanel", () => {
  it("没有知识库时渲染建库引导，不出现页面/队列空壳", () => {
    const html = renderToStaticMarkup(
      createElement(KnowledgePanel, {
        onClose: () => undefined,
        refreshToken: 0,
        modelChoices: [],
      }),
    );
    expect(html).toContain("知识库");
    expect(html).toContain("创建第一个知识库");
    expect(html).toContain("导入材料后");
    expect(html).not.toContain("整理队列");
  });
});
