import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublicUser } from "../src/core/types";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceRegistry } from "../src/workspace/workspace";

let dir: string;
let skills: SkillLibrary;
let registry: WorkspaceRegistry;

const adminUser: PublicUser = {
  id: "u_admin",
  username: "owner",
  displayName: "老板",
  role: "admin",
  createdAt: 0,
  mainAgentId: "m_main",
  roomId: "room_main",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-workspace-"));
  skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  registry = new WorkspaceRegistry(dir, skills);
});

afterEach(async () => {
  await registry.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceRegistry", () => {
  it("每个用户有独立房间、主智能体、消息与看板", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const bob = await registry.get({ id: "u_bob", displayName: "Bob" });

    expect(alice.bus.roomName).toContain("Alice");
    expect(bob.bus.roomName).toContain("Bob");
    expect(alice.bus.listMembers().find((member) => member.role === "main")?.id).toBe("m_main");

    alice.bus.append({
      senderId: "system",
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: "Alice 的私有记录",
    });
    alice.board.create({ title: "Alice 的任务", createdBy: "u_alice" });

    expect(alice.bus.listMessages(10)).toHaveLength(1);
    expect(bob.bus.listMessages(10)).toHaveLength(0);
    expect(alice.board.list()).toHaveLength(1);
    expect(bob.board.list()).toHaveLength(0);
  });

  it("按模板创建成员：技能白名单只留可用的，档案文件写入模板设定", async () => {
    await skills.create(adminUser, {
      scope: "shared",
      name: "web-search",
      description: "联网搜索现时信息",
      instructions: "# 联网搜索",
    });
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });

    const member = await alice.orchestrator.createMember({
      name: "调研员",
      description: "把问题查透并给出带出处的结论",
      skillNames: ["web-search", "已消失的技能"],
      profile: { vibe: "查证狂", emoji: "🔍", workstyle: ["关键结论至少两条独立来源。"] },
      template: { key: "deep-researcher", title: "深度调研员" },
    });

    expect(member.skillNames).toEqual(["web-search"]);
    expect(member.templateKey).toBe("deep-researcher");
    expect(member.templateTitle).toBe("深度调研员");

    const agentDir = join(dir, "u_alice", "agents", member.id);
    const soul = await readFile(join(agentDir, "SOUL.md"), "utf8");
    expect(soul).toContain("关键结论至少两条独立来源。");
    // 模板的工作方式排在通用底线之前，两者都在。
    expect(soul.indexOf("关键结论至少两条独立来源")).toBeLessThan(
      soul.indexOf("只做分给我的任务"),
    );
    const identity = await readFile(join(agentDir, "IDENTITY.md"), "utf8");
    expect(identity).toContain("- **Emoji:** 🔍");
    expect(identity).toContain("- **Vibe:** 查证狂");
    expect(identity).toContain("- **模板:** 深度调研员");

    const last = alice.bus.listMessages().at(-1);
    expect(last?.text).toContain("已按模板「深度调研员」创建成员 @调研员");
    expect(last?.text).toContain("可用技能 1 个");
  });

  it("不用模板创建成员时档案文件保持默认设定", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const member = await alice.orchestrator.createMember({
      name: "资料员",
      description: "整理资料并归档",
    });
    const identity = await readFile(join(dir, "u_alice", "agents", member.id, "IDENTITY.md"), "utf8");
    expect(identity).toContain("- **Emoji:** 待挑选");
    expect(identity).toContain("- **Vibe:** 直接、先查证再开口");
    expect(identity).not.toContain("- **模板:**");
    expect(member.skillNames).toBeUndefined();
    expect(member.templateKey).toBeUndefined();
  });

  it("drop 关闭并删除该用户的工作区目录，其他用户不受影响", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const bob = await registry.get({ id: "u_bob", displayName: "Bob" });
    await alice.files.write("草稿.md", Buffer.from("Alice 的成果", "utf8"));
    await bob.files.write("Bob的.md", Buffer.from("别动我", "utf8"));

    expect(await registry.drop("u_alice")).toBe(true);
    expect(existsSync(join(dir, "u_alice"))).toBe(false);
    expect((await bob.files.list()).files.map((entry) => entry.name)).toEqual(["Bob的.md"]);

    // 目录已没了也要能重复调用（幂等），之后取用会重建一个空工作区。
    expect(await registry.drop("u_alice")).toBe(true);
    const rebuilt = await registry.get({ id: "u_alice", displayName: "Alice" });
    expect(rebuilt.bus.listMessages(50)).toHaveLength(0);
    await expect(registry.drop("../escape")).rejects.toThrow("账号 ID 不合法");
    expect(existsSync(join(dir, "u_bob"))).toBe(true);
  });

  it("作战室模式随群聊状态持久化", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    expect(alice.bus.roomMode).toBe("delegate");
    alice.setRoomMode("free");
    await alice.persist();
    await alice.close();

    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const reloaded = new WorkspaceRegistry(dir, skills);
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    expect(restored.bus.roomMode).toBe("free");
    await reloaded.closeAll();
  });

  it("模型设置按用户隔离", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const bob = await registry.get({ id: "u_bob", displayName: "Bob" });

    await alice.setSettings({
      ...alice.getSettings(),
      selection: { ...alice.getSettings().selection, defaultModel: "deepseek/deepseek-chat" },
    });
    expect(alice.getSettings().selection.defaultModel).toBe("deepseek/deepseek-chat");
    expect(bob.getSettings().selection.defaultModel).toBe("demo/mock");
  });

  it("重启后从各自目录恢复状态与设置", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    alice.bus.append({
      senderId: "system",
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: "需要保留的消息",
    });
    alice.board.create({ title: "需要保留的任务", createdBy: "u_alice" });
    await alice.setSettings({
      ...alice.getSettings(),
      selection: { ...alice.getSettings().selection, defaultModel: "deepseek/deepseek-chat" },
    });
    await alice.close();

    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const reloaded = new WorkspaceRegistry(dir, skills);
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    expect(restored.bus.listMessages(10).map((message) => message.text)).toContain(
      "需要保留的消息",
    );
    expect(restored.board.list().map((task) => task.title)).toContain("需要保留的任务");
    expect(restored.getSettings().selection.defaultModel).toBe("deepseek/deepseek-chat");
    await reloaded.closeAll();
  });

  it("工作队列随房间落盘，重启后把未完成的唤醒义务接着跑完", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const room = alice.room();
    const trigger = room.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: "重启后继续这件事",
      depthTurn: 0,
    });
    const queued = room.workQueue.enqueue({
      memberId: "m_main",
      memberName: "主智能体",
      trigger,
    });
    expect(queued?.state).toBe("pending");
    await alice.close();

    const skills2 = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills2.init();
    const reloaded = new WorkspaceRegistry(dir, skills2);
    registry = reloaded;
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    const queue = restored.room().workQueue;
    const started = Date.now();
    while (
      !queue.list().some((item) => item.state === "done") &&
      Date.now() - started < 10_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const item = queue.list()[0];
    expect(item?.state).toBe("done");
    expect(item?.attempts).toBeGreaterThanOrEqual(1);
    expect(item?.outcome?.status).toBe("ok");
    expect(item?.outcome?.text).toBeTruthy();
  });

  it("结构化提问随房间落盘，重启后待答状态与已答字段都还在", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const room = alice.room();
    const questionMessage = room.bus.append({
      senderId: "m_main",
      senderName: "主智能体",
      senderKind: "member",
      kind: "question",
      text: "【需要你回答】确认口径",
      mentions: [],
      depthTurn: 0,
    });
    const item = room.questions.ask({
      messageId: questionMessage.id,
      askerId: "m_main",
      askerName: "主智能体",
      title: "确认口径",
      questions: [
        {
          id: "scope",
          question: "范围？",
          options: [
            { id: "brief", label: "摘要" },
            { id: "full", label: "完整", recommended: true },
          ],
        },
        {
          id: "audience",
          question: "读者？",
          options: [
            { id: "exec", label: "管理层" },
            { id: "team", label: "执行团队" },
          ],
        },
      ],
    });
    room.questions.answer(item.id, "scope", { optionId: "brief" }, "u_alice");
    await alice.close();

    const skills2 = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills2.init();
    const reloaded = new WorkspaceRegistry(dir, skills2);
    registry = reloaded;
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    const questions = restored.room().questions.list();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.status).toBe("open");
    expect(questions[0]?.messageId).toBe(questionMessage.id);
    expect(questions[0]?.answers["scope"]?.optionId).toBe("brief");
    expect(questions[0]?.questions).toHaveLength(2);
  });

  it("执行轨迹随房间落盘，重载后消息与工具活动仍在，清会话后清空", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const bus = alice.bus;
    bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      kind: "chat",
      text: "做一次巡检",
      depthTurn: 0,
    });
    bus.append({
      senderId: "m_main",
      senderName: "主智能体",
      senderKind: "member",
      kind: "announce",
      text: "开始巡检",
      depthTurn: 0,
    });
    bus.emit({
      type: "run",
      event: {
        type: "reasoning",
        runId: "run_x",
        memberId: "m_main",
        text: "先看目录结构，再决定巡检命令。",
      },
    });
    bus.emit({
      type: "run",
      event: {
        type: "tool",
        runId: "run_x",
        memberId: "m_main",
        name: "run_command",
        args: { command: "ls" },
      },
    });
    bus.emit({
      type: "run",
      event: { type: "run-final", runId: "run_x", memberId: "m_main", text: "巡检完成" },
    });
    expect(alice.listActivity().some((event) => event.kind === "tool")).toBe(true);
    await alice.close();

    const skills2 = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills2.init();
    const reloaded = new WorkspaceRegistry(dir, skills2);
    registry = reloaded;
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    const activity = restored.listActivity();
    expect(activity.some((event) => event.kind === "user")).toBe(true);
    expect(activity.some((event) => event.kind === "message")).toBe(true);
    expect(activity.some((event) => event.kind === "tool")).toBe(true);
    expect(activity.some((event) => event.kind === "final")).toBe(true);
    const thinking = activity.find((event) => event.kind === "thinking");
    expect(thinking?.detail).toContain("目录结构");
    expect(thinking?.runId).toBe("run_x");

    await restored.clearRoomSession();
    expect(restored.listActivity()).toHaveLength(0);
  });

  it("首次加载即生成智能体档案文件，且不覆盖已有内容", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const files = await alice.memory.listAgentFiles();
    expect(files.map((file) => file.path)).toEqual([
      "MEMORY.md",
      "USER.md",
      "SOUL.md",
      "IDENTITY.md",
      "TEAM.md",
    ]);
    const soul = await alice.memory.readAgentFile("SOUL.md");
    expect(soul.content).toContain("我是谁");

    // 手工改写后重新加载：模板绝不覆盖用户内容。
    await writeFile(join(dir, "u_alice", "MEMORY.md"), "# 我的记忆\n\n- 自定义条目\n", "utf8");
    const skills2 = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills2.init();
    const reloaded = new WorkspaceRegistry(dir, skills2);
    const again = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    const memory = await again.memory.readAgentFile("MEMORY.md");
    expect(memory.content).toContain("自定义条目");
    expect(memory.content).not.toContain("示例：");
    await reloaded.closeAll();
  });

  it("/new 归档消息与任务卡、保留文件工作区，并切断上一个会话的上下文", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    alice.bus.append({
      senderId: "user",
      senderName: "老板",
      senderKind: "user",
      text: "上一个任务：调研多智能体协同",
    });
    alice.board.create({ title: "调研报告", createdBy: "user" });
    await mkdir(join(dir, "u_alice", "files"), { recursive: true });
    await writeFile(join(dir, "u_alice", "files", "report.md"), "# 上一轮成果", "utf8");
    const beforeSeq = alice.bus.snapshot().seq;

    const result = await alice.newSession();
    expect(result.archived).not.toBeNull();
    expect(result.archived!.messageCount).toBe(1);
    expect(result.archived!.taskCount).toBe(1);
    // 文件不进这份归档，也不被移走：新会话还能接着用上一轮的成果。
    expect(result.archived!.fileCount).toBe(0);
    expect(await readFile(join(dir, "u_alice", "files", "report.md"), "utf8")).toContain("上一轮成果");

    // 当前会话只剩一条起点提示：群聊窗口里不会再出现上一个任务。
    const texts = alice.bus.listMessages(10).map((message) => message.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("已开启新会话");
    expect(alice.bus.window(12000).some((message) => message.text.includes("调研多智能体协同"))).toBe(false);
    expect(alice.board.list()).toEqual([]);
    expect(alice.bus.snapshot().seq).toBeGreaterThan(beforeSeq);

    const listed = await alice.archives.list();
    expect(listed).toHaveLength(1);
    const detail = await alice.archives.read(listed[0]!.id);
    expect(detail.messages.map((message) => message.text)).toEqual(["上一个任务：调研多智能体协同"]);
    expect(detail.tasks.map((task) => task.title)).toEqual(["调研报告"]);
    expect(detail.fileCount).toBe(0);
  });

  it("/new 在空房间里不生成归档，只留下新会话提示", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const result = await alice.newSession();
    expect(result.archived).toBeNull();
    expect(result.cleared).toBe(0);
    expect(result.tasksCleared).toBe(0);
    const texts = alice.bus.listMessages(10).map((message) => message.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("当前没有需要归档的内容");
    expect(await alice.archives.list()).toEqual([]);
  });

  it("/new 的结果落盘：重载工作区仍在同一个新会话里", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    alice.bus.append({
      senderId: "user",
      senderName: "老板",
      senderKind: "user",
      text: "旧会话内容",
    });
    await alice.newSession();
    await alice.close();

    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const reloaded = new WorkspaceRegistry(dir, skills);
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    expect(restored.bus.listMessages(10).map((message) => message.text)).toEqual([
      expect.stringContaining("已开启新会话"),
    ]);
    expect(restored.board.list()).toEqual([]);
    await reloaded.closeAll();
  });
});
