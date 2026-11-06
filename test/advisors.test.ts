// 顾问扇出（Hermes `moa_loop.py` 的群聊版）。
// 覆盖建议视角的裁剪、开销节奏、挑人、建议块的形状、失败降级与回合缓存，
// 以及设置层的校验/迁移、花费回流到用量账本。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Member, RoomMessage } from "../src/core/types";
import {
  DEFAULT_ADVISORS,
  SETTINGS_VERSION,
  defaultSettings,
  loadSettings,
  mergeSettings,
  sanitizeAdvisors,
  type AdvisorSettings,
  type Settings,
} from "../src/core/settings";
import type { LlmRequest } from "../src/provider/types";
import type { MockHandler } from "../src/provider/mock";
import {
  ADVISOR_VIEW_LIMITS,
  buildAdvisoryView,
  truncateMiddle,
} from "../src/agent/advisors/advisory-view";
import { advisorCacheKey, wantsFanOut } from "../src/agent/advisors/cadence";
import { MAX_ADVISOR_WORKERS, pickAdvisors } from "../src/agent/advisors/fanout";
import {
  ADVISOR_SLOTS,
  ADVISOR_SYSTEM_PROMPT,
  advisorBrief,
  advisorHeading,
  AGGREGATOR_INSTRUCTION,
} from "../src/agent/advisors/prompts";
import { AdvisorService, renderGuidance, type AdvisorRequest } from "../src/agent/advisors/service";

function member(partial: Partial<Member> & { id: string; name: string }): Member {
  return {
    roomId: "room_test",
    role: "sub",
    status: "idle",
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...partial,
  };
}

const main = member({ id: "m_main", name: "主智能体", role: "main", depth: 0, spawnedBy: null, controlScope: "children" });
const researcher = member({ id: "m_a", name: "研究员", brief: "负责资料调研与事实核对" });
const writer = member({ id: "m_b", name: "写手", brief: "负责初稿与改稿" });
const gone = member({ id: "m_gone", name: "已离场", status: "cancelled" });

function chat(partial: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    roomId: "room_test",
    seq: 1,
    ts: 0,
    senderId: "u_test",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text: "把这份材料整理成周报",
    mentions: [],
    mentionsRaw: [],
    ...partial,
  };
}

function advisorsOf(overrides: Partial<AdvisorSettings> = {}): AdvisorSettings {
  return { ...DEFAULT_ADVISORS, enabled: true, ...overrides };
}

function settingsWith(advisors: Partial<AdvisorSettings>): Settings {
  const settings = defaultSettings();
  settings.providers = [{ id: "demo", api: "mock", models: [{ id: "mock" }] }];
  settings.advisors = advisorsOf(advisors);
  return settings;
}

describe("递给顾问的材料", () => {
  it("短文本原样保留，长文本掐中间并如实写出省略了多少字", () => {
    expect(truncateMiddle("很短的一段")).toBe("很短的一段");
    const long = "头".repeat(10) + "中".repeat(100) + "尾".repeat(10);
    const cut = truncateMiddle(long, 10, 10);
    expect(cut).toBe(`头头头头头头头头头头\n[…… 中间省略 100 字 ……]\n尾尾尾尾尾尾尾尾尾尾`);
    expect(truncateMiddle(long, 10, 10).length).toBeLessThan(long.length);
  });

  it("系统播报与空消息不进材料，任务那条永远在最前面", () => {
    const view = buildAdvisoryView({
      messages: [
        chat({ text: "第一条用户消息" }),
        chat({ senderKind: "system", senderName: "系统", text: "取人方式已改为「自动选人」" }),
        chat({ senderId: "m_a", senderKind: "member", senderName: "研究员", text: "   " }),
        chat({ senderId: "m_b", senderKind: "member", senderName: "写手", text: "初稿已经写完了" }),
      ],
      taskLine: "任务：整理周报",
    });
    expect(view.startsWith("任务：整理周报")).toBe(true);
    expect(view).toContain("第一条用户消息");
    expect(view).toContain("@写手：初稿已经写完了");
    expect(view).not.toContain("取人方式");
    expect(view).toContain("用户（用户）：");
  });

  it("最多回看 20 条；超出总预算时从最旧的开始丢，并说明丢了几条", () => {
    const many = Array.from({ length: ADVISOR_VIEW_LIMITS.recentMessages + 5 }, (_, index) =>
      chat({ seq: index, text: `第 ${index} 条消息` }),
    );
    const view = buildAdvisoryView({ messages: many, taskLine: "任务" });
    expect(view).not.toContain("第 0 条消息");
    expect(view).toContain(`第 ${many.length - 1} 条消息`);
    expect(view.match(/条消息\n/g)?.length).toBeLessThanOrEqual(ADVISOR_VIEW_LIMITS.recentMessages);

    const fat = Array.from({ length: 12 }, (_, index) =>
      chat({ seq: index, text: "长".repeat(2_000) }),
    );
    const squeezed = buildAdvisoryView({ messages: fat, taskLine: "任务：别把问题挤没了" });
    expect(squeezed).toContain("更早");
    expect(squeezed).toContain("任务：别把问题挤没了");
    expect(squeezed.length).toBeLessThanOrEqual(ADVISOR_VIEW_LIMITS.totalChars + 200);
  });
});

describe("扇出节奏与缓存键", () => {
  it("关闭时一次都不问；every_n 第一次一定问，之后按间隔", () => {
    expect(wantsFanOut(advisorsOf({ enabled: false, cadence: "per_iteration" }), 1)).toBe(false);
    expect(wantsFanOut(advisorsOf({ cadence: "per_iteration" }), 7)).toBe(true);
    const every3 = advisorsOf({ cadence: "every_n", everyN: 3 });
    expect([1, 2, 3, 4, 7, 10].map((n) => wantsFanOut(every3, n))).toEqual([
      true, false, false, true, true, true,
    ]);
    // 间隔至少 2：配成 1 也不会退化成「每次都问」
    expect([1, 2, 3].map((n) => wantsFanOut(advisorsOf({ cadence: "every_n", everyN: 1 }), n))).toEqual([
      true, false, true,
    ]);
    // user_turn 的节流靠缓存，不在这里判
    expect(wantsFanOut(advisorsOf({ cadence: "user_turn" }), 5)).toBe(true);
  });

  it("换房间、换回合、换执行成员、换顾问名单都是另一份缓存", () => {
    const base = { roomId: "r1", turnKey: "t1", actingId: "m_main", advisorIds: ["m_a", "m_b"] };
    const key = advisorCacheKey(base);
    expect(advisorCacheKey(base)).toBe(key);
    for (const patch of [
      { roomId: "r2" },
      { turnKey: "t2" },
      { actingId: "m_a" },
      { advisorIds: ["m_a", "m_c"] },
      { advisorIds: ["m_b", "m_a"] },
    ]) {
      expect(advisorCacheKey({ ...base, ...patch })).not.toBe(key);
    }
  });
});

describe("挑顾问", () => {
  it("按花名册顺序取，跳过动手的那位与已离场的，人数封顶", () => {
    expect(pickAdvisors(main, [main, researcher, writer, gone], 2).map((m) => m.id)).toEqual([
      "m_a",
      "m_b",
    ]);
    expect(pickAdvisors(researcher, [main, researcher, writer], 1).map((m) => m.id)).toEqual(["m_main"]);
    expect(pickAdvisors(main, [main, gone], 3)).toEqual([]);
    // 上下限都收口：至少 1 位，最多不超过并发上限
    const crowd = Array.from({ length: 12 }, (_, index) =>
      member({ id: `m_${index}`, name: `成员${index}` }),
    );
    expect(pickAdvisors(main, [main, ...crowd], 0)).toHaveLength(1);
    expect(pickAdvisors(main, [main, ...crowd], 99)).toHaveLength(MAX_ADVISOR_WORKERS);
  });

  it("参谋视角就是这名成员的职责档案，标题带序号、角度与被问的人", () => {
    expect(advisorBrief(researcher)).toBe("研究员：负责资料调研与事实核对");
    expect(advisorBrief(member({ id: "m_n", name: "新人" }))).toBe("新人");
    expect(advisorBrief(member({ id: "m_l", name: "长", brief: "久".repeat(400) })).length).toBeLessThanOrEqual(
      300 + 10,
    );
    expect(advisorHeading(2, ADVISOR_SLOTS[1], writer)).toBe("参考建议 2 — 发散视角（@写手）");
  });
});

describe("建议块的形状", () => {
  it("1 起编号、带标签，没回话的那位也留在块里", () => {
    const text = renderGuidance([
      { advisor: researcher, slot: ADVISOR_SLOTS[0], text: "先定读者和篇幅。" },
      { advisor: writer, slot: ADVISOR_SLOTS[1], error: "上游 500" },
    ]);
    expect(text.startsWith(AGGREGATOR_INSTRUCTION)).toBe(true);
    expect(text).toContain("参考建议 1 — 稳妥视角（@研究员）：\n先定读者和篇幅。");
    expect(text).toContain("参考建议 2 — 发散视角（@写手）：\n[未产出：上游 500]");
    expect(text).toContain("若顾问之间意见冲突");
    expect(text).toContain("站哪一边");
  });
});

describe("顾问扇出服务", () => {
  function rig(advisors: Partial<AdvisorSettings>, handler: MockHandler) {
    const settings = settingsWith(advisors);
    const calls: LlmRequest[] = [];
    const records: Array<{ ref: string; input: number; output: number }> = [];
    const service = new AdvisorService({
      getSettings: () => settings,
      onUsageRecord: (record) =>
        records.push({ ref: record.ref, input: record.usage.input, output: record.usage.output }),
    });
    const request = (overrides: Partial<AdvisorRequest> = {}): AdvisorRequest => ({
      acting: main,
      members: [main, researcher, writer],
      messages: [chat({ seq: 1, text: "把这份材料整理成周报" })],
      taskText: "把这份材料整理成周报",
      roomId: "room_test",
      turnKey: "turn_1",
      getModelDeps: () => ({
        settings,
        mockHandler: (raw) => {
          calls.push(raw);
          return handler(raw);
        },
      }),
      ...overrides,
    });
    return { service, request, calls, records };
  }

  it("没开启就什么都不做：一次调用都不发", async () => {
    const { service, request, calls } = rig({ enabled: false }, () => ({ text: "不该发生" }));
    const outcome = await service.run(request());
    expect(outcome).toEqual({ entries: [], reason: "disabled" });
    expect(calls).toHaveLength(0);
    expect(service.configuredCount).toBe(0);
  });

  it("房间里只剩自己可问就当没有参谋", async () => {
    const { service, request, calls } = rig({}, () => ({ text: "不该发生" }));
    const outcome = await service.run(request({ members: [main] }));
    expect(outcome.reason).toBe("no-advisors");
    expect(calls).toHaveLength(0);
  });

  it("问到的建议按槽位温度区分、一律不带工具，花费记进同一本账", async () => {
    const { service, request, calls, records } = rig({ maxAdvisors: 2 }, (raw) => {
      const system = raw.messages[0]?.content ?? "";
      return { text: system.includes("角度：稳妥") ? "先把范围收窄" : "换个角度试试" };
    });
    const outcome = await service.run(request());
    expect(outcome.reason).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(outcome.guidance).toContain(AGGREGATOR_INSTRUCTION);
    expect(outcome.guidance).toContain("参考建议 1 — 稳妥视角（@研究员）：\n先把范围收窄");
    expect(outcome.guidance).toContain("参考建议 2 — 发散视角（@写手）：\n换个角度试试");
    for (const call of calls) {
      expect(call.tools).toEqual([]);
      expect(call.maxTokens).toBeLessThanOrEqual(700);
      expect(call.messages[0]?.content.startsWith(ADVISOR_SYSTEM_PROMPT)).toBe(true);
      expect(call.messages[0]?.content).toContain("不是执行者，也不会执行任何东西");
      expect(call.messages[0]?.content).toContain("不要调用工具");
      expect(call.messages[1]?.content).toContain("把这份材料整理成周报");
    }
    expect(calls.map((call) => call.params?.temperature)).toEqual([0.2, 0.9]);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.ref === "demo/mock" && record.input > 0)).toBe(true);
  });

  it("个别顾问失败照样出建议，全失败就整块不要，且只在 loud 时说明", async () => {
    const half = rig({ maxAdvisors: 2 }, (raw) => {
      if ((raw.messages[0]?.content ?? "").includes("角度：发散")) throw new Error("超时");
      return { text: "这份可以" };
    });
    const partial = await half.service.run(half.request());
    expect(partial.reason).toBe("ok");
    expect(partial.guidance).toContain("[未产出：超时]");
    expect(partial.note).toBe("1 位顾问出了建议，1 位没回（已在建议块里标注）。");

    const all = rig({ maxAdvisors: 2 }, () => {
      throw new Error("模型不可用");
    });
    const failed = await all.service.run(all.request());
    expect(failed.guidance).toBeUndefined();
    expect(failed.reason).toBe("all-failed");
    expect(failed.note).toContain("一个都没回");
    expect(failed.entries).toHaveLength(2);

    const quiet = rig({ maxAdvisors: 2, degraded: "silent" }, () => {
      throw new Error("模型不可用");
    });
    const silent = await quiet.service.run(quiet.request());
    expect(silent.reason).toBe("all-failed");
    expect(silent.note).toBeUndefined();
  });

  it("user_turn 的同一个回合只花一次钱，换回合或换顾问名单再问", async () => {
    const { service, request, calls } = rig({ maxAdvisors: 1, cadence: "user_turn" }, () => ({
      text: "同一份建议",
    }));
    const first = await service.run(request());
    const again = await service.run(request());
    expect(first.reason).toBe("ok");
    expect(again.reason).toBe("cached");
    expect(again.guidance).toBe(first.guidance);
    expect(calls).toHaveLength(1);

    const nextTurn = await service.run(request({ turnKey: "turn_2" }));
    expect(nextTurn.reason).toBe("ok");
    expect(calls).toHaveLength(2);

    const otherActors = await service.run(request({ acting: researcher }));
    expect(otherActors.reason).toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("per_iteration 不复用缓存，every_n 没到间隔就整轮跳过", async () => {
    const hot = rig({ maxAdvisors: 1, cadence: "per_iteration" }, () => ({ text: "每次都要" }));
    expect((await hot.service.run(hot.request())).reason).toBe("ok");
    expect((await hot.service.run(hot.request())).reason).toBe("ok");
    expect(hot.calls).toHaveLength(2);

    const cold = rig({ maxAdvisors: 1, cadence: "every_n", everyN: 3 }, () => ({ text: "每三次" }));
    const reasons: string[] = [];
    for (let i = 0; i < 4; i += 1) reasons.push((await cold.service.run(cold.request())).reason);
    expect(reasons).toEqual(["ok", "cadence", "cadence", "ok"]);
    expect(cold.calls).toHaveLength(2);
  });

  it("换房间或新会话后丢弃回合缓存：旧回合的建议不该再被复用", async () => {
    const { service, request, calls } = rig({ maxAdvisors: 1 }, () => ({ text: "旧回合" }));
    await service.run(request());
    service.clearCache();
    expect((await service.run(request())).reason).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("顾问借用动手成员的模型引用，调用照样发出去", async () => {
    const settings = settingsWith({ maxAdvisors: 1 });
    const service = new AdvisorService({ getSettings: () => settings });
    const models: string[] = [];
    const request: AdvisorRequest = {
      acting: main,
      members: [main, researcher],
      messages: [chat()],
      taskText: "任务",
      roomId: "room_test",
      turnKey: "turn_x",
      getModelDeps: () => ({
        settings,
        mockHandler: (raw) => {
          models.push(raw.model);
          return { text: "建议" };
        },
      }),
    };
    expect((await service.run(request)).reason).toBe("ok");
    expect(models).toEqual(["mock"]);
  });
});

describe("顾问设置的校验与迁移", () => {
  it("默认关闭，越界与未知字段一律拒绝", () => {
    expect(DEFAULT_ADVISORS).toEqual({
      enabled: false,
      maxAdvisors: 2,
      cadence: "user_turn",
      everyN: 3,
      degraded: "loud",
    });
    expect(sanitizeAdvisors({ enabled: true })).toEqual({ enabled: true });
    for (const [input, message] of [
      [null, "advisors 必须是对象"],
      [{ maxAdvisors: 0 }, "1–3"],
      [{ maxAdvisors: 4 }, "1–3"],
      [{ maxAdvisors: 1.5 }, "1–3"],
      [{ cadence: "always" }, "节奏"],
      [{ everyN: 1 }, "2–8"],
      [{ everyN: 9 }, "2–8"],
      [{ degraded: "noisy" }, "loud 或 silent"],
      [{ modelRef: 3 }, "字符串"],
      [{ extra: 1 }, "未知的顾问扇出字段"],
    ] as const) {
      expect(() => sanitizeAdvisors(input)).toThrow(new RegExp(message));
    }
    // 空串就是「跟随动手成员的模型」，不会把 "" 存下来
    expect(sanitizeAdvisors({ modelRef: "  " }).modelRef).toBeUndefined();
    expect(sanitizeAdvisors({ modelRef: " deepseek/deepseek-chat " })).toEqual({
      modelRef: "deepseek/deepseek-chat",
    });
  });

  it("旧设置文件里没有 advisors 时补默认值并回写；合并只覆盖提交过的字段", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-advisors-settings-"));
    const file = join(dir, "settings.json");
    try {
      await writeFile(
        file,
        JSON.stringify({ settingsVersion: 1, providers: [{ id: "demo", kind: "mock", model: "mock" }] }),
        "utf8",
      );
      const loaded = await loadSettings(file);
      expect(loaded.advisors).toEqual(DEFAULT_ADVISORS);
      // 迁移过的文件会被回写，下次加载不用再迁一遍
      expect(JSON.parse(await readFile(file, "utf8")).settingsVersion).toBe(SETTINGS_VERSION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const base = defaultSettings();
    base.advisors = advisorsOf({ maxAdvisors: 3, modelRef: "demo/mock" });
    const merged = mergeSettings(base, { advisors: sanitizeAdvisors({ cadence: "every_n" }) });
    expect(merged.advisors).toEqual({
      enabled: true,
      maxAdvisors: 3,
      cadence: "every_n",
      everyN: 3,
      degraded: "loud",
      modelRef: "demo/mock",
    });

    const cleared = mergeSettings(merged, { advisors: sanitizeAdvisors({ modelRef: "" }) });
    expect(cleared.advisors.modelRef).toBeUndefined();
  });
});
