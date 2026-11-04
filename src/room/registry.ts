/**
 * 房间清单：作战室之外，「群聊区」可以自建任意多个群聊。
 * 清单落在每用户工作区的 `rooms.json`，每间群聊自己的转录与任务卡落在 `rooms/<roomId>.json`，
 * 作战室沿用历史遗留的 `state.json`——因此老工作区不需要迁移。
 */

import { join } from "node:path";
import type { RoomDescriptor } from "../core/types";
import { readJson, writeJsonAtomic } from "../store/persist";

export const MAIN_ROOM_ID = "room_main";

export const ROOM_LIMITS = {
  name: 40,
  topic: 200,
  /** 一个账号最多能开多少群：再多也只是没人在看的房间。 */
  maxRooms: 50,
} as const;

/** 房间 ID 的形状：只允许这个格式，路径拼接才不会越出工作区目录。 */
const ROOM_ID_RE = /^room_[0-9a-f]{12}$/;

export class RoomError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

export function isMainRoom(id: string): boolean {
  return id === MAIN_ROOM_ID;
}

export function assertRoomId(id: string): void {
  if (!ROOM_ID_RE.test(id)) throw new RoomError(400, "房间 ID 不合法");
}

/** 请求里的 `?room=`：缺省或空串都表示作战室，前端所有旧调用因此不用改。 */
export function roomIdFromQuery(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || MAIN_ROOM_ID;
}

export function validateRoomName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new RoomError(400, "请填写群聊名称");
  if (name.length > ROOM_LIMITS.name) {
    throw new RoomError(400, `群聊名称最多 ${ROOM_LIMITS.name} 字`);
  }
  if (/[ \t\r\n]/.test(name)) throw new RoomError(400, "群聊名称不能包含空格或换行");
  return name;
}

export function validateRoomTopic(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new RoomError(400, "群聊主题格式不正确");
  const topic = raw.trim();
  if (!topic) return undefined;
  if (topic.length > ROOM_LIMITS.topic) {
    throw new RoomError(400, `群聊主题最多 ${ROOM_LIMITS.topic} 字`);
  }
  return topic;
}

interface RoomsFile {
  rooms: RoomDescriptor[];
}

export class RoomManifest {
  private readonly file: string;
  private rooms: RoomDescriptor[] = [];

  constructor(workspaceDir: string) {
    this.file = join(workspaceDir, "rooms.json");
  }

  async load(): Promise<RoomDescriptor[]> {
    const data = await readJson<RoomsFile | null>(this.file, null);
    this.rooms = (data?.rooms ?? []).filter(
      (room): room is RoomDescriptor =>
        typeof room?.id === "string" && typeof room.name === "string",
    );
    // 作战室一定在清单里：老工作区没有 rooms.json，也要有一条 warroom 档案。
    if (!this.rooms.some((room) => room.id === MAIN_ROOM_ID)) {
      this.rooms.unshift({
        id: MAIN_ROOM_ID,
        kind: "warroom",
        name: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return this.rooms;
  }

  list(): RoomDescriptor[] {
    return this.rooms;
  }

  get(id: string): RoomDescriptor | undefined {
    return this.rooms.find((room) => room.id === id);
  }

  groupRooms(): RoomDescriptor[] {
    return this.rooms.filter((room) => room.kind === "group");
  }

  count(): number {
    return this.rooms.length;
  }

  add(room: RoomDescriptor): void {
    this.rooms.push(room);
  }

  remove(id: string): RoomDescriptor | undefined {
    const index = this.rooms.findIndex((room) => room.id === id);
    if (index < 0) return undefined;
    return this.rooms.splice(index, 1)[0];
  }

  touch(id: string, patch: Partial<Pick<RoomDescriptor, "name" | "topic" | "updatedAt">>): void {
    const room = this.rooms.find((candidate) => candidate.id === id);
    if (!room) return;
    Object.assign(room, patch);
  }

  async save(): Promise<void> {
    await writeJsonAtomic(this.file, { rooms: this.rooms } satisfies RoomsFile);
  }
}
