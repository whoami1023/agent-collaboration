/**
 * 成员右栏：侧边栏「成员」按钮打开，展示当前房间的花名册与运行状态。
 * 点击成员卡片进入智能体文件；运行中的可取消，子成员可移出/移除。
 */
import type { Member } from "../../src/core/types";
import type { ActivityEvent, RunningView } from "./activity-model";
import { TraceFigure } from "./TraceFigure";
import { Icon } from "./icons";
import { traceActorFor, TRACE_MOOD_LABEL } from "./run-trace-model";

function activeAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function modelLabel(member: Member): string {
  return member.modelRef && member.modelRef !== "default" ? member.modelRef : "默认模型";
}

function skillLabel(member: Member): string {
  return member.skillNames ? `${member.skillNames.length} 个技能` : "全部技能";
}

export function MembersPanel({
  members,
  activity,
  runs,
  isGroupRoom,
  onOpenMember,
  onCancel,
  onRemove,
  onInvite,
  onNewMember,
  onClose,
}: {
  members: Member[];
  activity: ActivityEvent[];
  runs: Record<string, RunningView>;
  isGroupRoom: boolean;
  onOpenMember(memberId: string): void;
  onCancel(memberId: string): void;
  onRemove(member: Member): void;
  onInvite(): void;
  onNewMember(): void;
  onClose(): void;
}) {
  const running = members.filter((member) => member.status === "running").length;
  const problems = members.filter(
    (member) => member.status === "error" || member.status === "cancelled",
  ).length;

  return (
    <div className="board-sheet">
      <div className="board-head">
        <span className="section-label">{isGroupRoom ? "群成员" : "成员"}</span>
        <div className="board-head-actions">
          <span className="chip">{members.length} 位</span>
          <button
            type="button"
            className="btn icon ghost board-close"
            title="关闭成员列表"
            aria-label="关闭成员列表"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>

      <div className="board-body roster-body">
        <section className="roster-overview" aria-label="成员概览">
          <span className="roster-stat">
            <strong>{members.length}</strong>
            <span>在册</span>
          </span>
          <span className={`roster-stat${running > 0 ? " live" : ""}`}>
            <strong>{running}</strong>
            <span>运行中</span>
          </span>
          <span className={`roster-stat${problems > 0 ? " warn" : ""}`}>
            <strong>{problems}</strong>
            <span>异常</span>
          </span>
        </section>

        <div className="roster-actions">
          <button type="button" className="btn ghost sm" onClick={onNewMember}>
            <Icon name="plus" size={13} />
            新建成员
          </button>
          {isGroupRoom ? (
            <button type="button" className="btn ghost sm" onClick={onInvite}>
              <Icon name="users" size={13} />
              拉成员进群
            </button>
          ) : null}
          <span className="activity-hint">点成员卡片查看记忆与智能体文件</span>
        </div>

        {members.length === 0 ? (
          <p className="trace-lane-empty">房间里还没有成员。</p>
        ) : (
          <ul className="roster-list">
            {members.map((member) => {
              const actor = traceActorFor(member, activity, runs);
              const latestTool = actor.toolRuns.at(-1)?.name ?? runs[member.id]?.tools.at(-1);
              return (
                <li key={member.id} className="roster-card">
                  <span
                    className="roster-figure"
                    data-look={actor.look}
                    data-mood={actor.mood}
                    title={actor.thought || TRACE_MOOD_LABEL[actor.mood]}
                  >
                    <TraceFigure
                      look={actor.look}
                      accent={actor.accent}
                      mood={actor.mood}
                      scale={1.15}
                      label={`${member.name}，${TRACE_MOOD_LABEL[actor.mood]}`}
                    />
                    <span className={`status-dot ${member.status}`} />
                  </span>
                  <button
                    type="button"
                    className="roster-main"
                    title={`查看 @${member.name} 的记忆与智能体文件`}
                    onClick={() => onOpenMember(member.id)}
                  >
                    <span className="roster-line">
                      <span className="roster-name">@{member.name}</span>
                      <span className={`role-pill ${member.role}`}>
                        {member.role === "main" ? "主" : "成员"}
                      </span>
                      <span className={`roster-state ${actor.mood}`}>
                        {TRACE_MOOD_LABEL[actor.mood]}
                      </span>
                    </span>
                    <span className="roster-meta">
                      {modelLabel(member)} · {skillLabel(member)} · 最近活动 {activeAt(member.lastActiveAt)}
                    </span>
                    {actor.thought ? <span className="roster-thought">{actor.thought}</span> : null}
                    <span className="roster-tool">
                      工具 {actor.counts.tool} · 发言 {actor.counts.message}
                      {latestTool ? ` · 最近 ${latestTool}` : ""}
                    </span>
                    {member.templateTitle ? (
                      <span className="roster-template">来自模板「{member.templateTitle}」</span>
                    ) : null}
                  </button>
                  <div className="roster-card-actions">
                    {member.status === "running" ? (
                      <button type="button" className="btn sm" onClick={() => onCancel(member.id)}>
                        取消
                      </button>
                    ) : null}
                    {member.role === "sub" ? (
                      <button
                        type="button"
                        className="btn icon ghost danger"
                        aria-label={`${isGroupRoom ? "移出群聊" : "移除成员"} @${member.name}`}
                        title={isGroupRoom ? "移出群聊（成员池与其他群不受影响）" : "移除成员"}
                        onClick={() => onRemove(member)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
