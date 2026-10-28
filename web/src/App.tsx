import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PublicUser, RoomEvent, RoomMessage, TaskCard } from "../../src/core/types";
import { Icon } from "./icons";
import SkillLibraryDialog from "./SkillLibrary";
import {
  ApiError,
  cancelMember,
  createTask,
  createUser,
  fetchBootstrap,
  fetchMe,
  fetchState,
  listUsers,
  loginUser,
  logoutUser,
  patchTask,
  resetUserPassword,
  saveSettings,
  sendMessage,
  setupAdmin,
  subscribeEvents,
  updateProfile,
  type MaskedSettings,
  type StateSnapshot,
} from "./api";

type ThemeMode = "light" | "dark";
type SettingsTab = "profile" | "model" | "appearance";

const THEME_KEY = "ac_theme";

interface RunState {
  memberId: string;
  text: string;
  tools: string[];
}

function readTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
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

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

function statusLabel(status: TaskCard["status"]): string {
  switch (status) {
    case "doing":
      return "进行中";
    case "done":
      return "完成";
    case "blocked":
      return "阻塞";
    case "failed":
      return "失败";
    default:
      return "待办";
  }
}

export default function App() {
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [user, setUser] = useState<PublicUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage can be unavailable in private modes
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const me = await fetchMe();
        if (alive) setUser(me);
      } catch (err) {
        if (isUnauthorized(err)) {
          try {
            const bootstrap = await fetchBootstrap();
            if (alive) setNeedsSetup(bootstrap.needsSetup);
          } catch (bootErr) {
            if (alive) setBootError(messageOf(bootErr));
          }
        } else if (alive) {
          setBootError(messageOf(err));
        }
      } finally {
        if (alive) setPhase("ready");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleSessionLost = useCallback(() => {
    setUser(null);
    void fetchBootstrap()
      .then((bootstrap) => setNeedsSetup(bootstrap.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logoutUser();
    } catch {
      // the server may already have revoked the session
    }
    handleSessionLost();
  }, [handleSessionLost]);

  if (phase === "loading") {
    return <div className="loading">正在连接协同作战室…</div>;
  }

  if (bootError && !user) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="brand-mark">AC</span>
            <div className="auth-brand-text">
              <strong>协同作战室</strong>
              <span>无法连接服务</span>
            </div>
            <button
              type="button"
              className="btn icon ghost"
              aria-label="切换深浅色"
              onClick={toggleTheme}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
          </div>
          <p className="form-error">{bootError}</p>
          <button className="btn primary auth-submit" onClick={() => window.location.reload()}>
            重新连接
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginPage
        needsSetup={needsSetup}
        theme={theme}
        onToggleTheme={toggleTheme}
        onAuthed={setUser}
      />
    );
  }

  return (
    <RoomView
      key={user.id}
      user={user}
      theme={theme}
      onToggleTheme={toggleTheme}
      onThemeChange={setTheme}
      onLogout={() => void handleLogout()}
      onSessionLost={handleSessionLost}
      onUserUpdated={setUser}
    />
  );
}

function LoginPage({
  needsSetup,
  theme,
  onToggleTheme,
  onAuthed,
}: {
  needsSetup: boolean;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onAuthed: (user: PublicUser) => void;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (needsSetup && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const nextUser = needsSetup
        ? await setupAdmin({ username, displayName, password })
        : await loginUser({ username, password });
      onAuthed(nextUser);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <div className="auth-brand">
          <span className="brand-mark">AC</span>
          <div className="auth-brand-text">
            <strong>协同作战室</strong>
            <span>{needsSetup ? "首次初始化" : "多用户 · 每用户独立房间"}</span>
          </div>
          <button
            type="button"
            className="btn icon ghost"
            aria-label="切换深浅色"
            onClick={onToggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
        <p className="auth-sub">
          {needsSetup
            ? "创建管理员账号。登录后你会进入自己的独立房间，并绑定该房间的主智能体。"
            : "登录后进入你自己的房间，你就是这间房的主智能体。账号由管理员创建。"}
        </p>
        <label className="field">
          <span>用户名</span>
          <input
            autoFocus
            autoComplete="username"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        {needsSetup && (
          <label className="field">
            <span>显示名称（可选）</span>
            <input
              value={displayName}
              placeholder="例如：老板"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
        )}
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            autoComplete={needsSetup ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {needsSetup && (
          <label className="field">
            <span>确认密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary auth-submit" type="submit" disabled={busy}>
          {busy ? "请稍候…" : needsSetup ? "创建管理员并进入" : "登录"}
        </button>
        <p className="auth-hint">
          {needsSetup
            ? "用户名 3-24 位字母、数字、下划线或连字符；密码至少 8 位。"
            : "忘记密码请联系管理员；退出后需要重新登录。"}
        </p>
      </form>
    </div>
  );
}

function RoomView({
  user,
  theme,
  onToggleTheme,
  onThemeChange,
  onLogout,
  onSessionLost,
  onUserUpdated,
}: {
  user: PublicUser;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLogout: () => void;
  onSessionLost: () => void;
  onUserUpdated: (user: PublicUser) => void;
}) {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [usersOpen, setUsersOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(() => {
    try {
      return localStorage.getItem("ac_board") !== "0";
    } catch {
      return true;
    }
  });
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const checkingSession = useRef(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    try {
      localStorage.setItem("ac_board", boardOpen ? "1" : "0");
    } catch {
      // storage can be unavailable in private mode
    }
  }, [boardOpen]);

  useEffect(() => {
    let alive = true;
    fetchState()
      .then((snapshot) => {
        if (alive) setState(snapshot);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) {
          onSessionLost();
          return;
        }
        setError(messageOf(err));
      });

    const checkSession = () => {
      if (checkingSession.current) return;
      checkingSession.current = true;
      void fetchMe()
        .catch((err: unknown) => {
          if (isUnauthorized(err)) onSessionLost();
        })
        .finally(() => {
          checkingSession.current = false;
        });
    };

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
    }, checkSession);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [onSessionLost]);

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
      setError(messageOf(err));
    }
  }

  async function handleCancel(memberId: string) {
    try {
      await cancelMember(memberId);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleAddTask() {
    const title = newTaskTitle.trim();
    if (!title) return;
    setNewTaskTitle("");
    try {
      await createTask(title);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleTaskStatus(task: TaskCard) {
    const next = task.status === "todo" ? "doing" : task.status === "doing" ? "done" : "todo";
    try {
      await patchTask(task.id, { status: next });
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleProfileUpdated(next: PublicUser) {
    onUserUpdated(next);
    try {
      setState(await fetchState());
    } catch (err) {
      setError(messageOf(err));
    }
  }

  if (!state) {
    return <div className="loading">正在进入 @{user.displayName} 的作战室…</div>;
  }

  const activeProvider = state.settings.providers.find(
    (provider) => provider.id === state.settings.activeProviderId,
  );

  return (
    <div className={`shell${boardOpen ? "" : " board-closed"}`}>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="sidebar-top">
          <div className="brand-row">
            <span className="brand-mark">AC</span>
            <span className="brand-name">协同作战室</span>
            <button
              type="button"
              className="btn icon ghost"
              aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
              title={theme === "dark" ? "切换到浅色" : "切换到深色"}
              onClick={onToggleTheme}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <button
              type="button"
              className="btn icon ghost drawer-close"
              aria-label="关闭成员面板"
              onClick={() => setNavOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>

          <nav className="sidebar-nav" aria-label="功能">
            <button
              type="button"
              className="nav-item"
              onClick={() => {
                setNavOpen(false);
                setSkillsOpen(true);
              }}
            >
              <Icon name="book" />
              <span className="nav-label">技能库</span>
              <span className="nav-hint">共享 · 个人</span>
            </button>
          </nav>

          <div className="section-label">
            成员
            <span className="section-count">{members.length}</span>
          </div>
          <ul className="member-list">
            {members.map((member) => (
              <li key={member.id} className="member-row">
                <span className="member-avatar">
                  {initialOf(member.name)}
                  <span className={`status-dot ${member.status}`} />
                </span>
                <div className="member-main">
                  <div className="member-line">
                    <span className="member-name">@{member.name}</span>
                    <span className={`role-pill ${member.role}`}>
                      {member.role === "main" ? "主" : "成员"}
                    </span>
                  </div>
                  <div className="member-meta">
                    {member.status === "running"
                      ? "运行中"
                      : member.status === "error"
                        ? "异常"
                        : member.status === "cancelled"
                          ? "已取消"
                          : "空闲"}
                    {runs[member.id]?.tools.length
                      ? ` · ${runs[member.id]?.tools.at(-1)}`
                      : ""}
                  </div>
                </div>
                {member.status === "running" && (
                  <button className="btn sm" onClick={() => void handleCancel(member.id)}>
                    取消
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="sidebar-foot" ref={accountRef}>
          {menuOpen && (
            <div className="user-menu" role="menu" aria-label="账号菜单">
              <div className="user-menu-head">
                <span className="avatar">{initialOf(user.displayName)}</span>
                <div className="user-menu-id">
                  <strong>{user.displayName}</strong>
                  <span>@{user.username}</span>
                </div>
                <span className={`role-pill ${user.role}`}>
                  {user.role === "admin" ? "管理员" : "成员"}
                </span>
              </div>
              <div className="menu-list">
                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setSettingsTab("profile");
                  }}
                >
                  <Icon name="settings" />
                  <span className="menu-label">设置</span>
                  <span className="menu-hint">资料 · 模型 · 外观</span>
                </button>
                {user.role === "admin" && (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setNavOpen(false);
                      setUsersOpen(true);
                    }}
                  >
                    <Icon name="users" />
                    <span className="menu-label">用户管理</span>
                    <span className="menu-hint">账号 · 重置密码</span>
                  </button>
                )}
              </div>
              <div className="menu-sep" role="separator" />
              <div className="menu-list">
                <button
                  type="button"
                  className="menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                >
                  <Icon name="logout" />
                  <span className="menu-label">退出登录</span>
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="account-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="账号菜单"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="avatar">{initialOf(user.displayName)}</span>
            <div className="identity">
              <strong>{user.displayName}</strong>
              <span>@{user.username} · 主智能体</span>
            </div>
            <span className={`chevron${menuOpen ? " up" : ""}`}>
              <Icon name="chevron" />
            </span>
          </button>
        </div>
      </aside>

      <header className="mobile-bar">
        <button
          type="button"
          className="btn icon ghost"
          aria-label="成员与账号"
          onClick={() => setNavOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <span className="mobile-room">{state.room.name}</span>
        <button
          type="button"
          className="btn icon ghost"
          aria-pressed={boardOpen}
          aria-label={boardOpen ? "收起任务看板" : "展开任务看板"}
          title={boardOpen ? "收起任务看板" : "展开任务看板"}
          onClick={() => setBoardOpen((open) => !open)}
        >
          <Icon name="columns" />
        </button>
      </header>

      <main className="content">
        <header className="content-header">
          <div className="content-title">{state.room.name}</div>
          <span className="env-pill">
            {activeProvider ? `${activeProvider.id} · ${activeProvider.model}` : "未配置模型"}
          </span>
          <button
            type="button"
            className="btn ghost board-toggle"
            aria-pressed={boardOpen}
            aria-controls="task-board"
            title={boardOpen ? "收起任务看板" : "展开任务看板"}
            onClick={() => setBoardOpen((open) => !open)}
          >
            <Icon name="columns" />
            <span>任务看板</span>
            <span className="chip">{tasks.length}</span>
          </button>
        </header>

        {error && (
          <div className="error-bar" role="alert">
            {error}
          </div>
        )}

        <div className="chat-main">
          <div className="messages">
            <div className="messages-inner">
              {messages.length === 0 && (
                <div className="empty-chat">
                  <span className="empty-mark">
                    <Icon name="users" size={18} />
                  </span>
                  <p>在下面发一条消息开始。</p>
                  <p className="empty-sub">
                    试试「帮我调研多智能体协同的调度方式」，主智能体会拆任务并用 @
                    派给子成员。
                  </p>
                </div>
              )}
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} nameById={nameById} />
              ))}
              {Object.values(runs).map((run) => {
                const name = nameById.get(run.memberId) ?? "成员";
                return (
                  <article key={`run-${run.memberId}`} className="bubble member streaming">
                    <header className="bubble-head">
                      <span className="sender">@{name}</span>
                      <span className="tool-chip">
                        {run.tools.at(-1) ? `工具 · ${run.tools.at(-1)}` : "思考中"}
                      </span>
                    </header>
                    <div className="bubble-text">
                      {run.text || <span className="typing">…</span>}
                    </div>
                  </article>
                );
              })}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="composer-wrap">
            <div className="composer">
              <textarea
                value={draft}
                placeholder={`以 ${user.displayName} 的身份发消息… 用 @成员名 指派任务`}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <button
                type="button"
                className="send-btn"
                aria-label="发送消息"
                disabled={!draft.trim()}
                onClick={() => void handleSend()}
              >
                <Icon name="send" />
              </button>
            </div>
            <div className="composer-hint">
              <span>Enter 发送 · Shift+Enter 换行</span>
              <span>@成员名 指派任务</span>
            </div>
          </div>
        </div>
      </main>

      <aside
        id="task-board"
        className="board-panel"
        aria-label="任务看板"
        inert={!boardOpen}
      >
        <div className="board-sheet">
          <div className="board-head">
            <span className="section-label">任务看板</span>
            <div className="board-head-actions">
              <span className="chip">{tasks.length}</span>
              <button
                type="button"
                className="btn icon ghost board-close"
                aria-label="收起任务看板"
                title="收起任务看板"
                onClick={() => setBoardOpen(false)}
              >
                <Icon name="chevronRight" />
              </button>
            </div>
          </div>
          <form
            className="task-add"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddTask();
            }}
          >
            <input
              value={newTaskTitle}
              placeholder="新增任务卡…"
              onChange={(event) => setNewTaskTitle(event.target.value)}
            />
            <button className="btn" type="submit" aria-label="添加任务">
              <Icon name="plus" />
            </button>
          </form>
          <div className="board-body">
            {tasks.length === 0 && (
              <p className="empty small">还没有任务卡。主智能体派活时会自动建卡。</p>
            )}
            {tasks.map((task) => (
              <article key={task.id} className={`task-card ${task.status}`}>
                <div className="task-line">
                  <span className="task-title">{task.title}</span>
                  <button
                    className={`status-chip ${task.status}`}
                    title="切换状态"
                    onClick={() => void handleTaskStatus(task)}
                  >
                    {statusLabel(task.status)}
                  </button>
                </div>
                <div className="task-meta">
                  {task.ownerId ? `@${nameById.get(task.ownerId) ?? "?"}` : "未指派"}
                  {task.deps.length > 0 ? ` · 依赖 ${task.deps.length}` : ""}
                  {task.artifacts.length > 0 ? ` · 成果 ${task.artifacts.length}` : ""}
                </div>
              </article>
            ))}
          </div>
        </div>
      </aside>

      {settingsTab && (
        <SettingsDialog
          user={user}
          roomName={state.room.name}
          settings={state.settings}
          theme={theme}
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
          onUserUpdated={(next) => void handleProfileUpdated(next)}
          onSettingsSaved={(next) =>
            setState((current) => (current ? { ...current, settings: next } : current))
          }
          onThemeChange={onThemeChange}
        />
      )}

      {usersOpen && user.role === "admin" && <AdminPanel onClose={() => setUsersOpen(false)} />}

      {skillsOpen && <SkillLibraryDialog onClose={() => setSkillsOpen(false)} />}
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

function MessageBubble({
  message,
  nameById,
}: {
  message: RoomMessage;
  nameById: Map<string, string>;
}) {
  if (message.senderKind === "system") {
    return <div className="system-line">{message.text}</div>;
  }
  const isUser = message.senderKind === "user";
  return (
    <article className={`bubble ${isUser ? "user" : "member"} ${message.kind}`}>
      <header className="bubble-head">
        <span className="sender">{isUser ? "你" : `@${message.senderName}`}</span>
        {message.kind === "announce" && <span className="chip accent">报告</span>}
        {message.taskId && <span className="chip">{message.taskId.slice(0, 12)}</span>}
        <span className="time">{clock(message.ts)}</span>
      </header>
      <div className="bubble-text">{message.text}</div>
    </article>
  );
}

function AdminPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setUsers(await listUsers());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createUser({ username, displayName, password });
      setNotice(`已创建 @${created.username}。请把初始密码单独告知对方。`);
      setUsername("");
      setDisplayName("");
      setPassword("");
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  function startReset(target: PublicUser) {
    setResetFor(resetFor === target.id ? null : target.id);
    setResetPassword("");
    setError(null);
    setNotice(null);
  }

  async function handleReset(event: FormEvent, target: PublicUser) {
    event.preventDefault();
    if (resetBusy) return;
    setResetBusy(true);
    setError(null);
    setNotice(null);
    try {
      await resetUserPassword(target.id, resetPassword);
      setNotice(`已重置 @${target.username} 的密码，该账号已登录的会话全部失效。`);
      setResetFor(null);
      setResetPassword("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-card wide"
        role="dialog"
        aria-modal="true"
        aria-label="用户管理"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <strong>用户管理</strong>
            <span className="modal-sub">每个账号拥有独立房间与绑定的主智能体</span>
          </div>
          <button type="button" className="btn icon ghost" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          {error && <p className="form-error">{error}</p>}
          {notice && <p className="form-note">{notice}</p>}
          {loading ? (
            <p className="hint">正在加载账号…</p>
          ) : (
            <ul className="user-list">
              {users.map((item) => (
                <li key={item.id}>
                  <div className="user-row">
                    <span className="avatar">{initialOf(item.displayName)}</span>
                    <div className="user-main">
                      <div className="user-line">
                        <span className="user-name">{item.displayName}</span>
                        <span className="user-handle">@{item.username}</span>
                        <span className={`role-pill ${item.role}`}>
                          {item.role === "admin" ? "管理员" : "成员"}
                        </span>
                      </div>
                      <div className="member-meta">
                        绑定 @主智能体 · 创建于 {new Date(item.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      aria-expanded={resetFor === item.id}
                      onClick={() => startReset(item)}
                    >
                      {resetFor === item.id ? "收起" : "重置密码"}
                    </button>
                  </div>
                  {resetFor === item.id && (
                    <form
                      className="reset-form"
                      onSubmit={(event) => void handleReset(event, item)}
                    >
                      <label className="field">
                        <span>新密码</span>
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder="至少 8 位，重置后请单独告知对方"
                          autoFocus
                          value={resetPassword}
                          onChange={(event) => setResetPassword(event.target.value)}
                        />
                      </label>
                      <button className="btn primary sm" type="submit" disabled={resetBusy}>
                        {resetBusy ? "重置中…" : "确认重置"}
                      </button>
                      <button
                        className="btn ghost sm"
                        type="button"
                        onClick={() => setResetFor(null)}
                      >
                        取消
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form className="admin-create" onSubmit={(event) => void handleCreate(event)}>
            <div className="section-label">创建账号</div>
            <div className="admin-fields">
              <label className="field">
                <span>用户名</span>
                <input value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label className="field">
                <span>显示名称</span>
                <input
                  value={displayName}
                  placeholder="可选"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>初始密码</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn primary" type="submit" disabled={busy}>
                <Icon name="plus" />
                {busy ? "创建中…" : "创建账号"}
              </button>
              <span className="hint">新账号首次登录时自动创建自己的房间与主智能体。</span>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function SettingsDialog({
  user,
  roomName,
  settings,
  theme,
  initialTab,
  onClose,
  onUserUpdated,
  onSettingsSaved,
  onThemeChange,
}: {
  user: PublicUser;
  roomName: string;
  settings: MaskedSettings;
  theme: ThemeMode;
  initialTab: SettingsTab;
  onClose: () => void;
  onUserUpdated: (user: PublicUser) => void;
  onSettingsSaved: (next: MaskedSettings) => void;
  onThemeChange: (theme: ThemeMode) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-card settings-card"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <strong>设置</strong>
            <span className="modal-sub">账号资料、模型与界面偏好</span>
          </div>
          <button type="button" className="btn icon ghost" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <button
              type="button"
              className={`settings-tab${tab === "profile" ? " active" : ""}`}
              onClick={() => setTab("profile")}
            >
              <Icon name="users" />
              个人资料
            </button>
            <button
              type="button"
              className={`settings-tab${tab === "model" ? " active" : ""}`}
              onClick={() => setTab("model")}
            >
              <Icon name="settings" />
              模型设置
            </button>
            <button
              type="button"
              className={`settings-tab${tab === "appearance" ? " active" : ""}`}
              onClick={() => setTab("appearance")}
            >
              <Icon name={theme === "dark" ? "moon" : "sun"} />
              外观
            </button>
          </nav>
          <div className="settings-body">
            {tab === "profile" && (
              <ProfileSection user={user} roomName={roomName} onUserUpdated={onUserUpdated} />
            )}
            {tab === "model" && <ModelSection settings={settings} onSaved={onSettingsSaved} />}
            {tab === "appearance" && (
              <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileSection({
  user,
  roomName,
  onUserUpdated,
}: {
  user: PublicUser;
  roomName: string;
  onUserUpdated: (user: PublicUser) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passBusy, setPassBusy] = useState(false);
  const [passError, setPassError] = useState<string | null>(null);
  const [passNote, setPassNote] = useState<string | null>(null);

  async function handleNameSave(event: FormEvent) {
    event.preventDefault();
    if (nameBusy) return;
    const next = displayName.trim();
    setNameError(null);
    setNameNote(null);
    if (!next) {
      setNameError("显示名称不能为空");
      return;
    }
    if (next === user.displayName) {
      setNameNote("显示名称没有变化");
      return;
    }
    setNameBusy(true);
    try {
      const updated = await updateProfile({ displayName: next });
      setDisplayName(updated.displayName);
      onUserUpdated(updated);
      setNameNote("已保存，房间名同步更新");
    } catch (err) {
      setNameError(messageOf(err));
    } finally {
      setNameBusy(false);
    }
  }

  async function handlePasswordSave(event: FormEvent) {
    event.preventDefault();
    if (passBusy) return;
    setPassError(null);
    setPassNote(null);
    if (!currentPassword || !newPassword) {
      setPassError("请填写当前密码与新密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPassError("两次输入的新密码不一致");
      return;
    }
    setPassBusy(true);
    try {
      const updated = await updateProfile({ currentPassword, newPassword });
      onUserUpdated(updated);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPassNote("密码已更新，其他设备上的登录已退出");
    } catch (err) {
      setPassError(messageOf(err));
    } finally {
      setPassBusy(false);
    }
  }

  return (
    <>
      <div className="profile-card">
        <span className="avatar avatar-lg">{initialOf(user.displayName)}</span>
        <div className="profile-id">
          <strong>{user.displayName}</strong>
          <span>@{user.username}</span>
        </div>
        <span className={`role-pill ${user.role}`}>
          {user.role === "admin" ? "管理员" : "成员"}
        </span>
      </div>

      <dl className="profile-meta">
        <div>
          <dt>主智能体</dt>
          <dd>{user.mainAgentId}</dd>
        </div>
        <div>
          <dt>房间</dt>
          <dd>{roomName}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{new Date(user.createdAt).toLocaleDateString()}</dd>
        </div>
      </dl>

      <form className="settings-form" onSubmit={(event) => void handleNameSave(event)}>
        <div className="section-label">基本资料</div>
        <label className="field">
          <span>显示名称</span>
          <input
            value={displayName}
            maxLength={24}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>用户名</span>
          <input value={`@${user.username}`} disabled />
        </label>
        {nameError && <p className="form-error">{nameError}</p>}
        {nameNote && <p className="form-note">{nameNote}</p>}
        <div className="modal-actions">
          <button className="btn primary" type="submit" disabled={nameBusy}>
            {nameBusy ? "保存中…" : "保存资料"}
          </button>
          <span className="hint">用户名不可修改；显示名称会同步更新房间名。</span>
        </div>
      </form>

      <form className="settings-form" onSubmit={(event) => void handlePasswordSave(event)}>
        <div className="section-label">修改密码</div>
        <label className="field">
          <span>当前密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>确认新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
        </div>
        {passError && <p className="form-error">{passError}</p>}
        {passNote && <p className="form-note">{passNote}</p>}
        <div className="modal-actions">
          <button className="btn primary" type="submit" disabled={passBusy}>
            {passBusy ? "更新中…" : "更新密码"}
          </button>
          <span className="hint">至少 8 位；更新后其他设备需要重新登录。</span>
        </div>
      </form>
    </>
  );
}

function ModelSection({
  settings,
  onSaved,
}: {
  settings: MaskedSettings;
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
      setMessage(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (!provider) return <p className="hint">没有可用的模型 provider。</p>;

  return (
    <div className="settings-form">
      <div className="section-label">模型服务</div>
      <label className="field">
        <span>Provider</span>
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
          <label className="field">
            <span>Base URL</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label className="field">
            <span>模型</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <label className="field">
            <span>
              API Key
              {provider.hasApiKey ? <em>（已保存，留空保持不变）</em> : null}
            </span>
            <input
              type="password"
              value={apiKey}
              placeholder="sk-…"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </>
      )}
      <div className="modal-actions">
        <button className="btn primary" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "保存中…" : "保存"}
        </button>
        {message && <span className="form-note">{message}</span>}
      </div>
      <p className="hint">
        Key 只保存在你自己的 data/workspaces 目录下（已 gitignore），其他账号看不到。演示桩模式不需要
        Key。
      </p>
    </div>
  );
}

function AppearanceSection({
  theme,
  onThemeChange,
}: {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}) {
  return (
    <div className="settings-form">
      <div className="section-label">主题</div>
      <div className="theme-options">
        <button
          type="button"
          className={`theme-option${theme === "light" ? " active" : ""}`}
          onClick={() => onThemeChange("light")}
        >
          <span className="theme-preview light" />
          <span className="theme-option-label">
            浅色
            {theme === "light" && <span className="chip accent">当前</span>}
          </span>
        </button>
        <button
          type="button"
          className={`theme-option${theme === "dark" ? " active" : ""}`}
          onClick={() => onThemeChange("dark")}
        >
          <span className="theme-preview dark" />
          <span className="theme-option-label">
            深色
            {theme === "dark" && <span className="chip accent">当前</span>}
          </span>
        </button>
      </div>
      <p className="hint">主题偏好只保存在本机浏览器，不影响其他账号。</p>
    </div>
  );
}
