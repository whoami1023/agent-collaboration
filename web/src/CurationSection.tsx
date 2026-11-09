import { useCallback, useEffect, useMemo, useState } from "react";
import type { CurationProposal, CurationSnapshot } from "./api";
import {
  applyCurationProposal,
  dismissCurationProposal,
  fetchCuration,
  sweepCuration,
} from "./api";
import { Icon } from "./icons";

interface CurationSectionProps {
  /** 复盘事件到达时自增：策展也跟着重拉，闲置与提案会随用量变化。 */
  refreshToken: number;
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

const KIND_LABEL: Record<CurationProposal["kind"], string> = {
  stale: "标记闲置",
  archive: "建议归档",
  consolidate: "合并重复",
};

const OUTCOME_LABEL: Record<string, string> = {
  transitioned: "已迁移",
  proposed: "产出提案",
  nothing: "无需整理",
  skipped: "已跳过",
  failed: "失败",
};

/** 提案卡片上的一句「凭这些数据提的」：闲置天数、用过几次，都是账本里的硬事实。 */
function evidenceLine(proposal: CurationProposal): string {
  const parts = proposal.evidence.subjects.map(
    (subject) =>
      `${subject.skillName}（闲置 ${subject.idleDays} 天 · 用过 ${subject.useCount} 次 · 读过 ${subject.viewCount} 次）`,
  );
  return parts.length === 0 ? proposal.evidence.detail : parts.join("；");
}

export default function CurationSection({ refreshToken, onPendingChange }: CurationSectionProps) {
  const [snapshot, setSnapshot] = useState<CurationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanning, setScanning] = useState<"plain" | "consolidate" | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await fetchCuration();
      setSnapshot(next);
      onPendingChange?.(
        next.proposals.filter((proposal) => proposal.status === "pending").length,
      );
    } catch (err) {
      setError(messageOf(err));
    }
  }, [onPendingChange]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  const pending = useMemo(
    () => (snapshot?.proposals ?? []).filter((proposal) => proposal.status === "pending"),
    [snapshot],
  );

  async function handleSweep(consolidate: boolean) {
    setScanning(consolidate ? "consolidate" : "plain");
    setError(null);
    try {
      const result = await sweepCuration(
        consolidate ? { force: true, consolidate: true } : { force: true },
      );
      if (result.skipped) setError(result.skipped);
      await reload();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setScanning(null);
    }
  }

  async function handleApply(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const updated = await applyCurationProposal(id);
      setSnapshot((current) =>
        current
          ? { ...current, proposals: current.proposals.map((item) => (item.id === id ? updated : item)) }
          : current,
      );
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
      const updated = await dismissCurationProposal(id);
      setSnapshot((current) =>
        current
          ? { ...current, proposals: current.proposals.map((item) => (item.id === id ? updated : item)) }
          : current,
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  const settings = snapshot?.settings;

  return (
    <>
      <div className="skills-toolbar">
        <button
          type="button"
          className="btn ghost sm"
          disabled={scanning !== null}
          onClick={() => void handleSweep(false)}
        >
          <Icon name="refresh" size={13} />
          {scanning === "plain" ? "扫描中…" : "立即扫描"}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={scanning !== null}
          onClick={() => void handleSweep(true)}
        >
          <Icon name="inspect" size={13} />
          {scanning === "consolidate" ? "比对中…" : "扫描并找重复"}
        </button>
      </div>

      <p className="hint">
        技能用得少就会被标记闲置，长期没人用才会提议归档；归档只把它移出智能体的技能清单，正文与附带文件一律保留，随时能恢复。
        {settings
          ? `当前阈值：闲置 ${settings.staleAfterDays} 天、归档 ${settings.archiveAfterDays} 天，每 ${settings.intervalHours} 小时最多扫一次。`
          : ""}
        从未用过的技能只标记、不归档 —— 没数据是证据不足，不是「该删」。可在「设置 → 技能策展」里调整。
      </p>

      {error && <p className="form-error">{error}</p>}

      {settings && !settings.enabled && (
        <p className="form-note">技能策展当前是「已关闭」，扫描不会改动任何技能状态。</p>
      )}

      <h3 className="curation-title">待确认（{pending.length}）</h3>
      {pending.length === 0 ? (
        <p className="empty small">
          没有待确认的策展提案。技能被真正使用过、并且闲置超过阈值时，这里会出现标记或归档建议。
        </p>
      ) : (
        <ul className="learning-list">
          {pending.map((proposal) => (
            <li
              key={proposal.id}
              className={`learning-card curation${proposal.kind === "consolidate" ? " skill" : ""}`}
            >
              <div className="learning-kind-row">
                <span className={`learning-kind${proposal.kind === "consolidate" ? " skill" : ""}`}>
                  {KIND_LABEL[proposal.kind]}
                </span>
                <span className="learning-skill-name">
                  {proposal.kind === "consolidate"
                    ? `→ ${proposal.target.name}`
                    : (proposal.evidence.subjects[0]?.skillName ?? proposal.skillId)}
                </span>
                <span className="learning-target">
                  {proposal.origin === "model" ? "模型比对" : proposal.origin === "manual" ? "手动发起" : "定时扫描"}
                </span>
              </div>
              <p className="learning-content">{evidenceLine(proposal)}</p>
              {proposal.reason && <p className="learning-meta">{proposal.reason}</p>}
              {proposal.evidence.detail && proposal.kind === "consolidate" && (
                <p className="learning-meta">{proposal.evidence.detail}</p>
              )}
              <p className="learning-meta">提出于 {formatInstant(proposal.createdAt)}</p>
              <div className="learning-actions">
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={busyId === proposal.id}
                  onClick={() => void handleApply(proposal.id)}
                >
                  <Icon name={proposal.kind === "archive" || proposal.kind === "consolidate" ? "archive" : "check"} size={13} />
                  {proposal.kind === "stale"
                    ? "标记闲置"
                    : proposal.kind === "archive"
                      ? "归档（保留正文）"
                      : "合并并归档来源"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busyId === proposal.id}
                  onClick={() => void handleDismiss(proposal.id)}
                >
                  先不动
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="curation-title">扫描流水</h3>
      <ul className="learning-list">
        {(snapshot?.log.length ?? 0) === 0 ? (
          <li className="learning-log skipped">
            <span className="learning-outcome">暂无</span>
            <span className="learning-log-main">还没有扫描记录。打开这个标签、或点上面的「立即扫描」就会跑一次。</span>
          </li>
        ) : (
          snapshot?.log.map((entry) => (
            <li key={entry.id} className={`learning-log ${entry.outcome}`}>
              <span className="learning-outcome">{OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</span>
              <span className="learning-log-main">
                <strong>{formatInstant(entry.at)}</strong>
                <span className="learning-log-detail">
                  扫了 {entry.scanned} 条技能
                  {entry.transitions.length > 0 &&
                    `：${entry.transitions.map((t) => `${t.skillName} ${t.from}→${t.to}`).join("、")}`}
                  {entry.detail ? ` · ${entry.detail}` : ""}
                </span>
              </span>
              {entry.modelRef && <span className="learning-log-model">{entry.modelRef}</span>}
            </li>
          ))
        )}
      </ul>
    </>
  );
}
