// 定时任务与作战室的接缝单独成文件：src/cron/types.ts 必须保持纯数据，
// 否则 Web 端只要引用任务定义类型，就会把 RoomBus/Orchestrator 这些服务端模块拖进浏览器类型图里。

import type { RoomBus } from "../room/bus";
import type { Orchestrator } from "../agent/orchestrator";
import type { Settings } from "../core/settings";

/** 服务只通过它访问某个账号的群聊与编排器；一个账号就是一个宿主（相当于 OpenClaw 的一个 storeKey）。 */
export interface CronHost {
  ownerId: string;
  bus: RoomBus;
  orchestrator: Orchestrator;
  getSettings(): Settings;
  /** command payload 的工作目录（文件工作区 files/）。 */
  commandCwd?: string;
}
