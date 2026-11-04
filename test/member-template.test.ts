import { describe, expect, it } from "vitest";
import type { Member } from "../src/core/types";
import { agentFileTemplate, DEFAULT_MEMBER_WORKSTYLE } from "../src/memory/bootstrap-files";
import { draftTemplateFromMember } from "../src/templates/member-template";
import { TEMPLATE_LIMITS } from "../src/templates/template-library";

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "m_research",
    roomId: "room_main",
    name: "调研员",
    role: "sub",
    status: "idle",
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    createdAt: 1,
    lastActiveAt: 1,
    modelRef: "default",
    ...overrides,
  };
}

const SOUL = `# SOUL.md - 我是谁

_我是 @调研员，老板 的作战室里的成员，由 @主智能体 创建。_

## 角色

负责把调研问题查透，分多轮检索并交叉验证。所有事实都要带出处。

## 工作方式

- 每条结论至少两个独立来源
- ${DEFAULT_MEMBER_WORKSTYLE[0]}
- 先自己查再开口：room_history、use_skill、memory_search 能查到的不要问回来。
- 对外发送、删除、覆盖这类不可逆动作，先向 @主智能体 确认。

## 边界

- 不把私密内容带到共享技能库或对外消息里。
`;

const IDENTITY = `# IDENTITY.md - 身份档案

- **Name:** 调研员
- **Creature:** 老板的作战室里的子成员，向 @主智能体 汇报
- **Role:** 负责把调研问题查透
- **Vibe:** 查证狂，宁缺毋滥
- **Emoji:** 🔍
- **模板:** 深度调研员
`;

describe("成员导出模板草稿", () => {
  it("带上成员职责、非默认的工作方式条目与身份字段", () => {
    const draft = draftTemplateFromMember({
      member: member({ brief: "负责把调研问题查透，所有事实必须带出处。" }),
      soul: SOUL,
      identity: IDENTITY,
    });
    expect(draft.title).toBe("调研员");
    expect(draft.suggestedName).toBe("调研员");
    expect(draft.brief).toBe("负责把调研问题查透，所有事实必须带出处。");
    expect(draft.description).toBe("负责把调研问题查透，所有事实必须带出处");
    expect(draft.vibe).toBe("查证狂，宁缺毋滥");
    expect(draft.emoji).toBe("🔍");
    expect(draft.workstyle).toEqual(["每条结论至少两个独立来源"]);
  });

  it("成员没有职责描述时回落到 SOUL 的角色段落", () => {
    const draft = draftTemplateFromMember({ member: member({ brief: undefined }), soul: SOUL, identity: IDENTITY });
    expect(draft.brief).toContain("分多轮检索并交叉验证");
  });

  it("主智能体没有角色段落，取基本信条里改过的那条，并去掉加粗标记", () => {
    const mainSoul = `# SOUL.md - 我是谁\n\n## 基本信条\n\n**先自己查再开口。** 先用 room_history、task_list 把手上的信息用完。\n\n**本房间的规矩。** 所有对外稿件先过一遍法务清单。\n\n## 边界\n\n- 私密内容不外泄\n`;
    const draft = draftTemplateFromMember({
      member: member({ id: "m_main", name: "主智能体", role: "main", spawnedBy: null, brief: undefined }),
      soul: mainSoul,
    });
    // 预置的「先自己查再开口」不算他自己的设定，只有用户新增的那条进模板。
    expect(draft.brief).toBe("本房间的规矩。 所有对外稿件先过一遍法务清单。");
    expect(draft.description).toBe("本房间的规矩");
    expect(draft.workstyle).toBeUndefined();
  });

  it("主智能体的信条一条没改过，就用兜底职责而不是预置模板文字", () => {
    const draft = draftTemplateFromMember({
      member: member({ id: "m_main", name: "主智能体", role: "main", spawnedBy: null, brief: undefined }),
      soul: agentFileTemplate("SOUL.md", {
        displayName: "老板",
        mainAgentName: "主智能体",
        roomName: "作战室",
      }),
    });
    expect(draft.brief).toBe("由成员导出的模板：职责待补充。");
    expect(draft.description).toBe("由成员导出的模板：职责待补充");
  });

  it("没有显式技能白名单时草稿不带技能清单（引用后跟随技能库）", () => {
    expect(draftTemplateFromMember({ member: member() }).skillNames).toBeUndefined();
    expect(draftTemplateFromMember({ member: member({ skillNames: [] }) }).skillNames).toBeUndefined();
    const limited = draftTemplateFromMember({ member: member({ skillNames: ["web-search", "summarize"] }) });
    expect(limited.skillNames).toEqual(["web-search", "summarize"]);
  });

  it("分类优先沿用来源模板，其次按名称与描述推断", () => {
    expect(draftTemplateFromMember({ member: member(), categoryHint: "product" }).category).toBe("product");
    expect(draftTemplateFromMember({ member: member({ brief: "负责分析数据并出报表" }) }).category).toBe("data");
    expect(draftTemplateFromMember({ member: member({ name: "扫地僧", brief: "打扫" }) }).category).toBe("other");
  });

  it("占位 Emoji 与默认气质不会进模板", () => {
    const draft = draftTemplateFromMember({
      member: member(),
      identity: `- **Vibe:** 直接、先查证再开口\n- **Emoji:** 待挑选\n`,
    });
    expect(draft.vibe).toBeUndefined();
    expect(draft.emoji).toBeUndefined();
  });

  it("超长字段按模板上限裁剪，工作方式和技能都不越界", () => {
    const draft = draftTemplateFromMember({
      member: member({ brief: "长".repeat(2000), skillNames: Array.from({ length: 80 }, (_, i) => `skill-${i}`) }),
      soul: `## 工作方式\n\n${Array.from({ length: 20 }, (_, i) => `- 第${i}条`).join("\n")}\n\n## 边界\n`,
    });
    expect(draft.brief).toHaveLength(TEMPLATE_LIMITS.brief);
    expect(draft.description).toHaveLength(TEMPLATE_LIMITS.description);
    expect(draft.workstyle).toHaveLength(TEMPLATE_LIMITS.workstyle);
    // 技能清单超出模板上限时截断，保证草稿一定能存进模板库。
    expect(draft.skillNames).toHaveLength(TEMPLATE_LIMITS.skillNames);
  });

  it("过长的单条工作方式被丢弃而不是截断成半句", () => {
    const draft = draftTemplateFromMember({
      member: member(),
      soul: `## 工作方式\n\n- 正常条目\n- ${"超".repeat(TEMPLATE_LIMITS.workstyleLine + 1)}\n`,
    });
    expect(draft.workstyle).toEqual(["正常条目"]);
  });
});
