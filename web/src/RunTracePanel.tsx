/**
 * 运行轨迹面板：把当前房间的成员画成像素小人，实时显示谁在思考、在用工具、在交付，
 * 下方是每个成员真实的持久活动轨迹。数据来自服务端活动日志与 SSE 运行态，不额外造状态。
 */
import { useEffect, useMemo, useState } from "react";
import type { Member } from "../../src/core/types";
import {
  fetchRunCheckpoints,
  fetchRuns,
  forkRun,
  type RunCheckpointView,
  type RunJournalView,
} from "./api";
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
      {actor.toolRuns.length > 0 ? (
        <>
          <div className="trace-subhead">
            <span>工具轨迹</span>
            <span>最近 {actor.toolRuns.length} 次</span>
          </div>
          <div className="trace-tools">
            {actor.toolRuns.map((run, index) => (
              <div
                key={run.id}
                className={`trace-tool${run.ok === false ? " failed" : run.ok === true ? " ok" : " pending"}`}
              >
                <div className="trace-tool-head">
                  <span className="trace-tool-index">{index + 1}</span>
                  <span className="trace-tool-name">{run.name}</span>
                  <span className={`trace-tool-state ${run.ok === false ? "failed" : run.ok === true ? "ok" : "pending"}`}>
                    {run.ok === false ? "失败" : run.ok === true ? "完成" : "调用中"}
                  </span>
                  <span className="trace-tool-time">{clock(run.at)}</span>
                </div>
                {run.args ? (
                  <code className="trace-tool-args" title={run.args}>
                    {run.args}
                  </code>
                ) : null}
                {run.result ? (
                  <div className={`trace-tool-result${run.ok === false ? " err" : ""}`} title={run.result}>
                    <span>↳</span>
                    {run.result}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : actor.milestones.length === 0 ? (
        <p className="trace-lane-empty">还没有活动。</p>
      ) : (
        <p className="trace-lane-empty">这一轮还没有调用工具。</p>
      )}
      {actor.milestones.length > 0 ? (
        <>
          <div className="trace-subhead">
            <span>里程碑</span>
          </div>
          <div className="trace-track">
            {actor.milestones.map((event) => (
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
        </>
      ) : null}
    </article>
  );
}

export function RunTracePanel({
  members,
  activity,
  runs,
  roomName,
  roomId,
  onClose,
}: {
  members: Member[];
  activity: ActivityEvent[];
  runs: Record<string, RunningView>;
  roomName: string;
  roomId: string;
  onClose(): void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [journalRuns, setJournalRuns] = useState<RunJournalView[]>([]);
  const [forkRunId, setForkRunId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<RunCheckpointView[]>([]);
  const [forkStep, setForkStep] = useState(0);
  const [instruction, setInstruction] = useState("");
  const [forkBusy, setForkBusy] = useState(false);
  const [forkNote, setForkNote] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);

  const reloadRuns = useMemo(
    () => async () => {
      if (!roomId) return;
      try {
        setJournalRuns(await fetchRuns(roomId));
      } catch {
        setJournalRuns([]);
      }
    },
    [roomId],
  );

  useEffect(() => {
    void reloadRuns();
  }, [reloadRuns]);

  const memberName = (memberId: string): string =>
    members.find((candidate) => candidate.id === memberId)?.name ?? memberId;

  async function openCheckpoints(runId: string): Promise<void> {
    if (forkRunId === runId) {
      setForkRunId(null);
      setCheckpoints([]);
      return;
    }
    setForkRunId(runId);
    setCheckpoints([]);
    setForkError(null);
    setForkNote(null);
    try {
      const loaded = await fetchRunCheckpoints(runId, roomId);
      setCheckpoints(loaded);
      setForkStep(loaded.at(-1)?.step ?? 0);
    } catch (err) {
      setForkError(err instanceof Error ? err.message : "读取检查点失败");
    }
  }

  async function submitFork(): Promise<void> {
    if (!forkRunId || !instruction.trim()) return;
    setForkBusy(true);
    setForkError(null);
    setForkNote(null);
    try {
      const result = await forkRun(
        forkRunId,
        { step: forkStep, instruction: instruction.trim() },
        roomId,
      );
      setInstruction("");
      setForkNote(`已从第 ${forkStep} 步另起一轮（${result.runId}）；原运行没有改动。`);
      await reloadRuns();
    } catch (err) {
      setForkError(err instanceof Error ? err.message : "另起一轮失败");
    } finally {
      setForkBusy(false);
    }
  }

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
            {actors.length > 4 ? (
              <span className="trace-scene-scrollhint">可上下滑动</span>
            ) : null}
            <span className="trace-scene-room">{roomName}</span>
          </div>
          {actors.length === 0 ? (
            <p className="trace-scene-empty">房间里还没有成员。</p>
          ) : (
            <div
              className="trace-stage"
              tabIndex={0}
              aria-label="运行现场，可上下滑动查看全部成员"
            >
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

        <section className="trace-time" aria-label="时间旅行">
          <div className="trace-lanes-head">
            <span>时间旅行</span>
            <button type="button" className="trace-focus-reset" onClick={() => void reloadRuns()}>
              刷新
            </button>
            <span className="activity-hint">从已完成的回合另起一轮，原运行不改</span>
          </div>
          {journalRuns.length === 0 ? (
            <p className="trace-lane-empty">还没有可回看的运行。</p>
          ) : (
            <div className="trace-runs">
              {journalRuns.slice(0, 12).map((run) => {
                const open = forkRunId === run.runId;
                const status =
                  run.status === "ok"
                    ? "完成"
                    : run.status === "error"
                      ? "失败"
                      : run.status === "aborted"
                        ? "中止"
                        : run.done
                          ? "已结束"
                          : "可续跑";
                return (
                  <div key={run.runId} className={`trace-run${open ? " open" : ""}`}>
                    <button
                      type="button"
                      className="trace-run-head"
                      aria-expanded={open}
                      onClick={() => void openCheckpoints(run.runId)}
                    >
                      <span className="trace-run-name">@{memberName(run.memberId)}</span>
                      <span className="trace-run-meta">
                        {run.steps} 步 · {clock(run.updatedAt)} · {status}
                      </span>
                    </button>
                    {open ? (
                      <div className="trace-run-body">
                        {checkpoints.length === 0 ? (
                          <p className="trace-lane-empty">这条运行还没有完整回合可以作检查点。</p>
                        ) : (
                          <>
                            <div className="trace-checkpoints">
                              {checkpoints.map((checkpoint) => (
                                <button
                                  key={checkpoint.step}
                                  type="button"
                                  className={`trace-checkpoint${forkStep === checkpoint.step ? " selected" : ""}`}
                                  title={
                                    checkpoint.calls.length > 0
                                      ? `调用过 ${checkpoint.calls.join("、")}`
                                      : checkpoint.text
                                  }
                                  onClick={() => setForkStep(checkpoint.step)}
                                >
                                  <span>
                                    {checkpoint.step === 0 ? "开始" : `第 ${checkpoint.step} 步`}
                                  </span>
                                  <small>
                                    {checkpoint.calls.length > 0
                                      ? checkpoint.calls.join("、")
                                      : checkpoint.step === 0
                                        ? "原始任务"
                                        : "无工具"}
                                  </small>
                                </button>
                              ))}
                            </div>
                            <label className="trace-instruction-label">
                              <span>从这里继续做什么</span>
                              <textarea
                                className="trace-instruction"
                                rows={3}
                                value={instruction}
                                placeholder="例如：保留前面的资料，换成先列提纲再写的做法"
                                onChange={(event) => setInstruction(event.target.value)}
                              />
                            </label>
                            <div className="trace-run-actions">
                              {forkError ? (
                                <span className="trace-run-error">{forkError}</span>
                              ) : forkNote ? (
                                <span className="trace-run-ok">{forkNote}</span>
                              ) : (
                                <span className="activity-hint">
                                  保留到第 {forkStep} 步的历史，之后的对话不会带进新分支
                                </span>
                              )}
                              <button
                                type="button"
                                className="trace-fork-btn"
                                disabled={forkBusy || instruction.trim() === ""}
                                onClick={() => void submitFork()}
                              >
                                {forkBusy ? "正在另起一轮…" : "从这里继续"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
