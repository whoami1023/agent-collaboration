// 整轮预算：同一条用户消息共享 token / 时长 / 运行次数三个闸门；停止原因只提醒一次。
import { describe, expect, it } from "vitest";
import { TurnBudgetBook } from "../src/room/turn-budget";
import { DEFAULT_LIMITS, type Limits } from "../src/core/types";

function limits(overrides: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

describe("TurnBudgetBook", () => {
  it("token 到顶后拒绝开新运行", () => {
    let clock = 0;
    const book = new TurnBudgetBook(() => limits({ turnTokenBudget: 100 }), () => clock);
    book.begin("msg_1");
    expect(book.addTokens("msg_1", 60)).toBeNull();
    expect(book.beginRun("msg_1").allowed).toBe(true);
    expect(book.addTokens("msg_1", 50)).toBe("tokens");
    const gate = book.beginRun("msg_1");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("tokens");
    expect(book.view("msg_1")).toMatchObject({ runs: 1, tokens: 110, stop: "tokens" });
  });

  it("运行次数到顶后停止；新用户消息重新建账", () => {
    const book = new TurnBudgetBook(() => limits({ turnMaxRuns: 2 }), () => 0);
    book.begin("msg_1");
    expect(book.beginRun("msg_1").allowed).toBe(true);
    expect(book.beginRun("msg_1").allowed).toBe(true);
    expect(book.beginRun("msg_1")).toEqual({ allowed: false, reason: "runs" });

    book.begin("msg_2");
    expect(book.beginRun("msg_2").allowed).toBe(true);
    expect(book.view("msg_2").stop).toBeUndefined();
  });

  it("墙钟到顶后停止；同一原因只提醒一次", () => {
    let clock = 1_000;
    const book = new TurnBudgetBook(() => limits({ turnTimeoutMs: 60_000 }), () => clock);
    book.begin("msg_1");
    expect(book.stopReason("msg_1")).toBeNull();
    clock += 60_001;
    expect(book.stopReason("msg_1")).toBe("time");
    expect(book.markNotified("msg_1", "time")).toBe(true);
    expect(book.markNotified("msg_1", "time")).toBe(false);
    expect(book.markNotified("msg_1", "tokens")).toBe(true);
  });
});
