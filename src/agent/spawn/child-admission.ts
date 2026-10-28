// Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
// src/agents/child-admission.ts, MIT licensed (Copyright (c) 2026 OpenClaw Foundation).

import { isSubagentSpawnDepthAllowed } from "./agent-limits";

export type ChildAdmissionCap =
  | "subagents.maxSpawnDepth"
  | "subagents.maxChildrenPerAgent"
  | "groups.maxChildrenPerGroup"
  | "groups.maxTotalPerGroup";

export type ChildAdmissionResult =
  | { ok: true }
  | { ok: false; governingCap: ChildAdmissionCap; error: string };

export type ChildAdmissionParams = {
  callerDepth: number;
  maxSpawnDepth: number;
  activeChildren: number;
  maxActiveChildren: number;
} & ({ collect: false } | { collect: true; totalChildren: number; maxTotalChildren: number });

/**
 * Ported resolveChildAdmission: depth cap first, then (for collector/group
 * spawns) the per-group total cap, then the live-children cap. The governing
 * cap identifies which limit rejected the spawn so callers can surface it.
 */
export function resolveChildAdmission(params: ChildAdmissionParams): ChildAdmissionResult {
  const reject = (governingCap: ChildAdmissionCap, error: string): ChildAdmissionResult => ({
    ok: false,
    governingCap,
    error,
  });

  if (!isSubagentSpawnDepthAllowed(params.callerDepth, params.maxSpawnDepth)) {
    return reject(
      "subagents.maxSpawnDepth",
      `当前层级不允许再创建成员（嵌套深度已达上限：当前深度 ${params.callerDepth}，上限 ${params.maxSpawnDepth}）。`,
    );
  }
  if (params.collect && params.totalChildren >= params.maxTotalChildren) {
    return reject(
      "groups.maxTotalPerGroup",
      `本轮任务组的成员总数已达上限（${params.totalChildren}/${params.maxTotalChildren}）。`,
    );
  }
  if (params.activeChildren < params.maxActiveChildren) {
    return { ok: true };
  }
  return params.collect
    ? reject(
        "groups.maxChildrenPerGroup",
        `本轮任务组的活跃成员已达上限（${params.activeChildren}/${params.maxActiveChildren}）。`,
      )
    : reject(
        "subagents.maxChildrenPerAgent",
        `该会话的直接成员活跃数已达上限（${params.activeChildren}/${params.maxActiveChildren}），请等已有成员交回结果后再派发。`,
      );
}

/**
 * Ported reserveChildAdmissionSlot: holds a pending-admission slot per
 * controller between admission and actual child start, so parallel spawns in
 * the same tick cannot all pass the same active-children count.
 */
const pendingChildAdmissions = new Map<string, Set<string | symbol>>();

type ReservableChildAdmission = { ok: true } | { ok: false };

export type ChildAdmissionReservation<TAdmission extends ReservableChildAdmission> =
  | Extract<TAdmission, { ok: false }>
  | (Extract<TAdmission, { ok: true }> & { release: () => void });

export function reserveChildAdmissionSlot<TAdmission extends ReservableChildAdmission>(
  params: ChildAdmissionReservationParams<TAdmission>,
): ChildAdmissionReservation<TAdmission>;
export function reserveChildAdmissionSlot(
  params: ChildAdmissionReservationParams<ReservableChildAdmission>,
): ChildAdmissionReservation<ReservableChildAdmission> {
  const pending = pendingChildAdmissions.get(params.controllerKey) ?? new Set<string | symbol>();
  const pendingChildKeys = new Set(
    [...pending].filter((key): key is string => typeof key === "string"),
  );
  const admission = params.resolveAdmission(pending.size, pendingChildKeys);
  if (!admission.ok) return admission;

  const reservation = params.childKey ?? Symbol("pending child admission");
  pending.add(reservation);
  pendingChildAdmissions.set(params.controllerKey, pending);
  let released = false;
  return {
    ...admission,
    release() {
      if (released) return;
      released = true;
      pending.delete(reservation);
      if (
        pending.size === 0 &&
        pendingChildAdmissions.get(params.controllerKey) === pending
      ) {
        pendingChildAdmissions.delete(params.controllerKey);
      }
    },
  };
}

type ChildAdmissionReservationParams<TAdmission extends ReservableChildAdmission> = {
  controllerKey: string;
  childKey?: string;
  resolveAdmission: (
    pendingChildren: number,
    pendingChildKeys: ReadonlySet<string>,
  ) => TAdmission;
};

/** 与 resolveChildAdmission 深度拒绝分支同文案：执行侧护栏复用。 */
export function spawnDepthRejectError(callerDepth: number, maxSpawnDepth: number): string {
  return `当前层级不允许再创建成员（嵌套深度已达上限：当前深度 ${callerDepth}，上限 ${maxSpawnDepth}）。`;
}

/** 末端执行者工具面护栏文案：orchestrator 与 tools 层共用，保证报错一致。 */
export const LEAF_SPAWN_REJECT_ERROR = "错误：末端执行者不能再下派成员，请只做分给你的任务并把结果交回";

export function isSpawnDepthAllowed(callerDepth: number, maxSpawnDepth: number): boolean {
  return isSubagentSpawnDepthAllowed(callerDepth, maxSpawnDepth);
}

/** 测试与进程内复位用。 */
export function clearPendingChildAdmissions(): void {
  pendingChildAdmissions.clear();
}
