import { join } from "node:path";
import { ensureMainMember, Orchestrator } from "../agent/orchestrator";
import { loadSettings, saveSettings, type Settings } from "../core/settings";
import type { Member, RoomMessage, TaskCard } from "../core/types";
import { RoomBus } from "../room/bus";
import { readJson, writeJsonAtomic } from "../store/persist";
import { Workboard } from "../workboard/board";

interface PersistedState {
  members: Member[];
  messages: RoomMessage[];
  seq: number;
  tasks: TaskCard[];
}

export interface WorkspaceOwner {
  id: string;
  displayName: string;
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
  ) {}

  static async load(rootDir: string, owner: WorkspaceOwner): Promise<Workspace> {
    const dir = join(rootDir, owner.id);
    const [state, loadedSettings] = await Promise.all([
      readJson<PersistedState | null>(join(dir, "state.json"), null),
      loadSettings(join(dir, "settings.json")),
    ]);

    const bus = new RoomBus("room_main", `${owner.displayName} 的作战室`);
    const board = new Workboard("room_main");
    if (state) {
      bus.hydrate({ seq: state.seq, messages: state.messages });
      for (const member of state.members) {
        bus.addMember({ ...member, status: member.status === "running" ? "idle" : member.status });
      }
      board.hydrate(state.tasks ?? []);
    }
    ensureMainMember(bus);

    const settingsRef = { current: loadedSettings };
    const orchestrator = new Orchestrator({
      bus,
      board,
      getSettings: () => settingsRef.current,
    });

    const workspace = new Workspace(owner.id, dir, bus, board, orchestrator, settingsRef);
    bus.subscribe((event) => {
      if (event.type === "message" || event.type === "member") workspace.scheduleSave();
    });
    board.subscribe(() => workspace.scheduleSave());
    await workspace.persist();
    return workspace;
  }

  getSettings(): Settings {
    return this.settingsRef.current;
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

  constructor(private readonly rootDir: string) {}

  get(owner: WorkspaceOwner): Promise<Workspace> {
    const existing = this.workspaces.get(owner.id);
    if (existing) return existing;
    const created = Workspace.load(this.rootDir, owner).catch((err) => {
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
