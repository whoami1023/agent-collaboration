import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionArchives } from "../src/archive/session-archive";
import type { SessionArchiveSummary } from "../src/core/types";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";

let dir: string;
let archives: SessionArchives;
let bus: RoomBus;
let board: Workboard;

function say(text: string) {
  return bus.append({ senderId: "user", senderName: "老板", senderKind: "user", text });
}

async function writeLiveFile(relPath: string, content: string): Promise<void> {
  const abs = join(dir, "files", relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

async function readLiveFile(relPath: string): Promise<string> {
  return readFile(join(dir, "files", relPath), "utf8");
}

async function exists(relPath: string): Promise<boolean> {
  try {
    await readFile(join(dir, "files", relPath));
    return true;
  } catch {
    return false;
  }
}

function input() {
  const snapshot = bus.snapshot();
  return {
    roomName: bus.roomName,
    seq: snapshot.seq,
    messages: snapshot.messages,
    tasks: board.list(),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-archive-"));
  archives = new SessionArchives(dir);
  bus = new RoomBus("room_1", "老板的作战室");
  board = new Workboard("room_1");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("会话归档采集", () => {
  it("把消息、任务卡与文件整体收进归档，文件是移走而不是复制", async () => {
    say("帮我调研多智能体协同");
    say("再补一份对比表");
    board.create({ title: "调研报告", createdBy: "user" });
    await writeLiveFile("report.md", "# 调研");
    await writeLiveFile("data/raw.csv", "a,b");

    const summary = await archives.capture(input());
    expect(summary).not.toBeNull();
    expect(summary!.roomName).toBe("老板的作战室");
    expect(summary!.messageCount).toBe(2);
    expect(summary!.taskCount).toBe(1);
    expect(summary!.fileCount).toBe(2);
    expect(summary!.totalBytes).toBe(Buffer.byteLength("# 调研") + Buffer.byteLength("a,b"));

    const detail = await archives.read(summary!.id);
    expect(detail.seq).toBe(2);
    expect(detail.messages.map((message) => message.text)).toEqual([
      "帮我调研多智能体协同",
      "再补一份对比表",
    ]);
    expect(detail.tasks.map((task) => task.title)).toEqual(["调研报告"]);
    expect(detail.files.map((file) => file.path)).toEqual(["data/raw.csv", "report.md"]);

    // 归档里的文件是真实移走的：工作区里同名文件不再存在，原内容只在归档目录里。
    expect(await exists("report.md")).toBe(false);
    expect((await readdir(join(dir, "archives", summary!.id, "files"))).sort()).toEqual([
      "data",
      "report.md",
    ]);
    const manifest = JSON.parse(
      await readFile(join(dir, "archives", summary!.id, "manifest.json"), "utf8"),
    ) as { seq: number; id: string };
    expect(manifest.seq).toBe(2);
    expect(manifest.id).toBe(summary!.id);
  });

  it("消息、任务卡与文件都为空时不生成空归档", async () => {
    expect(await archives.capture(input())).toBeNull();
    expect(await archives.list()).toEqual([]);
  });

  it("技能脚本缓存目录 .skill-runtime 不进归档", async () => {
    say("跑一下技能脚本");
    await writeLiveFile(".skill-runtime/run.py", "print(1)");
    await writeLiveFile("out.md", "成果");

    const summary = await archives.capture(input());
    expect(summary!.fileCount).toBe(1);
    expect((await archives.read(summary!.id)).files.map((file) => file.path)).toEqual(["out.md"]);
    expect(await exists(".skill-runtime/run.py")).toBe(true);
  });
});

describe("会话归档恢复", () => {
  let first: SessionArchiveSummary;

  beforeEach(async () => {
    say("第一轮：调研");
    board.create({ title: "调研报告", createdBy: "user" });
    await writeLiveFile("report.md", "第一轮的结论");
    const captured = await archives.capture(input());
    expect(captured).not.toBeNull();
    first = captured!;
    bus.clearMessages();
    board.clearAll();
  });

  it("恢复把消息、任务卡与文件放回作战室，并改写归档里剩余的文件数", async () => {
    const result = await archives.restore(first.id);
    expect(result.restoredFiles).toEqual(["report.md"]);
    expect(result.conflicts).toEqual([]);
    expect(result.archive.messages.map((message) => message.text)).toEqual(["第一轮：调研"]);
    expect(result.archive.tasks.map((task) => task.title)).toEqual(["调研报告"]);
    expect(result.archive.fileCount).toBe(0);
    expect(result.archive.totalBytes).toBe(0);
    expect(result.archive.files).toEqual([]);

    expect(await readLiveFile("report.md")).toBe("第一轮的结论");
    // 摘要跟着改写：列表不会再报出早已移走的文件。
    const listed = await archives.list();
    expect(listed[0]).toMatchObject({ id: first.id, messageCount: 1, taskCount: 1, fileCount: 0 });

    // 会话内容仍在，所以同一份归档还能再恢复一次；文件已经移走，第二次只放回记录。
    const again = await archives.restore(first.id);
    expect(again.restoredFiles).toEqual([]);
    expect(again.archive.messages.length).toBe(1);
  });

  it("工作区已有同名文件时记为冲突，保留当前版本不覆盖", async () => {
    await writeLiveFile("report.md", "这一轮的版本");
    const result = await archives.restore(first.id);
    expect(result.conflicts).toEqual(["report.md"]);
    expect(result.restoredFiles).toEqual([]);
    expect(await readLiveFile("report.md")).toBe("这一轮的版本");
    expect(result.archive.fileCount).toBe(1);
    expect((await archives.read(first.id)).files.map((file) => file.path)).toEqual(["report.md"]);
  });
});

describe("归档列表与删除", () => {
  it("按时间从新到旧列出，只读摘要", async () => {
    say("第一轮");
    await writeLiveFile("a.md", "A");
    const older = await archives.capture(input());
    bus.clearMessages();
    say("第二轮");
    await writeLiveFile("b.md", "B");
    const newer = await archives.capture(input());

    const listed = await archives.list();
    expect(listed.map((archive) => archive.id)).toEqual([newer!.id, older!.id]);
    expect(listed[0]).not.toHaveProperty("messages");
    expect(listed[1]!.fileCount).toBe(1);
  });

  it("删除后归档目录整体消失", async () => {
    say("要丢掉的一轮");
    await writeLiveFile("a.md", "A");
    const captured = (await archives.capture(input()))!;
    const removed = await archives.remove(captured.id);
    expect(removed.id).toBe(captured.id);
    expect(await archives.list()).toEqual([]);
    await expect(readdir(join(dir, "archives", captured.id))).rejects.toThrow();
  });

  it("归档不存在与 ID 不合法分别报错", async () => {
    await expect(archives.read("arch_000000000000")).rejects.toThrow("归档不存在");
    await expect(archives.restore("../../../etc")).rejects.toThrow("归档 ID 不合法");
    expect(await archives.list()).toEqual([]);
  });
});
