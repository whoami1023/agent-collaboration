import { useCallback, useEffect, useMemo, useState } from "react";
import type { LearningProposal, LearningSettings, ReviewLog, SkillProposal } from "./api";
import { applyLearningProposal, dismissLearningProposal, fetchLearning } from "./api";
import CurationSection from "./CurationSection";
import { Icon } from "./icons";

type LearningTab = "pending" | "applied" | "log" | "curation";

interface LearningPanelProps {
  onClose(): void;
  /** 复盘事件到达时自增：面板据此重拉数据，不丢用户的当前标签。 */
  refreshToken: number;
  learning?: LearningSettings;
  onPendingChange?(count: number): void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatInstant(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const OUTCOME_LABEL: Record<ReviewLog["outcome"], string> = {
  proposed: "产出提案",
  applied: "已写入",
  nothing: "无所学",
  skipped: "已跳过",
  failed: "失败",
};

const MODE_LABEL: Record<LearningSettings["mode"], string> = {
  off: "已关闭",
  propose: "待确认",
  auto: "自动写入记忆",
};

const CATEGORY_LABEL: Record<string, string> = {
  planning: "协同与规划",
  research: "调研与写作",
  data: "数据分析",
  engineering: "开发与测试",
  product: "产品与文档",
  design: "设计与可视化",
  web: "网页与检索",
  agent: "智能体与技能",
  other: "其他",
};

function isSkill(proposal: LearningProposal): proposal is SkillProposal {
  return proposal.kind === "skill";
}

/** 记忆正文里的换行已经在后端压成一行，这里只做展示层的长度控制。 */
function memoryTitle(content: string): string {
  return content.length > 96 ? `${content.slice(0, 96)}…` : content;
}

function sourceLine(proposal: LearningProposal): string {
  return `@${proposal.memberName}${proposal.memberRole === "main" ? "（主智能体）" : ""} · ${proposal.roomName} · ${formatInstant(proposal.createdAt)}`;
}

function Triggers({ triggers }: { triggers: string[] }) {
  if (triggers.length === 0) return null;
  return (
    <p className="learning-triggers">
      {triggers.map((trigger) => (
        <span key={trigger} className="learning-trigger">
          {trigger}
        </span>
      ))}
    </p>
  );
}

export default function LearningPanel({
  onClose,
  refreshToken,
  learning,
  onPendingChange,
}: LearningPanelProps) {
  const [tab, setTab] = useState<LearningTab>("pending");
  const [proposals, setProposals] = useState<LearningProposal[]>([]);
  const [log, setLog] = useState<ReviewLog[]>([]);
  const [curationPending, setCurationPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const snapshot = await fetchLearning();
      setProposals(snapshot.proposals);
      setLog(snapshot.log);
      onPendingChange?.(
        snapshot.proposals.filter((proposal) => proposal.status === "pending").length,
      );
    } catch (err) {
      setError(messageOf(err));
    }
  }, [onPendingChange]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  const pending = useMemo(
    () => proposals.filter((proposal) => proposal.status === "pending"),
    [proposals],
  );
  const applied = useMemo(
    () => proposals.filter((proposal) => proposal.status === "applied"),
    [proposals],
  );
  const skillPending = pending.filter(isSkill).length;

  async function handleApply(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const updated = await applyLearningProposal(id);
      setProposals((current) => current.map((item) => (item.id === id ? updated : item)));
      onPendingChange?.(pending.length - 1);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const updated = await dismissLearningProposal(id);
      setProposals((current) => current.map((item) => (item.id === id ? updated : item)));
      onPendingChange?.(Math.max(0, pending.length - 1));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="board-sheet skills-sheet learning-sheet">
      <div className="board-head">
        <span className="section-label">学习</span>
        <div className="board-head-actions">
          <span className="chip">{pending.length}</span>
          <button type="button" className="btn ghost sm" onClick={() => void reload()}>
            <Icon name="refresh" size={13} />
            刷新
          </button>
          <button
            type="button"
            className="btn icon ghost board-close"
            title="关闭学习面板"
            aria-label="关闭学习面板"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>

      <div className="board-body skills-body">
        {error && <p className="form-error">{error}</p>}
        {learning?.mode === "off" && (
          <p className="form-note">
            自我复盘当前是「已关闭」，成员跑完不会产出提案。可在「设置 → 学习」里改成「待确认」。
          </p>
        )}

        <div className="skills-toolbar">
          <div className="skills-tabs" role="tablist" aria-label="学习视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "pending"}
              className={`skills-tab${tab === "pending" ? " active" : ""}`}
              onClick={() => setTab("pending")}
            >
              待确认
              <span className="chip">{pending.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "applied"}
              className={`skills-tab${tab === "applied" ? " active" : ""}`}
              onClick={() => setTab("applied")}
            >
              已落地
              <span className="chip">{applied.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "log"}
              className={`skills-tab${tab === "log" ? " active" : ""}`}
              onClick={() => setTab("log")}
            >
              复盘流水
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "curation"}
              className={`skills-tab${tab === "curation" ? " active" : ""}`}
              onClick={() => setTab("curation")}
            >
              技能策展
              <span className="chip">{curationPending}</span>
            </button>
          </div>
        </div>

        {tab === "curation" && (
          <CurationSection refreshToken={refreshToken} onPendingChange={setCurationPending} />
        )}

        {tab !== "log" && tab !== "curation" && (
          <p className="hint">
            成员每轮交付后，另起一次模型调用判断「这轮有没有值得长期记住的事实、有没有值得沉淀的做法」。
            {learning
              ? `当前模式：${MODE_LABEL[learning.mode]}，每 ${learning.everyNRuns} 轮复盘一次，每天最多 ${learning.dailyCap} 次。`
              : ""}
            记忆采纳后写入对应成员的长期记忆；技能提案一律等你确认，采纳后在本账号技能库创建个人技能，不会自动启用。
          </p>
        )}

        {tab === "pending" && (
          pending.length === 0 ? (
            <div className="skills-empty">
              <p className="empty small">
                还没有待确认的提案。成员跑完几轮、且复盘模式不是「已关闭」时，这里会出现记忆或技能候选。
              </p>
            </div>
          ) : (
            <ul className="learning-list">
              {pending.map((proposal) =>
                isSkill(proposal) ? (
                  <li key={proposal.id} className="learning-card skill">
                    <div className="learning-kind-row">
                      <span className="learning-kind skill">技能提案</span>
                      <span className="learning-skill-name">{proposal.skill.name}</span>
                    </div>
                    <p className="learning-content">{proposal.skill.description}</p>
                    <p className="learning-meta">
                      {sourceLine(proposal)} · {CATEGORY_LABEL[proposal.skill.category] ?? proposal.skill.category}
                    </p>
                    <p className="learning-meta">
                      采纳后在「技能库」创建个人技能；{proposal.memberName} 的技能白名单会自动加上它。
                    </p>
                    <Triggers triggers={proposal.skill.triggers} />
                    {proposal.rationale && <p className="learning-why">依据：{proposal.rationale}</p>}
                    <details className="learning-instructions">
                      <summary>查看 SKILL.md（{proposal.skill.instructions.length} 字）</summary>
                      <pre>{proposal.skill.instructions}</pre>
                    </details>
                    <div className="learning-actions">
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={busyId === proposal.id}
                        onClick={() => void handleApply(proposal.id)}
                      >
                        <Icon name="check" size={13} />
                        创建技能
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busyId === proposal.id}
                        onClick={() => void handleDismiss(proposal.id)}
                      >
                        忽略
                      </button>
                    </div>
                  </li>
                ) : (
                  <li key={proposal.id} className="learning-card">
                    <div className="learning-kind-row">
                      <span className="learning-kind">记忆提案</span>
                      <span className="learning-target">
                        {proposal.target === "member" ? "写入成员自己的记忆" : "写入账号记忆"}
                      </span>
                    </div>
                    <p className="learning-content">{memoryTitle(proposal.content)}</p>
                    <p className="learning-meta">{sourceLine(proposal)}</p>
                    <Triggers triggers={proposal.triggers} />
                    {proposal.rationale && <p className="learning-why">依据：{proposal.rationale}</p>}
                    <div className="learning-actions">
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={busyId === proposal.id}
                        onClick={() => void handleApply(proposal.id)}
                      >
                        <Icon name="check" size={13} />
                        写入记忆
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busyId === proposal.id}
                        onClick={() => void handleDismiss(proposal.id)}
                      >
                        忽略
                      </button>
                    </div>
                  </li>
                ),
              )}
            </ul>
          )
        )}

        {tab === "applied" && (
          applied.length === 0 ? (
            <div className="skills-empty">
              <p className="empty small">还没有落地过提案。确认记忆或创建技能后会出现在这里。</p>
            </div>
          ) : (
            <ul className="learning-list">
              {applied.map((proposal) => (
                <li key={proposal.id} className="learning-card done">
                  <div className="learning-kind-row">
                    <span className={`learning-kind${isSkill(proposal) ? " skill" : ""}`}>
                      {isSkill(proposal) ? "已创建技能" : "已写入记忆"}
                    </span>
                    {isSkill(proposal) && <span className="learning-skill-name">{proposal.skill.name}</span>}
                  </div>
                  <p className="learning-content">
                    {isSkill(proposal) ? proposal.skill.description : memoryTitle(proposal.content)}
                  </p>
                  <p className="learning-meta">
                    @{proposal.memberName} · {proposal.appliedPath ?? "已落地"} ·{" "}
                    {formatInstant(proposal.appliedAt ?? proposal.updatedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )
        )}

        {tab === "log" && (
          <ul className="learning-list">
            {skillPending > 0 && (
              <li className="learning-log skipped">
                <span className="learning-outcome">待确认</span>
                <span className="learning-log-main">
                  还有 {skillPending} 条技能提案等你批准；技能不会自动创建。
                </span>
              </li>
            )}
            {log.length === 0 ? (
              <li className="learning-log skipped">
                <span className="learning-outcome">暂无</span>
                <span className="learning-log-main">
                  还没有复盘记录。成员跑完一轮且达到复盘频率时会在这里留痕。
                </span>
              </li>
            ) : (
              log.map((entry) => (
                <li key={entry.id} className={`learning-log ${entry.outcome}`}>
                  <span className="learning-outcome">{OUTCOME_LABEL[entry.outcome]}</span>
                  <span className="learning-log-main">
                    <strong>{formatInstant(entry.at)}</strong> @
                    {entry.memberName}
                    <span className="learning-log-detail">{entry.detail}</span>
                  </span>
                  {entry.modelRef && <span className="learning-log-model">{entry.modelRef}</span>}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
