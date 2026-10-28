import { join } from "node:path";
import { createApp } from "./app";
import { RoomBus } from "../room/bus";
import { Workboard } from "../workboard/board";
import { Orchestrator, ensureMainMember } from "../agent/orchestrator";
import { loadSettings, maskSettings, saveSettings, type Settings } from "../core/settings";
import { readJson, writeJsonAtomic } from "../store/persist";
import type { Member, RoomMessage, TaskCard } from "../core/types";

const root = process.cwd();
const dataDir = join(root, "data");
const settingsFile = join(dataDir, "settings.json");
const stateFile = join(dataDir, "state.json");

interface PersistedState {
  members: Member[];
  messages: RoomMessage[];
  seq: number;
  tasks: TaskCard[];
}

async function main(): Promise<void> {
  const loadedSettings = await loadSettings(settingsFile);
  const state = await readJson<PersistedState | null>(stateFile, null);

  const bus = new RoomBus("room_main", "协同作战室");
  const board = new Workboard("room_main");

  if (state) {
    bus.hydrate({ seq: state.seq, messages: state.messages });
    for (const member of state.members) {
      bus.addMember({ ...member, status: member.status === "running" ? "idle" : member.status });
    }
    board.hydrate(state.tasks);
  }
  ensureMainMember(bus);

  let currentSettings: Settings = loadedSettings;
  const orchestrator = new Orchestrator({
    bus,
    board,
    getSettings: () => currentSettings,
  });

  let saveTimer: NodeJS.Timeout | null = null;
  const persist = async (): Promise<void> => {
    const snapshot = bus.snapshot();
    await writeJsonAtomic(stateFile, {
      members: bus.listMembers(),
      messages: snapshot.messages,
      seq: snapshot.seq,
      tasks: board.snapshot(),
    });
  };
  const scheduleSave = (): void => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist().catch((err) => console.error("持久化失败", err));
    }, 300);
  };
  bus.subscribe((event) => {
    if (event.type === "message" || event.type === "member") scheduleSave();
  });
  board.subscribe(() => scheduleSave());

  const app = createApp({
    bus,
    board,
    orchestrator,
    getSettings: () => currentSettings,
    setSettings: async (next) => {
      currentSettings = next;
      await saveSettings(settingsFile, next);
    },
    webDist: join(root, "web", "dist"),
  });

  const port = Number(process.env["PORT"] ?? 8788);
  const server = app.listen(port, "127.0.0.1", () => {
    const active = maskSettings(currentSettings).providers.find(
      (provider) => provider.id === currentSettings.activeProviderId,
    );
    console.log(`agent-collaboration 已启动：http://127.0.0.1:${port}`);
    console.log(`当前 provider：${currentSettings.activeProviderId}（${active?.kind ?? "未知"}）`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用，可能还有一个旧服务在运行（可用 PORT 换端口）。`);
    } else {
      console.error("服务启动失败", err);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
