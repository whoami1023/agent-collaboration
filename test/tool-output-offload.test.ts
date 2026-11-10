import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ToolOutputStore,
  chunkLines,
  clipForContext,
  formatSpanLabel,
} from "../src/agent/content/offload";
import { transformToolResult } from "../src/agent/content/policy";
import { buildOutputTools } from "../src/agent/content/output-tools";
import { applyRunScope } from "../src/agent/run-scope";

const signal = new AbortController().signal;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(options: ConstructorParameters<typeof ToolOutputStore>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ac-offload-"));
  tempDirs.push(dir);
  return { store: new ToolOutputStore(join(dir, "tool-outputs"), options), dir };
}

function makeLog(lines = 400): string {
  const rows = Array.from(
    { length: lines },
    (_, index) => `log line ${index + 1} routine output ${"x".repeat(60)}`,
  );
  rows[249] = "ERROR cache miss detected while fetching esbuild";
  rows[lines - 1] = "cache miss summary: 1 occurrence";
  return rows.join("\n");
}

function capture(store: ToolOutputStore, text: string, memberId = "m_1") {
  return store.capture({
    tool: "run_command",
    roomId: "room_1",
    memberId,
    runId: "run_1",
    argsPreview: "command=node big.js",
    text,
  });
}

describe("按行切块", () => {
  it("块与块首尾相接、覆盖全文，且不切断任何一行", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1} ${"x".repeat(200)}`);
    const spans = chunkLines(lines.join("\n"), 1024);
    expect(spans[0]?.startLine).toBe(1);
    expect(spans.at(-1)?.endLine).toBe(50);
    for (let index = 0; index < spans.length - 1; index += 1) {
      expect(spans[index]!.endLine + 1).toBe(spans[index + 1]!.startLine);
    }
  });

  it("单行超过块大小就让它单独成块，宁可超限也不切断", () => {
    const spans = chunkLines(`${"y".repeat(5000)}\nshort`, 1024);
    expect(spans[0]).toEqual({ startLine: 1, endLine: 1 });
    expect(spans[1]).toEqual({ startLine: 2, endLine: 2 });
  });
});

describe("存档、检索与读取", () => {
  it("按行读取指定区间，并在末尾告诉调用方后面还有没有", async () => {
    const { store } = await makeStore();
    const record = await capture(store, makeLog(200));
    expect(record).not.toBeNull();

    const first = await store.read("m_1", record!.id, 1, 20);
    expect(first?.startLine).toBe(1);
    expect(first?.endLine).toBe(20);
    expect(first?.text).toContain("log line 1 ");
    expect(first?.text).toContain("log line 20 ");
    expect(first?.more).toBe(true);

    const later = await store.read("m_1", record!.id, 21);
    expect(later?.startLine).toBe(21);
    expect(later?.text).toContain("log line 21 ");
  });

  it("成员隔离：别人的存档 id 既读不到也搜不到", async () => {
    const { store } = await makeStore();
    const record = await capture(store, makeLog(200));
    expect(await store.read("m_2", record!.id)).toBeNull();
    expect(await store.search("m_2", "cache miss")).toEqual([]);
  });

  it("检索按 BM25 命中关键行，而不是只返回开头", async () => {
    const { store } = await makeStore();
    const record = await capture(store, makeLog(400));
    const hits = await store.search("m_1", "cache miss");
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.some((hit) => hit.span.startLine <= 250 && hit.span.endLine >= 250),
    ).toBe(true);
    expect(hits[0]?.text).toContain("cache miss");
    expect(await store.search("m_1", "postgres")).toEqual([]);
  });

  it("首次回填有查询词时选相关块，没有查询词时从头开始", async () => {
    const { store } = await makeStore();
    const record = await capture(store, makeLog(400));
    const text = makeLog(400);

    const focused = store.selectForContext(record!, text, "cache miss");
    expect(focused.excerpts).toContain("cache miss");
    expect(focused.excerpts).not.toContain("log line 1 ");
    expect(focused.spans.length).toBeGreaterThan(0);

    const fromHead = store.selectForContext(record!, text, "");
    expect(fromHead.spans[0]?.startLine).toBe(1);
    expect(fromHead.excerpts.startsWith(formatSpanLabel(record!.id, fromHead.spans[0]!))).toBe(true);
  });

  it("保留策略从最旧的开始删，份数回到上限内", async () => {
    let clock = 1;
    const { store } = await makeStore({ maxCaptures: 2, now: () => clock++ });
    const a = await capture(store, "first output");
    const b = await capture(store, "second output");
    const c = await capture(store, "third output");
    expect(await store.read("m_1", a!.id)).toBeNull();
    expect(await store.read("m_1", b!.id)).not.toBeNull();
    expect(await store.read("m_1", c!.id)).not.toBeNull();
  });

  it("检索默认融合新近度：相关度接近时刚跑出来的输出优先，relevance 仍按纯 BM25", async () => {
    let clock = 1_000;
    const { store } = await makeStore({ now: () => clock });
    const old = (await capture(store, "needle ".repeat(20).trim()))!;
    clock = 2_000;
    const recent = (await capture(store, "needle once, then routine lines"))!;

    const relevance = await store.search("m_1", "needle", { sort: "relevance" });
    expect(relevance[0]?.record.id).toBe(old.id);

    const fused = await store.search("m_1", "needle");
    expect(fused[0]?.record.id).toBe(recent.id);

    const recentOnly = await store.search("m_1", "needle", { sort: "recent" });
    expect(recentOnly[0]?.record.id).toBe(recent.id);
  });

  it("状态块只列本成员、本房间的最近存档，整行取舍且重复生成字节一致", async () => {
    let clock = 1;
    const { store } = await makeStore({ now: () => clock++ });
    const own = (await capture(store, "own output"))!;
    const otherMember = await store.capture({
      tool: "run_command",
      roomId: "room_1",
      memberId: "m_2",
      argsPreview: "command=other",
      text: "other member output",
    });
    const otherRoom = await store.capture({
      tool: "run_command",
      roomId: "room_2",
      memberId: "m_1",
      argsPreview: "command=other-room",
      text: "other room output",
    });

    const block = await store.stateBlock("m_1", "room_1");
    expect(block).toContain('<tool_output_state room="room_1" captured="1">');
    expect(block).toContain(own.id);
    expect(block).toContain("output_search");
    expect(block).toContain("output_read");
    expect(block).not.toContain(otherMember!.id);
    expect(block).not.toContain(otherRoom!.id);
    expect(block).not.toContain("other member output");
    expect(await store.stateBlock("m_1", "room_1")).toBe(block);
    expect(await store.stateBlock("m_missing", "room_1")).toBe("");
  });

  it("状态块最多列 8 份，超出上限的整行省略并说明", async () => {
    let clock = 1;
    const { store } = await makeStore({ now: () => clock++ });
    for (let index = 0; index < 12; index += 1) {
      await capture(store, `output ${index}`);
    }
    const block = await store.stateBlock("m_1", "room_1");
    const listed = block.split("\n").filter((line) => line.startsWith("- out_"));
    expect(listed).toHaveLength(8);
    expect(listed.every((line) => line.endsWith("行）"))).toBe(true);
    expect(block).toContain("另有 4 份较早存档未列出");
  });

  it("按当前问题召回：命中块套信封并给出取回方式", async () => {
    const { store } = await makeStore();
    const record = await capture(store, makeLog(400));
    const block = await store.recallBlock("m_1", "room_1", "cache miss");
    expect(block).toContain("压缩后按当前问题自动召回");
    expect(block).toContain(record!.id);
    expect(block).toContain("cache miss");
    expect(block).toContain('<untrusted_tool_result source="tool_output">');
    expect(block).toContain("output_search");
    expect(block).toContain("output_read");
  });

  it("召回有成员与房间边界；没命中或空问题不注入", async () => {
    const { store } = await makeStore();
    await capture(store, makeLog(200));
    expect(await store.recallBlock("m_1", "room_1", "postgres")).toBe("");
    expect(await store.recallBlock("m_1", "room_1", "   ")).toBe("");
    expect(await store.recallBlock("m_2", "room_1", "cache miss")).toBe("");
    expect(await store.recallBlock("m_1", "room_2", "cache miss")).toBe("");
  });

  it("召回最多两段，同一份存档只取一段，整块受字节预算约束", async () => {
    const { store } = await makeStore();
    for (const label of ["first", "second", "third"]) {
      await capture(store, `${label} cache miss detail\n${label} cache miss follow-up`);
    }
    const block = await store.recallBlock("m_1", "room_1", "cache miss");
    expect((block.match(/--- out_/g) ?? []).length).toBe(2);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThan(4 * 1024);
  });
});

describe("异步工具结果管线", () => {
  it("大输出落盘后只把相关片段和存档指针放进上下文，原文段仍套外部内容信封", async () => {
    const { store } = await makeStore();
    const raw = `$ node big.js\n${makeLog(400)}`;
    const out = await transformToolResult(
      "run_command",
      raw,
      { command: "node big.js" },
      { store, memberId: "m_1", roomId: "room_1", runId: "run_1", query: "找出 cache miss" },
    );

    expect(out).toContain("完整内容已存档 out_");
    expect(out).toContain("output_search");
    expect(out).toContain('<untrusted_tool_result source="run_command">');
    expect(out).toContain("cache miss");
    // 存档 id 与取回说明在信封外，选中的原文段在信封内。
    expect(out.indexOf("完整内容已存档")).toBeLessThan(out.indexOf("<untrusted_tool_result"));

    const id = /完整内容已存档 (out_[A-Za-z0-9]+)/.exec(out)?.[1];
    expect(id).toBeDefined();
    const read = await store.read("m_1", id!, 1, 3);
    expect(read?.text).toContain("$ node big.js");
  });

  it("小结果原样进入上下文，不做存档", async () => {
    const { store } = await makeStore();
    const raw = `退出码：0\n${"ok ".repeat(80)}`;
    const out = await transformToolResult("run_command", raw, { command: "echo ok" }, {
      store,
      memberId: "m_1",
      roomId: "room_1",
    });
    expect(out).not.toContain("完整内容已存档");
    expect(out).toContain("退出码：0");
  });

  it("我们自己工具的错误消息不再套一层存档或外部内容边界", async () => {
    const { store } = await makeStore();
    const raw = `错误：${"x".repeat(20_000)}`;
    const out = await transformToolResult("file_read", raw, { path: "a.txt" }, {
      store,
      memberId: "m_1",
      roomId: "room_1",
    });
    expect(out.startsWith("错误：")).toBe(true);
    expect(out).not.toContain("完整内容已存档");
    expect(out).not.toContain("untrusted_tool_result");
  });

  it("落盘前先脱敏：存档与读回都不含原密钥", async () => {
    const { store } = await makeStore();
    const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const raw = `token: ${key}\n${Array.from({ length: 400 }, (_, index) => `row ${index} ${"z".repeat(80)}`).join("\n")}`;
    const out = await transformToolResult("run_command", raw, { command: "print-config" }, {
      store,
      memberId: "m_1",
      roomId: "room_1",
    });
    expect(out).not.toContain(key);
    // 同一个密钥可能同时命中「厂商密钥」和「密钥赋值」两条规则，这里只要求确实掩了。
    expect(out).toMatch(/已掩掉 [1-9]\d* 处疑似密钥/);

    const id = /完整内容已存档 (out_[A-Za-z0-9]+)/.exec(out)?.[1];
    const read = await store.read("m_1", id!, 1, 400);
    expect(read?.text).toContain("已脱敏");
    expect(read?.text).not.toContain(key);
  });

  it("存档写不进去时退回头尾截断，并把整轮运行留给后续步骤", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-offload-fail-"));
    tempDirs.push(dir);
    const notADir = join(dir, "tool-outputs");
    await writeFile(notADir, "occupied", "utf8");
    const store = new ToolOutputStore(notADir);
    const raw = makeLog(400);
    const out = await transformToolResult("run_command", raw, { command: "node big.js" }, {
      store,
      memberId: "m_1",
      roomId: "room_1",
    });
    expect(out).toContain("存档失败");
    expect(out).toContain("中间省略");
    expect(out).toContain('<untrusted_tool_result source="run_command">');
  });
});

describe("output_search / output_read", () => {
  async function setup() {
    const { store } = await makeStore();
    const record = (await capture(store, makeLog(400)))!;
    const tools = new Map(
      buildOutputTools({ store, memberId: "m_1" }).map((tool) => [tool.schema.name, tool]),
    );
    return { store, record, tools };
  }

  it("检索返回带行号的片段，每段都套 tool_output 边界", async () => {
    const { tools } = await setup();
    const out = await tools.get("output_search")!.execute({ query: "cache miss" }, signal);
    expect(out).toContain("找到");
    expect(out).toContain('<untrusted_tool_result source="tool_output">');
    expect(out).toContain("cache miss");
    expect(out).toContain("第 ");
    expect(out).toContain("行");
  });

  it("按行读取并给出下一段的入口", async () => {
    const { record, tools } = await setup();
    const out = await tools.get("output_read")!.execute(
      { id: record.id, start_line: 1, end_line: 5 },
      signal,
    );
    expect(out).toContain("第 1–5 行");
    expect(out).toContain("继续读：output_read");
    expect(out).toContain("start_line=6");
    expect(out).toContain('<untrusted_tool_result source="tool_output">');
  });

  it("别的成员建的工具读不到这份存档", async () => {
    const { store, record } = await setup();
    const other = new Map(
      buildOutputTools({ store, memberId: "m_2" }).map((tool) => [tool.schema.name, tool]),
    );
    expect(await other.get("output_search")!.execute({ query: "cache miss" }, signal)).toContain(
      "没有找到匹配的工具输出",
    );
    expect(await other.get("output_read")!.execute({ id: record.id }, signal)).toContain(
      "没有找到工具输出存档",
    );
  });

  it("伪造的存档 id 被拒绝，不会碰到存档目录之外", async () => {
    const { tools } = await setup();
    const out = await tools.get("output_read")!.execute({ id: "../../settings" }, signal);
    expect(out).toContain("存档 id 不合法");
  });
});

describe("兜底工具", () => {
  it("clipForContext 保持头尾、省略中间", () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${"q".repeat(100)}`).join("\n");
    const clipped = clipForContext(text, 2048);
    expect(clipped).toContain("line 1 ");
    expect(clipped).toContain("line 200 ");
    expect(clipped).toContain("中间省略");
    expect(clipped.length).toBeLessThan(text.length);
  });

  it("计划轮白名单保留输出检索与读取", () => {
    const names = applyRunScope(
      [
        { schema: { name: "output_search", description: "", parameters: { type: "object", properties: {} } }, execute: async () => "" },
        { schema: { name: "output_read", description: "", parameters: { type: "object", properties: {} } }, execute: async () => "" },
        { schema: { name: "run_command", description: "", parameters: { type: "object", properties: {} } }, execute: async () => "" },
      ],
      "plan",
    ).map((tool) => tool.schema.name);
    expect(names).toEqual(["output_search", "output_read"]);
  });
});
