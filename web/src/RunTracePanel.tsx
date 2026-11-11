/**
 * 运行轨迹面板：把当前房间的成员画成像素小人，实时显示谁在思考、在用工具、在交付，
 * 下方是每个成员真实的持久活动轨迹。数据来自服务端活动日志与 SSE 运行态，不额外造状态。
 */
import { useEffect, useMemo, useState } from "react";
import type { Member } from "../../src/core/types";
import { ACTIVITY_META, type ActivityEvent, type RunningView } from "./activity-model";
import { Icon } from "./icons";
import { TraceFigure } from "./TraceFigure";
import {
  buildTraceActors,
  TRACE_MOOD_LABEL,
  type TraceActor,
} from "./run-trace-model";

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function ActorCard({
  actor,
  now,
  focused,
  onFocus,
}: {
  actor: TraceActor;
  now: number;
  focused: boolean;
  onFocus(): void;
}) {
  const live = actor.mood === "working" || actor.mood === "thinking";
  const runningFor = live && actor.startedAt ? elapsed(now - actor.startedAt) : "";
  return (
    <button
      type="button"
      className={`trace-actor ${actor.mood}${focused ? " focused" : ""}`}
      data-look={actor.look}
      data-mood={actor.mood}
      aria-pressed={focused}
      title={`点击只看 @${actor.member.name} 的运行轨迹`}
      onClick={onFocus}
    >
      <span className="trace-bubble" title={actor.thought}>
        <span className="trace-bubble-text">{actor.thought}</span>
      </span>
      <span className="trace-figure-wrap">
        <TraceFigure
          look={actor.look}
          accent={actor.accent}
          mood={actor.mood}
          scale={1.9}
          selected={focused}
          label={`${actor.member.name}，${TRACE_MOOD_LABEL[actor.mood]}`}
        />
      </span>
      <span className="trace-plate">
        <span className="trace-plate-name">@{actor.member.name}</span>
        <span className={`trace-plate-state ${actor.mood}`}>
          {actor.member.role === "main" ? "主" : "子"} · {TRACE_MOOD_LABEL[actor.mood]}
          {runningFor ? ` · ${runningFor}` : ""}
        </span>
      </span>
    </button>
  );
}

function Lane({ actor, focused, onFocus }: { actor: TraceActor; focused: boolean; onFocus(): void }) {
  return (
    <article className={`trace-lane ${actor.mood}${focused ? " focused" : ""}`}>
      <button
        type="button"
        className="trace-lane-head"
        aria-pressed={focused}
        title={`只看 @${actor.member.name}`}
        onClick={onFocus}
      >
        <span className={`trace-lane-dot ${actor.mood}`} />
        <span className="trace-lane-name">@{actor.member.name}</span>
        <span className="trace-lane-counts">
          工具 {actor.counts.tool} · 发言 {actor.counts.message}
          {actor.counts.error > 0 ? ` · 失败 ${actor.counts.error}` : ""}
        </span>
      </button>
      {actor.trail.length === 0 ? (
        <p className="trace-lane-empty">还没有活动。</p>
      ) : (
        <div className="trace-track">
          {actor.trail.map((event) => (
            <span
              key={event.id}
              className={`trace-chip ${ACTIVITY_META[event.kind].tone}`}
              title={event.detail ?? event.title}
            >
              <span className="trace-chip-time">{clock(event.at)}</span>
              <span className="trace-chip-kind">{ACTIVITY_META[event.kind].label}</span>
              <span className="trace-chip-title">{event.title}</span>
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function RunTracePanel({
  members,
  activity,
  runs,
  roomName,
  onClose,
}: {
  members: Member[];
  activity: ActivityEvent[];
  runs: Record<string, RunningView>;
  roomName: string;
  onClose(): void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const actors = useMemo(
    () => buildTraceActors(members, activity, runs),
    [members, activity, runs],
  );
  const live = actors.filter((actor) => actor.mood === "working" || actor.mood === "thinking").length;
  const focusedId = selectedId && actors.some((actor) => actor.member.id === selectedId)
    ? selectedId
    : null;

  useEffect(() => {
    if (live === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const lanes = focusedId ? actors.filter((actor) => actor.member.id === focusedId) : actors;

  return (
    <div className="board-sheet trace-sheet">
      <div className="board-head">
        <span className="section-label">运行轨迹</span>
        <div className="board-head-actions">
          <span className={`chip${live > 0 ? " trace-chip-live" : ""}`}>
            {live > 0 ? `${live} 个运行中` : "空闲"}
          </span>
          <button
            type="button"
            className="btn icon ghost board-close"
            title="关闭运行轨迹"
            aria-label="关闭运行轨迹"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>

      <div className="board-body trace-body">
        <section className="trace-scene" aria-label="智能体运行现场">
          <div className="trace-scene-bar">
            <span>运行现场</span>
            <span className="trace-scene-room">{roomName}</span>
          </div>
          {actors.length === 0 ? (
            <p className="trace-scene-empty">房间里还没有成员。</p>
          ) : (
            <div className="trace-stage">
              {actors.map((actor) => (
                <ActorCard
                  key={actor.member.id}
                  actor={actor}
                  now={now}
                  focused={focusedId === actor.member.id}
                  onFocus={() =>
                    setSelectedId((current) =>
                      current === actor.member.id ? null : actor.member.id,
                    )
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section className="trace-lanes" aria-label="成员运行轨迹">
          <div className="trace-lanes-head">
            <span>轨迹带</span>
            {focusedId ? (
              <button type="button" className="trace-focus-reset" onClick={() => setSelectedId(null)}>
                全部成员
              </button>
            ) : null}
            <span className="activity-hint">点角色只看 ta 的轨迹</span>
          </div>
          {lanes.map((actor) => (
            <Lane
              key={actor.member.id}
              actor={actor}
              focused={focusedId === actor.member.id}
              onFocus={() =>
                setSelectedId((current) => (current === actor.member.id ? null : actor.member.id))
              }
            />
          ))}
        </section>
      </div>
    </div>
  );
}
