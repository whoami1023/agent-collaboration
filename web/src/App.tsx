import { useEffect, useMemo, useRef, useState } from "react";
import type { Member, RoomEvent, RoomMessage, TaskCard } from "../../src/core/types";
import {
  cancelMember,
  createTask,
  fetchState,
  patchTask,
  saveSettings,
  sendMessage,
  subscribeEvents,
  type MaskedSettings,
  type StateSnapshot,
} from "./api";

interface RunState {
  memberId: string;
  text: string;
  tools: string[];
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

function clock(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function App() {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetchState()
      .then((snapshot) => {
        if (alive) setState(snapshot);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    const unsubscribe = subscribeEvents((event: RoomEvent) => {
      setState((current) => applyEvent(current, event));
      setRuns((current) => {
        if (event.type !== "run") return current;
        const run = event.event;
        const entry = current[run.memberId] ?? { memberId: run.memberId, text: "", tools: [] };
        if (run.type === "run-start") {
          return { ...current, [run.memberId]: { memberId: run.memberId, text: "", tools: [] } };
        }
        if (run.type === "delta") {
          return { ...current, [run.memberId]: { ...entry, text: entry.text + run.text } };
        }
        if (run.type === "tool") {
          return { ...current, [run.memberId]: { ...entry, tools: [...entry.tools, run.name] } };
        }
        if (run.type === "run-final" || run.type === "run-error" || run.type === "run-aborted") {
          const copy = { ...current };
          delete copy[run.memberId];
          return copy;
        }
        return current;
      });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const messages = state?.messages ?? [];
  const members = state?.members ?? [];
  const tasks = state?.tasks ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, runs]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) map.set(member.id, member.name);
    return map;
  }, [members]);

  async function handleSend() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError(null);
    try {
      await sendMessage(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCancel(memberId: string) {
    try {
      await cancelMember(memberId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddTask() {
    const title = newTaskTitle.trim();
    if (!title) return;
    setNewTaskTitle("");
    try {
      await createTask(title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleTaskStatus(task: TaskCard) {
    const next = task.status === "todo" ? "doing" : task.status === "doing" ? "done" : "todo";
    try {
      await patchTask(task.id, { status: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!state) {
    return <div className="loading">正在连接协同作战室…</div>;
  }

  const activeProvider = state.settings.providers.find(
    (provider) => provider.id === state.settings.activeProviderId,
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="room-title">
          <span className="room-name">{state.room.name}</span>
          <span className="badge">{activeProvider ? `${activeProvider.id} · ${activeProvider.model}` : "未配置模型"}</span>
          <span className="badge subtle">{members.length} 名成员</span>
        </div>
        <button className="ghost" onClick={() => setSettingsOpen((open) => !open)}>
          模型设置
        </button>
      </header>

      {error && (
        <div className="error-bar" role="alert">
          {error}
        </div>
      )}

      {settingsOpen && <SettingsPanel settings={state.settings} onClose={() => setSettingsOpen(false)} onSaved={(next) => setState((current) => (current ? { ...current, settings: next } : current))} />}

      <main className="layout">
        <aside className="panel members">
          <h2>成员</h2>
          <ul>
            {members.map((member) => (
              <li key={member.id} className={member.status}>
                <span className={`dot ${member.status}`} />
                <div className="member-main">
                  <div className="member-line">
                    <span className="member-name">@{member.name}</span>
                    <span className={`role ${member.role}`}>{member.role === "main" ? "主" : "成员"}</span>
                  </div>
                  <div className="member-meta">
                    {member.status === "running" ? "运行中" : member.status === "error" ? "异常" : "空闲"}
                    {runs[member.id]?.tools.length ? ` · ${runs[member.id]?.tools.at(-1)}` : ""}
                  </div>
                </div>
                {member.status === "running" && (
                  <button className="mini" onClick={() => void handleCancel(member.id)}>
                    取消
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <section className="chat-panel">
          <div className="messages">
            {messages.length === 0 && (
              <div className="empty">
                在下面发一条消息开始。试试「帮我调研多智能体协同的调度方式」，主智能体会拆任务并用 @ 派给子成员。
              </div>
            )}
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} nameById={nameById} />
            ))}
            {Object.values(runs).map((run) => {
              const name = nameById.get(run.memberId) ?? "成员";
              return (
                <div key={`run-${run.memberId}`} className="bubble member streaming">
                  <div className="bubble-head">
                    <span className="sender">@{name}</span>
                    <span className="tools">{run.tools.at(-1) ? `工具 · ${run.tools.at(-1)}` : "思考中"}</span>
                  </div>
                  <div className="bubble-text">{run.text || "…"}</div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
          <div className="composer">
            <textarea
              value={draft}
              placeholder="发消息给作战室…… 用 @成员名 指派任务"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
            />
            <button className="primary" onClick={() => void handleSend()}>
              发送
            </button>
          </div>
        </section>

        <aside className="panel board">
          <h2>任务看板</h2>
          <div className="task-add">
            <input
              value={newTaskTitle}
              placeholder="新增任务卡…"
              onChange={(event) => setNewTaskTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAddTask();
              }}
            />
            <button className="mini" onClick={() => void handleAddTask()}>
              添加
            </button>
          </div>
          <ul className="tasks">
            {tasks.length === 0 && <li className="empty small">还没有任务卡。主智能体派活时会自动建卡。</li>}
            {tasks.map((task) => (
              <li key={task.id} className={`task ${task.status}`}>
                <div className="task-head">
                  <span className="task-title">{task.title}</span>
                  <button className="status" onClick={() => void handleTaskStatus(task)} title="切换状态">
                    {task.status}
                  </button>
                </div>
                <div className="task-meta">
                  {task.ownerId ? `@${nameById.get(task.ownerId) ?? "?"}` : "未指派"}
                  {task.deps.length > 0 ? ` · 依赖 ${task.deps.length}` : ""}
                  {task.artifacts.length > 0 ? ` · 成果 ${task.artifacts.length}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}

function applyEvent(current: StateSnapshot | null, event: RoomEvent): StateSnapshot | null {
  if (!current) return current;
  if (event.type === "message") {
    if (current.messages.some((message) => message.id === event.message.id)) return current;
    return { ...current, messages: [...current.messages, event.message].slice(-400) };
  }
  if (event.type === "member") {
    return { ...current, members: upsert(current.members, event.member) };
  }
  if (event.type === "task") {
    return { ...current, tasks: upsert(current.tasks, event.task) };
  }
  return current;
}

function MessageBubble({ message, nameById }: { message: RoomMessage; nameById: Map<string, string> }) {
  if (message.senderKind === "system") {
    return <div className="system-line">{message.text}</div>;
  }
  const isUser = message.senderKind === "user";
  return (
    <div className={`bubble ${isUser ? "user" : "member"} ${message.kind}`}>
      <div className="bubble-head">
        <span className="sender">{isUser ? "你" : `@${message.senderName}`}</span>
        {message.kind === "announce" && <span className="tag">报告</span>}
        {message.taskId && <span className="tag subtle">{message.taskId.slice(0, 12)}</span>}
        <span className="time">{clock(message.ts)}</span>
      </div>
      <div className="bubble-text">{message.text}</div>
    </div>
  );
}

function SettingsPanel({
  settings,
  onClose,
  onSaved,
}: {
  settings: MaskedSettings;
  onClose: () => void;
  onSaved: (next: MaskedSettings) => void;
}) {
  const [providerId, setProviderId] = useState(settings.activeProviderId);
  const provider = settings.providers.find((item) => item.id === providerId) ?? settings.providers[0];
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSave() {
    if (!provider) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await saveSettings({
        activeProviderId: providerId,
        providers: [
          {
            id: provider.id,
            ...(apiKey ? { apiKey } : {}),
            ...(provider.kind === "openai" ? { baseUrl, model } : {}),
          },
        ],
      });
      onSaved(next);
      setApiKey("");
      setMessage("已保存，下一条消息生效");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!provider) return null;

  return (
    <div className="settings">
      <div className="settings-card">
        <div className="settings-head">
          <strong>模型设置</strong>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <label>
          Provider
          <select
            value={providerId}
            onChange={(event) => {
              const nextId = event.target.value;
              setProviderId(nextId);
              const next = settings.providers.find((item) => item.id === nextId);
              setBaseUrl(next?.baseUrl ?? "");
              setModel(next?.model ?? "");
              setApiKey("");
            }}
          >
            {settings.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}（{item.kind === "mock" ? "演示桩" : "OpenAI 兼容"}）
              </option>
            ))}
          </select>
        </label>
        {provider.kind === "openai" && (
          <>
            <label>
              Base URL
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label>
              模型
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label>
              API Key {provider.hasApiKey ? "（已保存，留空保持不变）" : ""}
              <input
                type="password"
                value={apiKey}
                placeholder="sk-…"
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
          </>
        )}
        <div className="settings-actions">
          <button className="primary" disabled={busy} onClick={() => void handleSave()}>
            {busy ? "保存中…" : "保存"}
          </button>
          {message && <span className="settings-message">{message}</span>}
        </div>
        <p className="hint">
          Key 只保存在本机 data/settings.json（已 gitignore）。演示桩模式不需要 Key，可以直接体验派发流程。
        </p>
      </div>
    </div>
  );
}
