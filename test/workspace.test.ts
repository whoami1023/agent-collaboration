import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRegistry } from "../src/workspace/workspace";

let dir: string;
let registry: WorkspaceRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-workspace-"));
  registry = new WorkspaceRegistry(dir);
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

    const reloaded = new WorkspaceRegistry(dir);
    const restored = await reloaded.get({ id: "u_alice", displayName: "Alice" });
    expect(restored.bus.listMessages(10).map((message) => message.text)).toContain(
      "需要保留的消息",
    );
    expect(restored.board.list().map((task) => task.title)).toContain("需要保留的任务");
    expect(restored.getSettings().activeProviderId).toBe("deepseek");
    await reloaded.closeAll();
  });
});
