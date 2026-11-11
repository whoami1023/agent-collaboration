/**
 * 任务审计视图：执行面板里的紧凑摘要与独立的「审计」标签共用同一张卡。
 * 审计由服务端在成员每轮交付后自动产生，这里只读展示，不提供修改入口。
 */
import type { AuditRecord, AuditVerdict } from "../../src/agent/audit/types";

const AUDIT_LABEL: Record<AuditVerdict, string> = {
  pass: "验收通过",
  fail: "有问题",
  unsure: "存疑",
};

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function AuditCard({ audit }: { audit: AuditRecord }) {
  const open = audit.criteria.filter((item) => item.verdict !== "pass").slice(0, 2);
  return (
    <article className={`audit-card ${audit.verdict}`}>
      <header className="audit-card-head">
        <span className={`audit-verdict ${audit.verdict}`}>{AUDIT_LABEL[audit.verdict]}</span>
        <span className="audit-task" title={audit.taskTitle}>
          {audit.taskTitle}
        </span>
        <span className="audit-time">{clock(audit.at)}</span>
      </header>
      <div className="audit-meta">
        <span>@{audit.memberName}</span>
        <span>
          通过 {audit.summary.passed}/{audit.summary.total}
        </span>
        {audit.taskSolved ? (
          <span className="audit-action pass">全部达成</span>
        ) : audit.action === "nudge" ? (
          <span className="audit-action nudge">
            已催办 {audit.interventionCount}/{audit.maxInterventions}
          </span>
        ) : audit.action === "escalate" ? (
          <span className="audit-action escalate">需人工介入</span>
        ) : null}
      </div>
      {audit.fixHint ? <p className="audit-fix">{audit.fixHint}</p> : null}
      {open.length > 0 ? (
        <ul className="audit-criteria">
          {open.map((item) => (
            <li key={item.id} className={item.verdict} title={item.evidence}>
              <span className="audit-dot" />
              {item.criterion}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function AuditPanel({ audits }: { audits: AuditRecord[] }) {
  const count = (verdict: AuditVerdict) =>
    audits.filter((audit) => audit.verdict === verdict).length;
  return (
    <div className="board-body audit-panel-body">
      <div className="audit-overview">
        <span className="audit-overview-chip pass">通过 {count("pass")}</span>
        <span className="audit-overview-chip fail">有问题 {count("fail")}</span>
        <span className="audit-overview-chip unsure">存疑 {count("unsure")}</span>
        <span className="audit-overview-hint">最近 {Math.min(audits.length, 20)} 条</span>
      </div>
      {audits.length === 0 ? (
        <div className="activity-empty audit-empty">
          <p>还没有审计记录。触发方式：</p>
          <p>
            给任务卡写「验收条款」→ 成员完成一轮交付 → 系统自动核对证据并在这里留下结论；
            必要时会在群聊里发出催办或升级消息。
          </p>
          <p>审计结论随房间持久化，刷新或重启后仍在。</p>
        </div>
      ) : (
        <div className="audit-cards">
          {audits.slice(-20).reverse().map((audit) => (
            <AuditCard key={audit.id} audit={audit} />
          ))}
        </div>
      )}
    </div>
  );
}
