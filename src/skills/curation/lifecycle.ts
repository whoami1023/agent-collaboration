// 策展的生命周期判断：纯函数，输入「技能清单 + 使用账本 + 当前时间」，输出「该做什么」。
// 完全照 Hermes 的确定性 pass —— 不碰模型、不看语义，只算时间与次数，因此可以当数据来测。
// 可逆且不影响可读性的迁移（标记闲置、重新激活）直接落地；
// 会让技能从所有智能体清单里消失的归档只产出候选，交给服务层按设置决定自动落地还是出提案。

import type { SkillRecord, SkillScope } from "../library";
import {
  CURATION_RULES,
  type SkillLifecycle,
  type SkillLifecycleState,
  type SkillUsageRecord,
} from "./types";

export const DAY_MS = 86_400_000;

const LIFECYCLE_STATES: SkillLifecycleState[] = ["active", "stale", "archived"];

/** 库里的手改/老记录：状态不认识就整位丢掉，按 active 处理，不要把坏值带给智能体。 */
export function normalizeLifecycle(value: unknown): SkillLifecycle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (typeof state !== "string" || !LIFECYCLE_STATES.includes(state as SkillLifecycleState)) {
    return undefined;
  }
  const archivedAt = record.archivedAt;
  const absorbedInto = record.absorbedInto;
  const absorbedIntoId = record.absorbedIntoId;
  return {
    state: state as SkillLifecycleState,
    ...(record.pinned === true ? { pinned: true } : {}),
    ...(typeof archivedAt === "number" && Number.isFinite(archivedAt) && archivedAt > 0
      ? { archivedAt }
      : {}),
    ...(typeof absorbedInto === "string" && absorbedInto.trim() ? { absorbedInto } : {}),
    ...(typeof absorbedIntoId === "string" && absorbedIntoId.trim()
      ? { absorbedIntoId }
      : {}),
  };
}

/** 没有 lifecycle 位的技能一律按 active 处理（老账本与新建技能都是这个默认）。 */
export function lifecycleStateOf(skill: SkillRecord): SkillLifecycleState {
  return skill.lifecycle?.state ?? "active";
}

/**
 * 最近一次活动：用 / 读 / 改与正文最后更新日取最大。
 * 改了正文就算动过手，否则「上周刚修订、上个月没用过」的技能会被判成两个月没活动。
 * 刻意不含「什么时候建的」——新建后没人用过的技能不该因为放着多久就被判死。
 */
export function lastActivityAtOf(
  skill: SkillRecord,
  usage: SkillUsageRecord | undefined,
): number {
  const stamps = [usage?.lastUsedAt, usage?.lastViewedAt, usage?.lastPatchedAt, skill.updatedAt];
  let newest = 0;
  for (const at of stamps) if (typeof at === "number" && at > newest) newest = at;
  return newest > 0 ? newest : skill.createdAt;
}

/** 距最近活动多少天（向下取整；未来时间戳按 0 天算，防止时钟漂移误判）。 */
export function idleDaysOf(skill: SkillRecord, usage: SkillUsageRecord | undefined, now: number): number {
  const elapsed = now - lastActivityAtOf(skill, usage);
  return elapsed > 0 ? Math.floor(elapsed / DAY_MS) : 0;
}

export interface LifecycleAction {
  skillId: string;
  skillName: string;
  scope: SkillScope;
  ownerId: string | null;
  from: SkillLifecycleState;
  to: SkillLifecycleState;
  /** 从没被 use_skill 命中过：零使用是证据缺失，只能标记闲置，永不提议归档。 */
  neverUsed: boolean;
  useCount: number;
  idleDays: number;
  lastActivityAt: number;
}

export interface LifecyclePlan {
  /** 直接落地的迁移：active→stale 的闲置标记，和 stale→active 的重新激活。 */
  transitions: LifecycleAction[];
  /** 需要批准的归档候选（跨过归档阈值且确实被用过）。 */
  archiveCandidates: LifecycleAction[];
}

export interface LifecycleInput {
  now: number;
  skills: readonly SkillRecord[];
  usage: ReadonlyMap<string, SkillUsageRecord>;
  staleAfterDays?: number;
  archiveAfterDays?: number;
}

/**
 * 一条技能要不要动，只看四件事：
 * 1. 内置技能与固定（pinned）技能永不参与；已归档的是终态，只能人工恢复；
 * 2. 「改过之后又被用过」（reuseAfterPatch）是 Hermes 唯一认的效能信号 —— 闲置的技能只要它成立就立刻回到 active；
 * 3. 跨过闲置阈值就标记闲置，回到窗口内就复活；
 * 4. 只有真正被用过、且跨过归档阈值的技能才进归档候选。
 */
export function planLifecycle(input: LifecycleInput): LifecyclePlan {
  const staleDays = Math.max(1, Math.floor(input.staleAfterDays ?? CURATION_RULES.staleAfterDays));
  const archiveDays = Math.max(
    input.archiveAfterDays ?? CURATION_RULES.archiveAfterDays,
    staleDays + 1,
  );

  const transitions: LifecycleAction[] = [];
  const archiveCandidates: LifecycleAction[] = [];

  for (const skill of input.skills) {
    if (skill.builtin || skill.lifecycle?.pinned) continue;
    const from = lifecycleStateOf(skill);
    if (from === "archived") continue;

    const usage = input.usage.get(skill.id);
    const useCount = usage?.useCount ?? 0;
    const lastActivityAt = lastActivityAtOf(skill, usage);
    const idleDays = idleDaysOf(skill, usage, input.now);
    const effectiveAgain = usage?.reuseAfterPatch === true;

    if (from === "stale" && (idleDays < staleDays || effectiveAgain)) {
      transitions.push(action(skill, "stale", "active", useCount, idleDays, lastActivityAt));
      continue;
    }

    if (from === "active" && idleDays >= staleDays && !effectiveAgain) {
      transitions.push(action(skill, "active", "stale", useCount, idleDays, lastActivityAt));
    }

    if (useCount > 0 && idleDays >= archiveDays) {
      archiveCandidates.push(action(skill, from, "archived", useCount, idleDays, lastActivityAt));
    }
  }

  return { transitions, archiveCandidates };
}

function action(
  skill: SkillRecord,
  from: SkillLifecycleState,
  to: SkillLifecycleState,
  useCount: number,
  idleDays: number,
  lastActivityAt: number,
): LifecycleAction {
  return {
    skillId: skill.id,
    skillName: skill.name,
    scope: skill.scope,
    ownerId: skill.ownerId,
    from,
    to,
    neverUsed: useCount === 0,
    useCount,
    idleDays,
    lastActivityAt,
  };
}
