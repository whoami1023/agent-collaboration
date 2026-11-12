// 运行级检查点：快照 + 追加日志的重建、断点续跑只重跑只读调用、保留策略与坏文件兜底。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunJournalStore } from "../src/agent/run-journal";
import { runAgentLoop, type ToolImpl } from "../src/agent/loop";
import { MockProvider } from "../src/provider/mock";
import type { LlmMessage, ToolCall } from "../src/provider/types";

const tempDirs: string[] = [];
const INITIAL: LlmMessage[] = [{ role: "user", content: "开始" }];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ac-journal-"));
  tempDirs.push(dir);
  return dir;
}

function call(id: string, name: string): ToolCall {
  return { id, name, args: { key: id } };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RunJournalStore：记录与重建", () => {
  it("已完成的回合与工具结果按顺序重建，终局后不再续跑", async () => {
    const store = new RunJournalStore(join(await makeDir(), "journals"));
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_a",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    expect(recorder).not.toBeNull();
    recorder.assistant(0, "", [call("call_1", "file_list")]);
    recorder.toolResult(0, call("call_1", "file_list"), "a.md\nb.md", { ok: true });
    recorder.assistant(1, "整理完成", []);
    recorder.finish({ status: "ok", text: "整理完成", steps: 2 });

    const loaded = store.load("run_a")!;
    expect(loaded.done).toBe(true);
    expect(loaded.steps).toBe(2);
    expect(loaded.pendingCalls).toEqual([]);
    expect(loaded.initialMessages).toEqual(INITIAL);
    expect(loaded.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(loaded.messages[1]?.content).toBe("a.md\nb.md");
    expect(loaded.summary.replayedTools).toBe(1);
    expect(loaded.terminal?.status).toBe("ok");
  });

  it("挂起停留在等待用户回答：日志保持未完成，可长期保留并续跑", async () => {
    const store = new RunJournalStore(join(await makeDir(), "journals"));
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_paused",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    const askCall = call("call_ask", "ask_user");
    recorder.assistant(0, "", [askCall]);
    recorder.toolResult(0, askCall, "本轮已挂起，等待用户回答", { ok: true });
    recorder.pause({ questionId: "ask_1", messageId: "msg_1" });

    const loaded = store.load("run_paused")!;
    expect(loaded.done).toBe(false);
    expect(loaded.paused).toEqual({ questionId: "ask_1", messageId: "msg_1" });
    expect(loaded.pendingCalls).toEqual([]);
    expect(loaded.messages.at(-1)?.content).toBe("本轮已挂起，等待用户回答");
    expect(store.listRuns().find((run) => run.runId === "run_paused")?.paused).toBe(true);

    // 回答后续跑同一份日志，最终可以正常收尾。
    const resumed = store.start({
      roomId: "room_test",
      runId: "run_paused",
      memberId: "m_main",
      initialMessages: INITIAL,
      resumeFrom: loaded,
    })!;
    expect(resumed.resumed).toBe(true);
    resumed.assistant(1, "继续完成", []);
    resumed.finish({ status: "ok", text: "继续完成", steps: 2 });
    const final = store.load("run_paused")!;
    expect(final.done).toBe(true);
    expect(final.paused).toBeUndefined();
    expect(final.messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("中断在工具批次中间：只剩没有结果的调用，已完成的不再重跑", async () => {
    const store = new RunJournalStore(join(await makeDir(), "journals"));
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_b",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    const first = call("call_a", "file_read");
    const second = call("call_b", "file_write");
    recorder.assistant(0, "", [first, second]);
    recorder.toolResult(0, first, "文件内容", { ok: true });
    // 进程在第二个调用返回前被杀：没有 finish，也没有第二条 tool 结果。

    const loaded = store.load("run_b")!;
    expect(loaded.done).toBe(false);
    expect(loaded.steps).toBe(1);
    expect(loaded.pendingCalls.map((entry) => entry.id)).toEqual(["call_b"]);
    expect(loaded.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("周期性快照轮转后仍能完整重建", async () => {
    const store = new RunJournalStore(join(await makeDir(), "journals"), { snapshotEvery: 2 });
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_rotate",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    for (let step = 0; step < 3; step += 1) {
      const current = call(`call_${step}`, "file_list");
      recorder.assistant(step, `第 ${step} 步`, [current]);
      recorder.toolResult(step, current, `结果 ${step}`, { ok: true });
    }
    const loaded = store.load("run_rotate")!;
    expect(loaded.steps).toBe(3);
    expect(loaded.pendingCalls).toEqual([]);
    // 3 个 assistant + 3 个 tool；轮转把早期日志收进了快照。
    expect(loaded.messages).toHaveLength(6);
    expect(loaded.lastN).toBe(6);
  });

  it("检查点只算完整回合；分叉保留前缀、接上新指令且不动原日志", async () => {
    const dir = join(await makeDir(), "journals");
    const store = new RunJournalStore(dir);
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_fork",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    recorder.assistant(0, "第一问", [call("call_1", "file_read")]);
    recorder.toolResult(0, call("call_1", "file_read"), "结果一", { ok: true });
    recorder.assistant(1, "第二问", [call("call_2", "file_read")]);
    recorder.toolResult(1, call("call_2", "file_read"), "结果二", { ok: true });
    // 第三步只有调用没有结果：不能当作分叉点。
    recorder.assistant(2, "", [call("call_3", "file_write")]);

    const checkpoints = store.checkpoints("run_fork");
    expect(checkpoints.map((checkpoint) => checkpoint.step)).toEqual([0, 1, 2]);
    expect(checkpoints[2]?.calls).toEqual(["file_read"]);

    const forked = store.fork("run_fork", 1, "换个方向继续")!;
    expect(forked.runId).not.toBe("run_fork");
    expect(forked.steps).toBe(1);
    expect(forked.messages.map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
    expect(forked.messages.at(-1)?.content).toBe("换个方向继续");
    expect(forked.messages.some((message) => message.content === "结果二")).toBe(false);

    const reloaded = store.load(forked.runId)!;
    expect(reloaded.messages).toEqual(forked.messages);
    expect(reloaded.done).toBe(false);
    expect(reloaded.lastN).toBe(0);
    // 原日志原样保留，仍然是三步。
    expect(store.load("run_fork")?.steps).toBe(3);

    // 步数超出末尾时落到最后一个完整检查点，不把半截步骤带进分支。
    const tail = store.fork("run_fork", 99, "从最后继续")!;
    expect(tail.steps).toBe(2);
    expect(tail.messages.some((message) => message.content === "结果二")).toBe(true);
    expect(tail.messages.some((message) => message.content === "结果一")).toBe(true);

    const runs = store.listRuns();
    expect(runs.map((run) => run.runId)).toContain("run_fork");
    expect(runs.map((run) => run.runId)).toContain(forked.runId);
    expect(runs.every((run) => run.memberId === "m_main")).toBe(true);
  });

  it("续跑在同一份日志上追加，最终快照包含前后两段", async () => {
    const dir = join(await makeDir(), "journals");
    const store = new RunJournalStore(dir);
    const first = store.start({
      roomId: "room_test",
      runId: "run_resume",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    const pending = call("call_1", "file_read");
    first.assistant(0, "", [pending]);
    first.toolResult(0, pending, "旧结果", { ok: true });

    const loaded = store.load("run_resume")!;
    const second = store.start({
      roomId: "room_test",
      runId: "run_resume",
      memberId: "m_main",
      initialMessages: INITIAL,
      resumeFrom: loaded,
    })!;
    second.assistant(1, "继续完成", []);
    second.finish({ status: "ok", text: "继续完成", steps: 2 });

    const final = store.load("run_resume")!;
    expect(final.done).toBe(true);
    expect(final.messages.map((message) => message.content)).toEqual(["", "旧结果", "继续完成"]);
    expect(final.steps).toBe(2);
  });

  it("非法 runId 与损坏快照都不会拖垮运行", async () => {
    const root = await makeDir();
    const store = new RunJournalStore(join(root, "journals"));
    expect(store.start({
      roomId: "room_test",
      runId: "../escape",
      memberId: "m_main",
      initialMessages: INITIAL,
    })).toBeNull();
    expect(store.load("../escape")).toBeNull();

    await mkdir(join(root, "journals"), { recursive: true });
    await writeFile(join(root, "journals", "run_bad.snapshot.json"), "{not json");
    expect(store.load("run_bad")).toBeNull();
  });

  it("保留策略：最近 maxRuns 份，已完成的过期日志被清掉", async () => {
    const root = await makeDir();
    const dir = join(root, "journals");
    let clock = 1_000;
    const store = new RunJournalStore(dir, { maxRuns: 2, now: () => clock });
    const record = (runId: string): void => {
      const recorder = store.start({
        roomId: "room_test",
        runId,
        memberId: "m_main",
        initialMessages: INITIAL,
      })!;
      recorder.assistant(0, runId, []);
      recorder.finish({ status: "ok", text: runId, steps: 1 });
    };
    record("run_1");
    clock += 1_000;
    record("run_2");
    clock += 1_000;
    record("run_3");
    store.prune();
    expect(readdirSync(dir).filter((name) => name.endsWith(".snapshot.json"))).toHaveLength(2);
    expect(store.load("run_1")).toBeNull();
    expect(store.load("run_3")).not.toBeNull();

    // 完成的日志过了保留期后，即使份数没超也会被清掉。
    clock += 8 * 24 * 60 * 60 * 1000;
    store.prune();
    expect(readdirSync(dir).filter((name) => name.endsWith(".snapshot.json"))).toHaveLength(0);
  });

  it("日志只落模型实际看到的内容，不写系统提示词", async () => {
    const dir = join(await makeDir(), "journals");
    const store = new RunJournalStore(dir);
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_secret",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    recorder.assistant(0, "回答", []);
    recorder.finish({ status: "ok", text: "回答", steps: 1 });
    const raw = await readFile(join(dir, "run_secret.snapshot.json"), "utf8");
    expect(raw).toContain("开始");
    expect(raw).not.toContain("system");
  });
});

describe("循环断点续跑", () => {
  function fixture(): { readTool: ToolImpl; writeTool: ToolImpl; counts: { read: number; write: number } } {
    const counts = { read: 0, write: 0 };
    const readTool: ToolImpl = {
      schema: { name: "file_read", description: "读", parameters: { type: "object", properties: {} } },
      retry: "safe",
      execute: async () => {
        counts.read += 1;
        return "重跑后读到的内容";
      },
    };
    const writeTool: ToolImpl = {
      schema: { name: "file_write", description: "写", parameters: { type: "object", properties: {} } },
      retry: "never",
      execute: async () => {
        counts.write += 1;
        return "写入了";
      },
    };
    return { readTool, writeTool, counts };
  }

  it("只重跑只读调用；有副作用的调用标记结果未知并留在上下文里", async () => {
    const dir = join(await makeDir(), "journals");
    const store = new RunJournalStore(dir);
    const previous = store.start({
      roomId: "room_test",
      runId: "run_loop",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    const readCall = call("call_read", "file_read");
    const writeCall = call("call_write", "file_write");
    previous.assistant(0, "", [readCall, writeCall]);
    const loaded = store.load("run_loop")!;
    expect(loaded.pendingCalls).toHaveLength(2);

    const { readTool, writeTool, counts } = fixture();
    const seen: LlmMessage[] = [];
    const recorder = store.start({
      roomId: "room_test",
      runId: "run_loop",
      memberId: "m_main",
      initialMessages: INITIAL,
      resumeFrom: loaded,
    })!;
    const result = await runAgentLoop({
      provider: new MockProvider((request) => {
        seen.push(...request.messages);
        return { text: "汇总完成" };
      }),
      model: "mock",
      system: "测试",
      messages: INITIAL,
      tools: [readTool, writeTool],
      maxSteps: 4,
      signal: new AbortController().signal,
      journal: recorder,
      resume: {
        messages: loaded.messages,
        pendingCalls: loaded.pendingCalls,
        steps: loaded.steps,
      },
    });
    recorder.finish({ status: "ok", text: result.text, steps: result.steps });

    expect(counts).toEqual({ read: 1, write: 0 });
    expect(result.text).toBe("汇总完成");
    const writeResult = seen.find(
      (message) => message.role === "tool" && message.toolCallId === writeCall.id,
    );
    expect(writeResult?.content).toContain("无法确认");
    const readResult = seen.find(
      (message) => message.role === "tool" && message.toolCallId === readCall.id,
    );
    expect(readResult?.content).toBe("重跑后读到的内容");

    const final = store.load("run_loop")!;
    expect(final.done).toBe(true);
    expect(final.pendingCalls).toEqual([]);
    expect(final.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("全部调用都有结果时不会再次请求工具，直接从下一步继续", async () => {
    const dir = join(await makeDir(), "journals");
    const store = new RunJournalStore(dir);
    const previous = store.start({
      roomId: "room_test",
      runId: "run_clean",
      memberId: "m_main",
      initialMessages: INITIAL,
    })!;
    const done = call("call_done", "file_read");
    previous.assistant(0, "", [done]);
    previous.toolResult(0, done, "已完成的结果", { ok: true });
    const loaded = store.load("run_clean")!;

    const { readTool, writeTool, counts } = fixture();
    const requests: LlmMessage[][] = [];
    const result = await runAgentLoop({
      provider: new MockProvider((request) => {
        requests.push(request.messages);
        return { text: "接着做完了" };
      }),
      model: "mock",
      system: "测试",
      messages: INITIAL,
      tools: [readTool, writeTool],
      maxSteps: 4,
      signal: new AbortController().signal,
      resume: {
        messages: loaded.messages,
        pendingCalls: loaded.pendingCalls,
        steps: loaded.steps,
      },
    });
    expect(counts).toEqual({ read: 0, write: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.some((message) => message.content === "已完成的结果")).toBe(true);
    expect(result.text).toBe("接着做完了");
  });
});
