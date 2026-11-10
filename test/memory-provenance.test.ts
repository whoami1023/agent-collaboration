import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { MemorySearchManager } from "../src/memory/manager";
import {
  extractCuratedEntryRecallMetadata,
  isMemoryEntryStale,
  normalizeMemoryDate,
  normalizeMemoryEntryId,
  stripMemoryAnnotationCarriers,
} from "../src/memory/annotations";
import { resolveTriggerRecall } from "../src/memory/recall";
import { buildMemoryTools } from "../src/memory/tools";
import { ToolFailure } from "../src/agent/tool-errors";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-memory-prov-"));
  await writeFile(join(dir, "MEMORY.md"), "# 长期记忆\n\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function manager(): MemorySearchManager {
  return new MemorySearchManager({ workspaceDir: dir, bus: new RoomBus("room_main", "测试作战室") });
}

async function readMemory(): Promise<string> {
  return readFile(join(dir, "MEMORY.md"), "utf8");
}

describe("策展注释：出处与时效", () => {
  it("解析 id/source/as-of/valid-until/retracted/supersedes，并从正文剥离载体", () => {
    const line =
      "- 网关内部通信用 gRPC <!-- trigger: 网关协议 --> <!-- importance: 7 --> <!-- id: mem_abc123 --> " +
      "<!-- source: 群聊 #42 --> <!-- as-of: 2026-03-01 --> <!-- valid-until: 2026-12-31 --> " +
      "<!-- supersedes: mem_old1, mem_old2 -->";
    const meta = extractCuratedEntryRecallMetadata({
      sourceLines: [line],
      curatedRoot: true,
      projectScopeEligible: false,
    });
    expect(meta.entryId).toBe("mem_abc123");
    expect(meta.provenance).toBe("群聊 #42");
    expect(meta.asOf).toBe("2026-03-01");
    expect(meta.validUntil).toBe("2026-12-31");
    expect(meta.retracted).toBe(false);
    expect(meta.supersedes).toEqual(["mem_old1", "mem_old2"]);
    expect(stripMemoryAnnotationCarriers(line)).toBe("- 网关内部通信用 gRPC");
  });

  it("retracted 注释按真假值解析，日期与 id 做严格日历/字符校验", () => {
    const meta = extractCuratedEntryRecallMetadata({
      sourceLines: ["- 旧事实 <!-- retracted: 2026-05-01 已被取代 -->"],
      curatedRoot: true,
      projectScopeEligible: false,
    });
    expect(meta.retracted).toBe(true);
    expect(normalizeMemoryDate("2026-02-30")).toBeNull();
    expect(normalizeMemoryDate("2026-02-28")).toBe("2026-02-28");
    expect(normalizeMemoryEntryId("mem_x1")).toBe("mem_x1");
    expect(normalizeMemoryEntryId("bad id with space")).toBeNull();
  });

  it("valid-until 含当日：当天不算过期，次日零点起过期", () => {
    expect(isMemoryEntryStale("2026-11-10", Date.UTC(2026, 10, 10, 23, 59))).toBe(false);
    expect(isMemoryEntryStale("2026-11-10", Date.UTC(2026, 10, 11, 0, 0))).toBe(true);
    expect(isMemoryEntryStale(null, Date.now())).toBe(false);
  });
});

describe("写入：自动 id 与出处字段", () => {
  it("appendEntryWithId 持久化出处/时效/取代关系，非法日期不落盘", async () => {
    const m = manager();
    const first = await m.appendEntryWithId("事实一", { triggers: ["事实一"] });
    expect(first.id).toMatch(/^mem_[0-9a-f]{12}$/u);
    expect(first.path).toBe("MEMORY.md");

    const second = await m.appendEntryWithId("事实一（更正）", {
      triggers: ["事实一"],
      provenance: "群聊 #7",
      asOf: "2026-11-01",
      validUntil: "2026-12-31",
      supersedes: [first.id],
    });
    const raw = await readMemory();
    expect(raw).toContain(`<!-- id: ${first.id} -->`);
    expect(raw).toContain(`<!-- id: ${second.id} -->`);
    expect(raw).toContain("<!-- source: 群聊 #7 -->");
    expect(raw).toContain("<!-- as-of: 2026-11-01 -->");
    expect(raw).toContain("<!-- valid-until: 2026-12-31 -->");
    expect(raw).toContain(`<!-- supersedes: ${first.id} -->`);

    await expect(
      m.appendEntryWithId("坏日期", { asOf: "2026-13-01" }),
    ).rejects.toThrow(/as-of/u);
    expect(await readMemory()).not.toContain("坏日期");
  });
});

describe("检索：撤回、取代与过期", () => {
  it("撤回条目默认不返回，includeRetracted 时可见", async () => {
    const m = manager();
    const { id } = await m.appendEntryWithId("旧部署用 FTP", { triggers: ["部署协议"] });
    await m.retractEntry({ path: "MEMORY.md", id, reason: "已迁移" });

    const hidden = await m.search("旧部署用 FTP", { lexicalOnly: true, sources: ["memory"], minScore: 0 });
    expect(hidden).toHaveLength(0);

    const visible = await m.search("旧部署用 FTP", {
      lexicalOnly: true,
      sources: ["memory"],
      minScore: 0,
      includeRetracted: true,
    });
    expect(visible.some((hit) => hit.retracted === true)).toBe(true);
  });

  it("显式 supersedes 隐藏旧条目，读取时给出 supersededBy", async () => {
    const m = manager();
    const old = await m.appendEntryWithId("默认分支是 master", { triggers: ["默认分支"] });
    await m.appendEntryWithId("默认分支已改为 main", {
      triggers: ["默认分支"],
      supersedes: [old.id],
    });

    const results = await m.search("默认分支", { lexicalOnly: true, sources: ["memory"], minScore: 0 });
    expect(results.some((hit) => hit.snippet.includes("master"))).toBe(false);
    expect(results.some((hit) => hit.snippet.includes("main"))).toBe(true);

    const all = await m.search("默认分支", {
      lexicalOnly: true,
      sources: ["memory"],
      minScore: 0,
      includeRetracted: true,
    });
    const oldHit = all.find((hit) => hit.entryId === old.id);
    expect(oldHit?.supersededBy).toBeDefined();
  });

  it("过期条目仍可检索但标记 stale，检索结果携带出处字段", async () => {
    const m = manager();
    await m.appendEntryWithId("本季度目标是十万用户", {
      triggers: ["季度目标"],
      provenance: "周会纪要",
      asOf: "2026-01-01",
      validUntil: "2026-03-31",
    });
    const results = await m.search("本季度目标", {
      lexicalOnly: true,
      sources: ["memory"],
      minScore: 0,
      nowMs: Date.UTC(2026, 10, 10),
    });
    const hit = results.find((entry) => entry.snippet.includes("十万用户"));
    expect(hit?.stale).toBe(true);
    expect(hit?.provenance).toBe("周会纪要");
    expect(hit?.asOf).toBe("2026-01-01");
    expect(hit?.validUntil).toBe("2026-03-31");
  });
});

describe("撤回与巡检", () => {
  it("按 id/行号撤回，重复撤回幂等，且写回注释", async () => {
    const m = manager();
    const { id } = await m.appendEntryWithId("待撤回事实", {});
    const byId = await m.retractEntry({ path: "MEMORY.md", id, reason: "用户否认" });
    expect(byId.alreadyRetracted).toBe(false);
    expect(byId.text).toBe("- 待撤回事实");
    expect((await readMemory()).includes("<!-- retracted:")).toBe(true);

    const again = await m.retractEntry({ path: "MEMORY.md", id });
    expect(again.alreadyRetracted).toBe(true);

    const byLine = await m.retractEntry({ path: "MEMORY.md", line: byId.line });
    expect(byLine.alreadyRetracted).toBe(true);

    await expect(m.retractEntry({ path: "MEMORY.md", id: "mem_missing" })).rejects.toThrow(/找不到/u);
    await expect(m.retractEntry({ path: "MEMORY.md" })).rejects.toThrow(/id 或 line/u);
  });

  it("auditEntries 汇总撤回/取代/过期条目并给出可定位行号", async () => {
    const m = manager();
    const old = await m.appendEntryWithId("旧事实", {});
    await m.appendEntryWithId("新事实", { supersedes: [old.id] });
    const retired = await m.appendEntryWithId("撤回事实", {});
    await m.retractEntry({ path: "MEMORY.md", id: retired.id });
    await m.appendEntryWithId("过期事实", { validUntil: "2020-01-01" });

    const report = await m.auditEntries(Date.UTC(2026, 10, 10));
    expect(report.retracted).toBe(1);
    expect(report.superseded).toBe(1);
    expect(report.stale).toBe(1);
    expect(report.entries).toBeGreaterThanOrEqual(4);
    expect(report.findings.map((finding) => finding.issue).sort()).toEqual(
      ["retracted", "stale", "superseded"],
    );
    for (const finding of report.findings) {
      expect(finding.path).toBe("MEMORY.md");
      expect(finding.startLine).toBeGreaterThanOrEqual(1);
      expect(finding.excerpt.length).toBeGreaterThan(0);
    }
  });
});

describe("触发召回：不注入失效记忆", () => {
  it("撤回/过期/被取代的条目都不参与自动注入", async () => {
    const m = manager();
    const retracted = await m.appendEntryWithId("生产库连接串已轮换", { triggers: ["部署方式"] });
    await m.retractEntry({ path: "MEMORY.md", id: retracted.id });
    await m.appendEntryWithId("部署方式早已改为容器", {
      triggers: ["部署方式"],
      validUntil: "2020-01-01",
    });
    const replaced = await m.appendEntryWithId("部署方式是手工上传", { triggers: ["部署方式"] });
    await m.appendEntryWithId("部署方式改用 CI 流水线", {
      triggers: ["部署方式"],
      supersedes: [replaced.id],
    });

    const recall = await resolveTriggerRecall({
      manager: m,
      message: "部署方式 现状",
    });
    expect(recall.injectedCount).toBe(1);
    expect(recall.matches).toHaveLength(1);
    expect(recall.matches[0]?.excerpt).toContain("CI 流水线");
    expect(recall.context).not.toContain("连接串");
    expect(recall.context).not.toContain("手工上传");
    expect(recall.context).not.toContain("容器");
  });
});

describe("工具契约：memory_append / memory_retract", () => {
  const abortSignal = new AbortController().signal;

  function byName(): Map<string, { execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string> }> {
    return new Map(buildMemoryTools(manager()).map((tool) => [tool.schema.name, tool]));
  }

  it("memory_append 回执带 entryId，出处与时效落进条目注释", async () => {
    const tools = byName();
    const out = JSON.parse(
      await tools.get("memory_append")!.execute(
        {
          text: "生产环境数据库是 PostgreSQL 16",
          triggers: ["生产数据库"],
          source: "群聊 #12",
          asOf: "2026-10-01",
          validUntil: "2027-10-01",
        },
        abortSignal,
      ),
    );
    expect(out.status).toBe("ok");
    expect(out.entryId).toMatch(/^mem_/u);
    const raw = await readMemory();
    expect(raw).toContain("<!-- source: 群聊 #12 -->");
    expect(raw).toContain("<!-- as-of: 2026-10-01 -->");
    expect(raw).toContain("<!-- valid-until: 2027-10-01 -->");
    expect(raw).toContain(`<!-- id: ${out.entryId} -->`);
  });

  it("memory_append 非法日期抛 invalid_argument，且不落盘", async () => {
    const tools = byName();
    const failure = await tools
      .get("memory_append")!
      .execute({ text: "坏日期事实", asOf: "2026-02-30" }, abortSignal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolFailure);
    expect((failure as ToolFailure).code).toBe("invalid_argument");
    expect(await readMemory()).not.toContain("坏日期事实");
  });

  it("memory_retract 按 entryId 撤回，缺 id/line 报 invalid_argument，未知 id 报 not_found", async () => {
    const tools = byName();
    const appended = JSON.parse(
      await tools.get("memory_append")!.execute({ text: "临时结论待复核" }, abortSignal),
    );
    const retracted = JSON.parse(
      await tools.get("memory_retract")!.execute(
        { path: "MEMORY.md", id: appended.entryId, reason: "复核失败" },
        abortSignal,
      ),
    );
    expect(retracted.status).toBe("ok");
    expect(retracted.alreadyRetracted).toBe(false);
    expect(await readMemory()).toContain("<!-- retracted:");

    const missingArgs = await tools
      .get("memory_retract")!
      .execute({ path: "MEMORY.md" }, abortSignal)
      .catch((error: unknown) => error);
    expect((missingArgs as ToolFailure).code).toBe("invalid_argument");

    const missingId = await tools
      .get("memory_retract")!
      .execute({ path: "MEMORY.md", id: "mem_missing" }, abortSignal)
      .catch((error: unknown) => error);
    expect((missingId as ToolFailure).code).toBe("not_found");
  });

  it("memory_search 结果透出 entryId / provenance / stale", async () => {
    const m = manager();
    await m.appendEntryWithId("季度目标是十万用户", {
      triggers: ["季度目标"],
      provenance: "周会纪要",
      validUntil: "2020-01-01",
    });
    const tools = new Map(buildMemoryTools(m).map((tool) => [tool.schema.name, tool]));
    const out = JSON.parse(
      await tools.get("memory_search")!.execute({ query: "季度目标", min_score: 0 }, abortSignal),
    );
    const hit = out.results.find((entry: { snippet: string }) => entry.snippet.includes("十万用户"));
    expect(hit.entryId).toMatch(/^mem_/u);
    expect(hit.provenance).toBe("周会纪要");
    expect(hit.stale).toBe(true);
  });
});

describe("成员记忆作用域仍生效", () => {
  it("子成员写入到自己的 MEMORY.md，共享检索看不到", async () => {
    const m = manager();
    await mkdir(join(dir, "agents/m_a"), { recursive: true });
    await m.appendEntryWithId("成员私有事实", { triggers: ["私有"] }, { agentId: "m_a" });
    const own = await readFile(join(dir, "agents/m_a/MEMORY.md"), "utf8");
    expect(own).toContain("成员私有事实");

    const shared = await m.search("成员私有事实", {
      lexicalOnly: true,
      sources: ["memory"],
      minScore: 0,
    });
    expect(shared).toHaveLength(0);
  });
});
