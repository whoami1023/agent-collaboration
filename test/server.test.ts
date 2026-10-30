import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { SkillLibrary } from "../src/skills/library";
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
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  registry = new WorkspaceRegistry(join(dir, "workspaces"), skills);
  const app = createApp({ auth, workspaces: registry, skills, webDist: join(dir, "missing-dist") });
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

  it("个人资料更新：房间名同步、其他会话失效、新密码可登录", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    const cookie = setup.cookie as string;
    const second = await call("/api/auth/login", {
      method: "POST",
      body: { username: "owner", password: "secret123" },
    });
    const secondCookie = second.cookie as string;

    const renamed = await call("/api/auth/profile", {
      method: "PATCH",
      cookie,
      body: { displayName: "老王" },
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body["user"] as Record<string, unknown>)["displayName"]).toBe("老王");
    const state = await call("/api/state", { cookie });
    expect((state.body["room"] as Record<string, unknown>)["name"]).toContain("老王");

    const wrongPassword = await call("/api/auth/profile", {
      method: "PATCH",
      cookie,
      body: { currentPassword: "wrong-pass", newPassword: "newsecret1" },
    });
    expect(wrongPassword.status).toBe(400);

    const changed = await call("/api/auth/profile", {
      method: "PATCH",
      cookie,
      body: { currentPassword: "secret123", newPassword: "newsecret1" },
    });
    expect(changed.status).toBe(200);
    expect((await call("/api/auth/me", { cookie })).status).toBe(200);
    expect((await call("/api/auth/me", { cookie: secondCookie })).status).toBe(401);

    const oldLogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "owner", password: "secret123" },
    });
    expect(oldLogin.status).toBe(401);
    const relogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "owner", password: "newsecret1" },
    });
    expect(relogin.status).toBe(200);
    expect((relogin.body["user"] as Record<string, unknown>)["displayName"]).toBe("老王");
  });

  it("管理员重置用户密码：目标会话失效，旧密码不可登录，普通用户无权调用", async () => {
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
    const aliceId = (created.body["user"] as Record<string, unknown>)["id"] as string;
    const aliceLogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "alicepass1" },
    });
    const aliceCookie = aliceLogin.cookie as string;

    const forbidden = await call(`/api/users/${aliceId}/password`, {
      method: "POST",
      cookie: aliceCookie,
      body: { newPassword: "hijackpass1" },
    });
    expect(forbidden.status).toBe(403);
    const invalid = await call(`/api/users/${aliceId}/password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: "short" },
    });
    expect(invalid.status).toBe(400);
    const missing = await call("/api/users/u_missing/password", {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: "newalice1" },
    });
    expect(missing.status).toBe(404);

    const reset = await call(`/api/users/${aliceId}/password`, {
      method: "POST",
      cookie: adminCookie,
      body: { newPassword: "newalice1" },
    });
    expect(reset.status).toBe(200);
    expect((reset.body["user"] as Record<string, unknown>)["username"]).toBe("alice");
    expect((await call("/api/auth/me", { cookie: aliceCookie })).status).toBe(401);
    expect((await call("/api/auth/me", { cookie: adminCookie })).status).toBe(200);

    const oldLogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "alicepass1" },
    });
    expect(oldLogin.status).toBe(401);
    const relogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "newalice1" },
    });
    expect(relogin.status).toBe(200);
  });

  it("技能库：共享技能全员可见仅管理员可管，个人技能按账号隔离", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    const adminCookie = setup.cookie as string;
    await call("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "alice", displayName: "Alice", password: "alicepass1" },
    });
    const aliceLogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "alicepass1" },
    });
    const aliceCookie = aliceLogin.cookie as string;

    const shared = await call("/api/skills", {
      method: "POST",
      cookie: adminCookie,
      body: {
        scope: "shared",
        name: "research-brief",
        description: "三段式简报",
        instructions: "# 调研\n先给结论。",
      },
    });
    expect(shared.status).toBe(201);
    const sharedId = (shared.body["skill"] as Record<string, unknown>)["id"] as string;
    expect((shared.body["skill"] as Record<string, unknown>)["ownerName"]).toBe("老板");

    const aliceSkills = await call("/api/skills", { cookie: aliceCookie });
    expect(aliceSkills.status).toBe(200);
    expect(aliceSkills.body["canManageShared"]).toBe(false);
    expect((aliceSkills.body["shared"] as unknown[]).length).toBe(1);
    expect((aliceSkills.body["personal"] as unknown[]).length).toBe(0);

    const forbidden = await call("/api/skills", {
      method: "POST",
      cookie: aliceCookie,
      body: {
        scope: "shared",
        name: "alice-shared",
        description: "x",
        instructions: "x",
      },
    });
    expect(forbidden.status).toBe(403);
    expect(
      (
        await call(`/api/skills/${sharedId}`, {
          method: "PATCH",
          cookie: aliceCookie,
          body: { description: "篡改" },
        })
      ).status,
    ).toBe(403);
    expect((await call(`/api/skills/${sharedId}`, { method: "DELETE", cookie: aliceCookie })).status).toBe(403);

    const personal = await call("/api/skills", {
      method: "POST",
      cookie: aliceCookie,
      body: { name: "alice-notes", description: "个人笔记", instructions: "# 笔记" },
    });
    expect(personal.status).toBe(201);
    const adminSkills = await call("/api/skills", { cookie: adminCookie });
    expect((adminSkills.body["personal"] as unknown[]).length).toBe(0);
    const aliceAgain = await call("/api/skills", { cookie: aliceCookie });
    expect((aliceAgain.body["personal"] as Record<string, unknown>[])[0]?.["name"]).toBe("alice-notes");
    expect(
      (
        await call(`/api/skills/${sharedId}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: { description: "管理员更新" },
        })
      ).status,
    ).toBe(200);
    expect((await call(`/api/skills/${sharedId}`, { method: "DELETE", cookie: adminCookie })).status).toBe(200);
    expect((await call("/api/skills", { cookie: aliceCookie })).body["shared"]).toEqual([]);
  });

  it("导入 SKILL.md：共享要管理员，坏文件逐条返回，个人技能带导入标记", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "ownerpass1" },
    });
    const adminCookie = setup.cookie as string;
    await call("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "alice", displayName: "Alice", password: "alicepass1" },
    });
    const aliceCookie = (
      await call("/api/auth/login", {
        method: "POST",
        body: { username: "alice", password: "alicepass1" },
      })
    ).cookie as string;

    const forbidden = await call("/api/skills/import", {
      method: "POST",
      cookie: aliceCookie,
      body: {
        scope: "shared",
        files: [{ filename: "pdf-forms/SKILL.md", content: "---\nname: x\ndescription: y\n---\n正文" }],
      },
    });
    expect(forbidden.status).toBe(403);

    const imported = await call("/api/skills/import", {
      method: "POST",
      cookie: aliceCookie,
      body: {
        files: [
          {
            filename: "pdf-forms/SKILL.md",
            content: "---\nname: pdf-forms\ndescription: 填写 PDF 表单\n---\n\n1. 读取字段",
          },
          { filename: "broken/SKILL.md", content: "---\nname: broken\n---\n\n正文" },
        ],
      },
    });
    expect(imported.status).toBe(200);
    const results = imported.body["results"] as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ ok: true, action: "created" });
    expect((results[0]?.["skill"] as Record<string, unknown>)["imported"]).toBe(true);
    expect(results[1]).toMatchObject({ ok: false });
    expect(typeof results[1]?.["error"]).toBe("string");

    const snapshot = await call("/api/skills", { cookie: aliceCookie });
    const personal = snapshot.body["personal"] as Record<string, unknown>[];
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({
      name: "pdf-forms",
      imported: true,
      source: "导入自 pdf-forms/SKILL.md",
    });

    const sharedImport = await call("/api/skills/import", {
      method: "POST",
      cookie: adminCookie,
      body: {
        scope: "shared",
        files: [
          {
            filename: "notes/SKILL.md",
            content: "---\nname: notes\ndescription: 记笔记\n---\n\n先列要点",
          },
        ],
      },
    });
    expect(sharedImport.status).toBe(200);
    expect(
      ((await call("/api/skills", { cookie: aliceCookie })).body["shared"] as unknown[]).length,
    ).toBe(1);
  });

  it("技能附带文件：列表只给元信息，正文按需读取且只对属主可见", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    const adminCookie = setup.cookie as string;
    await call("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "alice", displayName: "Alice", password: "alicepass1" },
    });
    await call("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "bob", displayName: "Bob", password: "bobpass123" },
    });
    const aliceCookie = (
      await call("/api/auth/login", {
        method: "POST",
        body: { username: "alice", password: "alicepass1" },
      })
    ).cookie as string;
    const bobCookie = (
      await call("/api/auth/login", {
        method: "POST",
        body: { username: "bob", password: "bobpass123" },
      })
    ).cookie as string;

    const created = await call("/api/skills", {
      method: "POST",
      cookie: aliceCookie,
      body: {
        name: "pdf-forms",
        description: "填写 PDF 表单",
        instructions: "# 步骤\n运行 scripts/fill.py",
        files: [
          { path: "scripts/fill.py", content: "print('ok')" },
          { path: "assets/logo.png", content: "aGk=", encoding: "base64" },
        ],
      },
    });
    expect(created.status).toBe(201);
    const skill = created.body["skill"] as Record<string, unknown>;
    const files = skill["files"] as Record<string, unknown>[];
    expect(files.map((file) => file["path"])).toEqual(["assets/logo.png", "scripts/fill.py"]);
    expect(files[1]).not.toHaveProperty("content");
    const skillId = skill["id"] as string;

    const listed = await call("/api/skills", { cookie: aliceCookie });
    const personal = listed.body["personal"] as Record<string, unknown>[];
    expect(personal[0]).toMatchObject({ name: "pdf-forms" });
    expect(
      ((personal[0]?.["files"] as Record<string, unknown>[]) ?? []).map((file) => file["path"]),
    ).toEqual(["assets/logo.png", "scripts/fill.py"]);

    const text = await call(`/api/skills/${skillId}/file?path=scripts%2Ffill.py`, {
      cookie: aliceCookie,
    });
    expect(text.status).toBe(200);
    expect((text.body["file"] as Record<string, unknown>)["content"]).toBe("print('ok')");

    const foreign = await call(`/api/skills/${skillId}/file?path=scripts%2Ffill.py`, {
      cookie: bobCookie,
    });
    expect(foreign.status).toBe(403);
    expect((await call(`/api/skills/${skillId}/file?path=..%2Fx`, { cookie: aliceCookie })).status).toBe(
      400,
    );
    expect((await call(`/api/skills/${skillId}/file?path=nope.txt`, { cookie: aliceCookie })).status).toBe(
      404,
    );

    const imported = await call("/api/skills/import", {
      method: "POST",
      cookie: aliceCookie,
      body: {
        files: [
          {
            filename: "ocr/SKILL.md",
            content: "---\nname: ocr\ndescription: 识别扫描件\n---\n\n跑 scripts/run.py",
          },
          { filename: "ocr/scripts/run.py", content: "print(1)" },
        ],
      },
    });
    expect(imported.status).toBe(200);
    const result = (imported.body["results"] as Record<string, unknown>[])[0];
    expect(result).toMatchObject({ ok: true });
    const importedSkill = result?.["skill"] as Record<string, unknown>;
    expect((importedSkill["files"] as Record<string, unknown>[])?.map((file) => file["path"])).toEqual([
      "scripts/run.py",
    ]);

    const cleared = await call(`/api/skills/${skillId}`, {
      method: "PATCH",
      cookie: aliceCookie,
      body: { files: [] },
    });
    expect(cleared.status).toBe(200);
    expect((cleared.body["skill"] as Record<string, unknown>)["files"]).toBeUndefined();
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

describe("成员 API：新建成员与智能体文件编辑", () => {
  async function login(): Promise<string> {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    return setup.cookie as string;
  }

  it("新建成员按描述生成档案，随后可读取并保存修改", async () => {
    const cookie = await login();

    const created = await call("/api/members", {
      method: "POST",
      cookie,
      body: { name: "调研员", description: "负责检索资料并给出带出处的结论" },
    });
    expect(created.status).toBe(201);
    const member = created.body["member"] as Record<string, unknown>;
    expect(member["name"]).toBe("调研员");
    expect(member["role"]).toBe("sub");
    expect(member["brief"]).toBe("负责检索资料并给出带出处的结论");

    const memberId = String(member["id"]);
    const listed = await call(`/api/members/${memberId}/files`, { cookie });
    expect(listed.status).toBe(200);
    const paths = (listed.body["files"] as Array<Record<string, unknown>>).map((file) => file["path"]);
    // 子成员有自己的 MEMORY.md / USER.md / SOUL.md / IDENTITY.md。
    expect(paths).toEqual([
      `agents/${memberId}/MEMORY.md`,
      `agents/${memberId}/USER.md`,
      `agents/${memberId}/SOUL.md`,
      `agents/${memberId}/IDENTITY.md`,
    ]);

    const soulPath = `agents/${memberId}/SOUL.md`;
    const detail = await call(
      `/api/members/${memberId}/files/content?path=${encodeURIComponent(soulPath)}`,
      { cookie },
    );
    expect(detail.status).toBe(200);
    expect(String(detail.body["content"])).toContain("负责检索资料并给出带出处的结论");

    const saved = await call(`/api/members/${memberId}/files/content`, {
      method: "PUT",
      cookie,
      body: { path: soulPath, content: "# 改过的性格\n\n- 先查证再开口\n" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body["totalLines"]).toBe(4);

    const reread = await call(
      `/api/members/${memberId}/files/content?path=${encodeURIComponent(soulPath)}`,
      { cookie },
    );
    expect(reread.body["content"]).toBe("# 改过的性格\n\n- 先查证再开口\n");

    // 白名单外的路径不能通过「智能体文件」写接口落盘。
    const rejected = await call(`/api/members/${memberId}/files/content`, {
      method: "PUT",
      cookie,
      body: { path: "settings.json", content: "{}" },
    });
    expect(rejected.status).toBe(400);
  });

  it("新建成员的入参校验与权限：未登录拒绝，坏名字/空描述 400", async () => {
    expect((await call("/api/members", { method: "POST", body: { name: "x", description: "y" } })).status).toBe(401);

    const cookie = await login();
    expect(
      (await call("/api/members", { method: "POST", cookie, body: { name: "系统", description: "保留名" } })).status,
    ).toBe(400);
    expect(
      (await call("/api/members", { method: "POST", cookie, body: { name: "助手", description: "  " } })).status,
    ).toBe(400);
  });
});

describe("成员文件长文本：预览截断与全文读取", () => {
  it("默认返回前 200 行，full=1 返回全部行", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    const cookie = setup.cookie as string;
    const created = await call("/api/members", {
      method: "POST",
      cookie,
      body: { name: "长文员", description: "负责长文档" },
    });
    const memberId = String((created.body["member"] as Record<string, unknown>)["id"]);
    const path = `agents/${memberId}/SOUL.md`;
    const long = ["# SOUL.md", ...Array.from({ length: 299 }, (_, index) => `- 条目 ${index + 1}`)].join("\n");

    const saved = await call(`/api/members/${memberId}/files/content`, {
      method: "PUT",
      cookie,
      body: { path, content: long },
    });
    expect(saved.status).toBe(200);
    expect(saved.body["totalLines"]).toBe(300);

    const preview = await call(
      `/api/members/${memberId}/files/content?path=${encodeURIComponent(path)}`,
      { cookie },
    );
    expect(preview.body["truncated"]).toBe(true);
    expect(String(preview.body["content"]).split("\n")).toHaveLength(200);

    const full = await call(
      `/api/members/${memberId}/files/content?path=${encodeURIComponent(path)}&full=1`,
      { cookie },
    );
    expect(full.body["truncated"]).toBe(false);
    expect(full.body["totalLines"]).toBe(300);
    expect(full.body["content"]).toBe(long);
  });
});

describe("成员技能授权 API", () => {
  it("按成员读写技能白名单，null=全部，非法输入被拒，跨账号不可见", async () => {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    const cookie = setup.cookie as string;
    const shared = await call("/api/skills", {
      method: "POST",
      cookie,
      body: {
        scope: "shared",
        name: "research-brief",
        description: "三段式简报",
        instructions: "# 调研\n先给结论。",
      },
    });
    expect(shared.status).toBe(201);

    const created = await call("/api/members", {
      method: "POST",
      cookie,
      body: { name: "调研员", description: "负责检索资料并给出带出处的结论" },
    });
    const member = created.body["member"] as Record<string, unknown>;
    const memberId = String(member["id"]);
    expect(member).not.toHaveProperty("skillNames");

    const initial = await call(`/api/members/${memberId}/skills`, { cookie });
    expect(initial.status).toBe(200);
    expect(initial.body["enabled"]).toBeNull();
    expect(initial.body["skills"]).toMatchObject([
      { name: "research-brief", scope: "shared", builtin: false },
    ]);

    const saved = await call(`/api/members/${memberId}/skills`, {
      method: "PUT",
      cookie,
      body: { names: ["research-brief"] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body["enabled"]).toEqual(["research-brief"]);

    const state = await call("/api/state", { cookie });
    const updated = (state.body["members"] as Array<Record<string, unknown>>).find(
      (candidate) => candidate["id"] === memberId,
    );
    expect(updated?.["skillNames"]).toEqual(["research-brief"]);

    expect(
      (
        await call(`/api/members/${memberId}/skills`, {
          method: "PUT",
          cookie,
          body: { names: ["no-such-skill"] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(`/api/members/${memberId}/skills`, { method: "PUT", cookie, body: {} })).status,
    ).toBe(400);
    expect(
      (
        await call(`/api/members/${memberId}/skills`, {
          method: "PUT",
          cookie,
          body: { names: "research-brief" },
        })
      ).status,
    ).toBe(400);

    const cleared = await call(`/api/members/${memberId}/skills`, {
      method: "PUT",
      cookie,
      body: { names: [] },
    });
    expect(cleared.body["enabled"]).toEqual([]);

    const reset = await call(`/api/members/${memberId}/skills`, {
      method: "PUT",
      cookie,
      body: { names: null },
    });
    expect(reset.body["enabled"]).toBeNull();
    const stateAgain = await call("/api/state", { cookie });
    const resetMember = (stateAgain.body["members"] as Array<Record<string, unknown>>).find(
      (candidate) => candidate["id"] === memberId,
    );
    expect(resetMember).not.toHaveProperty("skillNames");

    expect(
      (await call("/api/members/m_missing/skills", { cookie })).status,
    ).toBe(404);
    expect(
      (await call(`/api/members/${memberId}/skills`, { method: "PUT", body: { names: null } }))
        .status,
    ).toBe(401);

    await call("/api/users", {
      method: "POST",
      cookie,
      body: { username: "alice", displayName: "Alice", password: "alicepass1" },
    });
    const aliceLogin = await call("/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "alicepass1" },
    });
    const aliceCookie = aliceLogin.cookie as string;
    expect(
      (await call(`/api/members/${memberId}/skills`, { cookie: aliceCookie })).status,
    ).toBe(404);
  });
});

describe("成员 API：移除成员", () => {
  async function login(): Promise<string> {
    const setup = await call("/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "老板", password: "secret123" },
    });
    return setup.cookie as string;
  }

  it("移除子成员：花名册消失、任务改为未指派、文件接口返回 404", async () => {
    const cookie = await login();
    const created = await call("/api/members", {
      method: "POST",
      cookie,
      body: { name: "资料员", description: "整理资料并归档" },
    });
    const memberId = String((created.body["member"] as Record<string, unknown>)["id"]);
    // 先让档案落盘，移除后应当不可再读。
    expect((await call(`/api/members/${memberId}/files`, { cookie })).status).toBe(200);
    const task = await call("/api/tasks", {
      method: "POST",
      cookie,
      body: { title: "整理季度资料", ownerId: memberId },
    });
    const taskId = String((task.body["task"] as Record<string, unknown>)["id"]);

    const removed = await call(`/api/members/${memberId}`, { method: "DELETE", cookie });
    expect(removed.status).toBe(200);
    expect(removed.body["removed"]).toBe(memberId);

    const state = await call("/api/state", { cookie });
    const members = state.body["members"] as Array<Record<string, unknown>>;
    expect(members.some((member) => member["id"] === memberId)).toBe(false);
    const tasks = state.body["tasks"] as Array<Record<string, unknown>>;
    expect(tasks.find((item) => item["id"] === taskId)?.["ownerId"]).toBeNull();
    const messages = state.body["messages"] as Array<Record<string, unknown>>;
    expect(String(messages.at(-1)?.["text"])).toContain("@资料员");

    expect((await call(`/api/members/${memberId}/files`, { cookie })).status).toBe(404);
  });

  it("主智能体不能移除，未知成员 404，未登录 401", async () => {
    expect((await call("/api/members/m_main", { method: "DELETE" })).status).toBe(401);

    const cookie = await login();
    expect((await call("/api/members/m_main", { method: "DELETE", cookie })).status).toBe(400);
    expect((await call("/api/members/m_missing", { method: "DELETE", cookie })).status).toBe(404);
  });
});
