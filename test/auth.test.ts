import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, AuthService } from "../src/auth/auth-service";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-auth-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(options = {}): AuthService {
  return new AuthService(join(dir, "auth.json"), options);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AuthService", () => {
  it("首个账号成为管理员，且初始化只能执行一次", async () => {
    const auth = service();
    await auth.init();
    expect(auth.needsSetup()).toBe(true);

    const result = await auth.setupAdmin({
      username: "Owner",
      displayName: "老板",
      password: "secret123",
    });
    expect(result.user.role).toBe("admin");
    expect(result.user.username).toBe("owner");
    expect(result.user.mainAgentId).toBe("m_main");
    expect(auth.needsSetup()).toBe(false);
    await expect(
      auth.setupAdmin({ username: "second", password: "secret123" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("登录、鉴权与退出", async () => {
    const auth = service();
    await auth.init();
    await auth.setupAdmin({ username: "owner", password: "secret123" });

    await expect(auth.login("owner", "wrongpass", "127.0.0.1")).rejects.toMatchObject({
      status: 401,
    });
    const login = await auth.login("OWNER", "secret123", "127.0.0.1");
    expect(login.user.username).toBe("owner");
    expect(await auth.authenticate(login.token)).toMatchObject({ username: "owner" });

    await auth.logout(login.token);
    expect(await auth.authenticate(login.token)).toBeNull();
  });

  it("仅管理员可以创建账号，用户名不可重复", async () => {
    const auth = service();
    await auth.init();
    const admin = await auth.setupAdmin({ username: "owner", password: "secret123" });
    const member = await auth.createUser(admin.user, {
      username: "alice",
      displayName: "Alice",
      password: "alicepass1",
    });
    expect(member.role).toBe("user");
    expect(auth.listUsers()).toHaveLength(2);

    await expect(
      auth.createUser(admin.user, { username: "Alice", password: "alicepass1" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      auth.createUser(member, { username: "bob", password: "bobpass123" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("校验用户名与密码强度，且不返回密码哈希", async () => {
    const auth = service();
    await auth.init();
    await expect(
      auth.setupAdmin({ username: "ab", password: "secret123" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      auth.setupAdmin({ username: "owner", password: "short" }),
    ).rejects.toMatchObject({ status: 400 });

    const admin = await auth.setupAdmin({ username: "owner", password: "secret123" });
    const users = auth.listUsers();
    expect(JSON.stringify(users)).not.toContain("passwordHash");
    expect(JSON.stringify(users)).not.toContain("salt");
    expect(admin.user.role).toBe("admin");
  });

  it("连续失败触发限流，锁定期内正确密码也拒绝", async () => {
    const auth = service({ maxAttempts: 2, lockoutMs: 60, failureWindowMs: 1000 });
    await auth.init();
    await auth.setupAdmin({ username: "owner", password: "secret123" });

    await expect(auth.login("owner", "bad1", "10.0.0.1")).rejects.toBeInstanceOf(AuthError);
    await expect(auth.login("owner", "bad2", "10.0.0.1")).rejects.toBeInstanceOf(AuthError);
    await expect(auth.login("owner", "secret123", "10.0.0.1")).rejects.toMatchObject({
      status: 429,
    });
    await expect(auth.login("owner", "bad3", "10.0.0.2")).rejects.toMatchObject({ status: 401 });

    await sleep(80);
    const result = await auth.login("owner", "secret123", "10.0.0.1");
    expect(result.user.username).toBe("owner");
  });

  it("可以更新显示名称与密码，密码变更会注销其他会话", async () => {
    const auth = service();
    await auth.init();
    const admin = await auth.setupAdmin({
      username: "owner",
      displayName: "老板",
      password: "secret123",
    });
    const other = await auth.login("owner", "secret123", "127.0.0.1");

    const renamed = await auth.updateProfile(admin.user.id, { displayName: "  老王  " });
    expect(renamed.displayName).toBe("老王");

    await expect(
      auth.updateProfile(admin.user.id, { displayName: "   " }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      auth.updateProfile(admin.user.id, { newPassword: "newsecret1" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      auth.updateProfile(admin.user.id, {
        currentPassword: "wrong-pass",
        newPassword: "newsecret1",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      auth.updateProfile(admin.user.id, {
        displayName: "中途失败",
        currentPassword: "wrong-pass",
        newPassword: "newsecret1",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(auth.listUsers()[0]?.displayName).toBe("老王");

    const changed = await auth.updateProfile(
      admin.user.id,
      { currentPassword: "secret123", newPassword: "newsecret1" },
      admin.token,
    );
    expect(changed.displayName).toBe("老王");
    expect(await auth.authenticate(admin.token)).not.toBeNull();
    expect(await auth.authenticate(other.token)).toBeNull();
    await expect(auth.login("owner", "secret123", "127.0.0.1")).rejects.toMatchObject({
      status: 401,
    });
    const relogin = await auth.login("owner", "newsecret1", "127.0.0.1");
    expect(relogin.user.displayName).toBe("老王");
  });

  it("管理员可以重置他人密码并注销其会话，普通用户被拒绝", async () => {
    const auth = service();
    await auth.init();
    const admin = await auth.setupAdmin({ username: "owner", password: "secret123" });
    const alice = await auth.createUser(admin.user, {
      username: "alice",
      displayName: "Alice",
      password: "alicepass1",
    });
    const aliceSession = await auth.login("alice", "alicepass1", "127.0.0.1");
    const aliceSecond = await auth.login("alice", "alicepass1", "127.0.0.2");
    const bob = await auth.createUser(admin.user, {
      username: "bob",
      password: "bobpass123",
    });

    await expect(auth.resetPassword(bob, alice.id, "resetpass1")).rejects.toMatchObject({
      status: 403,
    });
    await expect(auth.resetPassword(admin.user, "u_missing", "resetpass1")).rejects.toMatchObject({
      status: 404,
    });
    await expect(auth.resetPassword(admin.user, alice.id, "short")).rejects.toMatchObject({
      status: 400,
    });

    const reset = await auth.resetPassword(admin.user, alice.id, "resetpass1");
    expect(reset.username).toBe("alice");
    expect(JSON.stringify(reset)).not.toContain("passwordHash");
    expect(await auth.authenticate(aliceSession.token)).toBeNull();
    expect(await auth.authenticate(aliceSecond.token)).toBeNull();
    expect(await auth.authenticate(admin.token)).not.toBeNull();

    await expect(auth.login("alice", "alicepass1", "127.0.0.1")).rejects.toMatchObject({
      status: 401,
    });
    const relogin = await auth.login("alice", "resetpass1", "127.0.0.1");
    expect(relogin.user.username).toBe("alice");

    await auth.resetPassword(admin.user, admin.user.id, "adminnew1", admin.token);
    expect(await auth.authenticate(admin.token)).not.toBeNull();
    const adminRelogin = await auth.login("owner", "adminnew1", "127.0.0.1");
    expect(adminRelogin.user.role).toBe("admin");
  });

  it("会话可持久化，过期后失效", async () => {
    const auth = service();
    await auth.init();
    const admin = await auth.setupAdmin({ username: "owner", password: "secret123" });

    const reloaded = service();
    await reloaded.init();
    expect(await reloaded.authenticate(admin.token)).toMatchObject({ username: "owner" });

    const shortLived = service({ sessionTtlMs: 10 });
    await shortLived.init();
    const session = await shortLived.login("owner", "secret123", "127.0.0.1");
    await sleep(20);
    expect(await shortLived.authenticate(session.token)).toBeNull();
  });
});
