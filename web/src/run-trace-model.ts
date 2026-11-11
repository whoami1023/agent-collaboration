/**
 * 运行轨迹的数据层：把成员资料、实时运行态与持久活动合成「角色 + 轨迹」。
 *
 * 参考 AgentGUI 的像素角色办公室：形象由角色/技能/简介派生（不绑具体业务），
 * 状态决定动画与气泡文案，轨迹带只展示真实发生过的活动事件。
 */
import type { Member } from "../../src/core/types";
import type { ActivityEvent, RunningView } from "./activity-model";

export type TraceLook = "planner" | "researcher" | "coder" | "writer" | "member";
export type TraceMood = "idle" | "thinking" | "working" | "done" | "error" | "cancelled";

export const TRACE_MOOD_LABEL: Record<TraceMood, string> = {
  idle: "待命",
  thinking: "思考中",
  working: "执行中",
  done: "已交付",
  error: "出错了",
  cancelled: "已取消",
};

export interface TraceActor {
  member: Member;
  look: TraceLook;
  accent: string;
  mood: TraceMood;
  startedAt?: number;
  /** 角色头顶气泡里的短句：当前工具、最近一段推理或最近一条活动。 */
  thought: string;
  trail: ActivityEvent[];
  counts: { tool: number; message: number; error: number };
  lastAt: number;
}

/** 卡通形象库（按成员画像派生，颜色按成员 ID 稳定取色）。 */
export const TRACE_ACCENTS = ["#3e7cb1", "#c1773f", "#5d8a55", "#8368ad", "#b05d70", "#4c8f8b"];

export function traceAccentFor(member: Pick<Member, "id">): string {
  let hash = 0;
  for (const char of member.id) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return TRACE_ACCENTS[Math.abs(hash) % TRACE_ACCENTS.length]!;
}

/**
 * 形象映射：主智能体是「指挥」，子成员按技能/简介里的能力域取最接近的一种，
 * 都没有线索时用通用成员形象；这是内容分类，不是某个业务场景的专用分支。
 */
export function traceLookFor(
  member: Pick<Member, "role" | "name" | "brief" | "skillNames">,
): TraceLook {
  if (member.role === "main") return "planner";
  const hay = `${member.name} ${member.brief ?? ""} ${(member.skillNames ?? []).join(" ")}`;
  if (/(code|coding|program|develop|test|script|sql|python|工程|开发|编程|代码|脚本|测试)/i.test(hay)) {
    return "coder";
  }
  if (/(research|search|browse|调研|研究|检索|搜索|资料|分析)/i.test(hay)) {
    return "researcher";
  }
  if (/(write|writing|doc|report|写作|文档|报告|成文|编辑|排版)/i.test(hay)) {
    return "writer";
  }
  return "member";
}

/** 取最后一句完整表述，避免把整段推理塞进气泡。 */
export function latestClause(text: string, max = 88): string {
  const flat = text
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const parts = flat.split(/(?<=[。！？!?；;])/u).filter((part) => part.trim());
  const last = parts.at(-1) ?? flat;
  return last.length > max ? `…${last.slice(-max)}` : last;
}

function moodAndThought(
  member: Member,
  run: RunningView | undefined,
  last: ActivityEvent | undefined,
): { mood: TraceMood; thought: string } {
  if (run) {
    if (run.text) return { mood: "working", thought: "正在组织交付…" };
    const tool = run.tools.at(-1);
    if (tool) return { mood: "working", thought: `工具 · ${tool}` };
    return {
      mood: "thinking",
      thought: latestClause(run.reasoning ?? "") || "分析下一步…",
    };
  }
  if (member.status === "cancelled") return { mood: "cancelled", thought: "运行已取消" };
  if (member.status === "error") return { mood: "error", thought: "上次运行没有完成" };
  if (last?.kind === "final") {
    return { mood: "done", thought: latestClause(last.detail ?? last.title, 64) || "交付完成" };
  }
  if (last) return { mood: "idle", thought: last.title };
  return { mood: "idle", thought: "待命中" };
}

const MOOD_RANK: Record<TraceMood, number> = {
  working: 0,
  thinking: 1,
  error: 2,
  cancelled: 3,
  done: 4,
  idle: 5,
};

/** 生成角色列表：运行中的排前面，其余按最近活动排序。 */
export function buildTraceActors(
  members: readonly Member[],
  activity: readonly ActivityEvent[],
  runs: Readonly<Record<string, RunningView>>,
  trailLimit = 9,
): TraceActor[] {
  const actors = members.map((member) => {
    const mine = activity.filter((event) => event.memberId === member.id);
    const trail = mine.slice(-trailLimit);
    const last = mine.at(-1);
    const run = runs[member.id];
    const { mood, thought } = moodAndThought(member, run, last);
    return {
      member,
      look: traceLookFor(member),
      accent: traceAccentFor(member),
      mood,
      ...(run ? { startedAt: run.startedAt } : {}),
      thought,
      trail,
      counts: {
        tool: mine.filter((event) => event.kind === "tool").length,
        message: mine.filter((event) => event.kind === "message" || event.kind === "final").length,
        error: mine.filter((event) => event.kind === "error").length,
      },
      lastAt: last?.at ?? 0,
    };
  });
  return actors.sort(
    (a, b) => MOOD_RANK[a.mood] - MOOD_RANK[b.mood] || b.lastAt - a.lastAt,
  );
}
