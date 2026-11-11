// 房间取人方式（移植 Hermes 的 ROUTING_MODES = everyone|lead|auto）。
// 覆盖三层：分流本身的纯判定（该不该挑、挑出来算不算数）、唤醒规则的分支，
// 以及真正那次小模型调用的契约（不带工具、温度归零、输出封顶）与失败回落。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  ROOM_ROUTING_LABELS,
  type Limits,
  type Member,
  type RoomMessage,
} from "../src/core/types";
import { defaultSettings, type Settings } from "../src/core/settings";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { buildInstruction } from "../src/agent/prompts";
import { routeMembers } from "../src/agent/route-service";
import { SkillLibrary } from "../src/skills/library";
import { decideWakes } from "../src/room/wake";
import {
  buildRouterMessages,
  citedPeerIds,
  everyonePicks,
  isPassText,
  parseRouterPicks,
  ROUTING_LIMITS,
  ROUTER_SYSTEM_PROMPT,
  ROUTING_SWITCH_NOTICES,
  rotateBy,
  routingCandidates,
  routingNeeded,
} from "../src/room/routing";
import type { LlmRequest } from "../src/provider/types";
import type { MockHandler } from "../src/provider/mock";

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

function message(partial: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg_1",
    roomId: "room_test",
    seq: 1,
    ts: 0,
    senderId: "u_test",
    senderName: "用户",
    senderKind: "user",
    kind: "chat",
    text: "这份数据有什么问题？",
    mentions: [],
    mentionsRaw: [],
    ...partial,
  };
}

const main = member({ id: "m_main", name: "主智能体", role: "main", depth: 0, spawnedBy: null, controlScope: "children" });
const researcher = member({ id: "m_a", name: "研究员", brief: "负责资料调研与事实核对" });
const writer = member({ id: "m_b", name: "写手", brief: "负责初稿与改稿" });
const analyst = member({ id: "m_c", name: "分析师", brief: "负责看数据" });
const roster = [main, researcher, writer, analyst];

describe("该不该花这一次分流调用", () => {
  it("只有 auto 模式、用户没点名、不是计划轮、且至少有两个人可挑时才分流", () => {
    expect(routingNeeded(message(), "auto", roster)).toBe(true);
    expect(routingNeeded(message(), "lead", roster)).toBe(false);
    expect(routingNeeded(message(), "everyone", roster)).toBe(false);
    expect(routingNeeded(message({ mentions: [researcher.id] }), "auto", roster)).toBe(false);
    expect(
      routingNeeded(message({ senderId: main.id, senderKind: "member", senderName: main.name }), "auto", roster),
    ).toBe(false);
    expect(routingNeeded(message({ runScope: "plan" }), "auto", roster)).toBe(false);
    expect(routingNeeded(message({ text: "   " }), "auto", roster)).toBe(false);
    expect(routingNeeded(message(), "auto", [researcher])).toBe(false);
  });

  it("可挑的人排除已取消的、发消息的自己；计划轮里智能体发的消息一个都不给", () => {
    const cancelled = member({ id: "m_gone", name: "已离场", status: "cancelled" });
    expect(routingCandidates(message(), [...roster, cancelled]).map((m) => m.id)).toEqual([
      "m_main",
      "m_a",
      "m_b",
      "m_c",
    ]);
    expect(
      routingCandidates(message({ senderId: researcher.id, senderKind: "member" }), roster).map((m) => m.id),
    ).toEqual(["m_main", "m_b", "m_c"]);
    // 计划轮是只读轮：智能体说什么都不能把人拉进来干活
    expect(
      routingCandidates(message({ senderId: researcher.id, senderKind: "member", runScope: "plan" }), roster).map(
        (m) => m.id,
      ),
    ).toEqual([]);
    // 用户自己在计划轮里发的消息仍然可以挑人——出计划也要有人接
    expect(routingCandidates(message({ runScope: "plan" }), roster).length).toBe(4);
  });
});

describe("分流输入的形状", () => {
  it("花名册带职责与技能、最近消息只留 5 条并各自截断", () => {
    const recent = Array.from({ length: 8 }, (_, index) =>
      message({ id: `old_${index}`, seq: index, text: `第 ${index} 条旧消息 内容` }),
    );
    const current = message({ id: "now", seq: 99, text: "把上面这些整理成周报" });
    const [system, user] = buildRouterMessages({
      message: current,
      candidates: [main, researcher],
      recent: [...recent, current],
    });
    expect(system?.content).toBe(ROUTER_SYSTEM_PROMPT);
    expect(system?.role).toBe("system");
    const text = user?.content ?? "";
    expect(text).toContain("- 主智能体（主智能体）");
    expect(text).toContain("- 研究员：负责资料调研与事实核对");
    // 只留最近 5 条：最旧的那几条丢掉，长任务不会因为分流把全文再喂一遍
    expect(text.match(/条旧消息 内容/g)).toHaveLength(ROUTING_LIMITS.recentMessages);
    expect(text).toContain("第 7 条旧消息");
    expect(text).not.toContain("第 1 条旧消息");
    // 当前这条只出现在「用户刚发的消息」里，不进最近消息列表
    expect(text.match(/把上面这些整理成周报/g)).toHaveLength(1);
  });

  it("超长消息按 600 字截断，成员职责按 300 字截断", () => {
    const long = member({ id: "m_long", name: "长档案", brief: "职责".repeat(400) });
    const [system, user] = buildRouterMessages({
      message: message({ text: "结".repeat(900) }),
      candidates: [long],
      recent: [message({ id: "other", text: "长".repeat(900) })],
    });
    const text = `${system?.content}\n${user?.content}`;
    expect(text).toContain("…");
    expect(text).not.toContain("结".repeat(900));
    expect(text).not.toContain("长".repeat(900));
    expect(user?.content).toContain(`${"职责".repeat(150)}…`);
  });
});

describe("分流答复的严格解析", () => {
  it("认名字、忽略 @ 前缀与大小写、去重并封顶 6 人", () => {
    const picks = parseRouterPicks(
      '```json\n{"members": ["@研究员", "研究员", " 写手 ", "路人甲"]}\n```',
      roster,
    );
    expect(picks).toEqual(["m_a", "m_b"]);

    const many = Array.from({ length: 9 }, (_, index) =>
      member({ id: `m_${index}`, name: `成员${index}` }),
    );
    expect(
      parseRouterPicks(
        `{"members": ${JSON.stringify(many.map((item) => item.name))}}`,
        many,
      )?.length,
    ).toBe(ROUTING_LIMITS.maxPicks);
  });

  it("everyone（字符串或数组里）等于在场所有人，按上限截断", () => {
    expect(parseRouterPicks('{"members": "everyone"}', roster)?.sort()).toEqual([
      "m_a",
      "m_b",
      "m_c",
      "m_main",
    ]);
    expect(parseRouterPicks('{"members": ["Everyone"]}', roster)?.length).toBe(4);
  });

  it("格式稍有不合规就当没挑出来，交调用方回落", () => {
    for (const text of [
      "",
      "我觉得应该让研究员看",
      "{这不是 JSON}",
      "[]",
      '{"members": "研究员"}',
      '{"members": ["研究员"], "reason": "顺带"}',
      '{"members": ["不认识的人"]}',
      '{"members": 3}',
    ]) {
      expect(parseRouterPicks(text, roster)).toBeUndefined();
    }
  });

  it("全员挑选与轮转顺序受同一个上限约束", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      member({ id: `m_${index}`, name: `成员${index}` }),
    );
    expect(everyonePicks(many, 0).length).toBe(ROUTING_LIMITS.maxPicks);
    expect(rotateBy(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotateBy(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
    expect(rotateBy<string>([], 5)).toEqual([]);
    // 轮转只是换个人先开口，人数上限不变
    expect(new Set(everyonePicks(many, 1)).size).toBe(ROUTING_LIMITS.maxPicks);
  });
});

describe("顺嘴点名与 pass", () => {
  it("发言里提到还没开口的同伴名字（没 @）就拉进下一轮，最多 2 位", () => {
    const text = "我这边看完了，写手 和 分析师 那边应该还有要补的，另外 研究员 也提过一句。";
    const already = new Set<string>(["m_main", "m_a"]);
    expect(citedPeerIds(text, roster, already)).toEqual(["m_b", "m_c"]);
    expect(citedPeerIds("写手已经说过了", roster, new Set(["m_b"]))).toEqual([]);
    // 名字少于两字的成员不参与匹配：免得把常用词当人名
    expect(citedPeerIds("我 说了", [member({ id: "m_x", name: "我" })], new Set())).toEqual([]);
  });

  it("pass 只认这一个词，允许括号与句点", () => {
    for (const text of ["pass", " PASS ", "[pass]", "（pass）", "pass。", "(pass)!"]) {
      expect(isPassText(text)).toBe(true);
    }
    for (const text of ["", "pass 一下", "我 pass 这个方案", "passs", "no_pass"]) {
      expect(isPassText(text)).toBe(false);
    }
  });
});

describe("唤醒规则里的分流分支", () => {
  it("lead（缺省）保持原样：没点名的用户消息只交给主智能体", () => {
    expect(decideWakes(message(), roster).wakes).toEqual(["m_main"]);
    expect(decideWakes(message(), roster, "delegate", { routing: "lead" }).wakes).toEqual(["m_main"]);
  });

  it("auto 挑到人就不叫主智能体，且先开口的顺序会轮转", () => {
    // shift = seq % 人数：seq 1 从第二位开始，seq 2 回到第一位
    const first = decideWakes(message({ seq: 1 }), roster, "delegate", {
      routing: "auto",
      picks: [researcher.id, writer.id],
    });
    expect(first.wakes).toEqual(["m_b", "m_a"]);

    const second = decideWakes(message({ seq: 2 }), roster, "delegate", {
      routing: "auto",
      picks: [researcher.id, writer.id],
    });
    expect(second.wakes).toEqual(["m_a", "m_b"]);
  });

  it("auto 的 picks 只认还在册的候选，全被过滤掉就回落主智能体", () => {
    const gone = member({ id: "m_gone", name: "已离场", status: "cancelled" });
    const stale = decideWakes(message({ seq: 1 }), [...roster, gone], "delegate", {
      routing: "auto",
      picks: [gone.id, "m_unknown"],
    });
    expect(stale.wakes).toEqual(["m_main"]);

    const named = decideWakes(message({ mentions: [analyst.id] }), roster, "delegate", {
      routing: "auto",
      picks: [researcher.id],
    });
    // 用户自己 @ 过人了：分流不参与，显式 @ 优先，只唤醒被点的人
    expect(named.wakes).toEqual(["m_c"]);
  });

  it("everyone 同时唤醒在场成员与主智能体，一条消息最多 6 人", () => {
    const decision = decideWakes(message({ seq: 0 }), roster, "delegate", { routing: "everyone" });
    expect(decision.wakes.sort()).toEqual(["m_a", "m_b", "m_c", "m_main"]);

    const crowded = Array.from({ length: 8 }, (_, index) =>
      member({ id: `m_${index}`, name: `成员${index}` }),
    );
    const capped = decideWakes(
      message({ seq: 0 }),
      [main, ...crowded],
      "delegate",
      { routing: "everyone" },
    );
    expect(capped.wakes).toHaveLength(ROUTING_LIMITS.maxPicks);
    expect(capped.wakes).toContain("m_main");
  });

  it("everyone 下用户点了人，就只唤醒被点的那个", () => {
    const decision = decideWakes(message({ mentions: [writer.id] }), roster, "delegate", {
      routing: "everyone",
    });
    expect(decision.wakes).toEqual(["m_b"]);
  });

  it("成员发言点了还没开口的同伴，会把那人拉进下一轮", () => {
    const trigger = message({
      senderId: researcher.id,
      senderName: researcher.name,
      senderKind: "member",
      text: "数据来源已经确认，写手那边可以起稿了。",
    });
    const quiet = decideWakes(trigger, roster, "delegate", { routing: "lead" });
    expect(quiet.wakes).toEqual([]);

    const routed = decideWakes(trigger, roster, "delegate", {
      routing: "auto",
      unspoken: [writer.id, analyst.id, main.id],
    });
    expect(routed.wakes).toEqual(["m_b"]);
  });

  it("同一条消息里被点过的人不会被重复拉进来，计划轮也不拉", () => {
    const trigger = message({
      senderId: researcher.id,
      senderName: researcher.name,
      senderKind: "member",
      text: "写手 继续。",
      mentions: [writer.id],
    });
    const decision = decideWakes(trigger, roster, "free", {
      routing: "auto",
      unspoken: [writer.id, analyst.id],
    });
    expect(decision.wakes).toEqual(["m_b"]);

    const planned = decideWakes(message({
      senderId: researcher.id,
      senderName: researcher.name,
      senderKind: "member",
      text: "写手 继续。",
      runScope: "plan",
    }), roster, "delegate", { routing: "auto", unspoken: [writer.id] });
    expect(planned.wakes).toEqual([]);
  });
});

describe("分流调用本身", () => {
  function depsFor(handler: MockHandler, settings: Settings = defaultSettings()) {
    return () => ({ settings, mockHandler: handler });
  }

  it("不带工具、温度归零、输出封顶，并把挑到的人与花费交回去", async () => {
    const calls: LlmRequest[] = [];
    const records: Array<{ ref: string; input: number }> = [];
    const outcome = await routeMembers({
      message: message({ text: "这份季度数据有什么问题？" }),
      candidates: [researcher, writer],
      recent: [message({ id: "old", seq: 0, text: "上一轮的事" })],
      getModelDeps: depsFor((request) => {
        calls.push(request);
        return { text: '{"members": ["研究员"]}' };
      }),
      onUsageRecord: (record) => records.push({ ref: record.ref, input: record.usage.input }),
    });
    expect(outcome).toEqual({ picks: ["m_a"], reason: "picked" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.params?.temperature).toBe(0);
    expect(calls[0]?.maxTokens).toBeLessThanOrEqual(ROUTING_LIMITS.maxTokens);
    expect(calls[0]?.messages[0]?.content).toBe(ROUTER_SYSTEM_PROMPT);
    expect(records).toEqual([{ ref: "demo/mock", input: expect.any(Number) }]);
  });

  it("答复不合格式、模型不可用、调用抛错都回空名单，由调用方按 lead 处理", async () => {
    const candidates = [researcher, writer];
    const garbage = await routeMembers({
      message: message(),
      candidates,
      recent: [],
      getModelDeps: depsFor(() => ({ text: "这得看情况。" })),
    });
    expect(garbage).toEqual({ picks: [], reason: "no-pick" });

    const settings = defaultSettings();
    settings.selection = { ...settings.selection, defaultModel: "nope/nope" };
    const unavailable = await routeMembers({
      message: message(),
      candidates,
      recent: [],
      getModelDeps: depsFor(() => ({ text: "{}" }), settings),
    });
    expect(unavailable).toEqual({ picks: [], reason: "unavailable" });

    const failed = await routeMembers({
      message: message(),
      candidates,
      recent: [],
      getModelDeps: depsFor(() => {
        throw new Error("上游 500");
      }),
    });
    expect(failed).toEqual({ picks: [], reason: "failed" });
  });

  it("外部信号已经中止时不再花钱：调用直接失败回空名单", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await routeMembers({
      message: message(),
      candidates: [researcher, writer],
      recent: [],
      getModelDeps: depsFor(() => ({ text: '{"members": ["研究员"]}' })),
      signal: controller.signal,
    });
    expect(outcome.picks).toEqual([]);
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 房间 + 编排器：端到端验证「一条没点名的消息到底谁接」。 */
async function makeRig(handler: MockHandler, overrides: Partial<Limits> = {}) {
  const bus = new RoomBus("room_test", "测试群");
  const board = new Workboard("room_test");
  ensureMainMember(bus);
  bus.addMember(researcher);
  bus.addMember(writer);
  const dir = await mkdtemp(join(tmpdir(), "ac-routing-"));
  tempDirs.push(dir);
  const skills = new SkillLibrary(join(dir, "skills.json"));
  await skills.init();
  const settings: Settings = {
    ...defaultSettings(),
    providers: [{ id: "demo", api: "mock", models: [{ id: "mock" }] }],
    limits: { ...DEFAULT_LIMITS, maxStepsPerRun: 4, runTimeoutMs: 5000, ...overrides },
  };
  const orchestrator = new Orchestrator({
    bus,
    board,
    getSettings: () => settings,
    skills,
    ownerId: "u_test",
    mockHandler: handler,
  });
  return { bus, board, orchestrator, settings, skills };
}

/** 建议块与分流的系统提示词各认一行，测试据此判断这次调用是谁发起的。 */
function isRouterCall(request: LlmRequest): boolean {
  return request.messages[0]?.content === ROUTER_SYSTEM_PROMPT;
}

describe("端到端的取人方式", () => {
  it("切到 auto 会广播一句说明、落进快照，并让分流挑中的人接手", async () => {
    const events: string[] = [];
    const { bus, orchestrator } = await makeRig((request) =>
      isRouterCall(request) ? { text: '{"members": ["研究员"]}' } : { text: "已经核对完了。" },
    );
    bus.subscribe((event) => events.push(event.type));

    expect(orchestrator.setRoomRouting("auto")).toBe("auto");
    expect(bus.roomRouting).toBe("auto");
    expect(bus.snapshot().routing).toBe("auto");
    const notice = bus.listMessages().find((item) => item.senderKind === "system");
    expect(notice?.text).toContain(`「${ROOM_ROUTING_LABELS.auto}」`);
    expect(notice?.text).toContain(ROUTING_SWITCH_NOTICES.auto);
    expect(events).toContain("routing");
    expect(orchestrator.setRoomRouting("auto")).toBe("auto");
    expect(bus.listMessages().filter((item) => item.senderKind === "system")).toHaveLength(1);

    orchestrator.sendUserMessage("帮我核对这份数据里的三个数");
    await waitFor(() => bus.listMessages().filter((item) => item.senderKind === "member").length >= 2);
    await waitFor(() => orchestrator.activeRuns === 0);

    const replies = bus.listMessages().filter((item) => item.senderKind === "member");
    // 分流挑中的人先交结论，主智能体仍然会被汇报唤醒做核对——分流省的是「每条都叫主智能体先接」，
    // 不是把兜底的那位从群里删掉。
    expect(replies.map((item) => item.senderId)).toEqual(["m_a", "m_main"]);
  });

  it("分流一直不通时回落主智能体，并且只说明一次", async () => {
    let routerCalls = 0;
    const { bus, orchestrator } = await makeRig((request) => {
      if (isRouterCall(request)) {
        routerCalls += 1;
        return { text: "这个我说不好" };
      }
      return { text: "我来接。" };
    });
    orchestrator.setRoomRouting("auto");

    orchestrator.sendUserMessage("先看看这个");
    await waitFor(() => bus.listMessages().some((item) => item.text === "我来接。"));
    orchestrator.sendUserMessage("再看那个");
    await waitFor(() => bus.listMessages().filter((item) => item.text === "我来接。").length === 2);
    await waitFor(() => orchestrator.activeRuns === 0);

    expect(routerCalls).toBe(2);
    const fallbacks = bus
      .listMessages()
      .filter((item) => item.text.startsWith("分流没挑出人"));
    expect(fallbacks).toHaveLength(1);
  });

  it("全员模式下与自己无关的成员回 pass，群里不会出现这条", async () => {
    const heard: string[] = [];
    let routerCalls = 0;
    const { bus, orchestrator } = await makeRig((request) => {
      const system = request.messages[0]?.content ?? "";
      if (isRouterCall(request)) {
        routerCalls += 1;
        return { text: "全员模式不该调用分流" };
      }
      // 系统提示的第一行就是「你是群聊…@名字，」，据此分辨这一轮是谁在跑
      const name = /@([^，\s]+)，/.exec(system.split("\n")[0] ?? "")?.[1] ?? "?";
      heard.push(name);
      return name === "写手" ? { text: "（pass）" } : { text: `@${name} 这块我来。` };
    });
    orchestrator.setRoomRouting("everyone");

    orchestrator.sendUserMessage("这个功能需要一份使用说明");
    await waitFor(() => heard.includes("写手") && orchestrator.activeRuns === 0);

    // 三个人都被唤醒了，pass 那条没有落进群里；全员是广播，不该再花一次分流调用的钱
    expect(new Set(heard)).toEqual(new Set(["主智能体", "研究员", "写手"]));
    expect(routerCalls).toBe(0);
    const speakers = bus.listMessages().filter((item) => item.senderKind === "member");
    expect(new Set(speakers.map((item) => item.senderName))).toEqual(new Set(["主智能体", "研究员"]));
    expect(speakers.every((item) => !isPassText(item.text))).toBe(true);
  });

  it("pass 条款只发给分流送来的那位成员，被点名的和 lead 模式一个字都不加", () => {
    const trigger = message({ seq: 5 });
    const broadcast = buildInstruction(researcher, trigger, "delegate", "everyone");
    expect(broadcast).toContain("整条回复只写一个词：pass");
    expect(broadcast).toContain("只答自己负责的那部分");

    const hosting = buildInstruction(main, trigger, "delegate", "everyone");
    expect(hosting).toContain("你不能沉默");
    expect(hosting).not.toContain("只写一个词：pass");

    const named = buildInstruction(researcher, { ...trigger, mentions: [researcher.id] }, "delegate", "everyone");
    const legacy = buildInstruction(researcher, trigger, "delegate", "lead");
    expect(named).toBe(legacy);
    expect(legacy).not.toContain("pass");
  });
});
