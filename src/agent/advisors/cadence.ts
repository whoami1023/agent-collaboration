/**
 * 扇出节流（移植 Hermes 的 `fanout ∈ user_turn | per_iteration | every_n:<N>`）。
 *
 * 顾问是要花钱的，所以「什么时候问」必须能收紧：
 * - `user_turn`：同一个用户回合只问一次，问出来的建议块在该回合内复用（靠缓存，不靠重复调用）；
 * - `per_iteration`：每次动手都问——最贵，适合真的需要参谋的任务；
 * - `every_n`：每 N 次动手才问一次，第一次一定问（否则等于没有参谋）。
 */

import type { AdvisorSettings } from "../../core/settings";

/** 动手序号从 1 开始：第 1 次永远问，之后按间隔问。 */
export function wantsFanOut(settings: AdvisorSettings, runOrdinal: number): boolean {
  if (!settings.enabled) return false;
  switch (settings.cadence) {
    case "per_iteration":
      return true;
    case "every_n": {
      const interval = Math.max(2, Math.trunc(settings.everyN));
      return (Math.max(1, runOrdinal) - 1) % interval === 0;
    }
    case "user_turn":
      // user_turn 的节流是「一个回合只花一次钱」，由缓存实现，这里先放行。
      return true;
  }
}

/**
 * 缓存键：房间 + 用户回合 + 动手的成员 + 顾问名单与槽位。
 * 名单一变（新建成员、改职责）键就变，不会拿着旧阵容的建议继续用。
 */
export function advisorCacheKey(params: {
  roomId: string;
  turnKey: string;
  actingId: string;
  advisorIds: readonly string[];
}): string {
  return [params.roomId, params.turnKey, params.actingId, params.advisorIds.join(",")].join("|");
}
