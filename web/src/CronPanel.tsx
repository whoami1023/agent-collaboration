import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Member } from "../../src/core/types";
import type {
  CronActiveHours,
  CronJob,
  CronPayload,
  CronRunRecord,
  CronSchedule,
} from "../../src/cron/types";
import {
  createCron,
  deleteCron,
  fetchCronRuns,
  fetchCrons,
  runCronNow,
  setCronEnabled,
  updateCron,
  type CronInput,
  type CronJobView,
  type CronRunPage,
  type CronSnapshot,
} from "./api";
import { Icon } from "./icons";

type CronMode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; job: CronJob }
  | { kind: "runs"; job: CronJob | null };

type ScheduleKind = "at" | "every" | "cron";
type PayloadKind = "agentTurn" | "command";
type EveryUnit = "m" | "h" | "d";

interface CronForm {
  name: string;
  description: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  /** datetime-local 的原生值（墙上时间），提交时换算成绝对时刻。 */
  atLocal: string;
  everyValue: string;
  everyUnit: EveryUnit;
  expr: string;
  tz: string;
  payloadKind: PayloadKind;
  message: string;
  targetMemberId: string;
  argvText: string;
  commandTimeout: string;
  useActiveHours: boolean;
  activeStart: string;
  activeEnd: string;
  deleteAfterRun: boolean;
}

const DEFAULT_FORM: CronForm = {
  name: "",
  description: "",
  enabled: true,
  scheduleKind: "at",
  atLocal: "",
  everyValue: "30",
  everyUnit: "m",
  expr: "0 9 * * 1-5",
  tz: "",
  payloadKind: "agentTurn",
  message: "",
  targetMemberId: "",
  argvText: "",
  commandTimeout: "",
  useActiveHours: false,
  activeStart: "09:00",
  activeEnd: "18:00",
  deleteAfterRun: true,
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function formatInstant(ts: number | undefined): string {
  if (ts === undefined) return "未排期";
  const date = new Date(ts);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** 调度方式的人话摘要：与后端 describeSchedule 同源口径，但不把 croner 拖进前端包。 */
function describeSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "at") return `一次性 ${formatInstant(new Date(schedule.at).getTime())}`;
  if (schedule.kind === "every") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes < 60) return `每 ${minutes} 分钟`;
    if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
    return `每 ${Math.round(minutes / 60 * 10) / 10} 小时`;
  }
  return `cron ${schedule.expr}${schedule.tz ? `（${schedule.tz}）` : ""}`;
}

function describePayload(job: CronJob, memberName: (id: string) => string): string {
  if (job.payload.kind === "command") return `命令 ${job.payload.argv.join(" ")}`;
  const target = job.payload.targetMemberId
    ? `@${memberName(job.payload.targetMemberId)}`
    : "主智能体";
  return `指令 → ${target}：${job.payload.message}`;
}

function statusOf(run: CronRunRecord | undefined): { label: string; tone: string } {
  if (!run) return { label: "从未运行", tone: "muted" };
  if (run.status === "ok") return { label: "上次成功", tone: "ok" };
  if (run.status === "skipped") return { label: "上次跳过", tone: "muted" };
  return { label: "上次失败", tone: "danger" };
}

function formFromJob(job: CronJob, members: Member[]): CronForm {
  const schedule = job.schedule;
  const payload = job.payload;
  const storedTarget = payload.kind === "agentTurn" ? payload.targetMemberId ?? "" : "";
  const targetMember = members.find((member) => member.id === storedTarget);
  return {
    ...DEFAULT_FORM,
    name: job.name,
    description: job.description ?? "",
    enabled: job.enabled,
    scheduleKind: schedule.kind,
    atLocal: schedule.kind === "at" ? toLocalInputValue(new Date(schedule.at)) : "",
    everyValue:
      schedule.kind === "every" ? String(Math.round(schedule.everyMs / unitMs("m"))) : DEFAULT_FORM.everyValue,
    everyUnit:
      schedule.kind === "every"
        ? schedule.everyMs % unitMs("d") === 0
          ? "d"
          : schedule.everyMs % unitMs("h") === 0
            ? "h"
            : "m"
        : "m",
    expr: schedule.kind === "cron" ? schedule.expr : DEFAULT_FORM.expr,
    tz: schedule.kind === "cron" ? schedule.tz ?? "" : "",
    payloadKind: payload.kind,
    message: payload.kind === "agentTurn" ? payload.message : "",
    targetMemberId: targetMember && targetMember.role !== "main" ? storedTarget : "",
    argvText: payload.kind === "command" ? payload.argv.join("\n") : "",
    commandTimeout:
      payload.kind === "command" && payload.timeoutSeconds !== undefined
        ? String(payload.timeoutSeconds)
        : "",
    useActiveHours: Boolean(job.activeHours),
    activeStart: job.activeHours?.start ?? "09:00",
    activeEnd: job.activeHours?.end ?? "18:00",
    deleteAfterRun: job.deleteAfterRun !== false,
  };
}

function unitMs(unit: EveryUnit): number {
  return unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
}

function buildSchedule(form: CronForm): CronSchedule | string {
  if (form.scheduleKind === "at") {
    const raw = form.atLocal.trim();
    if (!raw) return "请选择一次性任务的时间";
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) return "时间格式不正确";
    if (ms <= Date.now()) return "这个时间已经过去了，请选一个未来的时刻";
    return { kind: "at", at: new Date(ms).toISOString() };
  }
  if (form.scheduleKind === "every") {
    const value = Number(form.everyValue);
    if (!Number.isFinite(value) || value <= 0) return "固定间隔要填一个正数";
    return { kind: "every", everyMs: Math.round(value * unitMs(form.everyUnit)) };
  }
  const expr = form.expr.trim();
  if (!expr) return "请填写 cron 表达式";
  return { kind: "cron", expr, ...(form.tz.trim() ? { tz: form.tz.trim() } : {}) };
}

function buildPayload(form: CronForm): CronPayload | string {
  if (form.payloadKind === "command") {
    const argv = form.argvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (argv.length === 0) return "命令任务要填可执行程序与参数（每行一项）";
    const timeout = form.commandTimeout.trim() ? Number(form.commandTimeout) : undefined;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
      return "超时秒数要填 0 或正数（0 表示不超时）";
    }
    return {
      kind: "command",
      argv,
      ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    };
  }
  const message = form.message.trim();
  if (!message) return "请填写到点要执行的指令";
  return {
    kind: "agentTurn",
    message,
    ...(form.targetMemberId ? { targetMemberId: form.targetMemberId } : {}),
  };
}

function buildActiveHours(form: CronForm): CronActiveHours | null {
  if (!form.useActiveHours) return null;
  return { start: form.activeStart, end: form.activeEnd };
}

export default function CronPanel({
  onClose,
  members,
  refreshToken = 0,
}: {
  onClose: () => void;
  members: Member[];
  /** 群聊里收到 cron-* 事件时自增：面板重拉一次，定义、排期与最近结果都是服务端真相。 */
  refreshToken?: number;
}) {
  const [snapshot, setSnapshot] = useState<CronSnapshot | null>(null);
  const [mode, setMode] = useState<CronMode>({ kind: "list" });
  const [form, setForm] = useState<CronForm>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRunPage | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchCrons());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (refreshToken > 0) void refresh();
  }, [refreshToken, refresh]);

  useEffect(() => {
    if (mode.kind !== "runs") {
      setRuns(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchCronRuns({
          ...(mode.job ? { jobId: mode.job.id } : {}),
          limit: 50,
        });
        if (!cancelled) setRuns(page);
      } catch (err) {
        if (!cancelled) setError(messageOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, snapshot]);

  const memberName = useCallback(
    (id: string) => members.find((member) => member.id === id)?.name ?? "已移除成员",
    [members],
  );

  const jobs = snapshot?.jobs ?? [];
  const status = snapshot?.status;
  const limits = snapshot?.limits;

  const editing = mode.kind === "edit" ? mode.job : null;
  const inEditor = mode.kind === "create" || mode.kind === "edit";

  const patchForm = (patch: Partial<CronForm>) => setForm((current) => ({ ...current, ...patch }));

  function openCreate() {
    setForm({ ...DEFAULT_FORM, atLocal: toLocalInputValue(new Date(Date.now() + 3_600_000)) });
    setError(null);
    setNotice(null);
    setMode({ kind: "create" });
  }

  function openEdit(job: CronJob) {
    setForm(formFromJob(job, members));
    setError(null);
    setNotice(null);
    setMode({ kind: "edit", job });
  }

  function backToList() {
    setMode({ kind: "list" });
    setError(null);
    setConfirmingId(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const schedule = buildSchedule(form);
    if (typeof schedule === "string") {
      setError(schedule);
      return;
    }
    const payload = buildPayload(form);
    if (typeof payload === "string") {
      setError(payload);
      return;
    }
    if (!form.name.trim()) {
      setError("请填写任务名");
      return;
    }
    const input: CronInput = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      enabled: form.enabled,
      schedule,
      payload,
      activeHours: buildActiveHours(form),
      ...(form.scheduleKind === "at" ? { deleteAfterRun: form.deleteAfterRun } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const view =
        mode.kind === "edit" ? await updateCron(mode.job.id, input) : await createCron(input);
      setNotice(
        `${mode.kind === "edit" ? "已更新" : "已创建"}定时任务「${view.job.name}」，下一次 ${formatInstant(
          view.state.nextRunAtMs,
        )}`,
      );
      await refresh();
      setMode({ kind: "list" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(job: CronJob, enabled: boolean) {
    setError(null);
    try {
      await setCronEnabled(job.id, enabled);
      setNotice(`定时任务「${job.name}」已${enabled ? "启用" : "停用"}`);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleRun(job: CronJob) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await runCronNow(job.id, { wait: false });
      setNotice(
        run
          ? `「${job.name}」手动运行${run.status === "ok" ? "完成" : `结束：${run.error ?? run.status}`}`
          : `已发起「${job.name}」的手动运行，结果稍后出现在运行记录里`,
      );
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(job: CronJob) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCron(job.id);
      setNotice(`已删除定时任务「${job.name}」`);
      setConfirmingId(null);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const quickPresets = useMemo(
    () => [
      { label: "10 分钟后", date: new Date(Date.now() + 10 * 60_000) },
      { label: "1 小时后", date: new Date(Date.now() + 3_600_000) },
      {
        label: "明天 9:00",
        date: (() => {
          const date = new Date();
          date.setDate(date.getDate() + 1);
          date.setHours(9, 0, 0, 0);
          return date;
        })(),
      },
      {
        label: "下周一 9:00",
        date: (() => {
          const date = new Date();
          const daysToNextMonday = ((8 - date.getDay()) % 7) || 7;
          date.setDate(date.getDate() + daysToNextMonday);
          date.setHours(9, 0, 0, 0);
          return date;
        })(),
      },
    ],
    // 预设只在进入编辑器时算一次，避免每次渲染都刷新相对时间。
    [mode.kind],
  );

  return (
    <div className="board-sheet skills-sheet cron-sheet">
      <div className="board-head">
        <span className="section-label">定时任务</span>
        <div className="board-head-actions">
          <span className="chip">{jobs.length}</span>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="刷新定时任务"
            title="刷新定时任务"
            onClick={() => void refresh()}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭定时任务面板"
            title="关闭面板，回到作战室"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="board-body skills-body">
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="form-note">{notice}</p>}

        {mode.kind === "list" && (
          <>
            <div className="skills-toolbar">
              <div className="skills-tabs" role="tablist" aria-label="定时任务视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected
                  className="skills-tab active"
                >
                  任务
                  <span className="chip">{jobs.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  className="skills-tab"
                  onClick={() => setMode({ kind: "runs", job: null })}
                >
                  运行记录
                </button>
              </div>
              <div className="skills-toolbar-actions">
                <button type="button" className="btn primary sm" onClick={openCreate}>
                  <Icon name="plus" />
                  新建任务
                </button>
              </div>
            </div>

            {status && (
              <p className="hint">
                启用 {status.enabled} / {status.total} 个，正在运行 {status.running} 个；
                最近一次排期 {formatInstant(status.nextRunAtMs)}。每个账号最多 {limits?.jobsPerUser ?? 50} 个任务。
                智能体也能用 cron 工具自行安排提醒与周期性工作。
              </p>
            )}

            {jobs.length === 0 ? (
              <div className="skills-empty">
                <p className="empty small">
                  还没有定时任务。点「新建任务」安排一次提醒，或让智能体把周期性工作交给调度。
                </p>
              </div>
            ) : (
              <ul className="cron-list">
                {jobs.map((view: CronJobView) => {
                  const job = view.job;
                  const state = statusOf(view.lastRun);
                  return (
                    <li key={job.id} className={`cron-card${job.enabled ? "" : " is-paused"}`}>
                      <div className="cron-card-head">
                        <strong className="cron-name">{job.name}</strong>
                        <span className={`cron-badge ${job.enabled ? "on" : "off"}`}>
                          {job.enabled ? "启用" : "停用"}
                        </span>
                        <span className={`cron-state ${state.tone}`}>{state.label}</span>
                        {view.state.autoDisabled && (
                          <span className="cron-state danger">已自动停用</span>
                        )}
                      </div>
                      {job.description && <p className="cron-desc">{job.description}</p>}
                      <p className="cron-meta">
                        {describeSchedule(job.schedule)}｜下一次 {formatInstant(view.state.nextRunAtMs)}
                        {job.activeHours ? `｜只在 ${job.activeHours.start}-${job.activeHours.end}` : ""}
                        {job.createdBy ? `｜由 @${job.createdBy.memberName} 创建` : ""}
                      </p>
                      <p className="cron-payload">{describePayload(job, memberName)}</p>
                      {view.lastRun?.summary && (
                        <p className="cron-last-summary">
                          上次结果：{view.lastRun.summary.slice(0, 160)}
                          {view.lastRun.summary.length > 160 ? "…" : ""}
                        </p>
                      )}
                      <div className="cron-actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={() => void toggleEnabled(job, !job.enabled)}
                        >
                          {job.enabled ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={busy}
                          onClick={() => void handleRun(job)}
                        >
                          立即运行
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setMode({ kind: "runs", job })}
                        >
                          运行记录
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => openEdit(job)}>
                          编辑
                        </button>
                        {confirmingId === job.id ? (
                          <span className="cron-confirm">
                            确认删除？
                            <button
                              type="button"
                              className="btn danger sm"
                              disabled={busy}
                              onClick={() => void handleDelete(job)}
                            >
                              删除
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              onClick={() => setConfirmingId(null)}
                            >
                              取消
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => setConfirmingId(job.id)}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {mode.kind === "runs" && (
          <>
            <div className="skill-detail-head">
              <button type="button" className="btn ghost sm" onClick={backToList}>
                ← 返回列表
              </button>
              <span className="template-name">
                {mode.job ? `「${mode.job.name}」的运行记录` : "全部运行记录"}
              </span>
              {runs && <span className="chip">{runs.total}</span>}
            </div>
            {!runs ? (
              <p className="empty small">正在读取运行记录…</p>
            ) : runs.entries.length === 0 ? (
              <p className="empty small">还没有运行记录。任务到点执行后，这里会留下每次的结果。</p>
            ) : (
              <ul className="cron-runs">
                {runs.entries.map((run) => (
                  <li key={run.id} className={`cron-run ${run.status}`}>
                    <div className="cron-run-head">
                      <strong>{run.jobName}</strong>
                      <span className={`cron-badge ${run.status}`}>
                        {run.status === "ok" ? "成功" : run.status === "skipped" ? "跳过" : "失败"}
                      </span>
                      <span className="cron-state muted">
                        {run.trigger === "manual"
                          ? "手动"
                          : run.trigger === "startup"
                            ? "启动补齐"
                            : "定时"}
                        {run.quiet ? "·静默" : ""}
                      </span>
                      <span className="cron-state muted">{formatInstant(run.startedAt)}</span>
                      <span className="cron-state muted">{Math.round(run.durationMs / 1000)}s</span>
                    </div>
                    {run.error && <p className="cron-run-error">{run.error}</p>}
                    {run.summary && <p className="cron-run-summary">{run.summary}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {inEditor && (
          <form className="cron-form" onSubmit={(event) => void handleSubmit(event)}>
            <div className="skill-form-head">
              <button type="button" className="btn ghost sm" onClick={backToList}>
                <Icon name="back" />
                返回列表
              </button>
              <span className="skill-form-title">
                {editing ? `编辑「${editing.name}」` : "新建定时任务"}
              </span>
            </div>

            <label className="field">
              <span>任务名</span>
              <input
                value={form.name}
                maxLength={limits?.name ?? 40}
                placeholder="例如：每周一早上巡检部署"
                onChange={(event) => patchForm({ name: event.target.value })}
                autoFocus
              />
            </label>
            <label className="field">
              <span>说明（可选）</span>
              <input
                value={form.description}
                maxLength={limits?.description ?? 160}
                placeholder="面板上显示的一句话"
                onChange={(event) => patchForm({ description: event.target.value })}
              />
            </label>

            <div className="field">
              <span>什么时候跑</span>
              <div className="cron-choice">
                {(["at", "every", "cron"] as ScheduleKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`skill-cat${form.scheduleKind === kind ? " active" : ""}`}
                    aria-pressed={form.scheduleKind === kind}
                    onClick={() => patchForm({ scheduleKind: kind })}
                  >
                    {kind === "at" ? "指定时刻" : kind === "every" ? "固定间隔" : "墙钟表达式"}
                  </button>
                ))}
              </div>
            </div>

            {form.scheduleKind === "at" && (
              <div className="cron-subfield">
                <label className="field">
                  <span>执行时间（本地时区）</span>
                  <input
                    type="datetime-local"
                    value={form.atLocal}
                    onChange={(event) => patchForm({ atLocal: event.target.value })}
                  />
                </label>
                <div className="cron-choice">
                  {quickPresets.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="skill-cat"
                      onClick={() => patchForm({ atLocal: toLocalInputValue(preset.date) })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <p className="hint">时间按这台电脑的时区理解，保存时会换算成绝对时刻。</p>
                <label className="cron-check">
                  <input
                    type="checkbox"
                    checked={form.deleteAfterRun}
                    onChange={(event) => patchForm({ deleteAfterRun: event.target.checked })}
                  />
                  <span>跑成功后自动删除这条任务</span>
                </label>
              </div>
            )}

            {form.scheduleKind === "every" && (
              <div className="cron-subfield">
                <label className="field inline">
                  <span>每隔</span>
                  <input
                    value={form.everyValue}
                    inputMode="numeric"
                    onChange={(event) => patchForm({ everyValue: event.target.value })}
                  />
                  <select
                    value={form.everyUnit}
                    onChange={(event) => patchForm({ everyUnit: event.target.value as EveryUnit })}
                  >
                    <option value="m">分钟</option>
                    <option value="h">小时</option>
                    <option value="d">天</option>
                  </select>
                </label>
                <p className="hint">
                  最短间隔 {Math.max(1, Math.round((limits?.minEveryMs ?? 10_000) / 1000))} 秒；
                  固定间隔从创建时刻起算，服务重启后会补齐错过的次数（最多 5 次，错峰执行）。
                </p>
              </div>
            )}

            {form.scheduleKind === "cron" && (
              <div className="cron-subfield">
                <label className="field">
                  <span>cron 表达式（分 时 日 月 周）</span>
                  <input
                    value={form.expr}
                    placeholder="0 9 * * 1-5"
                    onChange={(event) => patchForm({ expr: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>时区（可选，IANA 名称）</span>
                  <input
                    value={form.tz}
                    placeholder="Asia/Shanghai"
                    onChange={(event) => patchForm({ tz: event.target.value })}
                  />
                </label>
                <p className="hint">留空按服务器本地时区理解墙钟时间；整点任务会自动错峰几秒，避免一起唤醒。</p>
              </div>
            )}

            <div className="field">
              <span>跑什么</span>
              <div className="cron-choice">
                {(["agentTurn", "command"] as PayloadKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`skill-cat${form.payloadKind === kind ? " active" : ""}`}
                    aria-pressed={form.payloadKind === kind}
                    onClick={() => patchForm({ payloadKind: kind })}
                  >
                    {kind === "agentTurn" ? "让智能体做" : "执行命令"}
                  </button>
                ))}
              </div>
            </div>

            {form.payloadKind === "agentTurn" ? (
              <div className="cron-subfield">
                <label className="field">
                  <span>任务指令</span>
                  <textarea
                    rows={5}
                    value={form.message}
                    maxLength={limits?.message ?? 2000}
                    placeholder="到点无人值守执行，请写清做到什么程度算完成、结果发到群里说什么。"
                    onChange={(event) => patchForm({ message: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>交给谁执行</span>
                  <select
                    value={form.targetMemberId}
                    onChange={(event) => patchForm({ targetMemberId: event.target.value })}
                  >
                    <option value="">主智能体</option>
                    {members
                      .filter((member) => member.role !== "main")
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          @{member.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="hint">
                  运行没有人在旁边澄清：回复会作为交付物发到群里；状态没变化时智能体会静默。
                </p>
              </div>
            ) : (
              <div className="cron-subfield">
                <label className="field">
                  <span>命令（每行一个参数，不经过 shell）</span>
                  <textarea
                    rows={3}
                    value={form.argvText}
                    placeholder={"node\nscripts/daily-check.js"}
                    onChange={(event) => patchForm({ argvText: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>超时秒数（可选，0 表示不超时）</span>
                  <input
                    value={form.commandTimeout}
                    inputMode="numeric"
                    placeholder="300"
                    onChange={(event) => patchForm({ commandTimeout: event.target.value })}
                  />
                </label>
                <p className="hint">命令在文件工作区 files/ 里以服务进程权限运行，执行前想清后果。</p>
              </div>
            )}

            <div className="cron-subfield">
              <label className="cron-check">
                <input
                  type="checkbox"
                  checked={form.useActiveHours}
                  onChange={(event) => patchForm({ useActiveHours: event.target.checked })}
                />
                <span>只在指定时段内执行</span>
              </label>
              {form.useActiveHours && (
                <div className="field inline">
                  <input
                    type="time"
                    value={form.activeStart}
                    onChange={(event) => patchForm({ activeStart: event.target.value })}
                  />
                  <span>至</span>
                  <input
                    type="time"
                    value={form.activeEnd}
                    onChange={(event) => patchForm({ activeEnd: event.target.value })}
                  />
                </div>
              )}
              <label className="cron-check">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => patchForm({ enabled: event.target.checked })}
                />
                <span>创建后立即启用</span>
              </label>
            </div>

            <div className="cron-form-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {editing ? "保存修改" : "创建任务"}
              </button>
              <button type="button" className="btn ghost" onClick={backToList} disabled={busy}>
                取消
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
