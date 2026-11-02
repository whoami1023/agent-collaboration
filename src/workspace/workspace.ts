import { join } from "node:path";
import { ensureMainMember, Orchestrator } from "../agent/orchestrator";
import { SessionArchives, summaryOf } from "../archive/session-archive";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import type {
  Member,
  RoomMessage,
  RoomMode,
  SessionArchiveDetail,
  SessionArchiveSummary,
  TaskCard,
} from "../core/types";
import { SYSTEM_ID } from "../core/types";
import { ensureAgentFiles } from "../memory/bootstrap-files";
import { MemorySearchManager } from "../memory/manager";
import { WorkspaceFiles } from "../files/workspace-files";
import { RoomBus } from "../room/bus";
import type { SkillLibrary } from "../skills/library";
import { readJson, writeJsonAtomic } from "../store/persist";
import { Workboard } from "../workboard/board";

interface PersistedState {
  members: Member[];
  messages: RoomMessage[];
  seq: number;
  tasks: TaskCard[];
  mode?: RoomMode;
}

export interface WorkspaceOwner {
  id: string;
  displayName: string;
}

function roomNameFor(displayName: string): string {
  return `${displayName} 的作战室`;
}

export class Workspace {
  private saveTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(
    readonly userId: string,
    private readonly dir: string,
    readonly bus: RoomBus,
    readonly board: Workboard,
    readonly orchestrator: Orchestrator,
    private readonly settingsRef: { current: Settings },
    readonly memory: MemorySearchManager,
    readonly files: WorkspaceFiles,
    readonly archives: SessionArchives,
  ) {}

  static async load(rootDir: string, owner: WorkspaceOwner, skills: SkillLibrary): Promise<Workspace> {
    const dir = join(rootDir, owner.id);
    const [state, loadedSettings] = await Promise.all([
      readJson<PersistedState | null>(join(dir, "state.json"), null),
      loadSettings(join(dir, "settings.json")),
    ]);

    const bus = new RoomBus("room_main", roomNameFor(owner.displayName));
    const board = new Workboard("room_main");
    if (state) {
      bus.hydrate({ seq: state.seq, messages: state.messages, mode: state.mode });
      for (const member of state.members) {
        bus.addMember({ ...member, status: member.status === "running" ? "idle" : member.status });
      }
      board.hydrate(state.tasks ?? []);
    }
    ensureMainMember(bus);

    const settingsRef = { current: loadedSettings };
    // 智能体档案文件（对应 OpenClaw 的 generated bootstrap files）：只补写缺失项，
    // 已存在的文件视为用户内容，绝不覆盖。这样右侧「智能体文件」面板开箱即有内容。
    await ensureAgentFiles(dir, {
      displayName: owner.displayName,
      mainAgentName: bus.listMembers().find((member) => member.role === "main")?.name ?? "主智能体",
      roomName: bus.roomName,
    });
    // P5：每用户工作区一个记忆检索管理器（对应 OpenClaw 每 agent 的 memory manager），
    // 语料 = 工作区 MEMORY.md/USER.md/memory/**.md + 本群转录（sessions）。
    const memory = new MemorySearchManager({ workspaceDir: dir, bus });
    // 文件工作区独立于运行时数据：智能体与用户只经 files/ 交换文件。
    const files = new WorkspaceFiles(dir);
    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => settingsRef.current,
      skills,
      ownerId: owner.id,
      memory,
      files,
    });

    const workspace = new Workspace(
      owner.id,
      dir,
      bus,
      board,
      orchestrator,
      settingsRef,
      memory,
      files,
      new SessionArchives(dir),
    );
    bus.subscribe((event) => {
      if (
        event.type === "message" ||
        event.type === "messages-cleared" ||
        event.type === "session-archived" ||
        event.type === "session-restored" ||
        event.type === "mode" ||
        event.type === "member" ||
        event.type === "member-removed"
      ) {
        workspace.scheduleSave();
      }
      if (
        event.type === "message" ||
        event.type === "messages-cleared" ||
        event.type === "session-restored"
      ) {
        memory.markDirty();
      }
    });
    board.subscribe(() => workspace.scheduleSave());
    await workspace.persist();
    return workspace;
  }

  getSettings(): Settings {
    return this.settingsRef.current;
  }

  renameRoom(ownerDisplayName: string): void {
    this.bus.rename(roomNameFor(ownerDisplayName));
  }

  setRoomMode(mode: RoomMode): RoomMode {
    return this.orchestrator.setRoomMode(mode);
  }

  /**
   * /clear：先静默中止在跑的成员，把群聊记录、任务卡与 files/ 成果整体归档，再清空作战室。
   * 智能体长期记忆（MEMORY.md、USER.md、memory/）与成员档案不进归档、也不受影响。
   */
  async clearRoomSession(): Promise<{
    cleared: number;
    tasksCleared: number;
    cancelled: number;
    archived: SessionArchiveSummary | null;
  }> {
    const cancelled = this.orchestrator.cancelAllRuns();
    const archived = await this.captureRoomSession();
    const cleared = this.bus.clearMessages();
    const tasksCleared = this.board.clearAll();
    if (archived) this.bus.emit({ type: "session-archived", archive: archived });
    await this.persist();
    return { cleared, tasksCleared, cancelled, archived };
  }

  /**
   * /new：开一个新会话。与 /clear 的区别是文件工作区原地不动——上一轮的成果还能继续引用，
   * 但群聊记录与任务卡归档起来，新会话里智能体看不到上一个任务。
   * 归档后的会话仍可在右侧「归档」恢复；恢复是交换语义，会再把当前会话存回去。
   */
  async newSession(): Promise<{
    cleared: number;
    tasksCleared: number;
    cancelled: number;
    archived: SessionArchiveSummary | null;
  }> {
    const cancelled = this.orchestrator.cancelAllRuns();
    const snapshot = this.bus.snapshot();
    const archived = await this.archives.capture({
      roomName: this.bus.roomName,
      seq: snapshot.seq,
      messages: snapshot.messages,
      tasks: this.board.list(),
      includeFiles: false,
    });
    const cleared = this.bus.clearMessages();
    const tasksCleared = this.board.clearAll();
    if (archived) this.bus.emit({ type: "session-archived", archive: archived });
    this.bus.append({
      senderId: SYSTEM_ID,
      senderName: "系统",
      senderKind: "system",
      kind: "system",
      text: archived
        ? `已开启新会话：上一个会话（${archived.messageCount} 条消息、${archived.taskCount} 张任务卡）已归档，与当前任务无关；文件工作区与智能体记忆保留。`
        : "已开启新会话：当前没有需要归档的内容，这是一个全新的任务。",
    });
    await this.persist();
    return { cleared, tasksCleared, cancelled, archived };
  }

  /**
   * 恢复一份归档：当前内容非空时先自动存成新归档（恢复是「交换」，不会丢东西），
   * 再把归档里的消息、任务卡与文件放回作战室。seq 取两边较大值，保证序号继续单调递增。
   */
  async restoreArchive(id: string): Promise<{
    archive: SessionArchiveDetail;
    autoArchived: SessionArchiveSummary | null;
    restoredFiles: string[];
    conflicts: string[];
    cancelled: number;
  }> {
    const cancelled = this.orchestrator.cancelAllRuns();
    const autoArchived = await this.captureRoomSession();
    const { archive, restoredFiles, conflicts } = await this.archives.restore(id);
    const currentSeq = this.bus.snapshot().seq;
    this.bus.hydrate({
      seq: Math.max(archive.seq, currentSeq),
      messages: archive.messages,
      mode: this.bus.roomMode,
    });
    this.board.hydrate(archive.tasks);
    this.memory.markDirty();
    this.bus.emit({ type: "session-restored", archive: summaryOf(archive) });
    await this.persist();
    return { archive, autoArchived, restoredFiles, conflicts, cancelled };
  }

  private async captureRoomSession(): Promise<SessionArchiveSummary | null> {
    const snapshot = this.bus.snapshot();
    return this.archives.capture({
      roomName: this.bus.roomName,
      seq: snapshot.seq,
      messages: snapshot.messages,
      tasks: this.board.list(),
    });
  }

  async setSettings(next: Settings): Promise<void> {
    this.settingsRef.current = next;
    await saveSettings(join(this.dir, "settings.json"), next);
  }

  private scheduleSave(): void {
    if (this.closed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist().catch((err) => console.error("持久化失败", this.userId, err));
    }, 300);
    this.saveTimer.unref();
  }

  async persist(): Promise<void> {
    const snapshot = this.bus.snapshot();
    await writeJsonAtomic(join(this.dir, "state.json"), {
      members: this.bus.listMembers(),
      messages: snapshot.messages,
      seq: snapshot.seq,
      tasks: this.board.snapshot(),
      mode: snapshot.mode,
    } satisfies PersistedState);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.orchestrator.stop();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist().catch(() => undefined);
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

  async closeAll(): Promise<void> {
    const pending = [...this.workspaces.values()];
    this.workspaces.clear();
    const workspaces = await Promise.allSettled(pending);
    await Promise.all(
      workspaces.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)),
    );
  }
}
