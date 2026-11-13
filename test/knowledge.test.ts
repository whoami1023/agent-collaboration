// 知识库：路径与 frontmatter 纯函数、两阶段摄入、队列恢复/重试、检索/体检/图谱。
// 模型调用走注入的 MockHandler：分析阶段返回严格 JSON，撰写阶段返回 FILE 块。

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/core/settings";
import type { MockHandler, MockTurn } from "../src/provider/mock";
import { KnowledgeService } from "../src/knowledge/service";
import { KnowledgeStore } from "../src/knowledge/store";
import { WorkspaceFiles } from "../src/files/workspace-files";
import {
  normalizeWikiPath,
  pagePathOf,
  slugify,
} from "../src/knowledge/paths";
import {
  normalizePage,
  parseFrontmatter,
  serializePage,
} from "../src/knowledge/frontmatter";
import {
  buildGraph,
  extractJsonObject,
  lintWiki,
  parseFileBlocks,
  searchPages,
  summarizeCommunities,
} from "../src/knowledge/wiki";
import { buildKnowledgeTools } from "../src/agent/knowledge-tools";
import type { KnowledgeServiceDeps } from "../src/knowledge/service";
import type {
  KnowledgeGraphEdge,
  KnowledgePageMeta,
  KnowledgeSnapshot,
} from "../src/knowledge/types";

let dir: string;
let service: KnowledgeService | null = null;

function settings(): ReturnType<typeof defaultSettings> {
  return defaultSettings();
}

function modelDeps(handler: MockHandler) {
  return { settings: settings(), mockHandler: handler, dataDir: dir };
}

function analysisHandler(
  onGeneration: (request: Parameters<MockHandler>[0]) => MockTurn,
  analysisFails = false,
): MockHandler {
  return (request) => {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    if (system.includes("结构化分析器")) {
      if (analysisFails) throw new Error("分析阶段模拟失败");
      const sourceId = /src_[0-9a-f]{12}/.exec(user)?.[0] ?? "src_000000000000";
      return {
        text: JSON.stringify({
          summary: "材料对比了中心编排与对等会话两种协同方式，结论是交付型任务优先中心编排。",
          key_points: ["中心编排的交付路径唯一", "对等会话适合讨论不适合交付"],
          entities: [],
          concepts: [{ name: "中心编排", note: "主智能体分派、成员回报" }],
          uncertainties: ["样本只覆盖两个框架"],
          pages: [
            {
              path: "concepts/中心编排.md",
              type: "concept",
              title: "中心编排",
              tags: ["协同"],
              related: [],
              action: "create",
              brief: "解释中心编排的适用场景",
            },
            {
              path: `sources/source-${sourceId.slice(4)}.md`,
              type: "source",
              title: "演示材料",
              tags: ["来源摘要"],
              related: [],
              action: "create",
              brief: "来源摘要",
            },
          ],
        }),
      };
    }
    return onGeneration(request);
  };
}

function generationText(request: Parameters<MockHandler>[0]): string {
  const user = request.messages.find((message) => message.role === "user")?.content ?? "";
  const sourceId = /src_[0-9a-f]{12}/.exec(user)?.[0] ?? "src_000000000000";
  const summaryPath = `sources/source-${sourceId.slice(4)}.md`;
  return [
    "---FILE: concepts/中心编排.md---",
    "---",
    "type: concept",
    "title: 中心编排",
    "tags: [协同]",
    `related: [${summaryPath}]`,
    `sources: [${sourceId}]`,
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "# 中心编排",
    "",
    "主智能体拆解任务并分派，成员只对分内任务回报，交付路径唯一。",
    `相关来源见 [[${summaryPath}]]。`,
    "---END FILE---",
  ].join("\n");
}

async function until(predicate: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function makeService(
  handler: MockHandler,
  extra: Partial<KnowledgeServiceDeps> = {},
): Promise<KnowledgeService> {
  const deps: KnowledgeServiceDeps = {
    dir,
    getSettings: settings,
    getModelDeps: () => modelDeps(handler),
    ...extra,
  };
  const instance = new KnowledgeService(deps);
  await instance.load();
  service = instance;
  return instance;
}

async function waitForReady(instance: KnowledgeService, kbId: string): Promise<KnowledgeSnapshot> {
  let snapshot = await instance.snapshot(kbId);
  await until(async () => {
    snapshot = await instance.snapshot(kbId);
    // 来源状态先于索引落盘：等到索引也重建完，避免读到「已整理但索引为空」的中间态。
    return (
      snapshot.sources.every(
        (source) => source.status === "ready" || source.status === "failed",
      ) && snapshot.index.length > 0
    );
  }, "摄入完成");
  return snapshot;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-knowledge-"));
});

afterEach(async () => {
  await service?.close();
  service = null;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("知识库纯函数", () => {
  it("slugify 保留中文与字母数字，其余折叠为连字符", () => {
    expect(slugify("Hello, 世界! OpenClaw v2")).toBe("hello-世界-openclaw-v2");
    expect(slugify("...")).toBe("page");
  });

  it("normalizeWikiPath 拒绝越界与隐藏路径，并补 .md", () => {
    expect(normalizeWikiPath("wiki/concepts/测试")).toBe("wiki/concepts/测试.md");
    expect(pagePathOf("wiki/entities/openclaw.md")).toBe("entities/openclaw.md");
    expect(() => normalizeWikiPath("notes/../x.md")).toThrow();
    expect(() => normalizeWikiPath(".hidden/x.md")).toThrow();
    // 前导斜杠按相对路径归一化（把「看起来像绝对路径」的输入收进 wiki/），盘符路径则拒绝。
    expect(normalizeWikiPath("/abs/path.md")).toBe("wiki/abs/path.md");
    expect(() => normalizeWikiPath("C:/abs/path.md")).toThrow();
    expect(() => normalizeWikiPath("only-page.md")).toThrow();
  });

  it("frontmatter 解析与稳定序列化可往返", () => {
    const raw = [
      "---",
      "type: concept",
      "title: 上下文预算",
      "tags: [预算, 上下文]",
      "related: []",
      "sources: [src_0123456789ab]",
      "created: 2026-01-01",
      "updated: 2026-01-02",
      "---",
      "",
      "正文第一段。",
    ].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data["type"]).toBe("concept");
    const { meta, body } = normalizePage(raw, { path: "concepts/上下文预算.md", today: "2026-01-02" });
    expect(meta.title).toBe("上下文预算");
    const serialized = serializePage(meta, body);
    const roundtrip = normalizePage(serialized, { path: "concepts/上下文预算.md", today: "2026-01-02" });
    expect(serializePage(roundtrip.meta, roundtrip.body)).toBe(serialized);
  });

  it("FILE 块解析容忍缺失结束标记与围栏 JSON", () => {
    const blocks = parseFileBlocks(
      [
        "---FILE: concepts/a.md---",
        "# A",
        "---END FILE---",
        "---FILE: concepts/b.md---",
        "# B",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.path)).toEqual(["concepts/a.md", "concepts/b.md"]);
    expect(blocks[1]?.content).toContain("# B");

    const json = extractJsonObject('计划如下：\n```json\n{"summary":"x","pages":[]}\n```');
    expect(json["summary"]).toBe("x");
  });

  it("中文检索按双字切分命中，断链/孤立页/未索引会被体检报出", () => {
    const pages = [
      normalizePage(
        ["---", "type: concept", "title: 协同调度", "tags: [调度]", "related: []", "sources: [src_0123456789ab]", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "中心编排让交付路径唯一，成员只对分内任务回报。"].join("\n"),
        { path: "concepts/协同调度.md", today: "2026-01-01" },
      ),
      normalizePage(
        ["---", "type: note", "title: 孤立页", "tags: []", "related: []", "sources: [src_0123456789ab]", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "这里链接到 [[concepts/不存在的页面]]，而且正文足够长以便通过短页检查。"].join("\n"),
        { path: "notes/孤立页.md", today: "2026-01-01" },
      ),
    ].map((entry) => ({
      ...entry.meta,
      summary: "",
      body: entry.body,
      raw: "",
      hasFrontmatter: true,
    }));

    const hits = searchPages(pages, "协同调度", 5);
    expect(hits[0]?.path).toBe("concepts/协同调度.md");

    const report = lintWiki({
      pages,
      sources: [],
      indexText: "## 概念\n- [[concepts/协同调度]]｜协同调度\n",
      today: "2026-01-01",
    });
    const kinds = report.issues.map((issue) => issue.kind);
    expect(kinds).toContain("broken-link");
    expect(kinds).toContain("orphan");
    expect(kinds).toContain("unindexed");

    const graph = buildGraph(pages);
    expect(graph.nodes.map((node) => node.id)).toContain("concepts/协同调度.md");
  });
});

describe("知识库服务与摄入队列", () => {
  it("建库、两阶段摄入、摘要兜底页、索引/日志/检索/图谱", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "协同框架", description: "调研资料" });
    expect(base.id).toMatch(/^kb_[0-9a-f]{12}$/);
    expect(await instance.listBases()).toHaveLength(1);

    const { source } = await instance.addSource(base.id, {
      title: "演示材料",
      content: "# 演示\n\n中心编排把分派与回报分开记录，交付路径唯一。对等会话适合讨论。",
    });
    expect(source.status).toBe("queued");

    const snapshot = await waitForReady(instance, base.id);
    expect(snapshot.sources[0]?.status).toBe("ready");
    expect(snapshot.queue[0]?.state).toBe("done");
    expect(snapshot.sources[0]?.summaryPath).toMatch(/^sources\/source-[0-9a-f]{12}\.md$/);
    expect(snapshot.pages.map((page) => page.path).sort()).toEqual([
      "concepts/中心编排.md",
      snapshot.sources[0]!.summaryPath!,
    ]);
    const concept = snapshot.pages.find((page) => page.path === "concepts/中心编排.md");
    expect(concept?.type).toBe("concept");
    expect(concept?.sources).toContain(source.id);
    expect(snapshot.index).toContain("中心编排");
    expect(snapshot.index).toContain("来源");
    expect(snapshot.index).toContain("已整理");
    expect(snapshot.index).not.toContain("整理中");
    expect(snapshot.overview).toContain("已整理 1 份");
    expect(snapshot.log).toContain("演示材料");
    expect(snapshot.base.pageCount).toBe(2);
    expect(snapshot.base.sourceCount).toBe(1);
    expect(snapshot.base.pendingCount).toBe(0);

    const hits = await instance.search("中心编排");
    expect(hits[0]).toMatchObject({ baseId: base.id, path: "concepts/中心编排.md" });

    const lint = await instance.lint(base.id);
    expect(lint.issues.filter((issue) => issue.severity === "error")).toEqual([]);

    const graph = await instance.graph(base.id);
    expect(graph.nodes).toHaveLength(2);
    // 两页既直接互链又共享来源：链接信号 3 + 来源信号 4（类型不同，无同类加分）。
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.signals).toMatchObject({ link: 1, source: 1, typeAffinity: 0 });
    expect(graph.edges[0]?.weight).toBe(7);

    const summary = await instance.summary();
    expect(summary).toContain("协同框架");
    expect(summary).toContain("中心编排");
  });

  it("重复材料返回 409；页面可新建、编辑与删除", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "资料库" });
    await instance.addSource(base.id, { title: "材料", content: "同一份材料" });
    await expect(instance.addSource(base.id, { title: "材料副本", content: "同一份材料" })).rejects.toMatchObject({
      status: 409,
    });

    const page = await instance.writePage(
      base.id,
      "notes/手写笔记.md",
      ["---", "type: note", "title: 手写笔记", "tags: []", "related: []", "sources: []", "---", "", "手动整理的正文。"].join("\n"),
    );
    expect(page.path).toBe("notes/手写笔记.md");
    expect((await instance.readPageForEdit(base.id, page.path)).raw).toContain("手动整理的正文");

    const moved = await instance.writePage(
      base.id,
      "notes/手写笔记.md",
      ["---", "type: concept", "title: 手写笔记", "tags: []", "related: []", "sources: []", "---", "", "类型改成概念后应移动到 concepts/。"].join("\n"),
    );
    expect(moved.path).toBe("concepts/手写笔记.md");
    await expect(instance.readPage(base.id, "notes/手写笔记.md")).rejects.toMatchObject({ status: 404 });

    await instance.deletePage(base.id, moved.path);
    await expect(instance.readPage(base.id, moved.path)).rejects.toMatchObject({ status: 404 });
  });

  it("摄入失败进入队列，重试后成功；load 把中断的 running 放回 queued", async () => {
    let generationShouldFail = true;
    const instance = await makeService(
      analysisHandler((request) => {
        if (generationShouldFail) throw new Error("撰写阶段模拟失败");
        return { text: generationText(request) };
      }),
    );
    const base = await instance.createBase({ name: "重试库" });
    const { queueItem } = await instance.addSource(base.id, { title: "材料", content: "需要重试的材料内容。" });

    await until(async () => {
      const snapshot = await instance.snapshot(base.id);
      // 队列状态先于来源状态写回：两个都落定后再断言。
      return (
        snapshot.queue.find((item) => item.id === queueItem.id)?.state === "failed" &&
        snapshot.sources[0]?.status === "failed"
      );
    }, "首次摄入失败");
    let snapshot = await instance.snapshot(base.id);
    expect(snapshot.queue[0]?.error).toContain("撰写阶段模拟失败");
    expect(snapshot.sources[0]?.status).toBe("failed");

    generationShouldFail = false;
    await instance.retryQueue(base.id, queueItem.id);
    snapshot = await waitForReady(instance, base.id);
    expect(snapshot.queue[0]?.state).toBe("done");
    expect(snapshot.queue[0]?.attempts).toBe(1);

    // 模拟进程中断：把队列项与来源状态改回 running/ingesting，重新 load 应放回 queued。
    const store = new KnowledgeStore(dir, { today: () => "2026-01-01" });
    const queue = await store.readQueue(base.id);
    queue[0]!.state = "running";
    await store.writeQueue(base.id, queue);
    const sources = await store.readSourceIndex(base.id);
    sources[0]!.status = "ingesting";
    await store.writeSourceIndex(base.id, sources);
    await instance.load();
    expect((await store.readQueue(base.id))[0]?.state).toBe("queued");
    expect((await store.readSourceIndex(base.id))[0]?.status).toBe("queued");
  });

  it("智能体工具：knowledge_list 能看到库与页面，knowledge_read 能读全文", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "工具库", description: "给智能体用" });
    await instance.addSource(base.id, { title: "材料", content: "工具检索用的材料。" });
    await waitForReady(instance, base.id);

    const tools = buildKnowledgeTools(instance);
    expect(tools.map((tool) => tool.schema.name)).toEqual([
      "knowledge_search",
      "knowledge_read",
      "knowledge_list",
    ]);

    const list = await tools[2]!.execute({}, new AbortController().signal);
    expect(list).toContain("工具库");

    const hits = await tools[0]!.execute({ query: "中心编排", base: "工具库" }, new AbortController().signal);
    expect(hits).toContain("concepts/中心编排.md");

    const read = await tools[1]!.execute(
      { path: "concepts/中心编排.md", base: base.id },
      new AbortController().signal,
    );
    expect(read).toContain("主智能体拆解任务并分派");
  });

  it("运行中的摄入可取消：中止模型调用后队列项记为 cancelled，来源可重试", async () => {
    const blocking: MockHandler = (request) =>
      new Promise<MockTurn>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const instance = await makeService(blocking);
    const base = await instance.createBase({ name: "取消库" });
    const { queueItem } = await instance.addSource(base.id, {
      title: "慢材料",
      content: "这条材料的整理会被取消。",
    });

    await until(async () => {
      const snapshot = await instance.snapshot(base.id);
      return snapshot.queue.find((item) => item.id === queueItem.id)?.state === "running";
    }, "队列项开跑");
    await instance.cancelQueue(base.id, queueItem.id);

    await until(async () => {
      const current = await instance.snapshot(base.id);
      return current.queue[0]?.state === "cancelled" && current.sources[0]?.status === "failed";
    }, "取消状态落盘");
    const snapshot = await instance.snapshot(base.id);
    expect(snapshot.queue[0]?.state).toBe("cancelled");
    expect(snapshot.sources[0]?.status).toBe("failed");
    expect(snapshot.sources[0]?.error).toContain("已取消");
    expect(snapshot.base.pendingCount).toBe(0);
  });

  it("删库会中止在跑的摄入，worker 不会把目录重建出来", async () => {
    const blocking: MockHandler = (request) =>
      new Promise<MockTurn>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const instance = await makeService(blocking);
    const base = await instance.createBase({ name: "待删库" });
    await instance.addSource(base.id, { title: "慢材料", content: "删库时仍在整理的材料。" });
    await until(async () => {
      const snapshot = await instance.snapshot(base.id);
      return snapshot.queue[0]?.state === "running";
    }, "队列项开跑");

    await instance.deleteBase(base.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      readFile(join(dir, "knowledge", base.id, "meta.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await instance.listBases()).toEqual([]);
  });

  it("删除来源会清理原始材料，但保留已生成的 wiki 页面", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "清理库" });
    const { source } = await instance.addSource(base.id, { title: "材料", content: "会被删除的材料。" });
    const snapshot = await waitForReady(instance, base.id);
    const rawPath = join(dir, "knowledge", base.id, source.rawPath);
    expect(await readFile(rawPath, "utf8")).toContain("会被删除的材料");

    await instance.removeSource(base.id, source.id);
    const after = await instance.snapshot(base.id);
    expect(after.sources).toHaveLength(0);
    expect(after.pages.some((page) => page.path === "concepts/中心编排.md")).toBe(true);
    await expect(readFile(rawPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function graphPage(
  path: string,
  type: KnowledgePageMeta["type"],
  title: string,
  links: string[],
  sources: string[] = [],
): KnowledgePageMeta {
  return {
    path,
    type,
    title,
    tags: [],
    related: [],
    sources,
    created: "2026-01-01",
    updated: "2026-01-01",
    links,
    size: 100,
  };
}

function edgeWeightOf(
  graph: ReturnType<typeof buildGraph>,
  a: string,
  b: string,
): KnowledgeGraphEdge | undefined {
  return graph.edges.find(
    (edge) =>
      (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a),
  );
}

describe("四信号图谱与社区洞察", () => {
  it("直接链接 3、共享来源 4、同类型 1；Adamic-Adar 只在共同邻居上计分", () => {
    const pages = [
      graphPage("concepts/a.md", "concept", "A", ["concepts/b.md"], ["src_000000000001"]),
      graphPage("concepts/b.md", "concept", "B", ["concepts/a.md", "concepts/c.md"], ["src_000000000001"]),
      graphPage("concepts/c.md", "concept", "C", ["concepts/b.md"]),
    ];
    const graph = buildGraph(pages);

    const ab = edgeWeightOf(graph, "concepts/a.md", "concepts/b.md")!;
    expect(ab.kind).toBe("link");
    expect(ab.signals).toEqual({ link: 1, source: 1, adamicAdar: 0, typeAffinity: 1 });
    expect(ab.weight).toBe(8); // 3 + 4 + 0 + 1

    const ac = edgeWeightOf(graph, "concepts/a.md", "concepts/c.md")!;
    expect(ac.kind).toBe("neighbor");
    expect(ac.signals).toMatchObject({ link: 0, source: 0, typeAffinity: 1 });
    // B 的度数为 2，单个共同邻居贡献 1/ln2 > 1，被归一化封顶为 1。
    expect(ac.signals.adamicAdar).toBe(1);
    expect(ac.weight).toBe(2.5); // 1.5 + 1

    expect(graph.nodes.find((node) => node.id === "concepts/a.md")?.degree).toBe(2);
    expect(graph.communities).toHaveLength(1);
    expect(graph.communities[0]?.size).toBe(3);
  });

  it("Louvain 分开高内聚集群，并给出意外关联、桥接与孤立页洞察", () => {
    const group = (
      prefix: string,
      type: KnowledgePageMeta["type"],
      source: string,
    ): KnowledgePageMeta[] => {
      const paths = ["a", "b", "c"].map((suffix) => `${prefix}/${suffix}.md`);
      return paths.map((path, index) =>
        graphPage(
          path,
          type,
          path,
          [paths[(index + 1) % 3]!, paths[(index + 2) % 3]!],
          [source],
        ),
      );
    };
    const pages = [
      ...group("concepts", "concept", "src_000000000101"),
      ...group("entities", "entity", "src_000000000102"),
      ...group("notes", "note", "src_000000000103"),
      // 桥：concepts/a 同时连到另外两个集群。
      graphPage("concepts/a.md", "concept", "A", [
        "concepts/b.md",
        "concepts/c.md",
        "entities/a.md",
        "notes/a.md",
      ], ["src_000000000101"]),
      // 孤立页：没有链接、来源也不与他人共享。
      graphPage("notes/isolated.md", "note", "孤立页", [], ["src_000000000104"]),
    ];

    const graph = buildGraph(pages);
    expect(graph.communities.length).toBeGreaterThanOrEqual(3);
    const communityOf = new Map(graph.nodes.map((node) => [node.id, node.community]));
    expect(communityOf.get("concepts/a.md")).not.toBe(communityOf.get("entities/a.md"));
    expect(communityOf.get("concepts/a.md")).not.toBe(communityOf.get("notes/a.md"));

    expect(
      graph.insights.some(
        (insight) =>
          insight.kind === "surprising" &&
          insight.nodeIds.includes("concepts/a.md") &&
          (insight.nodeIds.includes("entities/a.md") || insight.nodeIds.includes("notes/a.md")),
      ),
    ).toBe(true);
    expect(
      graph.insights.some(
        (insight) => insight.kind === "bridge" && insight.nodeIds.includes("concepts/a.md"),
      ),
    ).toBe(true);
    expect(
      graph.insights.some(
        (insight) => insight.kind === "orphan" && insight.nodeIds.includes("notes/isolated.md"),
      ),
    ).toBe(true);
    expect(
      graph.insights.every(
        (insight) => insight.title.length > 0 && insight.detail.length > 0,
      ),
    ).toBe(true);
  });

  it("低内聚社区（内部边 / 可能边 < 0.15）标记 lowCohesion", () => {
    const pages = ["a", "b", "c", "d", "e"].map((name) =>
      graphPage(`notes/${name}.md`, "note", name, []),
    );
    const edge: KnowledgeGraphEdge = {
      source: "notes/a.md",
      target: "notes/b.md",
      kind: "neighbor",
      weight: 1,
      signals: { link: 0, source: 0, adamicAdar: 1, typeAffinity: 0 },
    };
    const communities = summarizeCommunities(
      pages,
      [edge],
      new Map(pages.map((page) => [page.path, 0])),
    );
    expect(communities).toHaveLength(1);
    expect(communities[0]?.size).toBe(5);
    expect(communities[0]?.cohesion).toBe(0.1);
    expect(communities[0]?.lowCohesion).toBe(true);
  });
});

function simplePage(
  type: KnowledgePageMeta["type"],
  title: string,
  body: string,
  sources: string[] = [],
): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    "tags: []",
    "related: []",
    `sources: [${sources.map((id) => JSON.stringify(id)).join(", ")}]`,
    "---",
    "",
    body,
  ].join("\n");
}

describe("混合检索与链接补全", () => {
  it("关键词无命中时用向量召回，命中带 via=vector", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })), {
      // 假 embedding：含“调度/中心/并发”的文本落在第一维，其它落在第二维。
      embedder: async ({ texts }) => ({
        vectors: texts.map((text) =>
          /调度|中心|并发/.test(text) ? [1, 0] : [0, 1],
        ),
        tokens: texts.length * 5,
      }),
    });
    const base = await instance.createBase({ name: "混合库", embeddingRef: "demo/mock" });
    await instance.writePage(
      base.id,
      "concepts/中心编排.md",
      simplePage("concept", "中心编排", "主智能体拆解任务并分派，交付路径唯一。"),
    );
    await instance.writePage(
      base.id,
      "concepts/缓存.md",
      simplePage("concept", "缓存", "缓存把重复计算的结果留在本地。"),
    );

    const result = await instance.searchDetailed("并发", base.id, { expand: false });
    expect(result.mode).toBe("hybrid");
    expect(result.warning).toBeUndefined();
    expect(result.hits[0]?.path).toBe("concepts/中心编排.md");
    expect(result.hits[0]?.via).toContain("vector");
    expect(result.hits.some((hit) => hit.path === "concepts/缓存.md")).toBe(false);
  });

  it("没有 embedding 配置时关键词检索照常工作", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "纯关键词库" });
    await instance.writePage(
      base.id,
      "concepts/调度.md",
      simplePage("concept", "调度", "调度方式决定谁先动手。"),
    );
    const result = await instance.searchDetailed("调度", base.id, { expand: false });
    expect(result.mode).toBe("keyword");
    expect(result.hits[0]?.via).toEqual(["keyword"]);
  });

  it("以命中页为种子做图谱扩展，第二页标 via=graph", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "扩展库" });
    await instance.writePage(
      base.id,
      "concepts/调度.md",
      simplePage("concept", "调度", "调度方式决定谁先动手，交付路径要唯一。", ["src_0000000000aa"]),
    );
    await instance.writePage(
      base.id,
      "notes/相关笔记.md",
      simplePage("note", "相关笔记", "补充笔记，细节在别处。", ["src_0000000000aa"]),
    );
    const result = await instance.searchDetailed("调度方式", base.id);
    expect(result.mode).toBe("keyword+graph");
    const related = result.hits.find((hit) => hit.path === "notes/相关笔记.md");
    expect(related?.via).toContain("graph");
  });

  it("链接补全先出提案，应用后正文出现 wikilink 且索引重建", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "补链库" });
    await instance.writePage(
      base.id,
      "concepts/中心编排.md",
      simplePage("concept", "中心编排", "中心编排适合交付型任务。"),
    );
    await instance.writePage(
      base.id,
      "notes/对比笔记.md",
      simplePage("note", "对比笔记", "中心编排与对等会话的区别见下方表格。\n\n```\n中心编排 代码块里的词不应被链接\n```"),
    );

    const dry = await instance.enrichLinks(base.id);
    expect(dry.applied).toBe(0);
    const proposal = dry.proposals.find(
      (item) => item.pagePath === "notes/对比笔记.md" && item.targetPath === "concepts/中心编排.md",
    );
    expect(proposal?.alias).toBe("中心编排");
    expect(proposal?.snippet).toContain("中心编排");

    const applied = await instance.enrichLinks(base.id, { apply: true });
    expect(applied.applied).toBeGreaterThanOrEqual(1);
    const page = await instance.readPageForEdit(base.id, "notes/对比笔记.md");
    expect(page.raw).toContain("[[concepts/中心编排|中心编排]]");
    expect(page.raw).toContain("```\n中心编排 代码块里的词不应被链接\n```");
    const snapshot = await instance.snapshot(base.id);
    expect(snapshot.log).toContain("链接补全");
  });
});

describe("第二批：审核、深度研究、文件夹导入", () => {
  it("摄入产出审核项，可跳过或按建议建页", async () => {
    const handler: MockHandler = (request) => {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      if (system.includes("结构化分析器")) {
        return {
          text: JSON.stringify({
            summary: "材料给出了中心编排的结论，但缺少对等会话的成本数据。",
            key_points: ["中心编排交付路径唯一"],
            entities: [],
            concepts: [],
            uncertainties: [],
            pages: [],
            reviews: [
              {
                kind: "research",
                title: "缺少对等会话的成本数据",
                reason: "结论需要成本对比支撑",
                query: "多智能体 对等会话 成本",
              },
              {
                kind: "create-page",
                title: "中心编排适用边界",
                reason: "现有页面没有写清不适用场景",
                query: "",
              },
            ],
          }),
        };
      }
      return { text: generationText(request) };
    };
    const instance = await makeService(handler);
    const base = await instance.createBase({ name: "审核库" });
    await instance.addSource(base.id, { title: "材料", content: "中心编排交付路径唯一。" });
    await waitForReady(instance, base.id);

    const snapshot = await instance.snapshot(base.id);
    expect(snapshot.reviews.filter((item) => item.status === "pending")).toHaveLength(2);
    const researchReview = snapshot.reviews.find((item) => item.kind === "research")!;
    const pageReview = snapshot.reviews.find((item) => item.kind === "create-page")!;

    const skipped = await instance.resolveReview(base.id, researchReview.id, "skip");
    expect(skipped.status).toBe("skipped");

    const reviewed = await instance.resolveReview(base.id, pageReview.id, "create-page");
    expect(reviewed.status).toBe("done");
    expect(reviewed.pagePath).toMatch(/^notes\/审核-/);
    const page = await instance.readPage(base.id, reviewed.pagePath!);
    expect(page.title).toBe("中心编排适用边界");

    // 已处理的审核项不能重复处理。
    await expect(instance.resolveReview(base.id, pageReview.id, "skip")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("深度研究：检索 → 抓取正文 → 组成来源并进入摄入队列", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })), {
      web: {
        search: async (query) => ({
          results: [
            { title: "协同成本报告", url: "https://example.com/cost", snippet: `关于 ${query} 的成本` },
            { title: "第二篇", url: "https://example.com/two", snippet: "补充材料" },
          ],
        }),
        fetchPage: async (url) => ({
          title: "协同成本报告",
          text: `正文内容：${url} 给出了对等会话的成本构成与样本局限。`,
          finalUrl: url,
        }),
      },
    });
    const base = await instance.createBase({ name: "研究库" });
    const result = await instance.research(base.id, {
      topic: "对等会话成本",
      queries: ["multi agent cost"],
    });
    expect(result.queries).toEqual(["multi agent cost"]);
    expect(result.documents).toBeGreaterThanOrEqual(1);
    expect(result.queueItem.state).toBe("queued");

    const snapshot = await waitForReady(instance, base.id);
    expect(snapshot.sources[0]?.title).toBe("深度研究：对等会话成本");
    const raw = await readFile(
      join(dir, "knowledge", base.id, snapshot.sources[0]!.rawPath),
      "utf8",
    );
    expect(raw).toContain("https://example.com/cost");
    expect(raw).toContain("成本构成");
    expect(snapshot.pages.some((page) => page.type === "source")).toBe(true);
  });

  it("文件夹导入保留相对路径，跳过重复与不支持的文件", async () => {
    await mkdir(join(dir, "files", "docs"), { recursive: true });
    await writeFile(join(dir, "files", "docs", "a.md"), "# A\n\n中心编排把分派与回报分开记录。", "utf8");
    await writeFile(join(dir, "files", "docs", "b.txt"), "缓存把重复计算留在本地。", "utf8");
    await writeFile(join(dir, "files", "docs", "c.pdf"), "%PDF-1.4", "utf8");
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })), {
      files: new WorkspaceFiles(dir),
    });
    const base = await instance.createBase({ name: "文件夹库" });
    const first = await instance.importFolder(base.id, { dir: "docs" });
    expect(first.added).toHaveLength(2);
    expect(first.unsupported.some((item) => item.path === "docs/c.pdf")).toBe(true);
    const snapshot = await waitForReady(instance, base.id);
    expect(snapshot.sources.map((source) => source.title).sort()).toEqual(["docs/a", "docs/b"]);

    const again = await instance.importFolder(base.id, { dir: "docs" });
    expect(again.added).toHaveLength(0);
    expect(again.skipped).toHaveLength(2);
  });
});

function makeSamplePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 49 >>\nstream\nBT /F1 18 Tf 30 100 Td (Hello PDF knowledge) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

describe("第三批：整库迁移、目录扫描、PDF 提取", () => {
  it("导出后导入：新 ID、重名加后缀，页面/来源/检索保持可用", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "原始库", description: "迁移测试" });
    await instance.addSource(base.id, { title: "材料", content: "中心编排交付路径唯一。" });
    await waitForReady(instance, base.id);

    const bundle = await instance.exportBundle(base.id);
    expect(bundle.filename).toMatch(/\.zip$/);
    const imported = await instance.importBundle(bundle.data);
    expect(imported.id).not.toBe(base.id);
    expect(imported.name).toBe("原始库（导入2）");

    const snapshot = await instance.snapshot(imported.id);
    expect(snapshot.pages.map((page) => page.path)).toEqual(
      (await instance.snapshot(base.id)).pages.map((page) => page.path),
    );
    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]?.status).toBe("ready");
    expect(snapshot.index).toContain("中心编排");
    const hits = await instance.search("中心编排", imported.id);
    expect(hits.length).toBeGreaterThan(0);

    const second = await instance.importBundle(bundle.data);
    expect(second.name).toBe("原始库（导入3）");
  });

  it("压缩包里的路径逃逸文件被忽略，不会写到库目录之外", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("meta.json", JSON.stringify({ name: "恶意包" }));
    zip.file("../evil.md", "should not escape");
    zip.file("wiki/../evil2.md", "should not escape");
    zip.file("wiki/notes/ok.md", "---\ntype: note\ntitle: 正常\n---\n\n正常正文。");
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.importBundle(await zip.generateAsync({ type: "nodebuffer" }));
    expect(base.name).toBe("恶意包");
    const snapshot = await instance.snapshot(base.id);
    expect(snapshot.pages.map((page) => page.path)).toEqual(["notes/ok.md"]);
    await expect(readFile(join(dir, "evil.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(dir, "knowledge", base.id, "evil2.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("扫描 raw/sources：新增导入、修改重新排队、删除把来源标失败", async () => {
    const instance = await makeService(analysisHandler((request) => ({ text: generationText(request) })));
    const base = await instance.createBase({ name: "扫描库" });
    const rawDir = join(dir, "knowledge", base.id, "raw", "sources");
    await mkdir(rawDir, { recursive: true });
    const external = join(rawDir, "external-note.md");
    await writeFile(external, "外部新增的说明：中心编排交付路径唯一。", "utf8");

    const first = await instance.rescanSources(base.id);
    expect(first).toEqual({ added: 1, updated: 0, removed: 0 });
    await waitForReady(instance, base.id);
    let snapshot = await instance.snapshot(base.id);
    expect(snapshot.sources[0]?.title).toBe("external-note");
    expect(snapshot.sources[0]?.status).toBe("ready");

    await writeFile(external, "外部修改：对等会话适合讨论，但缺少收口点。", "utf8");
    const second = await instance.rescanSources(base.id);
    expect(second).toEqual({ added: 0, updated: 1, removed: 0 });
    snapshot = await waitForReady(instance, base.id);
    expect(snapshot.sources[0]?.status).toBe("ready");
    const raw = await readFile(
      join(dir, "knowledge", base.id, snapshot.sources[0]!.rawPath),
      "utf8",
    );
    expect(raw).toContain("外部修改");

    await rm(external);
    const third = await instance.rescanSources(base.id);
    expect(third.removed).toBe(1);
    snapshot = await instance.snapshot(base.id);
    expect(snapshot.sources[0]?.status).toBe("failed");
    expect(snapshot.sources[0]?.error).toContain("原始文件已删除");
  });

  it("PDF 文件可以抽取文本层", async () => {
    const { extractTextFromFile } = await import("../src/files/extract-text");
    const file = join(dir, "sample.pdf");
    await writeFile(file, makeSamplePdf());
    const result = await extractTextFromFile(file);
    expect("text" in result ? result.text : result.error).toContain("Hello PDF knowledge");
    expect("format" in result ? result.format : "").toBe("pdf");
  });
});
