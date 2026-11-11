/**
 * 执行视图的前端数据层：活动事件由服务端生成并持久化，这里只负责合并与成员摘要。
 * 事件类型与字段定义在 src/room/activity-log.ts，前后端共用同一份契约。
 */
import type { Member } from "../../src/core/types";
import type { ActivityEvent, ActivityKind } from "../../src/room/activity-log";

export type { ActivityEvent, ActivityKind };

export const ACTIVITY_META: Record<ActivityKind, { label: string; tone: string }> = {
  user: { label: "用户", tone: "user" },
  start: { label: "开始", tone: "start" },
  thinking: { label: "思考", tone: "thinking" },
  tool: { label: "工具", tone: "tool" },
  "tool-result": { label: "结果", tone: "result" },
  span: { label: "子调用", tone: "tool" },
  final: { label: "完成", tone: "final" },
  error: { label: "失败", tone: "error" },
  aborted: { label: "中止", tone: "aborted" },
  message: { label: "发言", tone: "message" },
};

export interface RunningView {
  startedAt: number;
  text: string;
  reasoning?: string;
  tools: string[];
}

export interface MemberExecution {
  member: Member;
  status: "running" | "idle" | "error" | "cancelled";
  startedAt?: number;
  currentTool?: string;
  reasoning?: string;
  text: string;
  last?: ActivityEvent;
  counts: { tool: number; message: number; error: number };
  /** 该成员最近的事件（新到旧），给卡片画一条微型活动条。 */
  spark: ActivityEvent[];
}

export const MAX_ACTIVITY_EVENTS = 600;

/** 合并活动事件：按 id 去重、按时间排序、只保留最近 max 条。 */
export function appendActivity(
  current: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
  max = MAX_ACTIVITY_EVENTS,
): ActivityEvent[] {
  if (incoming.length === 0) return current as ActivityEvent[];
  const byId = new Map<string, ActivityEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.at - b.at).slice(-max);
}

/** 成员状态卡：运行中优先用实时 run，其次看成员的最终状态；计数与活动条来自活动流。 */
export function summarizeExecution(
  members: readonly Member[],
  activity: readonly ActivityEvent[],
  runs: Readonly<Record<string, RunningView>>,
  now: number,
): MemberExecution[] {
  void now;
  return members.map((member) => {
    const run = runs[member.id];
    const mine = activity.filter((event) => event.memberId === member.id);
    const counts = {
      tool: mine.filter((event) => event.kind === "tool").length,
      message: mine.filter((event) => event.kind === "message" || event.kind === "final").length,
      error: mine.filter((event) => event.kind === "error").length,
    };
    const status: MemberExecution["status"] = run
      ? "running"
      : member.status === "cancelled"
        ? "cancelled"
        : member.status === "error"
          ? "error"
          : "idle";
    return {
      member,
      status,
      ...(run ? { startedAt: run.startedAt } : {}),
      ...(run?.tools.at(-1) ? { currentTool: run.tools.at(-1) } : {}),
      ...(run?.reasoning ? { reasoning: run.reasoning } : {}),
      text: run?.text ?? "",
      ...(mine.at(-1) ? { last: mine.at(-1) } : {}),
      counts,
      spark: mine.slice(-24),
    };
  });
}
