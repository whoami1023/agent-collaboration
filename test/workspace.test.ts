import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLibrary } from "../src/skills/library";
import { WorkspaceRegistry } from "../src/workspace/workspace";

let dir: string;
let registry: WorkspaceRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-workspace-"));
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
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

    await alice.setSettings({ ...alice.getSettings(), activeProviderId: "deepseek" });
    expect(alice.getSettings().activeProviderId).toBe("deepseek");
    expect(bob.getSettings().activeProviderId).toBe("demo");
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
    await alice.setSettings({ ...alice.getSettings(), activeProviderId: "deepseek" });
    await alice.close();

    const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
    await skills.init();
    const reloaded = new WorkspaceRegistry(dir, skills);
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    expect(restored.bus.listMessages(10).map((message) => message.text)).toContain(
      "需要保留的消息",
    );
    expect(restored.board.list().map((task) => task.title)).toContain("需要保留的任务");
    expect(restored.getSettings().activeProviderId).toBe("deepseek");
    await reloaded.closeAll();
  });

  it("首次加载即生成智能体档案文件，且不覆盖已有内容", async () => {
    const alice = await registry.get({ id: "u_alice", displayName: "Alice" });
    const files = await alice.memory.listAgentFiles();
    expect(files.map((file) => file.path)).toEqual(["MEMORY.md", "USER.md", "SOUL.md", "IDENTITY.md"]);
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
