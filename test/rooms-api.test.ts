// 「群聊区」的 HTTP 面：房间增删改、成员进出、`?room=` 作用域与 SSE 房间维度。
// 与 test/rooms.test.ts 的分工：那份盯 Workspace 的多房间内部逻辑，这份盯路由与响应形状。

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import type { Member, RoomInfo, RoomMessage } from "../src/core/types";
import { MAIN_ROOM_ID } from "../src/room/registry";
import { SkillLibrary } from "../src/skills/library";
import { TemplateLibrary } from "../src/templates/template-library";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import { createApp } from "../src/server/app";

let dir: string;
let registry: WorkspaceRegistry;
let server: Server;
let baseUrl: string;
let cookie: string;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; auth?: string } = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.auth ? { cookie: options.auth } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

function roomsOf(result: ApiResult): RoomInfo[] {
  return (result.body["rooms"] ?? []) as RoomInfo[];
}

function roomOf(result: ApiResult): RoomInfo {
  return result.body["room"] as RoomInfo;
}

/** 房间作用域查询串：所有按房间走的路由都靠它，缺省即作战室。 */
function at(roomId: string): string {
  return `?room=${roomId}`;
}

async function createRoom(name: string, extra: Record<string, unknown> = {}): Promise<RoomInfo> {
  const result = await call("/api/rooms", {
    method: "POST",
    auth: cookie,
    body: { name, ...extra },
  });
  expect(result.status).toBe(201);
  return roomOf(result);
}

async function createPoolMember(name: string): Promise<Member> {
  const result = await call("/api/members", {
    method: "POST",
    auth: cookie,
    body: { name, description: `负责${name}` },
  });
  expect(result.status).toBe(201);
  return result.body["member"] as Member;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-roomsapi-"));
  const auth = new AuthService(join(dir, "auth.json"));
  await auth.init();
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  const templates = new TemplateLibrary(join(dir, "templates.json"));
  await templates.init();
  registry = new WorkspaceRegistry(join(dir, "workspaces"), skills);
  const app = createApp({ auth, workspaces: registry, skills, templates, webDist: join(dir, "missing-dist") });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器未监听");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", displayName: "老板", password: "secret123" }),
  });
  cookie = (setup.headers.getSetCookie()[0] ?? "").split(";")[0];
});

afterEach(async () => {
  // SSE 这类 keep-alive 连接不会自己断：先关连接再等 server.close，否则钩子会挂到超时。
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registry.closeAll();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      // Windows 上原子写留下的临时文件会和递归删除抢 rmdir。
      if (attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

describe("群聊区 REST：房间清单与增删改", () => {
  it("未登录拿不到房间列表，登录后先只有一间作战室", async () => {
    expect((await call("/api/rooms")).status).toBe(401);
    const result = await call("/api/rooms", { auth: cookie });
    expect(result.status).toBe(200);
    const rooms = roomsOf(result);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: MAIN_ROOM_ID, kind: "warroom", memberCount: 1 });
  });

  it("建房、改名、删除全流程都能在房间列表里看到，响应带着计数", async () => {
    const room = await createRoom("选题讨论", { topic: "下周专栏" });
    expect(room).toMatchObject({ kind: "group", name: "选题讨论", topic: "下周专栏" });
    expect(room.id).toMatch(/^room_[0-9a-f]{12}$/);
    // 主智能体默认在场，列表上的计数立刻可用。
    expect(room.memberCount).toBe(1);
    expect(room.messageCount).toBe(1);

    const renamed = await call(`/api/rooms/${room.id}`, {
      method: "PATCH",
      auth: cookie,
      body: { name: "选题讨论组", topic: "" },
    });
    expect(renamed.status).toBe(200);
    expect(roomOf(renamed)).toMatchObject({ name: "选题讨论组" });
    expect(roomOf(renamed).topic).toBeUndefined();

    const removed = await call(`/api/rooms/${room.id}`, { method: "DELETE", auth: cookie });
    expect(removed.status).toBe(200);
    expect(removed.body["removed"]).toBe(room.id);
    expect(roomsOf(await call("/api/rooms", { auth: cookie })).map((room) => room.id)).toEqual([
      MAIN_ROOM_ID,
    ]);
  });

  it("重名、空名、作战室改名或删除都被拒绝", async () => {
    await createRoom("重复名字");
    const duplicate = await call("/api/rooms", {
      method: "POST",
      auth: cookie,
      body: { name: "重复名字" },
    });
    expect(duplicate.status).toBe(400);
    expect(String(duplicate.body["error"])).toContain("已经存在");

    expect((await call("/api/rooms", { method: "POST", auth: cookie, body: { name: "  " } })).status).toBe(400);
    expect(
      (await call(`/api/rooms/${MAIN_ROOM_ID}`, { method: "PATCH", auth: cookie, body: { name: "改名" } })).status,
    ).toBe(400);
    expect((await call(`/api/rooms/${MAIN_ROOM_ID}`, { method: "DELETE", auth: cookie })).status).toBe(400);
  });

  it("不存在的房间 404，形状不对的房间 ID 400", async () => {
    expect((await call(`/api/rooms/room_ffffffffffff`, { method: "DELETE", auth: cookie })).status).toBe(404);
    expect((await call(`/api/state${at("../../etc")}`, { auth: cookie })).status).toBe(400);
    expect((await call(`/api/state${at("room_ffffffffffff")}`, { auth: cookie })).status).toBe(404);
  });
});

describe("群聊区 REST：成员进出", () => {
  it("拉成员进群再移出，房间里的人数随之变化，作战室花名册不受影响", async () => {
    const member = await createPoolMember("研究员");
    const room = await createRoom("调研群");

    const invited = await call(`/api/rooms/${room.id}/members`, {
      method: "POST",
      auth: cookie,
      body: { memberId: member.id },
    });
    expect(invited.status).toBe(201);
    expect(invited.body["member"] as Member).toMatchObject({ id: member.id, roomId: room.id });
    expect(roomOf(invited).memberIds).toContain(member.id);

    const kicked = await call(`/api/rooms/${room.id}/members/${member.id}`, {
      method: "DELETE",
      auth: cookie,
    });
    expect(kicked.status).toBe(200);
    expect(kicked.body["removed"]).toBe(member.id);
    expect(roomOf(kicked).memberIds).not.toContain(member.id);

    const warroom = await call("/api/state", { auth: cookie });
    const names = ((warroom.body["members"] ?? []) as Member[]).map((candidate) => candidate.id);
    expect(names).toContain(member.id);
  });

  it("重复邀请 400、未知成员 404、往作战室拉人 400", async () => {
    const member = await createPoolMember("撰稿人");
    const room = await createRoom("稿件群", { memberIds: [member.id] });
    expect(
      (await call(`/api/rooms/${room.id}/members`, { method: "POST", auth: cookie, body: { memberId: member.id } }))
        .status,
    ).toBe(400);
    expect(
      (await call(`/api/rooms/${room.id}/members`, { method: "POST", auth: cookie, body: { memberId: "m_missing" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(`/api/rooms/${MAIN_ROOM_ID}/members`, { method: "POST", auth: cookie, body: { memberId: member.id } }))
        .status,
    ).toBe(400);
    expect(
      (await call(`/api/rooms/${room.id}/members/m_missing`, { method: "DELETE", auth: cookie })).status,
    ).toBe(404);
  });

  it("在成员池里删掉某人，各间群聊的花名册一起清掉", async () => {
    const member = await createPoolMember("数据分析师");
    const first = await createRoom("一群", { memberIds: [member.id] });
    const second = await createRoom("二群", { memberIds: [member.id] });

    expect((await call(`/api/members/${member.id}`, { method: "DELETE", auth: cookie })).status).toBe(200);
    const rooms = roomsOf(await call("/api/rooms", { auth: cookie }));
    for (const id of [first.id, second.id]) {
      expect(rooms.find((room) => room.id === id)?.memberIds).not.toContain(member.id);
    }
  });

  it("GET /api/members 给成员池，GET /api/rooms/:id/members 给这间房的花名册", async () => {
    const member = await createPoolMember("摄影师");
    const room = await createRoom("配图群");

    const pool = (await call("/api/members", { auth: cookie })).body["members"] as Member[];
    expect(pool.find((candidate) => candidate.id === member.id)?.roomId).toBe(MAIN_ROOM_ID);
    expect((await call(`/api/rooms/${room.id}/members`, { auth: cookie })).body["members"]).toHaveLength(1);

    await call(`/api/rooms/${room.id}/members`, {
      method: "POST",
      auth: cookie,
      body: { memberId: member.id },
    });
    const roster = (await call(`/api/rooms/${room.id}/members`, { auth: cookie })).body["members"] as Member[];
    expect(roster.map((candidate) => candidate.id)).toContain(member.id);
    expect(roster.find((candidate) => candidate.id === member.id)?.roomId).toBe(room.id);

    expect((await call("/api/rooms/room_ffffffffffff/members", { auth: cookie })).status).toBe(404);
    // 形状不对的房间 ID 在碰到磁盘之前就被挡下（路径拼接只用校验过的 ID）。
    expect((await call("/api/rooms/not-an-id/members", { auth: cookie })).status).toBe(400);
  });

  it("池里改成员模型会同步到群里的副本", async () => {
    const member = await createPoolMember("校对");
    const room = await createRoom("校对群", { memberIds: [member.id] });
    const updated = await call(`/api/members/${member.id}/model`, {
      method: "PUT",
      auth: cookie,
      body: { ref: "deepseek/deepseek-chat" },
    });
    expect(updated.status).toBe(200);

    const state = await call(`/api/state${at(room.id)}`, { auth: cookie });
    const copy = ((state.body["members"] ?? []) as Member[]).find((candidate) => candidate.id === member.id);
    expect(copy?.modelRef).toBe("deepseek/deepseek-chat");
    expect(copy?.roomId).toBe(room.id);
  });
});

describe("群聊区 REST：?room= 作用域", () => {
  it("消息、任务卡与模式都落在指定房间，作战室照旧", async () => {
    const room = await createRoom("双房间对照");
    const posted = await call(`/api/messages${at(room.id)}`, {
      method: "POST",
      auth: cookie,
      body: { text: "这条只在群里" },
    });
    expect(posted.status).toBe(201);
    expect((posted.body["message"] as RoomMessage).roomId).toBe(room.id);

    await call(`/api/tasks${at(room.id)}`, {
      method: "POST",
      auth: cookie,
      body: { title: "群里的任务" },
    });
    expect((await call(`/api/room${at(room.id)}`, { method: "PATCH", auth: cookie, body: { mode: "free" } })).status).toBe(200);

    const group = await call(`/api/state${at(room.id)}`, { auth: cookie });
    expect(group.body["room"]).toMatchObject({ id: room.id, kind: "group", name: "双房间对照", mode: "free" });
    expect(((group.body["messages"] ?? []) as RoomMessage[]).some((message) => message.text === "这条只在群里")).toBe(
      true,
    );
    expect((group.body["tasks"] ?? []) as unknown[]).toHaveLength(1);

    const warroom = await call("/api/state", { auth: cookie });
    expect(warroom.body["room"]).toMatchObject({ id: MAIN_ROOM_ID, kind: "warroom", mode: "delegate" });
    expect(((warroom.body["messages"] ?? []) as RoomMessage[]).some((message) => message.text === "这条只在群里")).toBe(
      false,
    );
    expect((warroom.body["tasks"] ?? []) as unknown[]).toHaveLength(0);
  });

  it("归档按房间分：群里 /new 只进群里的归档列表", async () => {
    const room = await createRoom("要开新会话的群");
    await call(`/api/messages${at(room.id)}`, { method: "POST", auth: cookie, body: { text: "上一轮的议题" } });
    const opened = await call(`/api/session/new${at(room.id)}`, { method: "POST", auth: cookie });
    expect(opened.status).toBe(200);
    const archived = opened.body["archived"] as { id: string; roomId?: string; fileCount: number };
    expect(archived.roomId).toBe(room.id);
    expect(archived.fileCount).toBe(0);

    expect(roomsOf(await call("/api/rooms", { auth: cookie })).find((item) => item.id === room.id)?.messageCount).toBe(
      1,
    );
    const groupArchives = (await call(`/api/archives${at(room.id)}`, { auth: cookie })).body["archives"] as unknown[];
    expect(groupArchives).toHaveLength(1);
    expect((await call("/api/archives", { auth: cookie })).body["archives"]).toEqual([]);

    const restored = await call(`/api/archives/${archived.id}/restore${at(room.id)}`, {
      method: "POST",
      auth: cookie,
    });
    expect(restored.status).toBe(200);
    const state = await call(`/api/state${at(room.id)}`, { auth: cookie });
    expect(((state.body["messages"] ?? []) as RoomMessage[]).some((message) => message.text === "上一轮的议题")).toBe(
      true,
    );
  });

  it("中止运行也只作用于这间房", async () => {
    const room = await createRoom("待中止的群");
    expect((await call(`/api/members/cancel-all${at(room.id)}`, { method: "POST", auth: cookie })).body).toEqual({
      cancelled: 0,
    });
    const single = await call(`/api/members/m_main/cancel${at(room.id)}`, { method: "POST", auth: cookie });
    expect(single.status).toBe(200);
    expect(typeof single.body["cancelled"]).toBe("boolean");
  });
});

describe("群聊区 REST：账号隔离与 SSE", () => {
  it("另一个账号看不到这个账号的群聊", async () => {
    await createRoom("只属于老板的群");
    expect((await call("/api/users", { auth: cookie })).status).toBe(200);
    const created = await call("/api/users", {
      method: "POST",
      auth: cookie,
      body: { username: "guest", displayName: "访客", password: "guest1234" },
    });
    expect(created.status).toBe(201);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "guest", password: "guest1234" }),
    });
    const guestCookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    expect(guestCookie).toBeTruthy();

    const guestRooms = roomsOf(await call("/api/rooms", { auth: guestCookie }));
    expect(guestRooms).toHaveLength(1);
    expect(guestRooms[0]).toMatchObject({ kind: "warroom", id: MAIN_ROOM_ID });
    expect((await call("/api/rooms", { method: "POST", auth: guestCookie, body: { name: "只属于老板的群" } })).status).toBe(
      201,
    );
  });

  it("SSE 每帧都带 roomId，群里的消息不会串到作战室", async () => {
    interface Frame {
      roomId: string;
      event: { type: string; message?: RoomMessage };
    }
    const response = await fetch(`${baseUrl}/api/events`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE 没有可读流");
    const frames: Frame[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              frames.push(JSON.parse(line.slice(6)) as Frame);
            } catch {
              /* 心跳不算事件 */
            }
          }
        }
      }
    })();

    const room = await createRoom("直播群");
    await call(`/api/messages${at(room.id)}`, { method: "POST", auth: cookie, body: { text: "这条要被推出去" } });

    const startedAt = Date.now();
    const received = () =>
      frames.filter((frame) => frame.roomId === room.id && frame.event?.type === "message");
    while (!received().some((frame) => frame.event.message?.text === "这条要被推出去")) {
      if (Date.now() - startedAt > 8_000) throw new Error("等待 SSE 房间消息超时");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 建房时那条系统消息也推给了这间房，说明确实是按房间分发的。
    expect(received().some((frame) => frame.event.message?.text.startsWith("群聊「直播群」已创建"))).toBe(true);
    expect(frames.some((frame) => frame.roomId === MAIN_ROOM_ID && frame.event?.type === "message")).toBe(false);
    // 房间清单变化也走 SSE，前端据此刷新群聊列表。
    expect(frames.some((frame) => frame.event?.type === "rooms-changed")).toBe(true);

    await reader.cancel();
  });
});
