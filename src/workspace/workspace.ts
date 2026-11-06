import { join } from "node:path";
import { rm } from "node:fs/promises";
import { LearningService } from "../agent/learning/service";
import { LearningStore } from "../agent/learning/store";
import { ensureMainMember, Orchestrator } from "../agent/orchestrator";
import { SessionArchives, summaryOf } from "../archive/session-archive";
import { CronService } from "../cron/service";
import { CronRunHistory } from "../cron/history";
import { CronStore } from "../cron/store";
import type { CronHost } from "../cron/host";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import type {
  Member,
  RoomDescriptor,
  RoomEvent,
  RoomInfo,
  RoomMessage,
  RoomMode,
  RoomRoutingMode,
  SessionArchiveDetail,
  SessionArchiveSummary,
  TaskCard,
  UserRole,
} from "../core/types";
import { DEFAULT_MODEL_REF, SYSTEM_ID } from "../core/types";
import { newId } from "../core/ids";
import { ModelUsageStore } from "../model/usage-store";
import { ensureAgentFiles } from "../memory/bootstrap-files";
import { MemorySearchManager } from "../memory/manager";
import { WorkspaceFiles } from "../files/workspace-files";
import { RoomBus } from "../room/bus";
import {
  MAIN_ROOM_ID,
  ROOM_LIMITS,
  RoomError,
  RoomManifest,
  assertRoomId,
  roomIdFromQuery,
  validateRoomName,
  validateRoomTopic,
} from "../room/registry";
import type { SkillLibrary } from "../skills/library";
import { readJson, writeJsonAtomic } from "../store/persist";
import { Workboard } from "../workboard/board";

interface PersistedState {
  members: PersistedMember[];
  messages: RoomMessage[];
  seq: number;
  tasks: TaskCard[];
  mode?: RoomMode;
  routing?: RoomRoutingMode;
}

/** v3 及更早的成员档案用 `providerId`，v4 统一为 `modelRef`（`provider/model` 或别名）。 */
type PersistedMember = Omit<Member, "modelRef"> & { modelRef?: string; providerId?: string };

function hydrateMember(persisted: PersistedMember): Member {
  const { providerId, modelRef, ...rest } = persisted;
  return {
    ...rest,
    modelRef: modelRef ?? (providerId && providerId !== "default" ? providerId : DEFAULT_MODEL_REF),
    status: persisted.status === "running" ? "idle" : persisted.status,
  };
}

/** 成员池里的档案复制进某间群聊：ID 与智能体文件不变，房间归属与运行状态各自独立。 */
function roomCopy(pool: Member, roomId: string, status?: Member["status"]): Member {
  return {
    ...pool,
    roomId,
    status: !status || status === "running" ? "idle" : status,
    lastActiveAt: Date.now(),
  };
}

export interface WorkspaceOwner {
  id: string;
  displayName: string;
  /** 账号角色：学习层创建个人技能只需要它；老测试可以只给 id 与显示名。 */
  role?: UserRole;
}

function roomNameFor(displayName: string): string {
  return `${displayName} 的作战室`;
}

/** 一间打开的房间：总线、看板与编排器成套，各自持有转录、任务卡与运行槽位。 */
export interface RoomInstance {
  descriptor: RoomDescriptor;
  bus: RoomBus;
  board: Workboard;
  orchestrator: Orchestrator;
  /** 作战室落在 `state.json`，群聊落在 `rooms/<roomId>.json`。 */
  stateFile: string;
  saveTimer: NodeJS.Timeout | null;
}

const SAVE_TRIGGERS: RoomEvent["type"][] = [
  "message",
  "messages-cleared",
  "session-archived",
  "session-restored",
  "mode",
  "routing",
  "member",
  "member-removed",
];

const DIRTY_TRIGGERS: RoomEvent["type"][] = [
  "message",
  "messages-cleared",
  "session-restored",
];

export class Workspace {
  private closed = false;
  private readonly rooms = new Map<string, RoomInstance>();
  private readonly roomListeners = new Set<(roomId: string, event: RoomEvent) => void>();
  /** 群聊总线列表：交给记忆层当作 sessions 语料，开房与删房时同步增删。 */
  private groupBuses: RoomBus[] = [];
  private cronService: CronService | null = null;

  private constructor(
    readonly userId: string,
    private readonly dir: string,
    private readonly owner: WorkspaceOwner,
    private readonly skills: SkillLibrary,
    readonly memory: MemorySearchManager,
    readonly files: WorkspaceFiles,
    readonly usage: ModelUsageStore,
    readonly archives: SessionArchives,
    private readonly settingsRef: { current: Settings },
    private readonly manifest: RoomManifest,
    /** 学习层：复盘服务 + 账本，路由与关房都要用。 */
    readonly learning: LearningService,
  ) {}

  static async load(rootDir: string, owner: WorkspaceOwner, skills: SkillLibrary): Promise<Workspace> {
    const dir = join(rootDir, owner.id);
    const manifest = new RoomManifest(dir);
    const descriptors = await manifest.load();
    const [state, loadedSettings] = await Promise.all([
      readJson<PersistedState | null>(join(dir, "state.json"), null),
      loadSettings(join(dir, "settings.json")),
    ]);

    const mainDescriptor = descriptors.find((room) => room.id === MAIN_ROOM_ID)!;
    mainDescriptor.kind = "warroom";
    mainDescriptor.name = roomNameFor(owner.displayName);

    const mainBus = new RoomBus(MAIN_ROOM_ID, mainDescriptor.name);
    if (state) {
      mainBus.hydrate({
        seq: state.seq,
        messages: state.messages,
        mode: state.mode,
        routing: state.routing,
      });
      for (const member of state.members) mainBus.addMember(hydrateMember(member));
    }
    ensureMainMember(mainBus);

    const settingsRef = { current: loadedSettings };
    // 智能体档案文件（对应 OpenClaw 的 generated bootstrap files）：只补写缺失项，
    // 已存在的文件视为用户内容，绝不覆盖。这样右侧「智能体文件」面板开箱即有内容。
    await ensureAgentFiles(dir, {
      displayName: owner.displayName,
      mainAgentName: mainBus.listMembers().find((member) => member.role === "main")?.name ?? "主智能体",
      roomName: mainBus.roomName,
    });
    // P5：每用户工作区一个记忆检索管理器（对应 OpenClaw 每 agent 的 memory manager），
    // 语料 = 工作区 MEMORY.md/USER.md/memory/**.md + 各房间转录（sessions/<roomId>.md）。
    const groupBuses: RoomBus[] = [];
    const memory = new MemorySearchManager({
      workspaceDir: dir,
      bus: mainBus,
      extraBuses: () => groupBuses,
    });
    // 成员能力档案（TEAM.md）：加载时按当前花名册补齐，老工作区与新建群都自动有这份文件。
    await memory.syncTeamFile();
    // 文件工作区独立于运行时数据：智能体与用户只经 files/ 交换文件。
    const files = new WorkspaceFiles(dir);
    // 用量账本：按模型 × UTC 自然日聚合 token 与成本，供设置面板统计。
    const usage = new ModelUsageStore(join(dir, "model-usage.json"));

    // 学习层（P1）：成员一轮交付后的后台复盘。产出先落进本账号的 learning.json，
    // 事件按复盘所在的房间广播，前端「学习」面板据此刷新。
    let workspaceRef: Workspace | undefined;
    const learning = new LearningService({
      store: new LearningStore(join(dir, "learning.json")),
      getSettings: () => settingsRef.current,
      getModelDeps: () => ({ settings: settingsRef.current, dataDir: dir }),
      memory,
      usage,
      skills,
      skillOwner: { id: owner.id, ...(owner.role ? { role: owner.role } : {}) },
      // 技能提案被采纳后，若提案来源成员有技能白名单，就把新技能追加进去；
      // 白名单为 undefined 的成员本来就跟随全部技能，不用动。
      grantSkillToMember: async (memberId, skillName) => {
        const workspace = workspaceRef;
        if (!workspace) return;
        const member = workspace.bus.getMember(memberId);
        if (!member?.skillNames || member.skillNames.includes(skillName)) return;
        member.skillNames = [...member.skillNames, skillName];
        workspace.bus.updateMember(member);
        await workspace.propagateMember(memberId);
        await workspace.persist();
        await memory.syncTeamFile();
      },
      onLearned: ({ proposals, log }) => {
        const bus = workspaceRef?.rooms.get(log.roomId)?.bus;
        if (bus) bus.emit({ type: "learning", proposals, log });
      },
    });

    const workspace = new Workspace(
      owner.id,
      dir,
      owner,
      skills,
      memory,
      files,
      usage,
      new SessionArchives(dir),
      settingsRef,
      manifest,
      learning,
    );
    workspaceRef = workspace;
    workspace.groupBuses = groupBuses;
    workspace.rooms.set(MAIN_ROOM_ID, workspace.openRoom(mainDescriptor, state, mainBus));
    for (const descriptor of descriptors) {
      if (descriptor.id === MAIN_ROOM_ID || descriptor.kind !== "group") continue;
      const groupState = await readJson<PersistedState | null>(
        workspace.stateFileFor(descriptor.id),
        null,
      );
      const room = workspace.openRoom(descriptor, groupState);
      groupBuses.push(room.bus);
    }

    // 定时任务：每个账号一个独立调度器（相当于 OpenClaw 的一个 storeKey），作业定义、
    // 运行状态与运行历史都落在本账号目录里，删号随目录一起清掉。无人值守的回执只落作战室。
    const mainRoom = workspace.mainRoom();
    const cronHost: CronHost = {
      ownerId: owner.id,
      bus: mainRoom.bus,
      orchestrator: mainRoom.orchestrator,
      getSettings: () => settingsRef.current,
      commandCwd: files.rootDir,
    };
    const cron = new CronService({
      store: new CronStore(dir),
      history: new CronRunHistory(join(dir, "cron-runs.json")),
      getHost: (ownerId) => (ownerId === owner.id ? cronHost : undefined),
      onEvent: (event) => {
        if (event.type === "job") {
          mainRoom.bus.emit({ type: "cron-job", job: event.job, state: event.state });
        } else if (event.type === "job-removed") {
          mainRoom.bus.emit({ type: "cron-job-removed", jobId: event.jobId });
        } else {
          mainRoom.bus.emit({ type: "cron-run", run: event.run });
        }
      },
    });
    workspace.cronService = cron;
    // 群聊里的成员也能用 cron 工具：作业本身归账号，运行结果落在作战室。
    for (const room of workspace.rooms.values()) room.orchestrator.setCron(cron);

    await workspace.persist();
    await cron.start();
    return workspace;
  }

  /** 房间的转录落盘位置：作战室沿用历史 `state.json`，群聊各自一个文件。 */
  stateFileFor(roomId: string): string {
    return roomId === MAIN_ROOM_ID
      ? join(this.dir, "state.json")
      : join(this.dir, "rooms", `${roomId}.json`);
  }

  /**
   * 建好一间房的三件套并接上持久化与事件转发。
   * `presetBus` 只给作战室用（它的成员池要先建好，房间清单要按池来过滤群成员）。
   */
  private openRoom(
    descriptor: RoomDescriptor,
    persisted: PersistedState | null,
    presetBus?: RoomBus,
  ): RoomInstance {
    const isMain = descriptor.id === MAIN_ROOM_ID;
    const bus = presetBus ?? new RoomBus(descriptor.id, descriptor.name);
    const board = new Workboard(descriptor.id);
    if (isMain) {
      if (persisted) board.hydrate(persisted.tasks ?? []);
    } else if (persisted) {
      bus.hydrate({
        seq: persisted.seq,
        messages: persisted.messages,
        mode: persisted.mode,
        routing: persisted.routing,
      });
      // 群成员是成员池的引用：池里已经不存在的人不再复活，档案（模型、技能）以池为准。
      for (const persistedMember of persisted.members) {
        const pool = this.bus.getMember(persistedMember.id);
        if (pool) bus.addMember(roomCopy(pool, descriptor.id));
      }
      board.hydrate(persisted.tasks ?? []);
    } else {
      // 新建的群：默认把主智能体拉进来，否则「委派」模式没人拆解任务。
      const main = this.bus.listMembers().find((member) => member.role === "main");
      if (main) bus.addMember(roomCopy(main, descriptor.id));
    }
    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => this.settingsRef.current,
      skills: this.skills,
      ownerId: this.owner.id,
      memory: this.memory,
      files: this.files,
      dataDir: this.dir,
      usage: this.usage,
      onUsageRecord: (record) => bus.emit({ type: "model-usage", usage: record }),
      learning: this.learning,
    });
    const instance: RoomInstance = { descriptor, bus, board, orchestrator, stateFile: this.stateFileFor(descriptor.id), saveTimer: null };
    bus.subscribe((event) => {
      if (SAVE_TRIGGERS.includes(event.type)) this.scheduleSave(descriptor.id);
      if (DIRTY_TRIGGERS.includes(event.type)) this.memory.markDirty();
      for (const listener of [...this.roomListeners]) listener(descriptor.id, event);
    });
    board.subscribe((event) => {
      this.scheduleSave(descriptor.id);
      for (const listener of [...this.roomListeners]) listener(descriptor.id, event);
    });
    this.rooms.set(descriptor.id, instance);
    return instance;
  }

  private mainRoom(): RoomInstance {
    const room = this.rooms.get(MAIN_ROOM_ID);
    if (!room) throw new RoomError(400, "作战室尚未就绪，请刷新后重试");
    return room;
  }

  /** 作战室总线：成员池、定时任务与主智能体档案都以它为准。 */
  get bus(): RoomBus {
    return this.mainRoom().bus;
  }

  get board(): Workboard {
    return this.mainRoom().board;
  }

  get orchestrator(): Orchestrator {
    return this.mainRoom().orchestrator;
  }

  get cron(): CronService {
    if (!this.cronService) throw new RoomError(400, "定时任务尚未就绪");
    return this.cronService;
  }

  /** 取房间：不传或传空按作战室。ID 不合法与不存在都抛可读的 RoomError。 */
  room(id?: string): RoomInstance {
    const roomId = roomIdFromQuery(id);
    if (roomId !== MAIN_ROOM_ID) assertRoomId(roomId);
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(404, "房间不存在");
    return room;
  }

  listRooms(): RoomInfo[] {
    const infos: RoomInfo[] = [];
    for (const room of this.rooms.values()) infos.push(this.roomInfoOf(room));
    return infos;
  }

  /** 成员池：作战室里的全部成员，群聊只能从这份名单里拉人。 */
  listPoolMembers(): Member[] {
    return this.bus.listMembers();
  }

  /**
   * 开一间群聊：名称与主题进房间清单，成员从池里复制一份带进来。
   * 同一成员可以同时在几间房里待命，各自的运行状态互不影响。
   */
  async createRoom(input: {
    name: unknown;
    topic?: unknown;
    memberIds?: unknown;
  }): Promise<RoomInfo> {
    if (this.manifest.count() >= ROOM_LIMITS.maxRooms) {
      throw new RoomError(400, `最多只能开 ${ROOM_LIMITS.maxRooms} 间房间，先关掉不用的群聊`);
    }
    const name = validateRoomName(input.name);
    if (this.listRooms().some((room) => room.name === name)) {
      throw new RoomError(400, `房间「${name}」已经存在，换一个名字`);
    }
    const topic = validateRoomTopic(input.topic);
    const descriptor: RoomDescriptor = {
      id: newId("room"),
      kind: "group",
      name,
      ...(topic ? { topic } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.manifest.add(descriptor);
    const room = this.openRoom(descriptor, null);
    this.groupBuses.push(room.bus);
    await this.seedRoomMembers(room, input.memberIds);
    await this.manifest.save();
    await this.persistRoom(descriptor.id);
    this.bus.emit({ type: "rooms-changed", roomId: descriptor.id });
    return this.roomInfoOf(room);
  }

  /** 新群初次拉人：主智能体默认在场，其余按用户勾选的顺序拉进来。 */
  private async seedRoomMembers(room: RoomInstance, memberIds: unknown): Promise<void> {
    const pool = this.bus.listMembers();
    const wanted = Array.isArray(memberIds)
      ? memberIds.filter((id): id is string => typeof id === "string")
      : [];
    const main = pool.find((member) => member.role === "main");
    const ids = main ? [main.id, ...wanted.filter((id) => id !== main.id)] : wanted;
    for (const memberId of ids) {
      const source = pool.find((member) => member.id === memberId);
      if (source && !room.bus.getMember(memberId)) {
        room.bus.addMember(roomCopy(source, room.descriptor.id));
      }
    }
    const names = room.bus.listMembers().map((member) => `@${member.name}`).join("、");
    room.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text:
        `群聊「${room.descriptor.name}」已创建，房间里的成员：${names || "暂无"}。` +
        "拉进来的成员沿用它在作战室里的档案与记忆，@ 它就能在这个群里干活；" +
        "文件工作区与成员池是全账号共享的，成员在这里写出的成果，回到作战室也看得到。",
    });
  }

  /** 拉成员进群：从成员池复制一份档案。 */
  async inviteMember(roomId: string, memberId: string): Promise<{ room: RoomInfo; member: Member }> {
    const room = this.room(roomId);
    if (room.descriptor.kind !== "group") throw new RoomError(400, "作战室的成员请在成员列表里创建");
    if (room.bus.getMember(memberId)) throw new RoomError(400, "该成员已经在群里");
    const source = this.bus.getMember(memberId);
    if (!source) throw new RoomError(404, "成员不存在");
    const member = roomCopy(source, room.descriptor.id);
    room.bus.addMember(member);
    room.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: `已把 @${member.name} 拉进群聊，@ 它就能在这个群里派活。`,
    });
    this.touchRoom(room);
    await this.persistRoom(room.descriptor.id);
    return { room: this.roomInfoOf(room), member };
  }

  /** 移出群聊：只摘本房间的花名册，历史消息保留，它在作战室和其他群里不受影响。 */
  async kickMember(roomId: string, memberId: string): Promise<RoomInfo> {
    const room = this.room(roomId);
    if (room.descriptor.kind !== "group") throw new RoomError(400, "作战室请用「移除成员」彻底删除成员");
    const member = room.bus.getMember(memberId);
    if (!member) throw new RoomError(404, "该成员不在群里");
    room.orchestrator.cancelMember(memberId);
    for (const task of room.board.list()) {
      if (task.ownerId === memberId) room.board.update(task.id, { ownerId: null });
    }
    room.bus.removeMember(memberId);
    room.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: `已把 @${member.name} 移出群聊，历史消息保留。`,
    });
    this.touchRoom(room);
    await this.persistRoom(room.descriptor.id);
    return this.roomInfoOf(room);
  }

  /** 池里的档案变了（模型、技能授权）：同步到各群的副本，房间归属仍按各自。 */
  async propagateMember(memberId: string): Promise<void> {
    const source = this.bus.getMember(memberId);
    if (!source) return;
    for (const room of this.rooms.values()) {
      if (room.descriptor.kind !== "group") continue;
      const existing = room.bus.getMember(memberId);
      if (!existing) continue;
      room.bus.updateMember({ ...source, roomId: room.descriptor.id, status: existing.status });
    }
  }

  /** 池里彻底删掉某个成员：各群里的副本一并退出。 */
  async dropMemberFromRooms(memberId: string): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.descriptor.kind !== "group") continue;
      const member = room.bus.getMember(memberId);
      if (!member) continue;
      room.orchestrator.cancelMember(memberId);
      for (const task of room.board.list()) {
        if (task.ownerId === memberId) room.board.update(task.id, { ownerId: null });
      }
      room.bus.removeMember(memberId);
      await this.persistRoom(room.descriptor.id);
    }
    await this.learning.dropMember(memberId);
  }

  async updateRoom(roomId: string, patch: { name?: unknown; topic?: unknown }): Promise<RoomInfo> {
    const room = this.room(roomId);
    if (room.descriptor.kind !== "group") {
      throw new RoomError(400, "作战室的名字跟随账号显示名，请在设置里改昵称");
    }
    const next: { name?: string; topic?: string; updatedAt: number } = { updatedAt: Date.now() };
    if (patch.name !== undefined) {
      const name = validateRoomName(patch.name);
      if (this.listRooms().some((other) => other.id !== roomId && other.name === name)) {
        throw new RoomError(400, `房间「${name}」已经存在，换一个名字`);
      }
      next.name = name;
    }
    if (patch.topic !== undefined) next.topic = validateRoomTopic(patch.topic);
    Object.assign(room.descriptor, next);
    this.manifest.touch(roomId, next);
    if (next.name) room.bus.rename(next.name);
    if (patch.name !== undefined) {
      room.bus.append({
        senderId: SYSTEM_ID,
        senderName: "系统",
        senderKind: "system",
        kind: "system",
        text: `群聊已改名为「${room.descriptor.name}」。`,
      });
    }
    await this.manifest.save();
    await this.persistRoom(roomId);
    this.bus.emit({ type: "rooms-changed", roomId });
    return this.roomInfoOf(room);
  }

  /** 删除群聊：中止在跑的成员，删掉房间档案与转录。成员池、文件工作区与智能体记忆都不动。 */
  async deleteRoom(roomId: string): Promise<{ removed: string }> {
    const room = this.room(roomId);
    if (room.descriptor.kind !== "group") throw new RoomError(400, "作战室不能删除");
    room.orchestrator.stop();
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    this.rooms.delete(roomId);
    const index = this.groupBuses.findIndex((bus) => bus.roomId === roomId);
    if (index >= 0) this.groupBuses.splice(index, 1);
    this.manifest.remove(roomId);
    await this.manifest.save();
    await rm(room.stateFile, { force: true }).catch(() => undefined);
    this.memory.markDirty();
    this.bus.emit({ type: "rooms-changed", roomId });
    return { removed: roomId };
  }

  getSettings(): Settings {
    return this.settingsRef.current;
  }

  /** 工作区目录：`file:` 密钥引用与探针需要相对根目录。 */
  get dirPath(): string {
    return this.dir;
  }

  renameRoom(ownerDisplayName: string): void {
    const room = this.mainRoom();
    room.descriptor.name = roomNameFor(ownerDisplayName);
    room.bus.rename(room.descriptor.name);
    this.manifest.touch(MAIN_ROOM_ID, { name: room.descriptor.name, updatedAt: Date.now() });
    void this.manifest.save();
  }

  setRoomMode(mode: RoomMode, roomId = MAIN_ROOM_ID): RoomMode {
    return this.room(roomId).orchestrator.setRoomMode(mode);
  }

  /** 房间取人方式（everyone|lead|auto）：作战室与每间群聊各自独立。 */
  setRoomRouting(routing: RoomRoutingMode, roomId = MAIN_ROOM_ID): RoomRoutingMode {
    return this.room(roomId).orchestrator.setRoomRouting(routing);
  }

  /**
   * /clear：先静默中止本房间的在跑成员，把群聊记录与任务卡归档，再清空这间房。
   * 文件工作区是账号共享的：只有作战室的清空会把成果一起搬进归档，
   * 群聊清空时文件留在原地——否则作战室刚写出的东西会凭空消失。
   * 智能体长期记忆（MEMORY.md、USER.md、memory/）与成员档案不进归档、也不受影响。
   */
  async clearRoomSession(roomId = MAIN_ROOM_ID): Promise<{
    cleared: number;
    tasksCleared: number;
    cancelled: number;
    archived: SessionArchiveSummary | null;
  }> {
    const room = this.room(roomId);
    const cancelled = room.orchestrator.cancelAllRuns();
    const archived = await this.captureRoomSession(room);
    const cleared = room.bus.clearMessages();
    const tasksCleared = room.board.clearAll();
    if (archived) room.bus.emit({ type: "session-archived", archive: archived });
    await this.persistRoom(roomId);
    return { cleared, tasksCleared, cancelled, archived };
  }

  /**
   * /new：给这间房开一个新会话。与 /clear 的分别是文件工作区原地不动——上一轮的成果还能继续引用，
   * 但群聊记录与任务卡归档起来，新会话里智能体看不到上一个任务。
   * 归档后的会话仍可在右侧「归档」恢复；恢复是交换语义，会再把当前会话存回去。
   */
  async newSession(roomId = MAIN_ROOM_ID): Promise<{
    cleared: number;
    tasksCleared: number;
    cancelled: number;
    archived: SessionArchiveSummary | null;
  }> {
    const room = this.room(roomId);
    const cancelled = room.orchestrator.cancelAllRuns();
    const snapshot = room.bus.snapshot();
    const archived = await this.archives.capture({
      roomName: room.bus.roomName,
      roomId: room.descriptor.id,
      seq: snapshot.seq,
      messages: snapshot.messages,
      tasks: room.board.list(),
      includeFiles: false,
    });
    const cleared = room.bus.clearMessages();
    const tasksCleared = room.board.clearAll();
    if (archived) room.bus.emit({ type: "session-archived", archive: archived });
    room.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: archived
        ? `已开启新会话：上一个会话（${archived.messageCount} 条消息、${archived.taskCount} 张任务卡）已归档，与当前任务无关；文件工作区与智能体记忆保留。`
        : "已开启新会话：当前没有需要归档的内容，这是一个全新的任务。",
    });
    await this.persistRoom(roomId);
    return { cleared, tasksCleared, cancelled, archived };
  }

  /**
   * 恢复一份归档：当前内容非空时先自动存成新归档（恢复是「交换」，不会丢东西），
   * 再把归档里的消息与任务卡放回这间房。seq 取两边较大值，保证序号继续单调递增。
   */
  async restoreArchive(
    id: string,
    roomId = MAIN_ROOM_ID,
  ): Promise<{
    archive: SessionArchiveDetail;
    autoArchived: SessionArchiveSummary | null;
    restoredFiles: string[];
    conflicts: string[];
    cancelled: number;
  }> {
    const room = this.room(roomId);
    const cancelled = room.orchestrator.cancelAllRuns();
    const autoArchived = await this.captureRoomSession(room);
    const { archive, restoredFiles, conflicts } = await this.archives.restore(id);
    const currentSeq = room.bus.snapshot().seq;
    room.bus.hydrate({
      seq: Math.max(archive.seq, currentSeq),
      messages: archive.messages,
      mode: room.bus.roomMode,
    });
    room.board.hydrate(archive.tasks);
    this.memory.markDirty();
    room.bus.emit({ type: "session-restored", archive: summaryOf(archive) });
    await this.persistRoom(roomId);
    return { archive, autoArchived, restoredFiles, conflicts, cancelled };
  }

  /** 本房间当前会话的归档列表：老归档没有 roomId，按作战室算。 */
  listArchivesForRoom(roomId: string): Promise<SessionArchiveSummary[]> {
    const target = roomIdFromQuery(roomId);
    return this.archives.list().then((archives) =>
      archives.filter((archive) => (archive.roomId ?? MAIN_ROOM_ID) === target),
    );
  }

  private async captureRoomSession(room: RoomInstance): Promise<SessionArchiveSummary | null> {
    const snapshot = room.bus.snapshot();
    return this.archives.capture({
      roomName: room.bus.roomName,
      roomId: room.descriptor.id,
      seq: snapshot.seq,
      messages: snapshot.messages,
      tasks: room.board.list(),
      includeFiles: room.descriptor.kind === "warroom",
    });
  }

  async setSettings(next: Settings): Promise<void> {
    this.settingsRef.current = next;
    await saveSettings(join(this.dir, "settings.json"), next);
  }

  private roomInfoOf(room: RoomInstance): RoomInfo {
    const members = room.bus.listMembers();
    return {
      ...room.descriptor,
      mode: room.bus.roomMode,
      routing: room.bus.roomRouting,
      memberIds: members.map((member) => member.id),
      memberCount: members.length,
      messageCount: room.bus.messageCount,
      taskCount: room.board.list().length,
      runningCount: members.filter((member) => member.status === "running").length,
    };
  }

  private touchRoom(room: RoomInstance): void {
    room.descriptor.updatedAt = Date.now();
    this.manifest.touch(room.descriptor.id, { updatedAt: room.descriptor.updatedAt });
    void this.manifest.save();
  }

  /** 房间事件多路复用：一间房的事件带上它的 roomId 交给上层（SSE 用它按房间过滤）。 */
  subscribeRooms(listener: (roomId: string, event: RoomEvent) => void): () => void {
    this.roomListeners.add(listener);
    return () => this.roomListeners.delete(listener);
  }

  private scheduleSave(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || this.closed || room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      void this.persistRoom(roomId).catch((err) =>
        console.error("持久化失败", this.userId, roomId, err),
      );
    }, 300);
    room.saveTimer.unref();
  }

  async persist(): Promise<void> {
    if (this.closed) return;
    await Promise.all(
      [...this.rooms.keys()].map((roomId) => this.persistRoom(roomId)),
    );
  }

  async persistRoom(roomId: string): Promise<void> {
    if (this.closed) return;
    await this.writeRoom(roomId);
  }

  /** 落一份房间的转录。close() 之后的收尾走这里，不再过 closed 闸门，否则最后一次保存会写不进去。 */
  private async writeRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const snapshot = room.bus.snapshot();
    await writeJsonAtomic(room.stateFile, {
      members: room.bus.listMembers(),
      messages: snapshot.messages,
      seq: snapshot.seq,
      tasks: room.board.snapshot(),
      mode: snapshot.mode,
      routing: snapshot.routing,
    } satisfies PersistedState);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cronService?.stop();
    for (const room of this.rooms.values()) {
      room.orchestrator.stop();
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
        room.saveTimer = null;
      }
    }
    await Promise.all(
      [...this.rooms.keys()].map((roomId) => this.writeRoom(roomId).catch(() => undefined)),
    );
    await this.usage.flush().catch(() => undefined);
    await this.learning.flush().catch(() => undefined);
    await this.cronService?.flush().catch(() => undefined);
  }
}

export class WorkspaceRegistry {
  private workspaces = new Map<string, Promise<Workspace>>();

  constructor(
    private readonly rootDir: string,
    private readonly skills: SkillLibrary,
  ) {}

  get(owner: WorkspaceOwner): Promise<Workspace> {
    const existing = this.workspaces.get(owner.id);
    if (existing) return existing;
    const created = Workspace.load(this.rootDir, owner, this.skills).catch((err) => {
      this.workspaces.delete(owner.id);
      throw err;
    });
    this.workspaces.set(owner.id, created);
    return created;
  }

  /**
   * 删号：先从缓存取出工作区并 close（中止在跑的成员、停止定时落盘），
   * 再删除 `workspaces/<userId>` 目录（聊天记录、任务卡、文件工作区、归档与智能体文件）。
   * 返回目录是否真的删掉了——Windows 上刚中止的子进程可能短暂占用目录。
   */
  async drop(userId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error("账号 ID 不合法");
    const cached = this.workspaces.get(userId);
    this.workspaces.delete(userId);
    if (cached) {
      const workspace = await cached.catch(() => undefined);
      await workspace?.close();
    }
    return removeWorkspaceDir(join(this.rootDir, userId));
  }

  async closeAll(): Promise<void> {
    const pending = [...this.workspaces.values()];
    this.workspaces.clear();
    const workspaces = await Promise.allSettled(pending);
    await Promise.all(
      workspaces.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)),
    );
  }
}

/** 带重试的目录删除：短暂的文件占用不该让整个删号请求失败。 */
async function removeWorkspaceDir(dir: string): Promise<boolean> {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (attempt === attempts) {
        console.warn(`删除工作区目录失败：${dir}`, err);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  return false;
}
