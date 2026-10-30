import { join } from "node:path";
import { ensureMainMember, Orchestrator } from "../agent/orchestrator";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import type { Member, RoomMessage, RoomMode, TaskCard } from "../core/types";
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

    const workspace = new Workspace(owner.id, dir, bus, board, orchestrator, settingsRef, memory, files);
    bus.subscribe((event) => {
      if (
        event.type === "message" ||
        event.type === "messages-cleared" ||
        event.type === "mode" ||
        event.type === "member" ||
        event.type === "member-removed"
      ) {
        workspace.scheduleSave();
      }
      if (event.type === "message" || event.type === "messages-cleared") memory.markDirty();
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
