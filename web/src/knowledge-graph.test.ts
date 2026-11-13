import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeGraph } from "./api";
import KnowledgeGraphView from "./KnowledgeGraph";

function sample(): KnowledgeGraph {
  return {
    nodes: [
      {
        id: "concepts/a.md",
        title: "中心编排",
        type: "concept",
        tags: [],
        sourceCount: 1,
        degree: 2,
        community: 0,
      },
      {
        id: "entities/b.md",
        title: "OpenClaw",
        type: "entity",
        tags: [],
        sourceCount: 1,
        degree: 1,
        community: 5,
      },
      {
        id: "notes/c.md",
        title: "选型建议",
        type: "note",
        tags: [],
        sourceCount: 0,
        degree: 1,
        community: 5,
      },
    ],
    edges: [
      {
        source: "concepts/a.md",
        target: "entities/b.md",
        kind: "link",
        weight: 7,
        signals: { link: 1, source: 1, adamicAdar: 0, typeAffinity: 0 },
      },
      {
        source: "concepts/a.md",
        target: "notes/c.md",
        kind: "neighbor",
        weight: 2.5,
        signals: { link: 0, source: 0, adamicAdar: 1, typeAffinity: 1 },
      },
    ],
    communities: [
      { id: 0, label: "中心编排", size: 1, cohesion: 0, lowCohesion: false, members: ["concepts/a.md"] },
      { id: 5, label: "OpenClaw", size: 2, cohesion: 0.5, lowCohesion: false, members: ["entities/b.md", "notes/c.md"] },
    ],
    insights: [],
    truncated: false,
  };
}

describe("KnowledgeGraphView", () => {
  it("按类型着色时渲染节点、边与可访问名称", () => {
    const html = renderToStaticMarkup(
      createElement(KnowledgeGraphView, {
        graph: sample(),
        colorMode: "type",
        onOpenPage: () => undefined,
      }),
    );
    expect(html).toContain("知识图谱：3 个页面，2 条关联");
    expect(html.match(/<circle/g)).toHaveLength(3);
    expect(html.match(/<line/g)).toHaveLength(2);
    expect(html).toContain("#bd4531"); // concept
    expect(html).toContain("#2563eb"); // entity
    expect(html).toContain("中心编排");
  });

  it("按社区着色时改用社区色板，并支持高亮集合", () => {
    const html = renderToStaticMarkup(
      createElement(KnowledgeGraphView, {
        graph: sample(),
        colorMode: "community",
        highlight: { nodeIds: ["concepts/a.md"], edgeKeys: ["concepts/a.md|entities/b.md"] },
        onOpenPage: () => undefined,
      }),
    );
    expect(html).toContain("opacity=\"0.16\""); // 非高亮节点变暗
    expect(html).toContain("#0891b2"); // 社区 1 的颜色
  });
});
