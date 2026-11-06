import { describe, expect, it } from "vitest";
import type { Member, RoomMessage } from "../src/core/types";
import { buildSystemPrompt, formatRoomWindow, type PromptContext } from "../src/agent/prompts";

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "m_main",
    roomId: "room_main",
    name: "主智能体",
    role: "main",
    status: "idle",
    depth: 0,
    spawnedBy: null,
    controlScope: "children",
    contextMode: "fork",
    systemPrompt: "",
    modelRef: "default",
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  const main = member();
  return {
    roomName: "测试作战室",
    member: main,
    members: [main],
    parentName: null,
    taskTitles: new Map(),
    mode: "delegate",
    limits: {
      maxChildrenPerAgent: 5,
      maxSpawnDepth: 5,
      maxConcurrent: 8,
      maxStepsPerRun: 24,
    },
    skills: [],
    ...overrides,
  };
}

describe("交付文档契约", () => {
  it("有文件工具时注入通用成文规则，覆盖各类文体而不是只针对报告", () => {
    const prompt = buildSystemPrompt(
      context({ availableTools: new Set(["file_list", "file_write", "file_read"]) }),
    );
    expect(prompt).toContain("交付文档（给别人看的成稿）");
    expect(prompt).toContain("方案、纪要、说明书、论文、合同、手册、简报");
    expect(prompt).toContain("读者是谁、拿它做什么决定");
    expect(prompt).toContain("术语首次出现给定义");
    expect(prompt).toContain("md5/字节数/行尾");
    expect(prompt).toContain("append 续写");
  });

  it("没有文件工具时不注入成文规则", () => {
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main", brief: "调研" });
    const prompt = buildSystemPrompt(
      context({ member: sub, members: [member(), sub], parentName: "主智能体", availableTools: new Set() }),
    );
    expect(prompt).not.toContain("交付文档（给别人看的成稿）");
  });

  it("成员被要求写文档时，群聊汇报与成稿正文分开", () => {
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main" });
    const prompt = buildSystemPrompt(
      context({
        member: sub,
        members: [member(), sub],
        parentName: "主智能体",
        availableTools: new Set(["file_write"]),
      }),
    );
    expect(prompt).toContain("群聊汇报必须包含");
    expect(prompt).toContain("不要把工作简报当成交付物");
  });

  it("主智能体先核对成员自述，再负责统稿", () => {
    const prompt = buildSystemPrompt(context({ availableTools: new Set(["file_write"]) }));
    expect(prompt).toContain("核对与统稿");
    expect(prompt).toContain("不要直接把成员汇报拼成文档");
    expect(prompt).toContain("统一口径、术语与时间");
  });

  it("成员交回的产物在群聊窗口里标为汇报，不再与成稿混用「报告」", () => {
    const message: RoomMessage = {
      id: "msg_1",
      roomId: "room_main",
      seq: 3,
      ts: 0,
      senderId: "m_sub",
      senderName: "研究员",
      senderKind: "member",
      kind: "announce",
      text: "结论：…",
      mentions: [],
      mentionsRaw: [],
    };
    const window = formatRoomWindow([message]);
    expect(window).toContain("汇报");
    expect(window).not.toContain("· 报告");
  });
});

describe("行为准则与提示词分层（移植自 Hermes）", () => {
  /** 易变层的段首标题：主/子提示词正文里也会口头提到「当前群况」，只有这一串才是分层的边界。 */
  const VOLATILE = "当前群况（每轮更新";

  it("完成标准与真实性准则无条件注入，主与子都带", () => {
    const main = buildSystemPrompt(context({ availableTools: new Set() }));
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main" });
    const subPrompt = buildSystemPrompt(
      context({ member: sub, members: [member(), sub], parentName: "主智能体", availableTools: new Set() }),
    );
    for (const prompt of [main, subPrompt]) {
      expect(prompt).toContain("完成标准与真实性");
      expect(prompt).toContain("交付物是真的做出来、写出来的东西");
      expect(prompt).toContain("如实报告受阻永远好过编一个结果");
      expect(prompt).toContain("每一条被点名的验收项都验证过");
      expect(prompt).toContain("调用成功不等于任务成功");
      expect(prompt).toContain("不顺手重构、改名、排版");
      expect(prompt).toContain("冲突时的优先级：用户本轮的明确指示");
    }
  });

  it("易变的群况排在最后，前面的规则段逐字不变", () => {
    const stable = buildSystemPrompt(context({ availableTools: new Set(["file_list"]) }));
    const index = stable.indexOf(VOLATILE);
    expect(index).toBeGreaterThan(stable.indexOf("完成标准与真实性"));
    expect(index).toBeGreaterThan(stable.indexOf("文件工作区"));

    // 群况变了（多了成员、任务标题与技能），前缀必须仍然逐字一致，
    // 否则供应商的前缀缓存每一轮都从头重新预填。
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main", status: "running" });
    const changed = buildSystemPrompt(
      context({
        members: [member({ status: "running" }), sub],
        taskTitles: new Map([["m_sub", "调研坦桑关税"]]),
        skills: [{ name: "arxiv-research", description: "论文检索", scope: "shared" }],
        availableTools: new Set(["file_list"]),
      }),
    );
    expect(changed.slice(0, changed.indexOf(VOLATILE))).toBe(stable.slice(0, index));
    expect(changed).toContain("arxiv-research");
    expect(changed).toContain("调研坦桑关税");

    const withArchive = buildSystemPrompt(
      context({ teamFile: "## @研究员\n- 能力：调研", availableTools: new Set(["file_list"]) }),
    );
    expect(withArchive.indexOf("## @研究员")).toBeGreaterThan(index);
    expect(withArchive).toContain("分派前对照「当前群况」里的成员能力档案");
  });

  it("主智能体派活要重述背景，并把成员汇报当作自述去回读", () => {
    const prompt = buildSystemPrompt(context({ availableTools: new Set(["file_read"]) }));
    expect(prompt).toContain("成员看不到你这轮的推理");
    expect(prompt).toContain("错误原文、约束条件、完成标准和输出语言");
    expect(prompt).toContain("成员汇报只是它的自述，不是已核实的事实");
    expect(prompt).toContain("可核验的把手");
    expect(prompt).toContain("用 file_read / task_list 回读确认");
  });

  it("成员侧要求给出可核验把手，缺背景先自查而不是猜", () => {
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main" });
    const prompt = buildSystemPrompt(
      context({ member: sub, members: [member(), sub], parentName: "主智能体", availableTools: new Set() }),
    );
    expect(prompt).toContain("证据里要有可核验的把手");
    expect(prompt).toContain("上级会回读核对");
    expect(prompt).toContain("不要按猜测交付");
  });

  it("花名册与技能索引只出现在末尾的当前群况里", () => {
    const sub = member({ id: "m_sub", name: "研究员", role: "sub", spawnedBy: "m_main" });
    const prompt = buildSystemPrompt(
      context({
        member: sub,
        members: [member(), sub],
        parentName: "主智能体",
        skills: [{ name: "summarize", description: "摘要", scope: "shared" }],
        availableTools: new Set(),
      }),
    );
    expect(prompt.indexOf(VOLATILE)).toBeGreaterThan(prompt.indexOf("完成标准与真实性"));
    expect(prompt.indexOf("群成员：")).toBeGreaterThan(prompt.indexOf(VOLATILE));
    expect(prompt.indexOf("可用技能（任务与描述匹配")).toBeGreaterThan(prompt.indexOf(VOLATILE));
    expect(prompt).toContain("@ 之前先在这里找名字与技能");
  });
});
