/**
 * 执行视图：每个成员一张状态卡，下面是按成员筛选的活动时间线。
 *
 * 参考 AgentGUI 的 desk + activity feed：运行中的成员显示当前工具、实时文本与推理摘要，
 * 空闲成员保留最近活动与计数；活动由服务端生成并持久化，重载与重启后仍在。
 */
import { useEffect, useMemo, useState } from "react";
import type { Member } from "../../src/core/types";
import type { AuditRecord } from "../../src/agent/audit/types";
import { ACTIVITY_META, summarizeExecution, type ActivityEvent, type RunningView } from "./activity-model";
import { AuditCard } from "./AuditPanel";
import { Icon } from "./icons";

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

const STATUS_LABEL: Record<"running" | "idle" | "error" | "cancelled", string> = {
  running: "运行中",
  idle: "空闲",
  error: "上次失败",
  cancelled: "已取消",
};

export function ActivityPanel({
  members,
  activity,
  audits,
  runs,
  onOpenTrace,
}: {
  members: Member[];
  activity: ActivityEvent[];
  audits: AuditRecord[];
  runs: Record<string, RunningView>;
  /** 右侧执行面板里也能直接切到卡通运行现场，避免只认侧边栏入口。 */
  onOpenTrace?(): void;
}) {
  const [filter, setFilter] = useState<string | "all">("all");
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = Object.keys(runs).length > 0;

  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const summary = useMemo(
    () => summarizeExecution(members, activity, runs, now),
    [members, activity, runs, now],
  );
  const timeline = useMemo(
    () =>
      [...activity]
        .filter((event) => filter === "all" || event.memberId === filter)
        .reverse()
        .slice(0, 200),
    [activity, filter],
  );

  function exportCsv(): void {
    const cell = (value: string) => {
      const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
      return `"${guarded.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["时间", "成员", "类型", "标题", "详情", "结果"].map(cell).join(","),
      ...timeline.map((event) =>
        [
          new Date(event.at).toISOString(),
          event.memberName,
          event.kind,
          event.title,
          event.detail ?? "",
          event.ok === undefined ? "" : event.ok ? "成功" : "失败",
        ]
          .map(cell)
          .join(","),
      ),
    ];
    const blob = new Blob([`\uFEFF${rows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="activity-panel">
      <section className="activity-overview" aria-label="成员运行状态">
        <div className="activity-section-head">
          <span>成员状态</span>
          <span className="activity-head-right">
            <button
              type="button"
              className="activity-open-trace"
              title="把当前筛选的活动导出为 CSV（公式前缀已转义）"
              onClick={exportCsv}
            >
              <Icon name="download" size={13} />
              导出活动
            </button>
            {onOpenTrace ? (
              <button
                type="button"
                className="activity-open-trace"
                title="打开像素小人的运行现场"
                onClick={onOpenTrace}
              >
                <Icon name="route" size={13} />
                运行现场
              </button>
            ) : null}
            <span className={`activity-live${hasRunning ? " on" : ""}`}>
              {hasRunning ? "实时" : "空闲"}
            </span>
          </span>
        </div>
        {members.length === 0 ? (
          <div className="activity-empty">房间里还没有成员。</div>
        ) : (
          <div className="activity-cards">
            {summary.map((item) => {
              const elapsedMs = item.status === "running" && item.startedAt ? now - item.startedAt : 0;
              return (
                <button
                  key={item.member.id}
                  type="button"
                  className={`activity-card ${item.status}${filter === item.member.id ? " selected" : ""}`}
                  onClick={() => setFilter((current) => (current === item.member.id ? "all" : item.member.id))}
                  title="点击只看该成员的活动"
                >
                  <header className="activity-card-head">
                    <span className={`activity-dot ${item.status}`} />
                    <span className="activity-name">@{item.member.name}</span>
                    <span className="activity-role">{item.member.role === "main" ? "主" : "子"}</span>
                    <span className="activity-status">
                      {STATUS_LABEL[item.status]}
                      {elapsedMs > 0 ? ` · ${elapsed(elapsedMs)}` : ""}
                    </span>
                  </header>
                  <div className="activity-now">
                    {item.status === "running"
                      ? item.currentTool
                        ? `工具 · ${item.currentTool}`
                        : item.reasoning
                          ? `思考 · ${item.reasoning.slice(-120)}`
                          : "思考中…"
                      : item.last
                        ? `${ACTIVITY_META[item.last.kind].label} · ${item.last.title}`
                        : "暂无活动"}
                  </div>
                  {item.text ? <div className="activity-preview">{item.text.slice(-160)}</div> : null}
                  <div className="activity-spark" aria-hidden="true">
                    {item.spark.length === 0 ? (
                      <span className="activity-spark-empty">—</span>
                    ) : (
                      item.spark.map((event) => (
                        <span
                          key={event.id}
                          className={`activity-spark-bar ${ACTIVITY_META[event.kind].tone}`}
                          title={`${clock(event.at)} ${event.title}`}
                        />
                      ))
                    )}
                  </div>
                  <footer className="activity-counts">
                    <span>工具 {item.counts.tool}</span>
                    <span>发言 {item.counts.message}</span>
                    {item.counts.error > 0 ? <span className="err">失败 {item.counts.error}</span> : null}
                  </footer>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="activity-audits" aria-label="任务审计">
        <div className="activity-section-head">
          <span>任务审计</span>
          <span className="activity-hint">带验收条款的任务交付后自动核对</span>
        </div>
        {audits.length === 0 ? (
          <div className="activity-empty">
            暂无审计。任务写了验收条款后，成员每轮交付完都会核对证据。
          </div>
        ) : (
          <div className="audit-cards">
            {audits.slice(-6).reverse().map((audit) => (
              <AuditCard key={audit.id} audit={audit} />
            ))}
          </div>
        )}
      </section>

      <section className="activity-timeline" aria-label="活动时间线">
        <div className="activity-section-head">
          <span>活动时间线</span>
          <span className="activity-hint">活动已持久化，重载后仍在</span>
        </div>
        <div className="activity-filters">
          <button
            type="button"
            className={`activity-filter${filter === "all" ? " active" : ""}`}
            onClick={() => setFilter("all")}
          >
            全部
          </button>
          {summary.map((item) => (
            <button
              key={item.member.id}
              type="button"
              className={`activity-filter${filter === item.member.id ? " active" : ""}`}
              onClick={() => setFilter(item.member.id)}
            >
              {item.member.name}
            </button>
          ))}
        </div>
        {timeline.length === 0 ? (
          <div className="activity-empty">
            还没有活动。发一条消息后，这里会实时显示谁在思考、调用了什么工具、什么时候交付。
          </div>
        ) : (
          <ol className="activity-list">
            {timeline.map((event) => (
              <li key={event.id} className={`activity-row ${ACTIVITY_META[event.kind].tone}`}>
                <span className="activity-row-time">{clock(event.at)}</span>
                <span className="activity-row-kind">{ACTIVITY_META[event.kind].label}</span>
                <span className="activity-row-body">
                  <span className="activity-row-title">
                    {event.memberId === "user" ? "用户" : `@${event.memberName}`} · {event.title}
                  </span>
                  {event.detail ? <span className="activity-row-detail">{event.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
