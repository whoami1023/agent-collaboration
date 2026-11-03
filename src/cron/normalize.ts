// 定时任务的输入校验与归一：把面板/工具传进来的松散 JSON 收成可持久化的定义。
// 错误口径与本项目的 SkillError/TemplateError 一致——带 HTTP status，由全局中间件映射。

import { assertCronActiveHours } from "./active-hours";
import { isValidCronExpression } from "./schedule";
import { parseAbsoluteTimeMs } from "./time";
import {
  type CronActiveHours,
  type CronJob,
  type CronPayload,
  type CronSchedule,
} from "./types";
import { parseNonNegativeInt } from "./util";

export class CronError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CronError";
  }
}

export const CRON_LIMITS = {
  name: 40,
  description: 160,
  message: 2000,
  argvItems: 16,
  argvItem: 400,
  jobsPerUser: 50,
  minEveryMs: 10_000,
  maxEveryMs: 100 * 365 * 86_400_000,
  maxCommandTimeoutSeconds: 3600,
};

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 单位省略即毫秒（OpenClaw parse-duration 的 defaultUnit: "ms"）：面板传来的一律是毫秒数。 */
function parseDurationToken(value: string, unit: string): number | undefined {
  const multiplier = DURATION_UNIT_MS[unit];
  if (multiplier === undefined || value.length + unit.length > 100) return undefined;
  const parsed = Number(value) * multiplier;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function roundSafeDurationMs(ms: number): number | undefined {
  const rounded = Math.round(ms);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

/** "45s" / "30m" / "2h" / "1d" / "500ms" / "1h30m" / 纯数字毫秒 → 毫秒；不合法返回 undefined。 */
export function parseDurationMs(raw: unknown): number | undefined {
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const text = String(raw).trim().toLowerCase();
  if (!text) return undefined;

  const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text);
  if (single) {
    const token = parseDurationToken(single[1] ?? "", single[2] ?? "ms");
    return token === undefined ? undefined : roundSafeDurationMs(token);
  }

  // 复合写法（1h30m、2m500ms）：每段都要带单位，并且连续覆盖整个输入。
  const composite = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let totalMs = 0;
  let consumed = 0;
  let segments = 0;
  for (const match of text.matchAll(composite)) {
    const [full, valueRaw, unitRaw] = match;
    const index = match.index ?? -1;
    if (!full || !valueRaw || !unitRaw || index !== consumed) return undefined;
    const token = parseDurationToken(valueRaw, unitRaw);
    if (token === undefined) return undefined;
    totalMs += token;
    consumed += full.length;
    segments += 1;
  }
  if (segments === 0 || consumed !== text.length) return undefined;
  return roundSafeDurationMs(totalMs);
}

function textField(value: unknown, key: keyof typeof CRON_LIMITS, label: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const max = CRON_LIMITS[key];
  if (!raw) throw new CronError(`${label}不能为空`);
  if (raw.length > max) throw new CronError(`${label}最多 ${max} 字`);
  return raw;
}

function normalizeSchedule(raw: unknown): CronSchedule {
  if (!raw || typeof raw !== "object") throw new CronError("缺少调度方式 schedule");
  const input = raw as Record<string, unknown>;
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";

  if (kind === "at") {
    const at = typeof input.at === "string" ? input.at.trim() : String(input.at ?? "").trim();
    if (!at) throw new CronError("一次性任务需要具体时间 at");
    if (parseAbsoluteTimeMs(at) === null) {
      throw new CronError("at 需要是 epoch 毫秒或 ISO 时间（如 2026-11-03T09:00:00）");
    }
    return { kind: "at", at };
  }

  if (kind === "every") {
    const everyMs = parseDurationMs(input.everyMs ?? input.every);
    if (everyMs === undefined) {
      throw new CronError("everyMs 需要是毫秒数或 45s / 30m / 2h / 1h30m 这样的时长");
    }
    if (everyMs < CRON_LIMITS.minEveryMs) {
      throw new CronError(`固定间隔最少 ${CRON_LIMITS.minEveryMs / 1000} 秒`);
    }
    if (everyMs > CRON_LIMITS.maxEveryMs) throw new CronError("固定间隔超过一年了，请改用 cron 表达式");
    const schedule: Extract<CronSchedule, { kind: "every" }> = { kind: "every", everyMs };
    const anchor = parseNonNegativeInt(input.anchorMs);
    if (anchor !== undefined) schedule.anchorMs = anchor;
    return schedule;
  }

  if (kind === "cron") {
    const expr = typeof input.expr === "string" ? input.expr.trim() : "";
    if (!expr) throw new CronError("cron 调度需要 expr 表达式");
    const tz = typeof input.tz === "string" && input.tz.trim() ? input.tz.trim() : undefined;
    if (tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
      } catch {
        throw new CronError("时区名不合法，请使用 IANA 名称（如 Asia/Shanghai）");
      }
    }
    if (!isValidCronExpression(expr, tz)) {
      throw new CronError(`cron 表达式无法解析：${expr}（需要 5 段「分 时 日 月 周」或 6 段带秒）`);
    }
    const schedule: Extract<CronSchedule, { kind: "cron" }> = { kind: "cron", expr };
    if (tz) schedule.tz = tz;
    if (input.staggerMs !== undefined) {
      const stagger = parseNonNegativeInt(input.staggerMs);
      if (stagger === undefined) throw new CronError("staggerMs 需要是非负整数毫秒");
      schedule.staggerMs = stagger;
    }
    return schedule;
  }

  throw new CronError('schedule.kind 只能是 "at" / "every" / "cron"');
}

function normalizePayload(raw: unknown): CronPayload {
  if (!raw || typeof raw !== "object") throw new CronError("缺少任务内容 payload");
  const input = raw as Record<string, unknown>;
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";

  if (kind === "command") {
    const rawArgv = Array.isArray(input.argv) ? input.argv : [];
    if (rawArgv.length === 0) throw new CronError("命令任务需要 argv（第一个是要跑的程序）");
    if (rawArgv.length > CRON_LIMITS.argvItems) {
      throw new CronError(`argv 最多 ${CRON_LIMITS.argvItems} 项`);
    }
    const argv = rawArgv.map((item) => {
      const text = typeof item === "string" ? item : String(item ?? "");
      if (text.length > CRON_LIMITS.argvItem) {
        throw new CronError(`argv 单个参数最多 ${CRON_LIMITS.argvItem} 字`);
      }
      return text;
    });
    if (argv.some((item) => item.length === 0)) throw new CronError("argv 参数不能为空字符串");
    const payload: Extract<CronPayload, { kind: "command" }> = { kind: "command", argv };
    if (input.timeoutSeconds !== undefined) {
      const timeout = parseNonNegativeInt(input.timeoutSeconds);
      if (timeout === undefined || timeout > CRON_LIMITS.maxCommandTimeoutSeconds) {
        throw new CronError(`timeoutSeconds 需要在 0 ~ ${CRON_LIMITS.maxCommandTimeoutSeconds} 之间（0 表示不超时）`);
      }
      payload.timeoutSeconds = timeout;
    }
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (cwd) payload.cwd = cwd;
    return payload;
  }

  if (kind === "agentTurn" || kind === "") {
    const message = textField(input.message, "message", "任务指令");
    const payload: Extract<CronPayload, { kind: "agentTurn" }> = { kind: "agentTurn", message };
    const target = typeof input.targetMemberId === "string" ? input.targetMemberId.trim() : "";
    if (target) payload.targetMemberId = target;
    return payload;
  }

  throw new CronError('payload.kind 只能是 "agentTurn" / "command"');
}

function normalizeActiveHours(raw: unknown): CronActiveHours | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "object") throw new CronError("activeHours 需要是对象");
  const input = raw as Record<string, unknown>;
  const start = typeof input.start === "string" ? input.start.trim() : "";
  const end = typeof input.end === "string" ? input.end.trim() : "";
  if (!start || !end) throw new CronError("activeHours 需要同时给出 start 和 end");
  const active: CronActiveHours = { start, end };
  const timezone = typeof input.timezone === "string" ? input.timezone.trim() : "";
  if (timezone) active.timezone = timezone;
  try {
    assertCronActiveHours(active);
  } catch (err) {
    throw new CronError(err instanceof Error ? err.message : String(err));
  }
  return active;
}

export interface NormalizedCronInput {
  name: string;
  description?: string;
  schedule: CronSchedule;
  payload: CronPayload;
  activeHours?: CronActiveHours;
  enabled: boolean;
  deleteAfterRun?: boolean;
}

/** 创建与编辑共用：一次把整个定义收干净，任何一项不合法就整条拒绝。 */
export function normalizeCronInput(raw: Record<string, unknown>): NormalizedCronInput {
  const name = textField(raw.name, "name", "任务名");
  const result: NormalizedCronInput = {
    name,
    schedule: normalizeSchedule(raw.schedule),
    payload: normalizePayload(raw.payload),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
  };
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description) {
    if (description.length > CRON_LIMITS.description) {
      throw new CronError(`说明最多 ${CRON_LIMITS.description} 字`);
    }
    result.description = description;
  }
  const activeHours = normalizeActiveHours(raw.activeHours);
  if (activeHours) result.activeHours = activeHours;
  if (raw.deleteAfterRun !== undefined) result.deleteAfterRun = raw.deleteAfterRun === true;
  return result;
}

/** 编辑补丁：只覆盖请求里出现的字段，未出现的沿用原值。 */
/** 一次编辑的基线：合并补丁只看得到定义部分，所以 CronJob（多带 id 与时间戳）和上一轮的规范化结果都能进来。 */
export function mergeCronDefinition(
  current: NormalizedCronInput,
  raw: Record<string, unknown>,
): NormalizedCronInput {
  const base: NormalizedCronInput = {
    name: current.name,
    description: current.description,
    schedule: current.schedule,
    payload: current.payload,
    activeHours: current.activeHours,
    enabled: current.enabled,
    deleteAfterRun: current.deleteAfterRun,
  };
  if (raw.name !== undefined) base.name = textField(raw.name, "name", "任务名");
  if (raw.description !== undefined) {
    const text = typeof raw.description === "string" ? raw.description.trim() : "";
    if (text.length > CRON_LIMITS.description) {
      throw new CronError(`说明最多 ${CRON_LIMITS.description} 字`);
    }
    base.description = text || undefined;
  }
  if (raw.schedule !== undefined) base.schedule = normalizeSchedule(raw.schedule);
  if (raw.payload !== undefined) base.payload = normalizePayload(raw.payload);
  if (raw.activeHours !== undefined) base.activeHours = normalizeActiveHours(raw.activeHours);
  if (raw.enabled !== undefined) base.enabled = raw.enabled === true;
  if (raw.deleteAfterRun !== undefined) base.deleteAfterRun = raw.deleteAfterRun === true;
  return base;
}

/** 调度或任务内容变了就要清掉触发状态，OpenClaw 的「编辑换触发器就重置」规则。
 *  只比较触发条件本身，所以定义（CronJob）和规范化后的补丁都能进来。 */
export function triggerChanged(
  before: Pick<CronJob, "schedule" | "payload" | "activeHours">,
  after: Pick<CronJob, "schedule" | "payload" | "activeHours">,
): boolean {
  return (
    JSON.stringify(before.schedule) !== JSON.stringify(after.schedule) ||
    JSON.stringify(before.payload) !== JSON.stringify(after.payload) ||
    JSON.stringify(before.activeHours ?? null) !== JSON.stringify(after.activeHours ?? null)
  );
}
