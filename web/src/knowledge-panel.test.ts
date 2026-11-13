import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import KnowledgePanel, { resolveDraftBaseId } from "./KnowledgePanel";
import type { KnowledgeBaseMeta } from "./api";

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

  it("聊天草稿优先落到指定的库，库被删后退回最近更新的库", () => {
    const bases = [
      { id: "kb_recent" },
      { id: "kb_tanzania" },
    ] as KnowledgeBaseMeta[];
    expect(resolveDraftBaseId(bases, "kb_tanzania")).toBe("kb_tanzania");
    expect(resolveDraftBaseId(bases, "kb_deleted")).toBe("kb_recent");
    expect(resolveDraftBaseId(bases)).toBe("kb_recent");
    expect(resolveDraftBaseId([], "kb_tanzania")).toBe(null);
  });
});
