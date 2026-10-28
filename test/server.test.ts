import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import { createApp } from "../src/server/app";

let dir: string;
let registry: WorkspaceRegistry;
let server: Server;
let baseUrl: string;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
  cookie?: string;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  const cookie = setCookie?.split(";")[0];
  return {
    status: response.status,
    body,
    ...(cookie ? { cookie } : {}),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-server-"));
  const auth = new AuthService(join(dir, "auth.json"));
  await auth.init();
  registry = new WorkspaceRegistry(join(dir, "workspaces"));
  const app = createApp({ auth, workspaces: registry, webDist: join(dir, "missing-dist") });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器未监听");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registry.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("多用户 API", () => {
  it("未登录拒绝访问，首次初始化管理员并进入自己的房间", async () => {
    expect((await call("/api/auth/bootstrap")).body["needsSetup"]).toBe(true);
    expect((await call("/api/state")).status).toBe(401);

    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    expect(setup.status).toBe(201);
    expect(setup.cookie).toBeTruthy();
    const cookie = setup.cookie as string;

    const me = await call("/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect((me.body["user"] as Record<string, unknown>)["role"]).toBe("admin");

    const state = await call("/api/state", { cookie });
    expect(state.status).toBe(200);
    expect((state.body["room"] as Record<string, unknown>)["name"]).toContain("老板");
    expect(await call("/api/auth/setup", {
      method: "POST",
      body: { username: "other", password: "secret123" },
    })).toMatchObject({ status: 409 });
  });

  it("管理员建号，普通用户不能建号，两个账号数据隔离", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", password: "secret123" },
    });
    const adminCookie = setup.cookie as string;

    const created = await call("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "alice", displayName: "Alice", password: "alicepass1" },
    });
    expect(created.status).toBe(201);
    expect((created.body["user"] as Record<string, unknown>)["role"]).toBe("user");

    const login = await call("/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "alicepass1" },
    });
    const aliceCookie = login.cookie as string;
    expect(login.status).toBe(200);
    expect(
      (await call("/api/users", { method: "POST", cookie: aliceCookie, body: { username: "x", password: "xxxxxxxx" } })).status,
    ).toBe(403);

    await call("/api/tasks", {
      method: "POST",
      cookie: adminCookie,
      body: { title: "管理员的任务" },
    });
    const adminState = await call("/api/state", { cookie: adminCookie });
    const aliceState = await call("/api/state", { cookie: aliceCookie });
    expect((adminState.body["tasks"] as unknown[]).length).toBe(1);
    expect((aliceState.body["tasks"] as unknown[]).length).toBe(0);
    expect((aliceState.body["room"] as Record<string, unknown>)["name"]).toContain("Alice");

    await call("/api/messages", {
      method: "POST",
      cookie: adminCookie,
      body: { text: "帮我调研多智能体协同的调度方式" },
    });
    const aliceAfter = await call("/api/state", { cookie: aliceCookie });
    expect((aliceAfter.body["messages"] as unknown[]).length).toBe(0);
    const adminAfter = await call("/api/state", { cookie: adminCookie });
    expect((adminAfter.body["messages"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("登录失败限流、退出后会话失效，SSE 也需要登录", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", password: "secret123" },
    });
    const cookie = setup.cookie as string;

    const unauthorizedSse = await fetch(`${baseUrl}/api/events`);
    expect(unauthorizedSse.status).toBe(401);

    const sse = await fetch(`${baseUrl}/api/events`, { headers: { cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("connected");
    await reader?.cancel();

    const wrong = await call("/api/auth/login", {
      method: "POST",
      body: { username: "owner", password: "wrong-pass" },
    });
    expect(wrong.status).toBe(401);

    const logout = await call("/api/auth/logout", { method: "POST", cookie });
    expect(logout.status).toBe(200);
    expect((await call("/api/auth/me", { cookie })).status).toBe(401);
  });
});
