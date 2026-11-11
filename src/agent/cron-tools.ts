// 定时任务的智能体工具面。结构与 OpenClaw src/agents/tools/cron-tool*.ts 一致：
// 一个 cron 工具 + action 分派 + 按调用方收窄的作用域（列表与计数都只算可见任务，
// 空列表不能证明任务不存在，只能证明不在自己的可见范围里）。
// OpenClaw 的 sessionTarget/delivery/webhook/stream 触发器与 next_check 节奏控制没有本宿主对应物：
// 这里的投递目标是群聊成员，一次运行就是一条无人值守指令，因此不移植。

import { describeSchedule } from "../cron/jobs-scheduling";
import { CRON_LIMITS, CronError } from "../cron/normalize";
import type { CronJobView, CronService } from "../cron/service";
import type { CronAuthorship, CronJob, CronRunRecord } from "../cron/types";
import { CRON_SILENT_REPLY_TOKEN } from "../cron/types";
import type { Member } from "../core/types";
import type { RoomBus } from "../room/bus";
import type { ToolImpl } from "./loop";

export interface CronToolDeps {
  cron: CronService;
  bus: RoomBus;
  member: Member;
  ownerId: string;
}

const CRON_ACTIONS = ["status", "list", "get", "add", "update", "remove", "run", "runs"] as const;

/** 主智能体代表账号管理全部任务；子成员只看得到与自己有关的（自己创建的 / 指名唤醒自己的）。 */
function isCoordinator(member: Member): boolean {
  return member.role !== "sub";
}

function visibleTo(view: CronJobView, member: Member): boolean {
  if (isCoordinator(member)) return true;
  const job = view.job;
  if (job.createdBy?.memberId === member.id) return true;
  return job.payload.kind === "agentTurn" && job.payload.targetMemberId === member.id;
}

/** 读作用域宽，写作用域严：改/删/停只有作者（或主智能体）能做。 */
function writableBy(job: CronJob, member: Member): boolean {
  return isCoordinator(member) || job.createdBy?.memberId === member.id;
}

function formatTime(ts: number | undefined): string {
  if (ts === undefined) return "未排期";
  return new Date(ts).toLocaleString("zh-CN", { hourCycle: "h23" });
}

function renderJob(
  view: CronJobView,
  opts: { detail: boolean; memberNames: Map<string, string> },
): string {
  const { job, state, lastRun } = view;
  const lines = [
    `- ${job.id}「${job.name}」${job.enabled ? "启用" : "停用"}｜${describeSchedule(job.schedule)}`,
  ];
  if (opts.detail) {
    if (job.description) lines.push(`  说明：${job.description}`);
    lines.push(`  内容：${renderPayload(job, opts.memberNames)}`);
    if (job.activeHours) lines.push(`  只在 ${job.activeHours.start}-${job.activeHours.end} 时段内执行`);
    if (job.createdBy) lines.push(`  创建者：@${job.createdBy.memberName}`);
    lines.push(`  下一次：${formatTime(state.nextRunAtMs)}｜上次 ${lastLine(lastRun, state)}`);
    if (state.consecutiveErrors > 0) lines.push(`  连续失败 ${state.consecutiveErrors} 次`);
    if (state.autoDisabled) {
      lines.push(`  已自动停用：${state.autoDisabled.reason === "consecutive-failures" ? "连续失败过多" : "调度表达式连续出错"}`);
    }
  } else {
    lines.push(`  ${renderPayload(job, opts.memberNames)}｜下一次 ${formatTime(state.nextRunAtMs)}`);
  }
  return lines.join("\n");
}

function renderPayload(job: CronJob, memberNames: Map<string, string>): string {
  if (job.payload.kind === "command") {
    return `命令「${job.payload.argv.join(" ")}」${
      job.payload.timeoutSeconds ? `（超时 ${job.payload.timeoutSeconds}s）` : ""
    }`;
  }
  const targetName = job.payload.targetMemberId
    ? memberNames.get(job.payload.targetMemberId)
    : undefined;
  return `指令 → ${targetName ? `@${targetName}` : "主智能体"}：${job.payload.message}`;
}

function lastLine(record: CronRunRecord | undefined, state: CronJobView["state"]): string {
  if (!record && !state.lastRunAtMs) return "从未运行";
  const status = record?.status ?? state.lastRunStatus ?? "unknown";
  const at = record?.endedAt ?? state.lastRunAtMs;
  const error = record?.error ?? state.lastError;
  return `${status === "ok" ? "成功" : status === "skipped" ? "跳过" : "失败"}（${formatTime(at)}）${
    error ? `：${error}` : ""
  }`;
}

function readObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CronError(`${key} 需要是一个对象`);
  }
  return value as Record<string, unknown>;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 把模型写的 target_member / targetMember 成员名换成 id：normalize 只认 targetMemberId。 */
function resolveTargetMember(raw: Record<string, unknown>, bus: RoomBus): Record<string, unknown> {
  const payload = raw.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return raw;
  const input = { ...(payload as Record<string, unknown>) };
  const byName =
    typeof input.target_member === "string"
      ? input.target_member
      : typeof input.targetMember === "string"
        ? input.targetMember
        : "";
  delete input.target_member;
  delete input.targetMember;
  if (!byName.trim()) return { ...raw, payload: input };
  const name = byName.trim().replace(/^@/, "");
  const member = bus.findMemberByName(name);
  if (!member) {
    throw new CronError(`找不到成员 @${name}：target_member 要用群里的成员名，留空则交给主智能体`);
  }
  input.targetMemberId = member.id;
  return { ...raw, payload: input };
}

const SCHEDULE_SCHEMA = {
  type: "object",
  description:
    '调度方式。一次性：{kind:"at",at:"2026-11-04T09:00:00"}；固定间隔：{kind:"every",everyMs:"30m"}；' +
    '墙钟表达式：{kind:"cron",expr:"0 9 * * 1",tz:"Asia/Shanghai"}。',
  properties: {
    kind: { type: "string", enum: ["at", "every", "cron"], description: "调度类型" },
    at: { type: "string", description: 'kind=at：ISO 时间或 epoch 毫秒' },
    everyMs: { type: "string", description: 'kind=every：时长，如 45s / 30m / 2h / 1d，或毫秒数' },
    expr: { type: "string", description: "kind=cron：5 段「分 时 日 月 周」或 6 段带秒" },
    tz: { type: "string", description: "kind=cron：IANA 时区名，如 Asia/Shanghai；缺省按服务器本地时区" },
    staggerMs: { type: "number", description: "可选：整点错峰窗口毫秒，0 表示准点触发" },
  },
  required: ["kind"],
  additionalProperties: true,
};

const PAYLOAD_SCHEMA = {
  type: "object",
  description:
    '任务内容。{kind:"agentTurn",message,target_member?} 到点往群里投一条无人值守指令并唤醒成员执行；' +
    '{kind:"command",argv:["node","script.js"],cwd?,timeoutSeconds?} 在文件工作区直接跑命令，不经 shell。',
  properties: {
    kind: { type: "string", enum: ["agentTurn", "command"], description: "缺省 agentTurn" },
    message: { type: "string", description: "agentTurn：要执行的任务指令，写清楚做到什么程度算完成" },
    target_member: { type: "string", description: "agentTurn：可选，负责执行的成员名（不带 @）；留空交给主智能体" },
    argv: { type: "array", items: { type: "string" }, description: "command：程序与参数数组，第一个是要跑的程序" },
    cwd: { type: "string", description: "command：可选，相对文件工作区的目录" },
    timeoutSeconds: { type: "number", description: "command：可选，0 表示不超时" },
  },
  additionalProperties: true,
};

const JOB_SCHEMA = {
  type: "object",
  description: `任务定义。add 需要 name + schedule + payload；update 只覆盖出现的字段，description/activeHours 传 null 表示清除。`,
  properties: {
    name: { type: "string", description: `任务名，最多 ${CRON_LIMITS.name} 字` },
    description: { type: "string", description: `一句话说明，最多 ${CRON_LIMITS.description} 字` },
    enabled: { type: "boolean", description: "是否启用；传 false 只暂停，不删记录" },
    schedule: SCHEDULE_SCHEMA,
    payload: PAYLOAD_SCHEMA,
    activeHours: {
      type: "object",
      description: '可选执行窗口 {start:"09:00",end:"18:00",timezone?("user"|"local"|IANA)}，终点不含',
      properties: {
        start: { type: "string", description: "HH:MM" },
        end: { type: "string", description: "HH:MM，允许 24:00" },
        timezone: { type: "string", description: "时区：user 跟随账号设置、local 服务器时区，或 IANA 名称" },
      },
      required: ["start", "end"],
      additionalProperties: false,
    },
    deleteAfterRun: { type: "boolean", description: "一次性任务成功后是否删除，缺省 true" },
  },
  additionalProperties: false,
};

export function buildCronTools(deps: CronToolDeps): ToolImpl[] {
  const { cron, bus, member, ownerId } = deps;
  const coordinator = isCoordinator(member);
  const scopeNote = coordinator
    ? `你代表账号管理全部定时任务：列表与计数覆盖整个账号。`
    : `你只能看到与自己有关的定时任务（你创建的，或指名唤醒你的）；只有你创建的任务能改、删、停用。空列表或找不到某个 id 只说明它不在你的可见范围，不能证明它不存在，更不要据此重建一个已知任务。`;

  const memberNames = (): Map<string, string> =>
    new Map(bus.listMembers().map((item) => [item.id, item.name]));

  const authorship = (): CronAuthorship => ({ memberId: member.id, memberName: member.name });

  /** 作用域收窄后的任务视图：列表、计数、查找都走这里，绝不越过可见范围。 */
  const scopedViews = (): CronJobView[] =>
    cron.listJobs(ownerId).filter((view) => visibleTo(view, member));

  const findView = (jobId: string): CronJobView => {
    const view = cron.getJob(ownerId, jobId);
    if (!view) throw new CronError(`找不到定时任务 ${jobId}（不在你的可见范围内，或已被删除）`);
    if (!visibleTo(view, member)) {
      throw new CronError(`定时任务 ${jobId}「${view.job.name}」不在你的管理范围内`);
    }
    return view;
  };

  const assertWritable = (view: CronJobView): CronJob => {
    if (!writableBy(view.job, member)) {
      throw new CronError(
        `定时任务 ${view.job.id}「${view.job.name}」由 @${view.job.createdBy?.memberName ?? "用户"} 创建，只有它本人或主智能体能改`,
      );
    }
    return view.job;
  };

  return [
    {
      // 创建/改期不是幂等的：异常后重跑会排出重复任务。
      retry: "never",
      schema: {
        name: "cron",
        description:
          `给这个工作区安排提醒、延后自唤醒和周期性工作。绝不要用 run_command 里 sleep/轮询来假装定时器。` +
          `\n\n操作：status（概览）| list [include_disabled,limit]（默认只列启用的）| get job_id（完整定义与状态）` +
          `| add job | update job_id + job（局部覆盖，null 清除）| remove job_id（删除，正在跑的那次不重复计账）` +
          `| run job_id（立刻试跑一次，不消耗调度槽位；不等终态，稍后用 runs 查结果）| runs job_id [limit]（历史）。` +
          `\n\n作用域：${scopeNote}` +
          `\n\n调度：{kind:"at",at:"ISO-8601"} 一次性，跑成功默认自动删除；{kind:"every",everyMs:"30m"} 固定间隔` +
          `（最少 ${CRON_LIMITS.minEveryMs / 1000} 秒）；{kind:"cron",expr,tz?} 墙钟表达式，写 tz 时按该时区的墙钟时间，` +
          `不要自己换算成 UTC。周期性重活优先用 cron 表达式定在低峰，避免整点扎堆。` +
          `\n\n内容：{kind:"agentTurn",message,target_member?} 到点把 message 作为无人值守指令投进群并唤醒成员` +
          `（target_member 用群里的成员名，留空给主智能体）；{kind:"command",argv,cwd?,timeoutSeconds?} 在文件工作区直接跑命令，` +
          `argv 不经过 shell。指令要写清交付物与完成标准：定时运行没有人在旁边澄清。` +
          `\n\n静默：无人值守运行的最终回复就是交付物，会落到群里。状态没变化时回复整条只写 ${CRON_SILENT_REPLY_TOKEN} 即可保持安静。` +
          `\n\n失败会自动退避重试，连续失败或调度表达式连续出错会被自动停用；` +
          `每个账号最多 ${CRON_LIMITS.jobsPerUser} 个任务。要暂停但不删记录就用 update job:{enabled:false}。`,
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...CRON_ACTIONS], description: "要做的操作" },
            job_id: {
              type: "string",
              description: "get/update/remove/run/runs 必填：任务 id（add 时不需要）",
            },
            job: JOB_SCHEMA,
            include_disabled: { type: "boolean", description: "list：是否把已停用的记录也算上，默认 false" },
            limit: { type: "number", description: "list/runs 返回条数，默认 20" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        const action = readString(args, "action");
        if (!action || !CRON_ACTIONS.includes(action as (typeof CRON_ACTIONS)[number])) {
          return `错误：action 只能是 ${CRON_ACTIONS.join(" / ")}`;
        }
        const jobId = readString(args, "job_id");
        try {
          switch (action) {
            case "status": {
              const views = scopedViews();
              const account = cron.status(ownerId);
              const enabled = views.filter((view) => view.job.enabled).length;
              const running = views.filter((view) => view.state.runningAtMs).length;
              const next = views
                .map((view) => (view.job.enabled ? view.state.nextRunAtMs : undefined))
                .filter((value): value is number => typeof value === "number")
                .sort((a, b) => a - b)[0];
              return [
                `定时任务：可见 ${views.length} 个（启用 ${enabled}、正在运行 ${running}）；` +
                  `账号整体 ${account.total} 个。`,
                `最近一次排期：${formatTime(next)}`,
                coordinator
                  ? `作用域：整个账号。每个账号最多 ${CRON_LIMITS.jobsPerUser} 个任务。`
                  : `作用域：只看得到与自己相关的任务${
                      account.total > views.length
                        ? `；账号里还有 ${account.total - views.length} 个不在你的可见范围内`
                        : ""
                    }。`,
              ].join("\n");
            }
            case "list": {
              const includeDisabled = args.include_disabled === true;
              const limit = clampLimit(args.limit, 20, 100);
              const views = scopedViews().filter(
                (view) => includeDisabled || view.job.enabled,
              );
              if (views.length === 0) {
                return includeDisabled
                  ? "当前没有你可见的定时任务。空列表只说明可见范围里没有，不代表账号里不存在。"
                  : "当前没有你可见的启用中定时任务（用 include_disabled:true 看已停用的记录）。";
              }
              const page = views.slice(0, limit);
              const names = memberNames();
              return (
                `${page.length === views.length ? "" : `共 ${views.length} 个，列出前 ${page.length} 个：\n`}` +
                page.map((view) => renderJob(view, { detail: false, memberNames: names })).join("\n")
              );
            }
            case "get": {
              if (!jobId) return "错误：get 需要 job_id";
              const view = findView(jobId);
              const names = memberNames();
              const runs = cron.listRuns(ownerId, { jobId, limit: 5 }).entries.map(formatRun);
              return (
                renderJob(view, { detail: true, memberNames: names }) +
                `\n最近运行：\n${runs.join("\n") || "  从未运行"}`
              );
            }
            case "add": {
              const raw = resolveTargetMember(readObject(args, "job"), bus);
              const job = await cron.createJob(ownerId, raw, authorship());
              const state = cron.getJob(ownerId, job.id)?.state;
              return (
                `已创建定时任务 ${job.id}「${job.name}」：${describeSchedule(job.schedule)}` +
                `｜下一次 ${formatTime(state?.nextRunAtMs)}。`
              );
            }
            case "update": {
              if (!jobId) return "错误：update 需要 job_id";
              const view = findView(jobId);
              assertWritable(view);
              const raw = resolveTargetMember(readObject(args, "job"), bus);
              const next = await cron.updateJob(ownerId, jobId, raw);
              const state = cron.getJob(ownerId, jobId)?.state;
              return (
                `已更新定时任务 ${next.id}「${next.name}」${next.enabled ? "" : "（已停用）"}：` +
                `${describeSchedule(next.schedule)}｜下一次 ${formatTime(state?.nextRunAtMs)}。`
              );
            }
            case "remove": {
              if (!jobId) return "错误：remove 需要 job_id";
              const view = findView(jobId);
              assertWritable(view);
              await cron.removeJob(ownerId, jobId);
              return `已删除定时任务 ${jobId}「${view.job.name}」（运行历史仍保留）。`;
            }
            case "run": {
              if (!jobId) return "错误：run 需要 job_id";
              const view = findView(jobId);
              await cron.runNow(ownerId, jobId, { wait: false });
              return (
                `已立刻发起 ${jobId}「${view.job.name}」的一次手动运行，不消耗调度槽位。` +
                `它可能还在跑：稍后用 action:runs, job_id:${jobId} 查看结果，不要为此再建一个校验用的定时任务。`
              );
            }
            case "runs": {
              if (!jobId) return "错误：runs 需要 job_id";
              findView(jobId);
              const page = cron.listRuns(ownerId, { jobId, limit: clampLimit(args.limit, 10, 50) });
              if (page.entries.length === 0) return `定时任务 ${jobId} 还没有运行记录。`;
              return (
                `定时任务 ${jobId} 最近 ${page.entries.length} 次运行（共 ${page.total} 条）：\n` +
                page.entries.map(formatRun).join("\n")
              );
            }
          }
          return "错误：action 未被处理";
        } catch (err) {
          if (err instanceof CronError) return `错误：${err.message}`;
          return `定时任务操作失败：${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(max, Math.max(1, Math.round(raw)))
    : fallback;
}

function formatRun(run: CronRunRecord): string {
  const status =
    run.status === "ok" ? "成功" : run.status === "skipped" ? "跳过" : `失败${run.error ? `：${run.error}` : ""}`;
  return (
    `  ${new Date(run.startedAt).toLocaleString("zh-CN", { hourCycle: "h23" })} ` +
    `${run.trigger === "manual" ? "手动" : run.trigger === "startup" ? "启动补齐" : "定时"}｜${status}` +
    `${run.quiet ? "｜静默" : ""}${run.summary ? `｜${summarise(run.summary)}` : ""}`
  );
}

function summarise(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}
