import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomBus } from "../src/room/bus";
import { Workboard } from "../src/workboard/board";
import { Orchestrator, ensureMainMember } from "../src/agent/orchestrator";
import { buildSystemPrompt } from "../src/agent/prompts";
import { DEFAULT_MODEL_REF, type Member } from "../src/core/types";
import { defaultSettings } from "../src/core/settings";
import { SkillLibrary } from "../src/skills/library";
import { MemorySearchManager } from "../src/memory/manager";
import { readTeamFileForPrompt, syncTeamFile, TEAM_FILE_NAME } from "../src/memory/team-file";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-team-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const context = { roomName: "测试作战室", mainAgentName: "主智能体" };

function mainMember(): Member {
  return {
    id: "m_main",
    roomId: "room_test",
    name: "主智能体",
    role: "main",
    status: "idle",
    depth: 0,
    spawnedBy: null,
    controlScope: "children",
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: DEFAULT_MODEL_REF,
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    lastActiveAt: Date.parse("2026-01-01T00:00:00Z"),
  };
}

function subMember(overrides: Partial<Member> & Pick<Member, "id" | "name">): Member {
  const now = Date.parse("2026-01-02T00:00:00Z");
  return {
    roomId: "room_test",
    role: "sub",
    status: "idle",
    depth: 1,
    spawnedBy: "m_main",
    controlScope: "none",
    contextMode: "isolated",
    systemPrompt: "",
    modelRef: DEFAULT_MODEL_REF,
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

const researcher = () =>
  subMember({
    id: "m_research",
    name: "调研员",
    brief: "负责联网搜索资料并给出带出处的结论",
    skillNames: ["web-search", "web-fetch"],
  });

const writer = () =>
  subMember({
    id: "m_writer",
    name: "文档员",
    brief: "把草稿排版成 Word 交付件",
    templateTitle: "文档写手",
    skillNames: [],
  });

async function teamText(): Promise<string> {
  return readFile(join(dir, TEAM_FILE_NAME), "utf8");
}

describe("TEAM.md 自动维护", () => {
  it("首次同步生成前言与每个子成员一段，主智能体不入档", async () => {
    const result = await syncTeamFile(dir, [mainMember(), researcher(), writer()], context);
    expect(result).toMatchObject({ changed: true, added: 2 });
    const text = await teamText();
    expect(text).toContain("# TEAM.md - 成员能力档案");
    expect(text).toContain("## @调研员");
    expect(text).toContain("- 能力：负责联网搜索资料并给出带出处的结论");
    expect(text).toContain("- 技能：web-search、web-fetch");
    expect(text).toContain("- 能力：把草稿排版成 Word 交付件");
    expect(text).toContain("- 技能：未启用任何技能");
    expect(text).toContain("- 来源：模板「文档写手」");
    expect(text).toContain("- 创建：2026-01-02");
    expect(text).not.toContain("## @主智能体");
  });

  it("重复同步不写盘；技能白名单变了才刷新自动段落", async () => {
    await syncTeamFile(dir, [mainMember(), researcher()], context);
    const first = await teamText();
    expect(first).toContain("- 技能：web-search、web-fetch");
    expect(await syncTeamFile(dir, [mainMember(), researcher()], context)).toMatchObject({
      changed: false,
    });

    const narrowed = subMember({ ...researcher(), skillNames: ["web-search"] });
    expect(await syncTeamFile(dir, [mainMember(), narrowed], context)).toMatchObject({
      changed: true,
      updated: 1,
    });
    const next = await teamText();
    expect(next).toContain("- 技能：web-search\n");
    expect(next).not.toContain("web-search、web-fetch");
  });

  it("用户手改过的段落原样保留，之后不再被自动刷新覆盖", async () => {
    await syncTeamFile(dir, [mainMember(), researcher()], context);
    const original = await teamText();
    const annotated = original.replace(
      "- 能力：负责联网搜索资料并给出带出处的结论",
      "- 能力：负责联网搜索资料并给出带出处的结论\n- 实测：只擅长中文资料，英文源经常漏引用",
    );
    await writeFile(join(dir, TEAM_FILE_NAME), annotated, "utf8");

    await syncTeamFile(dir, [mainMember(), subMember({ ...researcher(), skillNames: [] })], context);
    const text = await teamText();
    expect(text).toContain("- 实测：只擅长中文资料，英文源经常漏引用");
    // 技能行仍是用户看到的那一行：手改过的段落不再被自动改写。
    expect(text).toContain("- 技能：web-search、web-fetch");
  });

  it("移除成员的段落被删掉，用户自己写的段落保留", async () => {
    await syncTeamFile(dir, [mainMember(), researcher(), writer()], context);
    const original = await teamText();
    await writeFile(
      join(dir, TEAM_FILE_NAME),
      `${original}\n## 派活习惯\n\n- 排版类优先给文档员。\n`,
      "utf8",
    );

    const result = await syncTeamFile(dir, [mainMember(), researcher()], context);
    expect(result).toMatchObject({ changed: true, removed: 1, added: 0 });
    const text = await teamText();
    expect(text).not.toContain("## @文档员");
    expect(text).toContain("## @调研员");
    expect(text).toContain("## 派活习惯");
    expect(text.startsWith("# TEAM.md")).toBe(true);
  });

  it("注入提示词只取成员段落；没有成员时不注入", async () => {
    expect(await readTeamFileForPrompt(dir)).toBeUndefined();
    await syncTeamFile(dir, [mainMember(), researcher()], context);
    const injected = await readTeamFileForPrompt(dir);
    expect(injected).toBeDefined();
    expect(injected!.startsWith("## @调研员")).toBe(true);
    expect(injected).not.toContain("<!-- member:");
    expect(injected).not.toContain("# TEAM.md - 成员能力档案");
    await syncTeamFile(dir, [mainMember()], context);
    expect(await readTeamFileForPrompt(dir)).toBeUndefined();
  });
});

describe("记忆层接入", () => {
  function manager(bus: RoomBus): MemorySearchManager {
    return new MemorySearchManager({ workspaceDir: dir, bus });
  }

  it("syncTeamFile 以花名册为准，TEAM.md 可读写但不进检索语料", async () => {
    await writeFile(join(dir, "MEMORY.md"), "# 长期记忆\n\n- 项目用 Docker Compose 部署\n", "utf8");
    const bus = new RoomBus("room_test", "测试作战室");
    ensureMainMember(bus);
    bus.addMember(researcher());
    const m = manager(bus);

    await m.syncTeamFile();
    expect((await m.listAgentFiles()).map((file) => file.path)).toContain(TEAM_FILE_NAME);
    expect(await m.readTeamFile()).toContain("## @调研员");
    expect((await m.readAgentFile(TEAM_FILE_NAME)).content).toContain("- 技能：web-search、web-fetch");
    expect(await m.writeAgentFile(TEAM_FILE_NAME, "# TEAM.md\n\n## @我自己写的段落\n\n- 保留\n")).toMatchObject({
      path: TEAM_FILE_NAME,
    });

    const hits = await m.search("Docker Compose", { lexicalOnly: true, sources: ["memory"] });
    expect(hits.some((hit) => hit.path === TEAM_FILE_NAME)).toBe(false);
  });

  it("主智能体提示词带上成员能力档案，子成员提示词不带", () => {
    const base = {
      roomName: "测试作战室",
      parentName: null,
      taskTitles: new Map<string, string>(),
      mode: "delegate" as const,
      limits: { maxChildrenPerAgent: 3, maxSpawnDepth: 3, maxConcurrent: 4, maxStepsPerRun: 12 },
      skills: [],
    };
    const teamFile = "## @调研员\n\n- 能力：负责联网搜索资料并给出带出处的结论\n- 技能：web-search、web-fetch";

    const main = buildSystemPrompt({
      ...base,
      member: mainMember(),
      members: [mainMember(), researcher()],
      teamFile,
    });
    expect(main).toContain("成员能力档案");
    expect(main).toContain("- 技能：web-search、web-fetch");
    expect(main).toContain("分派前对照「当前群况」里的成员能力档案");
    // 群成员花名册与档案之间仍然只隔一个空行。
    expect(main).toContain("）\n\n成员能力档案");
    expect(main).toContain("web-fetch\n\n可用技能");

    const withoutTeam = buildSystemPrompt({
      ...base,
      member: mainMember(),
      members: [mainMember(), researcher()],
    });
    expect(withoutTeam).not.toContain("成员能力档案");
    expect(withoutTeam).toContain("）\n\n可用技能");

    const sub = buildSystemPrompt({
      ...base,
      member: researcher(),
      members: [mainMember(), researcher()],
      parentName: "主智能体",
      teamFile,
    });
    expect(sub).not.toContain("成员能力档案");
  });
});

describe("成员增删同步档案", () => {
  it("createMember 写入能力段落，removeMember 删除", async () => {
    const bus = new RoomBus("room_test", "测试作战室");
    const board = new Workboard("room_test");
    ensureMainMember(bus);
    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const memory = new MemorySearchManager({ workspaceDir: dir, bus });
    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => defaultSettings(),
      skills,
      ownerId: "u_test",
      memory,
    });

    const member = await orchestrator.createMember({
      name: "调研员",
      description: "负责联网搜索资料并给出带出处的结论",
    });
    const text = await teamText();
    expect(text).toContain(`## @调研员 <!-- member:${member.id}`);
    expect(text).toContain("- 能力：负责联网搜索资料并给出带出处的结论");
    expect(text).toContain("- 技能：跟随技能库");
    expect(bus.listMessages().at(-1)?.text).toContain("TEAM.md");
    expect(await memory.readTeamFile()).toContain("## @调研员");

    await orchestrator.removeMember(member.id);
    const after = await teamText();
    expect(after).not.toContain("## @调研员");
    expect(after.startsWith("# TEAM.md")).toBe(true);
    expect(await memory.readTeamFile()).toBeUndefined();
  });
});
