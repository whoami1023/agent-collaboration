import type { ArtifactRef, RoomEvent, TaskCard, TaskStatus } from "../core/types";
import { newId } from "../core/ids";

export interface CreateTaskInput {
  title: string;
  detail?: string;
  createdBy: string;
  ownerId?: string | null;
  deps?: string[];
}

export interface UpdateTaskPatch {
  title?: string;
  detail?: string;
  ownerId?: string | null;
  status?: TaskStatus;
}

const ACTIVE_STATUSES: TaskStatus[] = ["doing", "done"];

export class Workboard {
  private tasks = new Map<string, TaskCard>();
  private listeners = new Set<(event: RoomEvent) => void>();

  constructor(private readonly roomId: string) {}

  subscribe(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(task: TaskCard): void {
    const event: RoomEvent = { type: "task", task: { ...task } };
    for (const listener of [...this.listeners]) listener(event);
  }

  create(input: CreateTaskInput): TaskCard {
    const now = Date.now();
    const task: TaskCard = {
      id: newId("task"),
      roomId: this.roomId,
      title: input.title.trim(),
      detail: input.detail?.trim() ?? "",
      ownerId: input.ownerId ?? null,
      status: "todo",
      deps: input.deps ?? [],
      artifacts: [],
      messageIds: [],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    return task;
  }

  get(id: string): TaskCard | undefined {
    return this.tasks.get(id);
  }

  list(): TaskCard[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  update(id: string, patch: UpdateTaskPatch): TaskCard {
    const task = this.require(id);
    if (patch.status && ACTIVE_STATUSES.includes(patch.status)) {
      const blocking = task.deps
        .map((depId) => this.tasks.get(depId))
        .filter((dep): dep is TaskCard => dep !== undefined && dep.status !== "done");
      if (blocking.length > 0) {
        throw new Error(
          `任务 ${id} 存在未完成依赖：${blocking.map((t) => `${t.id}(${t.status})`).join("、")}`,
        );
      }
    }
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.emit(task);
    return task;
  }

  attachArtifact(
    id: string,
    ref: { name: string; path?: string; summary?: string; addedBy: string },
  ): TaskCard {
    const task = this.require(id);
    const artifact: ArtifactRef = {
      name: ref.name,
      ...(ref.path ? { path: ref.path } : {}),
      ...(ref.summary ? { summary: ref.summary } : {}),
      addedAt: Date.now(),
      addedBy: ref.addedBy,
    };
    task.artifacts.push(artifact);
    task.updatedAt = Date.now();
    this.emit(task);
    return task;
  }

  linkMessage(id: string, messageId: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.messageIds.push(messageId);
    task.updatedAt = Date.now();
    this.emit(task);
  }

  /** 清空整块看板（归档作战室时用）：无任务时不广播，避免多一次无意义落盘。 */
  clearAll(): number {
    const cleared = this.tasks.size;
    if (cleared === 0) return 0;
    this.tasks = new Map();
    const event: RoomEvent = { type: "tasks-cleared" };
    for (const listener of [...this.listeners]) listener(event);
    return cleared;
  }

  private require(id: string): TaskCard {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`任务不存在：${id}`);
    return task;
  }

  snapshot(): TaskCard[] {
    return [...this.tasks.values()];
  }

  hydrate(tasks: TaskCard[] | undefined): void {
    this.tasks = new Map((tasks ?? []).map((task) => [task.id, task]));
  }
}
