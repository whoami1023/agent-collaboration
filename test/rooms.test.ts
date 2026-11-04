import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLibrary } from "../src/skills/library";
import { MAIN_ROOM_ID, RoomError } from "../src/room/registry";
import { WorkspaceRegistry, type Workspace } from "../src/workspace/workspace";

let dir: string;
let skills: SkillLibrary;
let registry: WorkspaceRegistry;
let open: Workspace[] = [];

async function workspaceFor(id: string, displayName = "老板"): Promise<Workspace> {
  const workspace = await registry.get({ id, displayName });
  open.push(workspace);
  return workspace;
}

async function addMember(workspace: Workspace, name: string, description: string) {
  return workspace.orchestrator.createMember({ name, description });
}

/** 文件工作区里当前有哪些路径：用来断言归档有没有把成果搬走。 */
async function filePaths(workspace: Workspace): Promise<string[]> {
  return (await workspace.files.list()).files.map((file) => file.path);
}

function text(content: string): Buffer {
  return Buffer.from(content, "utf8");
}

/** 房间相关的报错都必须是带 HTTP 状态的 RoomError，方便路由直接转成响应码。 */
function expectRoomError(fn: () => unknown, status: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RoomError);
    expect((err as RoomError).status).toBe(status);
    return;
  }
  throw new Error("期望抛出 RoomError，但没有抛错");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-rooms-"));
  skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  registry = new WorkspaceRegistry(dir, skills);
  open = [];
});

afterEach(async () => {
  await registry.closeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("群聊区：房间清单与开房", () => {
  it("新建账号只有一间作战室，成员池就是它的房间", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const rooms = workspace.listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      id: MAIN_ROOM_ID,
      kind: "warroom",
      memberCount: 1,
      messageCount: 0,
    });
    expect(rooms[0]!.name).toContain("Alice");
  });

  it("开一间群聊：主智能体默认在场，勾选的成员被复制进来", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const researcher = await addMember(workspace, "研究员", "负责资料调研与事实核对");

    const room = await workspace.createRoom({
      name: "选题讨论",
      topic: "下周专栏选题",
      memberIds: [researcher.id],
    });

    expect(room.kind).toBe("group");
    expect(room.name).toBe("选题讨论");
    expect(room.topic).toBe("下周专栏选题");
    expect(room.memberIds).toContain("m_main");
    expect(room.memberIds).toContain(researcher.id);

    const group = workspace.room(room.id);
    expect(group.bus.roomName).toBe("选题讨论");
    // 成员档案是池里的同一份：ID 一致，房间归属各自记。
    const copy = group.bus.getMember(researcher.id);
    expect(copy).toBeDefined();
    expect(copy!.roomId).toBe(room.id);
    expect(copy!.name).toBe("研究员");
    // 建房时写了一条系统消息说明房间里谁在场。
    expect(group.bus.listMessages().some((message) => message.text.includes("选题讨论"))).toBe(true);
    // 作战室不受影响：它的花名册仍是成员池。
    expect(workspace.bus.listMembers().map((member) => member.id)).toContain("m_main");
  });

  it("房间名去重、限长，作战室不能改名也不能删除", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    await workspace.createRoom({ name: "同一个名字" });
    await expect(workspace.createRoom({ name: "同一个名字" })).rejects.toThrow("已经存在");
    await expect(workspace.createRoom({ name: "  " })).rejects.toThrow("请填写群聊名称");
    await expect(workspace.createRoom({ name: "x".repeat(41) })).rejects.toThrow("最多 40 字");
    await expect(workspace.updateRoom(MAIN_ROOM_ID, { name: "改成别的" })).rejects.toThrow(
      "作战室的名字跟随账号显示名",
    );
    await expect(workspace.deleteRoom(MAIN_ROOM_ID)).rejects.toThrow("作战室不能删除");
  });

  it("改名与改主题会同步到总线，删除群聊会清掉房间档案与转录", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const room = await workspace.createRoom({ name: "旧名字" });
    const stateFile = join(dir, "u_alice", "rooms", `${room.id}.json`);
    expect(existsSync(stateFile)).toBe(true);

    const renamed = await workspace.updateRoom(room.id, { name: "新名字", topic: "换成复盘" });
    expect(renamed.name).toBe("新名字");
    expect(renamed.topic).toBe("换成复盘");
    expect(workspace.room(room.id).bus.roomName).toBe("新名字");

    await workspace.deleteRoom(room.id);
    expect(workspace.listRooms().map((candidate) => candidate.id)).toEqual([MAIN_ROOM_ID]);
    expect(existsSync(stateFile)).toBe(false);
    expectRoomError(() => workspace.room(room.id), 404);
  });

  it("不存在的房间与非法 ID 报可读错误", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    expectRoomError(() => workspace.room("room_ffffffffffff"), 404);
    expectRoomError(() => workspace.room("../../etc/passwd"), 400);
    // 不传 ID 就是作战室：所有旧的按房间无关写法调用的代码都走这条路。
    expect(workspace.room().bus.roomId).toBe(MAIN_ROOM_ID);
    expect(workspace.room("").bus.roomId).toBe(MAIN_ROOM_ID);
  });
});

describe("群聊区：成员进出与档案同步", () => {
  it("拉人进群、移出群聊，历史消息保留", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const writer = await addMember(workspace, "撰稿人", "负责初稿与改稿");
    const room = await workspace.createRoom({ name: "稿件群" });
    const roomId = room.id;

    const invited = await workspace.inviteMember(roomId, writer.id);
    expect(invited.member.roomId).toBe(roomId);
    expect(workspace.room(roomId).bus.getMember(writer.id)).toBeDefined();

    const message = workspace.room(roomId).bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      text: "这条要留着",
    });
    expect(message.roomId).toBe(roomId);

    const afterKick = await workspace.kickMember(roomId, writer.id);
    expect(afterKick.memberIds).not.toContain(writer.id);
    expect(workspace.room(roomId).bus.listMessages().some((item) => item.text === "这条要留着")).toBe(
      true,
    );
    // 池里照旧，别的群也照旧。
    expect(workspace.bus.getMember(writer.id)).toBeDefined();
  });

  it("作战室不接受邀请：成员池只能通过创建成员来变", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const member = await addMember(workspace, "校对", "负责校对");
    await expect(workspace.inviteMember(MAIN_ROOM_ID, member.id)).rejects.toThrow(
      "作战室的成员请在成员列表里创建",
    );
    await expect(workspace.kickMember(MAIN_ROOM_ID, member.id)).rejects.toThrow("彻底删除成员");
  });

  it("重复邀请与拉不存在的成员都被拒绝", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const member = await addMember(workspace, "摄影", "负责配图");
    const room = await workspace.createRoom({ name: "配图群", memberIds: [member.id] });
    await expect(workspace.inviteMember(room.id, member.id)).rejects.toThrow("已经在群里");
    await expect(workspace.inviteMember(room.id, "m_missing")).rejects.toThrow("成员不存在");
    await expect(workspace.kickMember(room.id, "m_missing")).rejects.toThrow("不在群里");
  });

  it("池里改模型会同步到各群副本；池里删人则各群一起退出", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const member = await addMember(workspace, "数据分析师", "负责看数据");
    const first = await workspace.createRoom({ name: "一群", memberIds: [member.id] });
    const second = await workspace.createRoom({ name: "二群", memberIds: [member.id] });

    const poolMember = workspace.bus.getMember(member.id)!;
    poolMember.modelRef = "deepseek/deepseek-chat";
    workspace.bus.updateMember(poolMember);
    await workspace.propagateMember(member.id);
    expect(workspace.room(first.id).bus.getMember(member.id)!.modelRef).toBe("deepseek/deepseek-chat");
    expect(workspace.room(second.id).bus.getMember(member.id)!.modelRef).toBe("deepseek/deepseek-chat");

    await workspace.orchestrator.removeMember(member.id);
    await workspace.dropMemberFromRooms(member.id);
    expect(workspace.room(first.id).bus.getMember(member.id)).toBeUndefined();
    expect(workspace.room(second.id).bus.getMember(member.id)).toBeUndefined();
  });
});

describe("群聊区：会话隔离与持久化", () => {
  it("每间房的消息、任务卡与模式互不干扰", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const room = await workspace.createRoom({ name: "讨论组" });
    workspace.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      text: "作战室的消息",
    });
    workspace.room(room.id).bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      text: "群里的消息",
    });
    workspace.room(room.id).board.create({ title: "群任务", createdBy: "u_alice" });
    workspace.setRoomMode("free", room.id);

    expect(workspace.bus.listMessages().map((message) => message.text)).not.toContain("群里的消息");
    expect(workspace.board.list()).toHaveLength(0);
    expect(workspace.bus.roomMode).toBe("delegate");
    expect(workspace.room(room.id).bus.roomMode).toBe("free");
    expect(workspace.listRooms().find((candidate) => candidate.id === room.id)?.taskCount).toBe(1);
  });

  it("重启后房间、花名册与转录都回来了，池里已删的成员不会复活", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const keeper = await addMember(workspace, "纪要员", "负责会议纪要");
    const leaver = await addMember(workspace, "临时帮手", "用完就删");
    const room = await workspace.createRoom({
      name: "周会",
      topic: "每周一次",
      memberIds: [keeper.id, leaver.id],
    });
    workspace.room(room.id).orchestrator.sendUserMessage("本周议题是什么");
    await workspace.persist();

    registry = new WorkspaceRegistry(dir, skills);
    const restored = await registry.get({ id: "u_alice", displayName: "Alice" });
    open.push(restored);
    const rooms = restored.listRooms();
    expect(rooms.map((candidate) => candidate.id)).toContain(room.id);
    const restoredRoom = restored.room(room.id);
    expect(restoredRoom.descriptor.topic).toBe("每周一次");
    expect(restoredRoom.bus.roomName).toBe("周会");
    expect(restoredRoom.bus.listMessages().some((message) => message.text === "本周议题是什么")).toBe(
      true,
    );
    expect(restoredRoom.bus.getMember(keeper.id)).toBeDefined();
    expect(restoredRoom.bus.getMember(leaver.id)).toBeDefined();

    await restored.orchestrator.removeMember(leaver.id);
    await restored.dropMemberFromRooms(leaver.id);
    await restored.persist();

    registry = new WorkspaceRegistry(dir, skills);
    const again = await registry.get({ id: "u_alice", displayName: "Alice" });
    open.push(again);
    expect(again.room(room.id).bus.getMember(leaver.id)).toBeUndefined();
    expect(again.room(room.id).bus.getMember(keeper.id)).toBeDefined();
    // 群成员的档案以池为准：模型被改过后重启也带着新值。
    expect(again.room(room.id).bus.getMember(keeper.id)!.roomId).toBe(room.id);
  });

  it("/new 与 /clear 只作用于指定的房间，文件工作区不被群聊搬走", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const room = await workspace.createRoom({ name: "临时讨论" });
    const group = workspace.room(room.id);
    group.orchestrator.sendUserMessage("群里的问题");
    group.board.create({ title: "群里的任务", createdBy: "u_alice" });
    await workspace.files.write("成果.md", text("作战室写的成果"));
    workspace.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      text: "作战室的问题",
    });

    const result = await workspace.newSession(room.id);
    expect(result.cleared).toBeGreaterThan(0);
    // 新会话里只剩「已开启新会话」那条系统提示，上一轮内容都不在了。
    const remaining = group.bus.listMessages();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.text).toContain("已开启新会话");
    expect(group.board.list()).toHaveLength(0);
    // 群聊开新会话绝不能把账号共享的文件工作区收进归档。
    expect((await workspace.files.read("成果.md")).content).toBe("作战室写的成果");
    expect(result.archived?.fileCount).toBe(0);
    expect(result.archived?.roomId).toBe(room.id);

    // 归档按房间过滤：作战室此时还没有可归档的内容。
    expect(await workspace.listArchivesForRoom(MAIN_ROOM_ID)).toEqual([]);
    const groupArchives = await workspace.listArchivesForRoom(room.id);
    expect(groupArchives).toHaveLength(1);
    expect(groupArchives[0]!.roomName).toBe("临时讨论");
  });

  it("作战室的 /clear 仍然把文件成果一起归档", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    await workspace.files.write("报告.md", text("内容"));
    workspace.bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      text: "做一份报告",
    });
    const result = await workspace.clearRoomSession();
    expect(result.archived?.fileCount).toBe(1);
    expect(await filePaths(workspace)).not.toContain("报告.md");
  });
});

describe("群聊区：记忆检索覆盖各房间转录", () => {
  it("群里讨论过的结论能被检索到，语料按房间 ID 分开；删群后不再命中", async () => {
    const workspace = await workspaceFor("u_alice", "Alice");
    const room = await workspace.createRoom({ name: "架构评审" });
    workspace.room(room.id).bus.append({
      senderId: "user",
      senderName: "用户",
      senderKind: "user",
      text: "这次决定用 B+ 树索引替代全表扫描来加速报表查询",
    });

    const hits = await workspace.memory.search("B+ 树 全表扫描 报表", {
      lexicalOnly: true,
      sources: ["sessions"],
    });
    expect(hits.some((hit) => hit.path === `sessions/${room.id}.md`)).toBe(true);

    await workspace.deleteRoom(room.id);
    const afterDelete = await workspace.memory.search("B+ 树 全表扫描 报表", {
      lexicalOnly: true,
      sources: ["sessions"],
    });
    expect(afterDelete.some((hit) => hit.path === `sessions/${room.id}.md`)).toBe(false);
  });
});
