import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
