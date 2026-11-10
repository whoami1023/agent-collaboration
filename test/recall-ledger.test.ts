import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallLedger, findCitedRecallHits } from "../src/memory/recall-ledger";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-ledger-"));
  file = join(dir, "recall-ledger.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const context = { roomId: "room_main", agentId: "m_main", runId: "run_1" };

describe("引用识别", () => {
  const hits = [
    { path: "MEMORY.md", startLine: 3, endLine: 3, entryId: "mem_a", citation: "MEMORY.md#L3", score: 0.9 },
    { path: "memory/notes.md", startLine: 10, endLine: 12, entryId: "mem_b", citation: "memory/notes.md#L10", score: 0.7 },
  ];

  it("Source 引用按行区间重叠匹配，路径不同的不算", () => {
    expect(findCitedRecallHits("依据是 Source: MEMORY.md#L3。", hits).map((hit) => hit.path)).toEqual([
      "MEMORY.md",
    ]);
    expect(
      findCitedRecallHits("见 Source: memory/notes.md#L11-L12。", hits).map((hit) => hit.path),
    ).toEqual(["memory/notes.md"]);
    expect(findCitedRecallHits("见 Source: memory/notes.md#L13。", hits)).toHaveLength(0);
    expect(findCitedRecallHits("见 Source: USER.md#L3。", hits)).toHaveLength(0);
  });

  it("没有引用或重复引用时结果稳定", () => {
    expect(findCitedRecallHits("没有任何引用的回答。", hits)).toHaveLength(0);
    const duplicated = findCitedRecallHits(
      "Source: MEMORY.md#L3 与 Source: MEMORY.md#L3",
      hits,
    );
    expect(duplicated).toHaveLength(1);
  });
});

describe("账本读写", () => {
  it("按顺序追加 volunteered/used，list 还原结构，坏行跳过", async () => {
    const ledger = new RecallLedger(file, undefined, () => 1_700_000_000_000);
    ledger.record(
      ledger.volunteeredEvents(context, "上周的数据库决定是什么？", [
        { path: "MEMORY.md", startLine: 3, endLine: 3, entryId: "mem_a", score: 0.81234 },
      ]),
    );
    ledger.record(
      ledger.usedEvents(context, [{ path: "MEMORY.md", startLine: 3, endLine: 3, entryId: "mem_a" }]),
    );
    await ledger.flush();
    await writeFile(file, `${await readFile(file, "utf8")}not-json\n`, "utf8");

    const events = await ledger.list();
    expect(events.map((event) => event.type)).toEqual(["volunteered", "used"]);
    expect(events[0]).toMatchObject({
      ts: 1_700_000_000_000,
      roomId: "room_main",
      agentId: "m_main",
      runId: "run_1",
      path: "MEMORY.md",
      startLine: 3,
      entryId: "mem_a",
      citation: "MEMORY.md#L3",
      query: "上周的数据库决定是什么？",
      score: 0.812,
    });
  });

  it("compact 只保留最近 N 条，并汇报丢弃数", async () => {
    const ledger = new RecallLedger(file);
    for (let index = 0; index < 5; index += 1) {
      ledger.record(
        ledger.usedEvents(context, [{ path: "MEMORY.md", startLine: index + 1 }]),
      );
    }
    await ledger.flush();
    const result = await ledger.compact(2);
    expect(result).toEqual({ kept: 2, dropped: 3 });
    const remaining = await ledger.list();
    expect(remaining.map((event) => event.startLine)).toEqual([4, 5]);
    // 压缩后仍可继续追加。
    ledger.record(ledger.usedEvents(context, [{ path: "MEMORY.md", startLine: 9 }]));
    await ledger.flush();
    expect((await ledger.list()).map((event) => event.startLine)).toEqual([4, 5, 9]);
  });

  it("清单不存在时返回空，不抛错", async () => {
    const ledger = new RecallLedger(join(dir, "missing.jsonl"));
    await expect(ledger.list()).resolves.toEqual([]);
  });
});
