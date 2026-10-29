import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { DEFAULT_LIMITS, USER_ID } from "../src/core/types";
import type { Settings } from "../src/core/settings";
import type { MockHandler } from "../src/provider/mock";
import { SkillLibrary } from "../src/skills/library";
import { tokenize, normalizeSearchTokens, bm25RankToScore, bm25RelevanceToScore } from "../src/memory/tokenize";
import { stripMemoryAnnotationCarriers, extractCuratedEntryRecallMetadata } from "../src/memory/annotations";
import { chunkMarkdown, splitCuratedMarkdownEntries } from "../src/memory/chunking";
import { MemorySearchManager } from "../src/memory/manager";
import { ensureAgentFiles } from "../src/memory/bootstrap-files";
import { resolveTriggerRecall, selectStrongTriggerMatches, toTriggerRecallHits } from "../src/memory/recall";
import { buildMemoryTools } from "../src/memory/tools";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-memory-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MEMORY_MD = [
  "# 长期记忆",
  "",
  "- User's favorite database is PostgreSQL <!-- trigger: favorite database, database preference --> <!-- importance: 9 -->",
  "- 网关决策：内部服务间通信用 gRPC，边缘保留 REST",
].join("\n");

const NOTES_MD = [
  "# 部署笔记",
  "",
  "部署使用 Docker Compose，跑在内网 Windows 服务器上，数据卷挂载在 D 盘。",
  "回滚方式是重新 up 上一个镜像 tag。",
].join("\n");

async function seedWorkspace(): Promise<RoomBus> {
  await writeFile(join(dir, "MEMORY.md"), MEMORY_MD, "utf8");
  await mkdir(join(dir, "memory"), { recursive: true });
  await writeFile(join(dir, "memory/notes.md"), NOTES_MD, "utf8");
  const bus = new RoomBus("room_main", "测试作战室");
  bus.append({
    senderId: USER_ID,
    senderName: "用户",
    senderKind: "user",
    text: "帮我梳理一下网关的缓存策略",
  });
  bus.append({
    senderId: "m_main",
    senderName: "主智能体",
    senderKind: "member",
    text: "建议网关层用 LRU，热点键单独设置 TTL。",
  });
  return bus;
}

function manager(bus: RoomBus, options: Partial<import("../src/memory/manager").MemorySearchManagerOptions> = {}): MemorySearchManager {
  return new MemorySearchManager({ ...options, workspaceDir: dir, bus });
}

const abortSignal = new AbortController().signal;

describe("tokenize（移植层）", () => {
  it("CJK 双字滑窗不产生跨词错切，ASCII 单词独立成 token", () => {
    const tokens = tokenize("我喜欢hello你好");
    expect([...tokens]).toContain("我喜");
    expect([...tokens]).toContain("喜欢");
    expect([...tokens]).toContain("hello");
    expect([...tokens]).toContain("你好");
    expect([...tokens]).not.toContain("欢你");
  });

  it("FTS5 bm25 rank 换算与 Okapi 饱和模型一致", () => {
    expect(bm25RankToScore(-3)).toBeCloseTo(3 / 4);
    expect(bm25RelevanceToScore(3)).toBeCloseTo(bm25RankToScore(-3));
    expect(bm25RankToScore(Number.NaN)).toBeCloseTo(1 / 1000);
  });

  it("normalizeSearchTokens 保留原样 token（大小写匹配由索引层的 lowerText 承担）", () => {
    const tokens = normalizeSearchTokens("PostgreSQL postgres 网关 网关");
    expect(tokens).toContain("postgres");
    expect(tokens).toHaveLength(4);
  });
});

describe("annotations 与 chunking", () => {
  it("策展条目解析出 trigger/importance，剥离注释载体", () => {
    const line = MEMORY_MD.split("\n")[2];
    const meta = extractCuratedEntryRecallMetadata({ sourceLines: [line], curatedRoot: true, projectScopeEligible: false });
    expect(meta.triggers).toBe("favorite database; database preference");
    expect(meta.importance).toBe(9);
    expect(stripMemoryAnnotationCarriers(line)).toBe("- User's favorite database is PostgreSQL");
  });

  it("perEntry 分块保持条目边界并标注条目行号", () => {
    const entries = splitCuratedMarkdownEntries(MEMORY_MD);
    expect(entries.filter((entry) => entry.kind === "entry")).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === "section")).toHaveLength(1);
    const chunks = chunkMarkdown(MEMORY_MD, { tokens: 400, overlap: 80, perEntry: true });
    const tagged = chunks.filter((chunk) => chunk.entryStartLine !== undefined);
    expect(tagged.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MemorySearchManager 检索", () => {
  it("hybrid 检索命中记忆文件并携带策展元数据", async () => {
    const bus = await seedWorkspace();
    const results = await manager(bus).search("favorite database PostgreSQL", {});
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.path).toBe("MEMORY.md");
    expect(top.source).toBe("memory");
    expect(top.importance).toBe(9);
    expect(top.triggers).toContain("favorite database");
    // OpenClaw 的策展候选保留原文（含注释载体），剥离发生在触发召回摘录与展示层。
    expect(stripMemoryAnnotationCarriers(top.snippet)).toContain("PostgreSQL");
  });

  it("lexicalOnly（无 embedding 通道）仍可中文检索 memory/ 下的文件", async () => {
    const bus = await seedWorkspace();
    const results = await manager(bus).search("Docker Compose 内网 部署", { lexicalOnly: true });
    expect(results.some((entry) => entry.path === "memory/notes.md")).toBe(true);
  });

  it("minScore 高阈值过滤弱相关命中", async () => {
    const bus = await seedWorkspace();
    const results = await manager(bus).search("香蕉 冰淇淋 游泳", { minScore: 0.9 });
    expect(results).toHaveLength(0);
  });

  it("sessions 语料命中群聊转录，行号是 seq", async () => {
    const bus = await seedWorkspace();
    const results = await manager(bus).search("LRU TTL 缓存", { sources: ["sessions"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("sessions");
    expect(results[0].path).toBe("sessions/room_main.md");
    expect(results[0].startLine).toBeGreaterThanOrEqual(1);
    expect(results[0].startLine).toBeLessThanOrEqual(2);
  });

  it("readFile 只允许记忆白名单路径，拒绝越界", async () => {
    const bus = await seedWorkspace();
    const m = manager(bus);
    const file = await m.readFile("MEMORY.md", {});
    expect(file.content).toContain("长期记忆");
    await expect(m.readFile("../state.json", {})).rejects.toThrow();
    await expect(m.readFile("memory/notes.md", { from: 3, lines: 1 })).resolves.toMatchObject({
      content: expect.stringContaining("Docker Compose"),
    });
  });

  it("appendEntry 写入策展条目格式并对后续检索可见", async () => {
    const bus = await seedWorkspace();
    const m = manager(bus);
    const entry = await m.appendEntry("用户常驻城市是杭州", { triggers: ["常驻城市, 住在哪里"], importance: 8 });
    const raw = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(raw).toContain("- 用户常驻城市是杭州 <!-- trigger: 常驻城市, 住在哪里 --> <!-- importance: 8 -->");
    expect(entry).toBe("MEMORY.md");
    const results = await m.search("用户常驻城市是杭州", { lexicalOnly: true });
    expect(results.some((hit) => hit.path === "MEMORY.md" && hit.snippet.includes("杭州"))).toBe(true);
  });

  it("listAgentFiles 按 bootstrap 顺序包含身份文件，memory_get 口径仍不含", async () => {
    const bus = await seedWorkspace();
    const m = manager(bus);
    const created = await ensureAgentFiles(dir, {
      displayName: "室长",
      mainAgentName: "主智能体",
      roomName: "室长 的作战室",
    });
    expect(created).toEqual(["USER.md", "SOUL.md", "IDENTITY.md"]);

    const files = await m.listAgentFiles();
    expect(files.map((file) => file.path)).toEqual([
      "MEMORY.md",
      "USER.md",
      "SOUL.md",
      "IDENTITY.md",
      "memory/notes.md",
    ]);

    const soul = await m.readAgentFile("SOUL.md");
    expect(soul.content).toContain("我是谁");
    // 身份文件可读，但工作区状态/设置依旧拒绝。
    await expect(m.readAgentFile("../state.json")).rejects.toThrow(/只允许读取/);
    await expect(m.readFile("SOUL.md")).rejects.toThrow(/只允许读取 MEMORY.md、USER.md 或 memory\//);

    // 二次补齐不得覆盖用户已改写的内容。
    await writeFile(join(dir, "MEMORY.md"), "# 我的记忆\n\n- 自定义\n", "utf8");
    expect(await ensureAgentFiles(dir, { displayName: "x", mainAgentName: "y", roomName: "z" })).toEqual([]);
    expect((await m.readAgentFile("MEMORY.md")).content).toContain("自定义");

    // SOUL.md 不属于检索语料（对应 OpenClaw：身份文件走提示词注入，不进 memory 索引）。
    const hits = await m.search("我是谁", { lexicalOnly: true, sources: ["memory"] });
    expect(hits.every((hit) => hit.path !== "SOUL.md")).toBe(true);
  });
});

describe("lane-1 触发召回（active-memory 移植）", () => {
  it("强触发命中注入 <active_memory_plugin> 上下文", async () => {
    const bus = await seedWorkspace();
    const m = manager(bus);
    const recall = await resolveTriggerRecall({ manager: m, message: "What is my favorite database?" });
    expect(recall.hasStrongHit).toBe(true);
    expect(recall.injectedCount).toBe(1);
    expect(recall.context).toContain("<active_memory_plugin>");
    expect(recall.context).toContain("PostgreSQL");
    expect(recall.context).toContain("Source: MEMORY.md#L");
  });

  it("模板自动补齐后，写法说明文字不会被当成记忆条目注入", async () => {
    const bus = await seedWorkspace();
    const m = manager(bus);
    await ensureAgentFiles(dir, {
      displayName: "室长",
      mainAgentName: "主智能体",
      roomName: "室长 的作战室",
    });
    const recall = await resolveTriggerRecall({ manager: m, message: "回复语言 沟通偏好" });
    expect(recall.hasStrongHit).toBe(true);
    // 注入的只能是 USER.md 的真实画像条目，说明文字与缩进示例没有触发元数据。
    expect(recall.context).toContain("默认使用中文");
    expect(recall.context).not.toContain("写法约定");
    expect(recall.context).not.toContain("条目格式举例");
  });

  it("无关消息不注入（fail-open，不报错）", async () => {
    const bus = await seedWorkspace();
    const m = manager(bus);
    const recall = await resolveTriggerRecall({ manager: m, message: "今天天气怎么样" });
    expect(recall.hasStrongHit).toBe(false);
    expect(recall.context).toBeUndefined();
  });

  it("打分公式：单词触发 0.85，多词覆盖度加权，阈值 0.65", () => {
    const hits = toTriggerRecallHits([
      {
        path: "MEMORY.md",
        startLine: 3,
        endLine: 3,
        score: 0.5,
        vectorScore: 0,
        textScore: 0.5,
        snippet: "- User's favorite database is PostgreSQL <!-- trigger: favorite database -->",
        source: "memory" as const,
        triggers: "favorite database",
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toBe("- User's favorite database is PostgreSQL");
    expect(hits[0].triggers).toBe("favorite database");
    const strong = selectStrongTriggerMatches("my favorite database please", hits, []);
    expect(strong).toHaveLength(1);
    // triggerScore=1.0（全词覆盖），relevance=0.5 → 1.0*0.8+0.5*0.2=0.9
    expect(strong[0].matchScore).toBeCloseTo(0.9);
    const weak = selectStrongTriggerMatches("database", hits, []);
    // 单词部分覆盖：coverage=1/2*0.8+0.5*0.2=0.5 → 0.5*0.8+0.5*0.2=0.5 < 0.65
    expect(weak).toHaveLength(0);
  });
});

describe("memory 工具契约", () => {
  async function tools(bus: RoomBus) {
    const m = manager(bus);
    const list = buildMemoryTools(m);
    return {
      m,
      byName: Object.fromEntries(list.map((tool) => [tool.schema.name, tool])),
    };
  }

  it("memory_search 归一化别名并按 JSON 输出结果", async () => {
    const bus = await seedWorkspace();
    const { byName } = await tools(bus);
    const out = JSON.parse(await byName.memory_search.execute({ query: "favorite database", limit: 2, min_score: 0.1 }, abortSignal));
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.citations).toBe("on");
    expect(out.results.length).toBeLessThanOrEqual(2);
    expect(out.results[0].path).toBe("MEMORY.md");
  });

  it("memory_search 拒绝非法参数（maxResults=0、未知 corpus）", async () => {
    const bus = await seedWorkspace();
    const { byName } = await tools(bus);
    await expect(byName.memory_search.execute({ query: "x", maxResults: 0 }, abortSignal)).rejects.toThrow(/positive integer/);
    await expect(byName.memory_search.execute({ query: "x", corpus: "wiki" }, abortSignal)).rejects.toThrow(/corpus must be one of/);
  });

  it("memory_get 返回 ok/not_found 口径，转录路径不支持", async () => {
    const bus = await seedWorkspace();
    const { byName } = await tools(bus);
    const ok = JSON.parse(await byName.memory_get.execute({ path: "memory/notes.md" }, abortSignal));
    expect(ok.status).toBe("ok");
    expect(ok.content).toContain("Docker Compose");
    const miss = JSON.parse(await byName.memory_get.execute({ path: "../settings.json" }, abortSignal));
    expect(["not_found", "error"]).toContain(miss.status);
  });

  it("memory_append 写入并立即可被 memory_search 检索", async () => {
    const bus = await seedWorkspace();
    const { byName } = await tools(bus);
    const written = JSON.parse(
      await byName.memory_append.execute(
        { text: "用户偏好用 pnpm 而不是 npm", triggers: ["包管理器偏好"], importance: 7 },
        abortSignal,
      ),
    );
    expect(written.status).toBe("ok");
    expect(written.path).toBe("MEMORY.md");
    const out = JSON.parse(await byName.memory_search.execute({ query: "用户偏好用 pnpm", min_score: 0.05 }, abortSignal));
    expect(out.results.some((hit: { snippet: string }) => hit.snippet.includes("pnpm"))).toBe(true);
  });
});

describe("运行时接线（workspace/orchestrator/member-runtime）", () => {
  it("系统提示注入记忆指引，触发召回注入用户消息，memory_search 工具可被调用", async () => {
    await seedWorkspace();
    const bus = new RoomBus("room_main", "测试作战室");
    const board = new Workboard("room_main");
    ensureMainMember(bus);
    const m = manager(bus);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const settings: Settings = {
      providers: [{ id: "demo", kind: "mock", model: "mock" }],
      activeProviderId: "demo",
      limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 4, runTimeoutMs: 10_000 },
    };

    const captured: { system?: string; firstUser?: string; toolResult?: string } = {};
    const handler: MockHandler = (request) => {
      const steps = request.messages.filter((message) => message.role === "assistant").length;
      if (steps === 0) {
        captured.system = request.messages.find((message) => message.role === "system")?.content;
        const users = request.messages.filter((message) => message.role === "user");
        captured.firstUser = users[0]?.content;
        const turn = { toolCalls: [{ name: "memory_search", args: { query: "favorite database", min_score: 0.05 } }] };
        return turn;
      }
      captured.toolResult = request.messages.filter((message) => message.role === "tool").pop()?.content;
      return { text: "你的最爱数据库是 PostgreSQL。" };
    };

    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => settings,
      skills,
      ownerId: "u_test",
      mockHandler: handler,
      memory: m,
    });
    orchestrator.sendUserMessage("What is my favorite database?");

    const started = Date.now();
    while (!bus.listMessages().some((message) => message.senderKind === "member" && message.text.includes("PostgreSQL"))) {
      if (Date.now() - started > 15_000) throw new Error("等待超时");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    orchestrator.stop();

    expect(captured.system).toContain("## 记忆检索");
    expect(captured.system).toContain("memory_search");
    // lane-1 trigger recall 在首个用户消息前注入 <active_memory_plugin> 上下文
    expect(captured.firstUser).toContain("<active_memory_plugin>");
    expect(captured.firstUser).toContain("PostgreSQL");
    expect(captured.toolResult).toContain('"path":"MEMORY.md"');
  }, 30_000);
});
