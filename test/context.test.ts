// P4 移植（OpenClaw token 预算与自动压缩）的行为测试。
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateStringCharsWithMinimumRawWeight,
  estimateTokensFromChars,
} from "../src/agent/context/cjk-chars";
import { sliceUtf16Safe, truncateUtf16Safe } from "../src/agent/context/utf16-slice";
import {
  isValidNonNegativeByteSizeString,
  parseByteSize,
  parseNonNegativeByteSize,
} from "../src/agent/context/byte-size";
import {
  classifyToolUseResultPairing,
  createToolCallOccurrenceQueue,
} from "../src/agent/context/tool-pairing";
import { estimateContextTokens, estimateTokens } from "../src/agent/context/token-estimate";
import { findCutPoint, findTurnStartIndex } from "../src/agent/context/cut-point";
import {
  capCompactionSummary,
  fitCompactionSummary,
  compact,
  compactWithoutSummary,
  prepareCompaction,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  COMPACTION_SUMMARY_MARKER,
  MAX_LATEST_USER_REQUEST_CHARS,
  buildCompactionSummaryMessage,
  extractLatestUserRequest,
  isCompactionSummaryMessage,
  readCompactionSummary,
  extractFileListsFromSummary,
} from "../src/agent/context/compaction";
import {
  BOUNDED_CONTEXT_NOTICE,
  boundTranscriptAssembly,
  refreshTranscriptByteCompactionLatch,
  resolveMaxActiveTranscriptBytes,
} from "../src/agent/context/bounded-context";
import {
  MAX_SUMMARY_INPUT_CHARS,
  serializeConversation,
  serializeConversationWithinBudget,
} from "../src/agent/context/utils";
import { applyContextBudget } from "../src/agent/context/budget";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../src/agent/context/summarization";
import { runAgentLoop, type ToolImpl } from "../src/agent/loop";
import { MockProvider } from "../src/provider/mock";
import type { LlmMessage, LlmRequest } from "../src/provider/types";

function user(text: string): LlmMessage {
  return { role: "user", content: text };
}
function assistant(text: string, calls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>): LlmMessage {
  return {
    role: "assistant",
    content: text,
    ...(calls ? { toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })) } : {}),
  };
}
function tool(id: string, content: string): LlmMessage {
  return { role: "tool", toolCallId: id, content };
}

describe("cjk-chars 权重估算", () => {
  it("ASCII 按原始长度，常见 CJK 按每字 4 计", () => {
    expect(estimateStringChars("abcd")).toBe(4);
    expect(estimateStringChars("中文")).toBe(2 * CHARS_PER_TOKEN_ESTIMATE);
    expect(estimateTokensFromChars(CHARS_PER_TOKEN_ESTIMATE * 3)).toBe(3);
  });
  it("罕见 BMP（扩展 A）与兼容区取更高权重", () => {
    expect(estimateStringChars("㐀")).toBe(1 + (CHARS_PER_TOKEN_ESTIMATE * 3 - 1));
    expect(estimateStringChars("（")).toBe(1 + (CHARS_PER_TOKEN_ESTIMATE - 1));
  });
  it("minimumRawWeight 提供原始长度下限且不重复乘 CJK 调整", () => {
    const weighted = estimateStringCharsWithMinimumRawWeight("abc中", { minimumRawWeight: 3 });
    expect(weighted).toBeGreaterThanOrEqual(estimateStringChars("abc中"));
    expect(weighted).toBe(3 * 3 + 1 + (CHARS_PER_TOKEN_ESTIMATE - 1));
  });
});

describe("utf16 安全切片", () => {
  it("切片与截断不会落在代理对中间", () => {
    const text = "\u{1F600}x";
    expect(sliceUtf16Safe(text, 1)).toBe("x");
    expect(truncateUtf16Safe(text, 1)).toBe("");
    expect(truncateUtf16Safe(text, 2)).toBe("\u{1F600}");
  });
});

describe("字节大小解析", () => {
  it("支持 b/kb/mb/gb/tb 与裸数字", () => {
    expect(parseByteSize("500")).toBe(500);
    expect(parseByteSize("512kb")).toBe(524288);
    expect(parseByteSize("10MB")).toBe(10485760);
    expect(parseByteSize("2.5m")).toBe(2621440);
  });
  it("非法输入抛错；配置解析降级为 null", () => {
    expect(() => parseByteSize("12xib")).toThrow(/Invalid byte size/);
    expect(() => parseByteSize("")).toThrow(/empty/);
    expect(parseNonNegativeByteSize("2mb")).toBe(2097152);
    expect(parseNonNegativeByteSize(-4)).toBe(null);
    expect(parseNonNegativeByteSize(1.9)).toBe(1);
    expect(parseNonNegativeByteSize("oops")).toBe(null);
    expect(isValidNonNegativeByteSizeString("1gb")).toBe(true);
    expect(resolveMaxActiveTranscriptBytes("2mb")).toBe(2097152);
    expect(resolveMaxActiveTranscriptBytes(0)).toBeUndefined();
    expect(resolveMaxActiveTranscriptBytes(undefined)).toBeUndefined();
  });
});

describe("工具调用/结果配对", () => {
  it("按 id 认领最早未答复的调用，重复 id 各自配对", () => {
    const messages: LlmMessage[] = [
      user("go"),
      assistant("", [
        { id: "c1", name: "search" },
        { id: "c1", name: "search" },
      ]),
      tool("c1", "first"),
      tool("c1", "second"),
    ];
    const frames = classifyToolUseResultPairing(messages);
    expect(frames).toHaveLength(1);
    const occurrences = frames[0]!.occurrences;
    expect(occurrences.map((o) => o.sourceResult?.content)).toEqual(["first", "second"]);
    expect(occurrences.map((o) => o.sourceResultIndex)).toEqual([2, 3]);
  });
  it("无 id 的孤立结果可被单调用帧按遗留规则认领", () => {
    const messages: LlmMessage[] = [
      assistant("", [{ id: "solo", name: "read" }]),
      { role: "tool", content: "orphan-without-id" },
    ];
    const frames = classifyToolUseResultPairing(messages);
    expect(frames[0]!.occurrences[0]!.sourceResultIndex).toBe(1);
  });
  it("occurrence 队列按 id 分桶并支持清空", () => {
    const queue = createToolCallOccurrenceQueue<number>();
    queue.add("a", 1);
    queue.add("a", 2);
    expect(queue.size).toBe(2);
    expect(queue.claim("a")).toBe(1);
    queue.clear();
    expect(queue.claim("a")).toBeUndefined();
  });
});

describe("token 估算与削减点", () => {
  it("assistant 的 text 与工具调用参数都计入", () => {
    const tokens = estimateTokens(assistant("hello", [{ id: "x", name: "probe", args: { q: "hello" } }]));
    expect(tokens).toBe(Math.ceil((estimateStringChars("hello") + estimateStringChars("probe") + estimateStringChars('{"q":"hello"}')) / 4));
  });
  it("estimateContextTokens 在无 usage 时退化为全量估算", () => {
    const est = estimateContextTokens([user("a"), assistant("b")]);
    expect(est.usageTokens).toBe(0);
    expect(est.lastUsageIndex).toBeNull();
    expect(est.tokens).toBeGreaterThanOrEqual(1);
  });
  it("反向预算走查只落在可切断边界，绝不留下孤儿结果", () => {
    const messages: LlmMessage[] = [
      user("older ask"),
      assistant("thinking…", [{ id: "c1", name: "tool_a" }]),
      tool("c1", "result one"),
      user("newer ask"),
      assistant("", [{ id: "c2", name: "tool_b" }]),
      tool("c2", "result two"),
      assistant("done"),
    ];
    const cut = findCutPoint(messages, 0, messages.length, 1);
    const first = messages[cut.firstKeptEntryIndex]!;
    // 切断边界只能是 assistant 或 user（轮次起点），且不会以孤儿工具结果开始。
    expect(["user", "assistant"]).toContain(first.role);
    expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
    expect(findTurnStartIndex(messages, cut.firstKeptEntryIndex, 0)).toBe(3);
  });
  it("retention 预算容不下任何完整原子时把切断推到 endIndex", () => {
    const huge = user("x".repeat(4000));
    const messages: LlmMessage[] = [huge, assistant("tiny")];
    const cut = findCutPoint(messages, 0, messages.length, 0, {
      budget: { maxTokens: 1, reserveTokens: 1, estimateTokens: () => 100 },
    });
    expect(cut.firstKeptEntryIndex).toBe(messages.length);
  });
  it("切断永远不会早于 boundaryStart（既有压缩边界之后）", () => {
    const messages: LlmMessage[] = [
      buildCompactionSummaryMessage("previous summary"),
      user("q"),
      assistant("a"),
    ];
    const cut = findCutPoint(messages, 1, messages.length, 0);
    expect(cut.firstKeptEntryIndex).toBeGreaterThanOrEqual(1);
  });
});

describe("摘要封装与预算", () => {
  it("capCompactionSummary 超限才截断并留下标记，保留后缀不被切断", () => {
    const short = capCompactionSummary("hello");
    expect(short).toBe("hello");
    const suffix = "\n\n<read-files>\na.ts\n</read-files>";
    const long = capCompactionSummary(`${"y".repeat(20_000)}${suffix}`, MAX_COMPACTION_SUMMARY_CHARS, suffix);
    expect(long.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(long).toContain(SUMMARY_TRUNCATED_MARKER);
    expect(long.endsWith(suffix)).toBe(true);
  });
  it("fitCompactionSummary 二分找可容纳尺寸，装不下则报错", () => {
    const fitted = fitCompactionSummary(10, (maxChars) => ({ summary: "x".repeat(maxChars) }));
    expect(fitted.ok).toBe(true);
    if (fitted.ok) expect(fitted.value.summary.length).toBeLessThanOrEqual(10 * CHARS_PER_TOKEN_ESTIMATE);
    const failed = fitCompactionSummary(1, (maxChars) =>
      maxChars < 100 ? undefined : { summary: "x".repeat(maxChars) },
    );
    expect(failed.ok).toBe(false);
  });
  it("shouldCompact 只在窗口正数且超过 reserve 后触发", () => {
    expect(shouldCompact(60_000, 64_000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    expect(shouldCompact(40_000, 64_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
    expect(shouldCompact(999_999, 0, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
    expect(shouldCompact(999_999, 64_000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })).toBe(false);
  });
  it("超长当前请求头尾保留、中间标记截断", () => {
    const source = `${"头".repeat(500)}${"m".repeat(1_000)}${"尾".repeat(500)}`;
    const request = extractLatestUserRequest([user(source)]);
    expect(request).toBeDefined();
    expect(request!.length).toBeLessThanOrEqual(MAX_LATEST_USER_REQUEST_CHARS);
    expect(request).toContain("[... 当前请求过长，中间已截断 ...]");
  });
});

describe("会话序列化与采样预算", () => {
  it("序列化标注角色，工具结果命名其调用", () => {
    const text = serializeConversation([
      { role: "system", content: "sys" },
      user("ask"),
      assistant("", [{ id: "c1", name: "read", args: { path: "a.ts" } }]),
      tool("c1", "file body"),
    ]);
    expect(text).toContain("[User]: ask");
    expect(text).toContain("[Assistant tool calls]: read(path=\"a.ts\")");
    expect(text).toContain("[Tool result]: file body");
  });
  it("超预算采样保留最新尾部与更旧 user 行，并标记省略", () => {
    const messages: LlmMessage[] = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(user(`ask-${index} ${"内容".repeat(30)}`));
      messages.push(assistant(`ans-${index} ${"y".repeat(400)}`));
    }
    const budget = 12_000;
    const sampled = serializeConversationWithinBudget(messages, budget);
    expect(sampled.omittedEntries).toBeGreaterThan(0);
    expect(sampled.text).toContain("ask-59");
    expect(sampled.text).toContain("entries omitted");
    expect(estimateStringChars(sampled.text)).toBeLessThanOrEqual(budget);
    expect(MAX_SUMMARY_INPUT_CHARS).toBe(160_000);
  });
});

describe("有界模型视图与失败闩", () => {
  it("预算内不动；超预算在 user 边界切断并给出指纹纪元", () => {
    const small = [user("a"), assistant("b")];
    expect(boundTranscriptAssembly(small, 100_000).bounded).toBeUndefined();
    const big: LlmMessage[] = [
      user("first ask " + "x".repeat(2_000)),
      assistant("first answer"),
      user("second ask"),
      assistant("second answer"),
    ];
    const view = boundTranscriptAssembly(big, 200);
    expect(view.bounded?.omittedMessages).toBeGreaterThan(0);
    expect(view.messages[0]!.role).toBe("user");
    expect(view.bounded!.epoch).toMatch(/^bounded:[0-9a-f]{64}$/);
    expect(BOUNDED_CONTEXT_NOTICE).toContain("有界");
  });
  it("切断不会把工具结果与它的调用分两侧", () => {
    const big: LlmMessage[] = [
      user("ask"),
      assistant("", [{ id: "c1", name: "probe", args: { blob: "z".repeat(4_000) } }]),
      tool("c1", "r".repeat(4_000)),
      user("next ask"),
    ];
    const view = boundTranscriptAssembly(big, 300);
    const firstTool = view.messages.findIndex((m) => m.role === "tool");
    if (firstTool >= 0) {
      const owner = view.messages.slice(0, firstTool).findLastIndex((m) => m.role === "assistant");
      expect(owner).toBeGreaterThanOrEqual(0);
    } else {
      expect(view.bounded).toBeDefined();
    }
  });
  it("失败闩仅在回落阈值以下或再增长一个阈值后重新武装", () => {
    const latch = { memberId: "m1", maxBytes: 1000, activeBytes: 1500 };
    expect(refreshTranscriptByteCompactionLatch(latch, "m1", 1000, 900)).toBeUndefined();
    expect(refreshTranscriptByteCompactionLatch(latch, "m1", 1000, 1500)).toEqual(latch);
    expect(refreshTranscriptByteCompactionLatch(latch, "m1", 1000, 2500)).toBeUndefined();
    expect(refreshTranscriptByteCompactionLatch(latch, "other", 1000, 1500)).toBeUndefined();
    expect(refreshTranscriptByteCompactionLatch(latch, "m1", 2000, 1500)).toBeUndefined();
  });
});

describe("prepare/compact/无摘要兜底", () => {
  const transcript: LlmMessage[] = [
    user("long older ask " + "a".repeat(8_000)),
    assistant("older answer"),
    user("newer ask"),
    assistant("newer answer"),
  ];

  it("token 压力下的准备会给出可提交的切断与摘要输入", () => {
    const preparation = prepareCompaction(transcript, {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 1,
    });
    expect(preparation.ok).toBe(true);
    const p = preparation.ok ? preparation.value : undefined;
    expect(p).toBeDefined();
    expect(p!.messagesToSummarize.length).toBeGreaterThan(0);
    expect(p!.tokensBefore).toBeGreaterThan(0);
  });
  it("compact 走模型摘要并保留尾部原文", async () => {
    const provider = new MockProvider(() => ({ text: "## 目标\n结构化摘要结果" }));
    const preparation = prepareCompaction(transcript, {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 1,
      reserveTokens: 2_048,
    });
    if (!preparation.ok || !preparation.value) {
      throw new Error("preparation should succeed");
    }
    const result = await compact(preparation.value, { provider, model: "mock" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toContain("结构化摘要结果");
      expect(transcript.slice(result.value.firstKeptIndex).length).toBeGreaterThan(0);
    }
  });
  it("无摘要兜底点名被移除的消息数并携带上一摘要", () => {
    const withBoundary: LlmMessage[] = [
      buildCompactionSummaryMessage("上一轮摘要正文"),
      user("ask-1 " + "b".repeat(8_000)),
      assistant("answer-1"),
      user("ask-2"),
    ];
    const preparation = prepareCompaction(withBoundary, {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 1,
    });
    expect(preparation.ok && preparation.value).toBeDefined();
    const p = preparation.ok ? preparation.value! : undefined as never;
    expect(p!.previousSummary).toBe("上一轮摘要正文");
    const fallback = compactWithoutSummary(p);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.value.summary).toContain("因摘要生成失败被移除");
      expect(fallback.value.summary).toContain("上一轮摘要正文");
      expect(fallback.value.firstKeptIndex).toBe(3);
    }
  });
  it("摘要消息标记可回读，文件清单标签可再解析", () => {
    const message = buildCompactionSummaryMessage(
      `正文\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>`,
    );
    expect(isCompactionSummaryMessage(message)).toBe(true);
    const text = readCompactionSummary(message);
    expect(extractFileListsFromSummary(text)).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
  });
});

describe("applyContextBudget 编排", () => {
  it("token 压力触发自动压缩，压缩后以摘要消息开头", async () => {
    const fat = "x".repeat(60_000);
    const provider = new MockProvider((request) =>
      request.messages[0]?.content === SUMMARIZATION_SYSTEM_PROMPT
        ? { text: "## 目标\n压缩产物" }
        : { text: "final" },
    );
    const outcome = await applyContextBudget({
      messages: [
        { role: "system", content: "sys" },
        user(`huge ask ${fat}`),
        assistant(`huge answer ${fat}`),
        user("tail ask"),
        assistant("tail answer"),
      ],
      config: {
        contextWindowTokens: 20_000,
        compaction: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10, reserveTokens: 1_024 },
      },
      memberId: "m1",
      transport: { provider, model: "mock" },
    });
    expect(outcome.compacted).toBeDefined();
    expect(outcome.compacted?.qualityDegraded).toBe(false);
    expect(isCompactionSummaryMessage(outcome.messages[1]!)).toBe(true);
    expect(outcome.messages[0]!.role).toBe("system");
  });

  it("字节压力做有界截断并附带纪元，无需压缩", async () => {
    const provider = new MockProvider(() => ({ text: "unused" }));
    const outcome = await applyContextBudget({
      messages: [
        { role: "system", content: "sys" },
        user("ask-1 " + "y".repeat(4_000)),
        user("ask-2 tail"),
      ],
      config: { maxActiveTranscriptBytes: 600 },
      memberId: "m2",
      transport: { provider, model: "mock" },
    });
    expect(outcome.compacted).toBeUndefined();
    expect(outcome.bounded?.omittedMessages).toBe(1);
    expect(outcome.messages).toHaveLength(2);
    expect(outcome.byteLatch).toBeUndefined();
  });

  it("无历史可移除时放弃压缩，由有界截断兜底", async () => {
    const provider = new MockProvider(() => {
      throw new Error("provider exploded");
    });
    const messages: LlmMessage[] = [
      { role: "system", content: "sys" },
      user("a".repeat(500)),
      assistant("b".repeat(500)),
      user("c"),
    ];
    const outcome = await applyContextBudget({
      messages,
      config: {
        maxActiveTranscriptBytes: 300,
        compaction: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: Number.MAX_SAFE_INTEGER },
      },
      memberId: "m3",
      transport: { provider, model: "mock" },
    });
    // keepRecentTokens 极大 → 无历史可移除 → 有界截断兜底；不应误报 compacted。
    expect(outcome.compacted).toBeUndefined();
    expect(outcome.bounded).toBeDefined();
  });
});

describe("agent 循环接入", () => {
  it("runAgentLoop 在字节压力下截断模型视图并把提示挂到 system", async () => {
    let sawNotice = false;
    const provider = new MockProvider((request: LlmRequest) => {
      if (request.messages[0]?.content === SUMMARIZATION_SYSTEM_PROMPT) return { text: "摘要" };
      if (request.messages[0]?.role === "system" && request.messages[0].content.includes(BOUNDED_CONTEXT_NOTICE)) {
        sawNotice = true;
      }
      const history = request.messages.filter((m) => m.role !== "system");
      if (history.some((m) => m.role === "assistant")) return { text: "收尾结论" };
      return { toolCalls: [{ name: "noop", args: {} }] };
    });
    const noop: ToolImpl = {
      schema: { name: "noop", description: "d", parameters: { type: "object", properties: {} } },
      execute: async () => "result",
    };
    const applied: string[] = [];
    const result = await runAgentLoop({
      provider,
      model: "mock",
      system: "系统提示",
      messages: [user("旧提问 " + "长".repeat(2_000)), user("新提问")],
      tools: [noop],
      maxSteps: 4,
      signal: new AbortController().signal,
      budget: { maxActiveTranscriptBytes: 1_500 },
      budgetOwnerId: "loop-member",
      onContextApplied: (info) => applied.push(info.kind),
    });
    expect(result.text).toBe("收尾结论");
    expect(applied).toContain("bounded");
    expect(sawNotice).toBe(true);
  });
});
