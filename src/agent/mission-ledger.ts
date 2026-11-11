/**
 * 任务台账（移植自 Microsoft AutoGen Magentic-One 的 task ledger / progress ledger）：
 * 每个用户任务链维护一份可被主智能体直接阅读的状态块——目标、任务卡进度、已完成的成果、
 * 连续多少轮没有进展，以及停滞到阈值后的重规划要求。
 *
 * 与 AutoGen 的差别：不让模型每轮额外产出一份 JSON 进度台账，而是用任务卡状态、
 * 成果数量和成员运行终局这些客观信号计算进展；只有连续停滞时才在下一轮注入重规划指令。
 * 这样长任务能拿到稳定的“做到哪了”，又不会为每轮多付一次模型调用。
 */

import type { RoomMessage, TaskCard } from "../core/types";

export const MISSION_SNAPSHOT_VERSION = 1;
const MAX_MISSIONS = 100;
const KEEP_COMPLETED = 20;
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_GOAL_CHARS = 240;
const MAX_BLOCK_CHARS = 1600;
const MAX_COMPLETED_LINES = 4;
const MAX_OPEN_LINES = 6;

export type MissionStatus = "active" | "completed";

export interface MissionRecord {
  /** 用户任务链的根消息 id。 */
  id: string;
  roomId: string;
  goal: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  /** 这条任务链上完成过多少次成员运行。 */
  runs: number;
  /** 距离上次任务状态/成果变化已经过了多少轮。 */
  runsSinceProgress: number;
  /** 累计触发过多少次停滞重规划。 */
  stalls: number;
  /** 本轮停滞周期内已经重规划过几次；出现新进展后归零。 */
  replans: number;
  lastProgressAt: number;
  lastProgressKey: string;
  /** 下一轮主智能体是否需要收到重规划要求。 */
  replanPending: boolean;
  /** 重规划次数已达上限仍无进展：要求主智能体停止自动尝试、向用户要指示。 */
  exhausted: boolean;
}

export interface MissionSnapshot {
  version: number;
  missions: MissionRecord[];
}

export interface MissionOptions {
  now?: () => number;
  /** 连续多少轮没有进展算一次停滞；默认 3。 */
  stallThreshold?: number;
  /** 一个停滞周期内最多自动重规划几次；默认 3。 */
  maxReplans?: number;
  onChange?: () => void;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function missionTasks(tasks: TaskCard[], missionId: string): TaskCard[] {
  return tasks.filter((task) => task.chainRootId === missionId);
}

function progressKey(tasks: TaskCard[]): string {
  return [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (task) =>
        `${task.id}:${task.status}:${task.artifacts.length}:${task.evidence?.length ?? 0}:${task.completion ? 1 : 0}:${task.acceptance ? 1 : 0}`,
    )
    .join("|");
}

function taskOwner(task: TaskCard): string {
  return task.ownerId ? `，负责人 ${task.ownerId}` : "";
}

function artifactNames(task: TaskCard): string {
  const names = task.artifacts
    .map((artifact) => artifact.path || artifact.name)
    .filter((name) => name.length > 0);
  if (names.length === 0) return "";
  return `（成果：${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}）`;
}

export class MissionStore {
  private readonly missions = new Map<string, MissionRecord>();
  private readonly now: () => number;
  private readonly stallThreshold: number;
  private readonly maxReplans: number;

  constructor(
    private readonly roomId: string,
    private readonly options: MissionOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.stallThreshold = Math.max(1, options.stallThreshold ?? 3);
    this.maxReplans = Math.max(1, options.maxReplans ?? 3);
  }

  /** 用户新消息就是一条新任务链；同一条根消息重复派发时复用原台账。 */
  begin(root: RoomMessage): MissionRecord {
    const existing = this.missions.get(root.id);
    if (existing) return existing;
    const at = this.now();
    const record: MissionRecord = {
      id: root.id,
      roomId: this.roomId,
      goal: clip(root.text, MAX_GOAL_CHARS),
      status: "active",
      createdAt: at,
      updatedAt: at,
      runs: 0,
      runsSinceProgress: 0,
      stalls: 0,
      replans: 0,
      lastProgressAt: at,
      lastProgressKey: "",
      replanPending: false,
      exhausted: false,
    };
    this.missions.set(record.id, record);
    this.prune();
    this.changed();
    return record;
  }

  get(id: string): MissionRecord | undefined {
    return this.missions.get(id);
  }

  /**
   * 一轮成员运行结束后记账：任务卡状态/成果有任何变化就算进展，否则累加停滞轮数。
   * 没有任务卡的纯问答不参与停滞判定，避免把正常对话误判成卡死。
   */
  observe(input: { chainRootId: string; tasks: TaskCard[] }): MissionRecord | null {
    const mission = this.missions.get(input.chainRootId);
    if (!mission) return null;
    const at = this.now();
    mission.runs += 1;
    mission.updatedAt = at;

    const tasks = missionTasks(input.tasks, mission.id);
    if (tasks.length === 0) {
      mission.lastProgressKey = "";
      mission.runsSinceProgress = 0;
      mission.lastProgressAt = at;
      this.changed();
      return mission;
    }

    const nextKey = progressKey(tasks);
    if (nextKey !== mission.lastProgressKey) {
      mission.lastProgressKey = nextKey;
      mission.runsSinceProgress = 0;
      mission.lastProgressAt = at;
      mission.stalls = 0;
      mission.replans = 0;
      mission.replanPending = false;
      mission.exhausted = false;
    } else {
      mission.runsSinceProgress += 1;
    }

    const complete = tasks.every((task) => task.status === "done");
    if (complete) {
      mission.status = "completed";
      mission.replanPending = false;
      mission.exhausted = false;
    } else if (mission.status === "completed") {
      mission.status = "active";
    }

    if (
      mission.status === "active" &&
      mission.runsSinceProgress >= this.stallThreshold &&
      !mission.replanPending &&
      !mission.exhausted
    ) {
      if (mission.replans < this.maxReplans) {
        mission.replanPending = true;
        mission.stalls += 1;
      } else {
        mission.exhausted = true;
      }
    }

    this.changed();
    return mission;
  }

  /**
   * 主智能体本轮要看的台账。重规划要求只在下一轮消费一次：消费即计数，
   * 免得同一句「换个做法」在后续每轮重复出现、变成新的噪声。
   */
  takeContext(chainRootId: string, tasks: TaskCard[]): string | null {
    const mission = this.missions.get(chainRootId);
    if (!mission) return null;
    const missionTaskList = missionTasks(tasks, mission.id);
    if (missionTaskList.length === 0 && mission.runs === 0) return null;

    const replan = mission.replanPending;
    if (replan) {
      mission.replanPending = false;
      mission.replans += 1;
      mission.updatedAt = this.now();
      this.changed();
    }

    const counts = {
      done: missionTaskList.filter((task) => task.status === "done").length,
      doing: missionTaskList.filter((task) => task.status === "doing").length,
      todo: missionTaskList.filter((task) => task.status === "todo").length,
      blocked: missionTaskList.filter((task) => task.status === "blocked").length,
      failed: missionTaskList.filter((task) => task.status === "failed").length,
    };
    const lines: string[] = [`【任务台账】${mission.goal}`];
    if (missionTaskList.length > 0) {
      lines.push(
        `进度：任务卡 ${missionTaskList.length} 张（完成 ${counts.done} / 进行 ${counts.doing} / 待办 ${counts.todo} / 阻塞 ${counts.blocked} / 失败 ${counts.failed}）；累计成员运行 ${mission.runs} 次。`,
      );
      const completed = missionTaskList
        .filter((task) => task.status === "done")
        .slice(-MAX_COMPLETED_LINES);
      for (const task of completed) {
        lines.push(`已完成：${clip(task.title, 60)}${artifactNames(task)}`);
      }
      const open = missionTaskList
        .filter((task) => task.status !== "done" && task.status !== "failed")
        .slice(0, MAX_OPEN_LINES);
      for (const task of open) {
        lines.push(`未完成：${clip(task.title, 60)}（${task.status}${taskOwner(task)}）`);
      }
      const failed = missionTaskList.filter((task) => task.status === "failed").slice(0, 2);
      for (const task of failed) {
        lines.push(`失败：${clip(task.title, 60)}${taskOwner(task)}`);
      }
    } else {
      lines.push(`进度：还没有关联任务卡；已运行 ${mission.runs} 次。`);
    }
    if (mission.runsSinceProgress > 0) {
      lines.push(
        `注意：最近 ${mission.runsSinceProgress} 次成员运行没有改变任务状态或成果，可能已经在原地打转。`,
      );
    }
    if (replan) {
      lines.push(
        "【停滞重规划】先说明卡点，保留已完成的部分，换一种做法重排计划；不要重复同样的派发。" +
          "如果缺的是只有用户能提供的信息，用 ask_user 提问，不要硬猜。",
      );
    } else if (mission.exhausted) {
      lines.push(
        "【多次重规划仍无进展】停止继续自动尝试，向用户说明卡点、已经试过的做法和需要用户决定的事项。",
      );
    }
    const text = lines.join("\n");
    return text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS)}…` : text;
  }

  clear(): void {
    if (this.missions.size === 0) return;
    this.missions.clear();
    this.changed();
  }

  snapshot(): MissionSnapshot {
    return {
      version: MISSION_SNAPSHOT_VERSION,
      missions: [...this.missions.values()].map((mission) => ({ ...mission })),
    };
  }

  hydrate(value: MissionSnapshot | undefined): void {
    if (!value || !Array.isArray(value.missions)) return;
    this.missions.clear();
    for (const raw of value.missions) {
      if (!raw || typeof raw.id !== "string" || raw.id.length === 0) continue;
      const status: MissionStatus = raw.status === "completed" ? "completed" : "active";
      this.missions.set(raw.id, {
        id: raw.id,
        roomId: typeof raw.roomId === "string" ? raw.roomId : this.roomId,
        goal: typeof raw.goal === "string" ? clip(raw.goal, MAX_GOAL_CHARS) : "",
        status,
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        runs: typeof raw.runs === "number" ? Math.max(0, raw.runs) : 0,
        runsSinceProgress:
          typeof raw.runsSinceProgress === "number" ? Math.max(0, raw.runsSinceProgress) : 0,
        stalls: typeof raw.stalls === "number" ? Math.max(0, raw.stalls) : 0,
        replans: typeof raw.replans === "number" ? Math.max(0, raw.replans) : 0,
        lastProgressAt: typeof raw.lastProgressAt === "number" ? raw.lastProgressAt : 0,
        lastProgressKey: typeof raw.lastProgressKey === "string" ? raw.lastProgressKey : "",
        replanPending: raw.replanPending === true,
        exhausted: raw.exhausted === true,
      });
    }
    this.prune();
  }

  private prune(): void {
    const at = this.now();
    const records = [...this.missions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    let completed = 0;
    for (const record of records) {
      if (record.status !== "completed") continue;
      const stale = at - record.updatedAt > COMPLETED_RETENTION_MS;
      if (completed >= KEEP_COMPLETED || stale) {
        this.missions.delete(record.id);
        continue;
      }
      completed += 1;
    }
    if (this.missions.size <= MAX_MISSIONS) return;
    for (const record of [...records].reverse()) {
      if (this.missions.size <= MAX_MISSIONS) break;
      if (record.status === "completed") this.missions.delete(record.id);
    }
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
