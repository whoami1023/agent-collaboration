import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type {
  Member,
  PublicUser,
  RoomEvent,
  RoomMessage,
  RoomMode,
  SessionArchiveDetail,
  SessionArchiveSummary,
  TaskCard,
} from "../../src/core/types";
import { Icon, type IconName } from "./icons";
import {
  LAYOUT_KEY,
  PANE_STEP,
  PANEL_MIN,
  SIDEBAR_MIN,
  clampTo,
  defaultPanes,
  fitPanes,
  panelMax,
  pickStoredPanes,
  preferredPanelWidth,
  sidebarMax,
  type PaneName,
  type PaneWidths,
} from "./layout";
import SkillLibraryPanel from "./SkillLibrary";
import {
  buildContextReport,
  buildHelpReport,
  buildStatusReport,
  getSlashQuery,
  parseSlashCommand,
  suggestSlashCommands,
  type CommandData,
} from "./commands";
import {
  ApiError,
  cancelAllMembers,
  cancelMember,
  clearMessages,
  createMember,
  createTask,
  createUser,
  createWorkspaceFolder,
  deleteArchive,
  deleteWorkspaceFile,
  fetchArchive,
  fetchArchives,
  fetchBootstrap,
  fetchMe,
  fetchMemberFileContent,
  fetchMemberFiles,
  fetchMemberSkills,
  fetchState,
  fetchWorkspaceFile,
  fetchWorkspaceFiles,
  fetchWorkspaceRichPreview,
  listUsers,
  loginUser,
  logoutUser,
  patchTask,
  removeMember,
  resetUserPassword,
  restoreArchive,
  saveMemberFile,
  saveMemberSkills,
  saveSettings,
  sendMessage,
  setRoomMode,
  setupAdmin,
  subscribeEvents,
  updateProfile,
  uploadWorkspaceFile,
  workspaceFileDownloadUrl,
  type AgentFileContent,
  type AgentFileEntry,
  type MaskedSettings,
  type MemberSkillsView,
  type StateSnapshot,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
  type WorkspaceRichPreviewResponse,
} from "./api";
import MarkdownText, { hasMarkdownStructure, visibleMessageText } from "./markdown/MarkdownText";
import { CsvPreview, RichPreviewBody } from "./FilePreviews";

type ThemeMode = "light" | "dark";
type SettingsTab = "profile" | "model" | "appearance";
/** 右侧面板的三个视图：任务看板、文件工作区、归档区。 */
type RightTab = "tasks" | "files" | "archives";

const THEME_KEY = "ac_theme";

function readStoredPanes(): PaneWidths | null {
  try {
    return pickStoredPanes(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return null;
  }
}

function readPanes(): PaneWidths {
  const vw = window.innerWidth;
  return fitPanes(vw, readStoredPanes() ?? defaultPanes(vw));
}

function writePanes(next: PaneWidths): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  } catch {
    // storage can be unavailable in private mode
  }
}

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

/** 技能授权比较：null 表示「全部」，与显式列出的全部技能视为不同（新技能是否自动启用不同）。 */
function sameSkillSet(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
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

/** 右侧面板三个视图的显示名与图标，标签栏、顶栏切换和收起按钮共用一份。 */
const RIGHT_TAB_META: Record<RightTab, { title: string; icon: IconName }> = {
  tasks: { title: "任务看板", icon: "columns" },
  files: { title: "文件工作区", icon: "folder" },
  archives: { title: "归档区", icon: "archive" },
};

function rightTabTitle(tab: RightTab): string {
  return RIGHT_TAB_META[tab].title;
}

/** 归档时间：同一天只显示时刻，跨天补上日期，列表按新到旧排。 */
function archiveStamp(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `今天 ${clock(ts)}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${month}-${day} ${clock(ts)}`;
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
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [clearingChat, setClearingChat] = useState(false);
  const [commandOutput, setCommandOutput] = useState<{ title: string; body: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [usersOpen, setUsersOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(() => {
    try {
      return localStorage.getItem("ac_skills") === "1";
    } catch {
      return false;
    }
  });
  const [membersOpen, setMembersOpen] = useState(true);
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
  const [rightTab, setRightTab] = useState<RightTab>(() => {
    try {
      const stored = localStorage.getItem("ac_right_tab");
      return stored === "files" || stored === "archives" ? stored : "tasks";
    } catch {
      return "tasks";
    }
  });
  const [archives, setArchives] = useState<SessionArchiveSummary[] | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [openArchiveId, setOpenArchiveId] = useState<string | null>(null);
  const [archiveDetail, setArchiveDetail] = useState<SessionArchiveDetail | null>(null);
  const [archiveDetailError, setArchiveDetailError] = useState<string | null>(null);
  const [restoringArchive, setRestoringArchive] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[] | null>(null);
  const [workspaceFilesTruncated, setWorkspaceFilesTruncated] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  /** 文件工作区当前浏览的目录（"" = 根目录）；上传与新建目录都落在这里。 */
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [openWorkspacePath, setOpenWorkspacePath] = useState<string | null>(null);
  const [workspaceFileContent, setWorkspaceFileContent] = useState<WorkspaceFileContent | null>(null);
  const [workspaceFileContentError, setWorkspaceFileContentError] = useState<string | null>(null);
  const [workspaceRichPreview, setWorkspaceRichPreview] =
    useState<WorkspaceRichPreviewResponse | null>(null);
  const [workspaceRichPreviewError, setWorkspaceRichPreviewError] = useState<string | null>(null);
  const [workspaceFileSeq, setWorkspaceFileSeq] = useState(0);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const workspaceFileInput = useRef<HTMLInputElement | null>(null);
  const [panes, setPanes] = useState<PaneWidths>(readPanes);
  const [draggedPane, setDraggedPane] = useState<PaneName | null>(null);
  const panesRef = useRef<PaneWidths>(panes);
  const endDragRef = useRef<(() => void) | null>(null);
  /** 打开文件预览时临时加宽右栏的记录；用户在预览期间手动改过宽度就不再自动还原。 */
  const previewFitRef = useRef<{ from: number; overridden: boolean } | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [newMemberOpen, setNewMemberOpen] = useState(false);
  const [agentFiles, setAgentFiles] = useState<AgentFileEntry[] | null>(null);
  const [agentFileError, setAgentFileError] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<AgentFileContent | null>(null);
  const [fileContentSeq, setFileContentSeq] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
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
    try {
      localStorage.setItem("ac_skills", skillsOpen ? "1" : "0");
    } catch {
      // storage can be unavailable in private mode
    }
  }, [skillsOpen]);

  useEffect(() => {
    if (!chatNotice) return;
    const timer = setTimeout(() => setChatNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [chatNotice]);

  useEffect(() => {
    try {
      localStorage.setItem("ac_right_tab", rightTab);
    } catch {
      // storage can be unavailable in private mode
    }
  }, [rightTab]);

  // 拖拽回调要在下一次渲染前就读到最新宽度，所以把 state 镜像到 ref。
  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    // 以存下的宽度意图重新适配：窗口先缩小再放大时，栏宽能回到用户设定的值。
    const handleResize = () => {
      const vw = window.innerWidth;
      const intent = readStoredPanes() ?? panesRef.current;
      const fitted = previewFitRef.current
        ? { ...intent, panel: Math.max(intent.panel, preferredPanelWidth(vw)) }
        : intent;
      commitPanes(fitPanes(vw, fitted));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /**
   * 预览文件时右栏才是主角：自动升到最优预览宽度（只加宽、不写进用户存下的布局），
   * 关闭预览后还原；期间用户手动拖过/重置过就尊重手动结果。
   */
  useEffect(() => {
    const vw = window.innerWidth;
    if (!openWorkspacePath) {
      const fit = previewFitRef.current;
      previewFitRef.current = null;
      if (!fit || fit.overridden) return;
      const current = panesRef.current;
      if (current.panel === fit.from) return;
      commitPanes(fitPanes(vw, { ...current, panel: fit.from }));
      return;
    }
    if (previewFitRef.current) return;
    const current = panesRef.current;
    const optimal = fitPanes(vw, { ...current, panel: preferredPanelWidth(vw) }).panel;
    if (current.panel >= optimal) return;
    previewFitRef.current = { from: current.panel, overridden: false };
    commitPanes({ ...current, panel: optimal });
  }, [openWorkspacePath]);

  useEffect(() => {
    if (!draggedPane) return;
    document.body.classList.add("pane-dragging");
    return () => document.body.classList.remove("pane-dragging");
  }, [draggedPane]);

  useEffect(() => () => endDragRef.current?.(), []);

  function commitPanes(next: PaneWidths) {
    panesRef.current = next;
    setPanes(next);
  }

  function resizePane(pane: PaneName, rawWidth: number) {
    const vw = window.innerWidth;
    const current = panesRef.current;
    if (pane === "panel" && previewFitRef.current) previewFitRef.current.overridden = true;
    // 拖动时以另一栏的现有宽度为上限，不顺手把对方压到最小。
    const min = pane === "sidebar" ? SIDEBAR_MIN : PANEL_MIN;
    const max = pane === "sidebar" ? sidebarMax(vw, current) : panelMax(vw, current);
    const next = fitPanes(vw, { ...current, [pane]: Math.round(clampTo(rawWidth, min, max)) });
    if (next.sidebar === current.sidebar && next.panel === current.panel) return;
    commitPanes(next);
  }

  function handlePanePointerDown(pane: PaneName, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panesRef.current[pane];
    // 监听挂在 window 上而不是 setPointerCapture：指针越出 9px 命中区甚至离开窗口时仍然跟手。
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      endDragRef.current = null;
      setDraggedPane(null);
      writePanes(panesRef.current);
    };
    function move(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      // 右边界在面板左边，向左拖才是「右边变大」，方向取反。
      resizePane(pane, pane === "sidebar" ? startWidth + delta : startWidth - delta);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    endDragRef.current = stop;
    setDraggedPane(pane);
  }

  function handlePaneKeyDown(pane: PaneName, event: ReactKeyboardEvent<HTMLButtonElement>) {
    const grow = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (grow === 0 && event.key !== "Home") return;
    event.preventDefault();
    const current = panesRef.current;
    if (event.key === "Home") {
      previewFitRef.current = null;
      const next = fitPanes(window.innerWidth, defaultPanes(window.innerWidth));
      commitPanes(next);
      writePanes(next);
      return;
    }
    // 右边界在面板左侧：ArrowLeft 让面板变宽。
    const direction = pane === "sidebar" ? grow : -grow;
    resizePane(pane, current[pane] + direction * PANE_STEP);
    writePanes(panesRef.current);
  }

  function resetPaneWidth(pane: PaneName) {
    resizePane(pane, defaultPanes(window.innerWidth)[pane]);
    writePanes(panesRef.current);
  }

  const refreshArchives = useCallback(async () => {
    try {
      setArchives(await fetchArchives());
      setArchivesError(null);
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setArchivesError(messageOf(err));
    }
  }, [onSessionLost]);

  /** 归档与恢复都会整体替换会话内容（消息、任务卡、文件），一律以服务端为准重新拉一份视图。 */
  const reloadSession = useCallback(async () => {
    setRuns({});
    try {
      setState(await fetchState());
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
    await refreshArchives();
  }, [onSessionLost, refreshArchives]);

  useEffect(() => {
    if (!openArchiveId) {
      setArchiveDetail(null);
      setArchiveDetailError(null);
      return;
    }
    let alive = true;
    setArchiveDetail(null);
    setArchiveDetailError(null);
    fetchArchive(openArchiveId)
      .then((detail) => {
        if (alive) setArchiveDetail(detail);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) onSessionLost();
        else setArchiveDetailError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, [openArchiveId, onSessionLost]);

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
      if (event.type === "messages-cleared") setRuns({});
      if (event.type === "session-archived" || event.type === "session-restored") void reloadSession();
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
  }, [onSessionLost, reloadSession]);

  const messages = state?.messages ?? [];
  const members = state?.members ?? [];
  const tasks = state?.tasks ?? [];
  const roomMode = state?.room.mode ?? "delegate";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, runs]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) map.set(member.id, member.name);
    return map;
  }, [members]);

  const selectedMember = members.find((member) => member.id === selectedMemberId);
  const inWarRoom = !skillsOpen && !newMemberOpen && !selectedMember;
  /** 技能库 / 智能体文件 / 新建成员独占右侧整块区域：此时连作战室（群聊）一起收起。 */
  const takeover = skillsOpen || newMemberOpen || Boolean(selectedMember);
  const panelVisible = boardOpen || takeover;
  const runningCount = members.filter((member) => member.status === "running").length;
  const workspaceFileCount =
    workspaceFiles?.filter((file) => file.kind === "file").length ?? null;

  const refreshWorkspaceFiles = useCallback(async () => {
    setWorkspaceFilesLoading(true);
    try {
      const listing = await fetchWorkspaceFiles();
      setWorkspaceFiles(listing.files);
      setWorkspaceFilesTruncated(listing.truncated);
      setWorkspaceFilesError(null);
      return listing.files;
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionLost();
      } else {
        setWorkspaceFilesError(messageOf(err));
      }
      return null;
    } finally {
      setWorkspaceFilesLoading(false);
    }
  }, [onSessionLost]);

  // 打开「文件」标签、面板重新展开或群里来了新消息（智能体可能刚写出成果）时刷新清单。
  useEffect(() => {
    if (rightTab !== "files" || !boardOpen) return;
    void refreshWorkspaceFiles();
  }, [rightTab, boardOpen, messages.length, refreshWorkspaceFiles]);

  // 归档列表只在「归档」标签可见时拉取：切标签、展开面板或别的入口刚做完归档都会走到这里。
  useEffect(() => {
    if (rightTab !== "archives" || !boardOpen) return;
    void refreshArchives();
  }, [rightTab, boardOpen, refreshArchives]);

  // 当前目录被删除（或改名）后回退到最近的仍存在的上级目录。
  useEffect(() => {
    if (!workspaceDir || !workspaceFiles) return;
    let next = workspaceDir;
    while (
      next &&
      !workspaceFiles.some((entry) => entry.path === next && entry.kind === "dir")
    ) {
      next = next.includes("/") ? next.slice(0, next.lastIndexOf("/")) : "";
    }
    if (next !== workspaceDir) setWorkspaceDir(next);
  }, [workspaceDir, workspaceFiles]);

  useEffect(() => {
    if (!openWorkspacePath) {
      setWorkspaceFileContent(null);
      setWorkspaceFileContentError(null);
      return;
    }
    let alive = true;
    setWorkspaceFileContent(null);
    setWorkspaceFileContentError(null);
    fetchWorkspaceFile(openWorkspacePath)
      .then((file) => {
        if (alive) setWorkspaceFileContent(file);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) onSessionLost();
        else setWorkspaceFileContentError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, [openWorkspacePath, workspaceFileSeq, onSessionLost]);

  /** DOCX/XLSX 需要服务端解析，按打开的文件单独加载；CSV/PDF 不走这里。 */
  useEffect(() => {
    if (!openWorkspacePath || !isRichPreviewFile(openWorkspacePath)) {
      setWorkspaceRichPreview(null);
      setWorkspaceRichPreviewError(null);
      return;
    }
    let alive = true;
    setWorkspaceRichPreview(null);
    setWorkspaceRichPreviewError(null);
    fetchWorkspaceRichPreview(openWorkspacePath)
      .then((data) => {
        if (alive) setWorkspaceRichPreview(data);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (isUnauthorized(err)) onSessionLost();
        else setWorkspaceRichPreviewError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, [openWorkspacePath, workspaceFileSeq, onSessionLost]);

  function openWorkspaceFile(path: string) {
    setOpenWorkspacePath(path);
    setWorkspaceFileSeq((seq) => seq + 1);
  }

  function closeWorkspacePreview() {
    setOpenWorkspacePath(null);
  }

  function reloadWorkspaceFile() {
    setWorkspaceFileSeq((seq) => seq + 1);
  }

  async function handleCreateWorkspaceFolder(path: string): Promise<boolean> {
    setUploadNotice(null);
    setWorkspaceFilesError(null);
    try {
      const folder = await createWorkspaceFolder(path);
      await refreshWorkspaceFiles();
      setUploadNotice(`已新建目录：${folder.path}`);
      return true;
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setWorkspaceFilesError(messageOf(err));
      return false;
    }
  }

  async function handleDeleteWorkspaceEntry(entry: { path: string; name: string; kind: "file" | "dir" }) {
    const what = entry.kind === "dir" ? `目录「${entry.name}」` : `文件「${entry.name}」`;
    if (!window.confirm(`确定删除${what}吗？删除后智能体也无法再读取。`)) return;
    setDeletingFilePath(entry.path);
    setUploadNotice(null);
    setWorkspaceFilesError(null);
    try {
      await deleteWorkspaceFile(entry.path);
      if (openWorkspacePath === entry.path) setOpenWorkspacePath(null);
      await refreshWorkspaceFiles();
      setUploadNotice(`已删除：${entry.path}`);
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setWorkspaceFilesError(messageOf(err));
    } finally {
      setDeletingFilePath(null);
    }
  }

  async function handleUploadFiles(input: FileList | File[], dir = "") {
    const picked = Array.from(input);
    if (picked.length === 0) return;
    const targetFor = (file: File) => (dir ? `${dir}/${file.name}` : file.name);
    setUploadingFiles(true);
    setUploadNotice(null);
    setWorkspaceFilesError(null);
    try {
      const uploaded: WorkspaceFileEntry[] = [];
      const conflicts: File[] = [];
      const failures: string[] = [];
      for (const file of picked) {
        try {
          uploaded.push(await uploadWorkspaceFile(file, { path: targetFor(file) }));
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) conflicts.push(file);
          else if (isUnauthorized(err)) {
            onSessionLost();
            return;
          } else failures.push(`${file.name}：${messageOf(err)}`);
        }
      }
      if (conflicts.length > 0) {
        const names = conflicts.map((file) => file.name).join("、");
        if (window.confirm(`文件工作区已有同名文件：\n${names}\n\n要覆盖吗？`)) {
          for (const file of conflicts) {
            try {
              uploaded.push(
                await uploadWorkspaceFile(file, { path: targetFor(file), overwrite: true }),
              );
            } catch (err) {
              failures.push(`${file.name}：${messageOf(err)}`);
            }
          }
        } else {
          failures.push(`已跳过同名文件：${names}`);
        }
      }
      if (failures.length > 0) setWorkspaceFilesError(failures.join("；"));
      setRightTab("files");
      setBoardOpen(true);
      await refreshWorkspaceFiles();
      if (uploaded.length > 0) {
        setUploadNotice(
          `已上传 ${uploaded.length} 个文件：${uploaded.map((entry) => entry.name).join("、")}${dir ? `（${dir}/）` : ""}。在群里 @成员，就能让它用 file_read 读取。`,
        );
        openWorkspaceFile(uploaded[0]!.path);
      }
    } finally {
      setUploadingFiles(false);
    }
  }

  function commandData(): CommandData {
    return {
      roomName: state?.room.name ?? "作战室",
      mode: roomMode,
      members,
      messages,
      tasks,
      settings: state?.settings ?? null,
      workspaceFileCount,
    };
  }

  async function handleRoomMode(mode: RoomMode) {
    if (!state || state.room.mode === mode) return;
    setError(null);
    try {
      const room = await setRoomMode(mode);
      setState((current) =>
        current ? { ...current, room: { ...current.room, mode: room.mode } } : current,
      );
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleStopAll() {
    if (runningCount === 0) {
      setCommandOutput({ title: "停止运行", body: "当前没有正在运行的成员。" });
      return;
    }
    setError(null);
    try {
      const cancelled = await cancelAllMembers();
      setCommandOutput({
        title: "停止运行",
        body:
          cancelled > 0
            ? `已中止 ${cancelled} 个正在运行的成员。`
            : "没有找到可中止的运行，可能刚刚已经结束。",
      });
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
  }

  async function runSlashCommand(name: string, args: string) {
    if (args && name !== "help") {
      setCommandOutput({
        title: `/${name}`,
        body: `/${name} 不接受参数。用法：/${name}`,
      });
      return;
    }
    switch (name) {
      case "clear":
        setCommandOutput(null);
        await handleClearChat();
        return;
      case "stop":
        await handleStopAll();
        return;
      case "status":
        setCommandOutput({ title: "作战室状态", body: buildStatusReport(commandData()) });
        return;
      case "context":
        setCommandOutput({ title: "上下文", body: buildContextReport(commandData()) });
        return;
      default:
        setCommandOutput({ title: "可用命令", body: buildHelpReport() });
    }
  }

  async function handleClearChat() {
    if (clearingChat) return;
    const runningNote =
      runningCount > 0 ? `\n\n正在运行的 ${runningCount} 个智能体会先被中止本轮回复。` : "";
    const confirmed = window.confirm(
      `确定清空当前作战室吗？聊天记录、任务卡与文件工作区里的成果会整体归档，随时可以在右侧「归档」里恢复。${runningNote}\n\n智能体记忆（MEMORY.md、USER.md、memory/）与成员档案不进归档，也不受影响。`,
    );
    if (!confirmed) return;
    setClearingChat(true);
    setError(null);
    try {
      const result = await clearMessages();
      setState((current) =>
        current ? { ...current, messages: [], tasks: [] } : current,
      );
      setRuns({});
      // 文件工作区里的顶层成果被整体移进了归档，当前打开的预览也不再存在。
      closeWorkspacePreview();
      await Promise.all([refreshArchives(), refreshWorkspaceFiles()]);
      if (result.archived) {
        // 刚存好的归档直接展开，用户一眼能看到自己清掉了什么。
        setRightTab("archives");
        setOpenArchiveId(result.archived.id);
      }
      setChatNotice(
        result.archived
          ? `已归档 ${result.archived.messageCount} 条消息、${result.archived.taskCount} 张任务卡、${
              result.archived.fileCount
            } 个文件${
              result.cancelled > 0 ? `，并中止了 ${result.cancelled} 个正在运行的成员` : ""
            }；作战室已清空，可在右侧「归档」恢复。`
          : "作战室本来就是空的，没有生成归档。",
      );
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    } finally {
      setClearingChat(false);
    }
  }

  async function handleRestoreArchive(archive: SessionArchiveSummary) {
    if (restoringArchive) return;
    const confirmed = window.confirm(
      `恢复这份归档？会放回 ${archive.messageCount} 条消息、${archive.taskCount} 张任务卡、${archive.fileCount} 个文件。\n\n当前作战室的内容先自动存成一份新归档，所以这一步不会丢东西。`,
    );
    if (!confirmed) return;
    setRestoringArchive(true);
    setError(null);
    try {
      const result = await restoreArchive(archive.id);
      // 恢复会整体替换消息、任务卡与文件工作区：以服务端为准重拉一遍，别再留旧预览。
      closeWorkspacePreview();
      setOpenArchiveId(null);
      await Promise.all([reloadSession(), refreshWorkspaceFiles()]);
      setChatNotice(
        `已恢复 ${result.archive.messageCount} 条消息、${result.archive.taskCount} 张任务卡、${result.restoredFiles.length} 个文件` +
          (result.autoArchived ? "；清空前的内容已另存为新归档" : "") +
          (result.conflicts.length > 0
            ? `；${result.conflicts.length} 个同名文件保留了当前版本，未覆盖`
            : "") +
          "。",
      );
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    } finally {
      setRestoringArchive(false);
    }
  }

  async function handleDeleteArchive(archive: SessionArchiveSummary) {
    const confirmed = window.confirm(
      `删除这份归档？其中的 ${archive.messageCount} 条消息、${archive.taskCount} 张任务卡与 ${archive.fileCount} 个文件会被永久移除，无法再恢复。`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      await deleteArchive(archive.id);
      if (openArchiveId === archive.id) setOpenArchiveId(null);
      await refreshArchives();
      setChatNotice("已删除归档。");
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
  }

  const slashQuery = getSlashQuery(draft);
  const slashSuggestions = slashQuery === null ? [] : suggestSlashCommands(slashQuery);
  const slashMenuOpen = !suggestDismissed && slashSuggestions.length > 0;
  const slashActiveIndex =
    slashSuggestions.length > 0 ? Math.min(suggestIndex, slashSuggestions.length - 1) : 0;
  const slashActive = slashSuggestions[slashActiveIndex];

  function applySlashCompletion(name: string) {
    setDraft(`/${name}`);
    setSuggestDismissed(true);
    setSuggestIndex(0);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || clearingChat) return;
    const parsed = parseSlashCommand(text);
    if (parsed) {
      setDraft("");
      if (parsed.kind === "unknown") {
        setError(`未知命令 /${parsed.name}，输入 /help 查看可用命令。`);
        return;
      }
      setError(null);
      await runSlashCommand(parsed.command.name, parsed.args);
      return;
    }
    setDraft("");
    setError(null);
    setCommandOutput(null);
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

  async function handleRemoveMember(member: Member) {
    const confirmed = window.confirm(
      `移除成员 @${member.name}？\n\n它会从群聊成员中移除，名下任务改为未指派，它的智能体文件（agents 目录）会一并删除；历史消息保留。`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      await removeMember(member.id);
      setState((current) =>
        current
          ? { ...current, members: current.members.filter((item) => item.id !== member.id) }
          : current,
      );
      setRuns((current) => {
        if (!(member.id in current)) return current;
        const copy = { ...current };
        delete copy[member.id];
        return copy;
      });
      if (selectedMemberId === member.id) setSelectedMemberId(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  // 点击成员 → 右侧切到「智能体文件」面板；语料与记忆检索同一白名单。
  useEffect(() => {
    if (!selectedMemberId) return;
    let alive = true;
    setAgentFiles(null);
    setAgentFileError(null);
    setOpenFilePath(null);
    setOpenFile(null);
    fetchMemberFiles(selectedMemberId)
      .then((list) => {
        if (!alive) return;
        setAgentFiles(list);
        const first = list[0]?.path ?? null;
        setOpenFilePath(first);
        if (first === null) setOpenFile(null);
      })
      .catch((err: unknown) => {
        if (alive) setAgentFileError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, [selectedMemberId]);

  // 房间来新消息（记忆可能被写入/转录增长）时静默刷新文件清单，保持当前打开的文件。
  useEffect(() => {
    if (!selectedMemberId) return;
    let alive = true;
    fetchMemberFiles(selectedMemberId)
      .then((list) => {
        if (alive) setAgentFiles(list);
      })
      .catch(() => {
        // 静默刷新失败不打扰用户，手动刷新可重试
      });
    return () => {
      alive = false;
    };
  }, [selectedMemberId, messages.length]);

  /** 只刷新清单元信息，不动当前选中的文件。 */
  function refreshFileList() {
    if (!selectedMemberId) return;
    fetchMemberFiles(selectedMemberId)
      .then((list) => setAgentFiles(list))
      .catch((err: unknown) => setAgentFileError(messageOf(err)));
  }

  function reloadAgentFiles() {
    refreshFileList();
    setFileContentSeq((seq) => seq + 1);
  }

  function closeAgentFiles() {
    setSelectedMemberId(null);
  }

  useEffect(() => {
    if (!selectedMemberId || !openFilePath) return;
    let alive = true;
    setOpenFile(null);
    fetchMemberFileContent(selectedMemberId, openFilePath)
      .then((file) => {
        if (alive) setOpenFile(file);
      })
      .catch((err: unknown) => {
        if (alive) setAgentFileError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, [selectedMemberId, openFilePath, fileContentSeq]);

  async function saveOpenFile(path: string, text: string) {
    if (!selectedMemberId) return;
    try {
      await saveMemberFile(selectedMemberId, path, text);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error("服务端还没有文件保存接口（404），请重启服务后重试。");
      }
      throw err;
    }
    setFileContentSeq((seq) => seq + 1);
    refreshFileList();
  }

  /** 编辑长文件时取全文，避免把预览截断后的内容写回覆盖后半部分。 */
  async function loadFullFile(): Promise<string> {
    if (!selectedMemberId || !openFilePath) throw new Error("没有打开的文件");
    const file = await fetchMemberFileContent(selectedMemberId, openFilePath, { full: true });
    return file.content;
  }

  function openAgentFiles(memberId: string) {
    setSelectedMemberId(memberId);
    setNewMemberOpen(false);
    setSkillsOpen(false);
    setBoardOpen(true);
    setNavOpen(false);
  }

  function openNewMember() {
    setNewMemberOpen(true);
    setSelectedMemberId(null);
    setSkillsOpen(false);
    setBoardOpen(true);
    setNavOpen(false);
  }

  function openSkills() {
    setSkillsOpen(true);
    setNewMemberOpen(false);
    setBoardOpen(true);
    setNavOpen(false);
  }

  /** 作战室＝聊天本身：收起右侧的技能库/智能体文件，把焦点还给输入框。 */
  function goToWarRoom() {
    setSkillsOpen(false);
    setNewMemberOpen(false);
    setSelectedMemberId(null);
    setNavOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
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
    <div
      className={`shell${panelVisible ? "" : " board-closed"}${takeover ? " panel-full" : ""}${draggedPane ? " pane-dragging" : ""}`}
      style={{ "--sidebar-w": `${panes.sidebar}px`, "--panel-w": `${panes.panel}px` } as CSSProperties}
    >
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      <PaneResizer
        pane="sidebar"
        value={panes.sidebar}
        min={SIDEBAR_MIN}
        max={sidebarMax(window.innerWidth, panes)}
        dragging={draggedPane === "sidebar"}
        label="拖拽调整左侧成员栏宽度"
        onPointerDown={handlePanePointerDown}
        onKeyDown={handlePaneKeyDown}
        onReset={resetPaneWidth}
      />

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

          <button
            type="button"
            className={`room-entry${inWarRoom ? " active" : ""}`}
            aria-pressed={inWarRoom}
            title="回到群聊与任务看板"
            onClick={goToWarRoom}
          >
            <span className="room-entry-icon">
              <Icon name="chat" size={15} />
            </span>
            <span className="room-entry-text">
              <strong>作战室</strong>
              <small>{user.displayName} 的群聊 · 任务看板</small>
            </span>
            {runningCount > 0 && <span className="room-entry-live">{runningCount} 运行中</span>}
          </button>

          <div className="nav-section">工作区</div>

          <nav className="sidebar-nav" aria-label="功能">
            <button
              type="button"
              className={`nav-item${skillsOpen ? " active" : ""}`}
              aria-pressed={skillsOpen}
              onClick={() => (skillsOpen ? setSkillsOpen(false) : openSkills())}
            >
              <Icon name="book" />
              <span className="nav-label">技能库</span>
              <span className="nav-hint">共享 · 个人 · 导入</span>
            </button>

            <button
              type="button"
              className={`nav-item${newMemberOpen ? " active" : ""}`}
              aria-pressed={newMemberOpen}
              onClick={() => (newMemberOpen ? setNewMemberOpen(false) : openNewMember())}
            >
              <Icon name="plus" />
              <span className="nav-label">新建成员</span>
              <span className="nav-hint">按描述生成档案</span>
            </button>

            <button
              type="button"
              className="nav-item"
              aria-expanded={membersOpen}
              onClick={() => setMembersOpen((open) => !open)}
            >
              <Icon name="users" />
              <span className="nav-label">成员</span>
              <span className="nav-count">{members.length}</span>
              <span className={`chevron${membersOpen ? " up" : ""}`}>
                <Icon name="chevron" />
              </span>
            </button>
          </nav>
          {membersOpen && (
            <ul className="member-list">
            {members.map((member) => (
              <li key={member.id} className={`member-row${selectedMemberId === member.id ? " active" : ""}`}>
                <span className="member-avatar">
                  {initialOf(member.name)}
                  <span className={`status-dot ${member.status}`} />
                </span>
                <button
                  type="button"
                  className="member-main"
                  title="查看该智能体的记忆与相关文件"
                  onClick={() => openAgentFiles(member.id)}
                >
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
                </button>
                {member.status === "running" && (
                  <button className="btn sm" onClick={() => void handleCancel(member.id)}>
                    取消
                  </button>
                )}
                {member.role === "sub" && (
                  <button
                    type="button"
                    className="btn icon ghost danger member-remove"
                    aria-label={`移除成员 @${member.name}`}
                    title="移除成员"
                    onClick={() => void handleRemoveMember(member)}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </li>
            ))}
            </ul>
          )}
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
          className={`mode-pill ${roomMode}`}
          aria-label={`当前${roomMode === "delegate" ? "委派" : "自由交流"}模式，点击切换`}
          title="切换任务完成模式"
          onClick={() => void handleRoomMode(roomMode === "delegate" ? "free" : "delegate")}
        >
          {roomMode === "delegate" ? "委派" : "自由"}
        </button>
        <button
          type="button"
          className="btn icon ghost"
          aria-pressed={boardOpen && rightTab === "files"}
          aria-label="文件工作区"
          title="文件工作区"
          onClick={() => {
            setRightTab("files");
            setBoardOpen(true);
          }}
        >
          <Icon name="folder" />
        </button>
        <button
          type="button"
          className="btn icon ghost"
          aria-pressed={boardOpen}
          aria-label={boardOpen ? "收起右侧面板" : "展开右侧面板"}
          title={boardOpen ? "收起右侧面板" : "展开右侧面板"}
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
          <div className="mode-switch" role="group" aria-label="任务完成模式">
            <button
              type="button"
              className={`mode-option${roomMode === "delegate" ? " active" : ""}`}
              aria-pressed={roomMode === "delegate"}
              title="委派模式：主智能体拆解任务并 @ 成员分派，成员只对分内任务汇报"
              onClick={() => void handleRoomMode("delegate")}
            >
              委派
            </button>
            <button
              type="button"
              className={`mode-option${roomMode === "free" ? " active" : ""}`}
              aria-pressed={roomMode === "free"}
              title="自由交流模式：成员之间可直接 @ 讨论，讨论安静后由主智能体收集并总结"
              onClick={() => void handleRoomMode("free")}
            >
              自由交流
            </button>
          </div>
          {skillsOpen ? (
            <button
              type="button"
              className="btn ghost board-toggle"
              aria-pressed
              aria-controls="skills-panel"
              title="关闭技能库，回到作战室"
              onClick={() => setSkillsOpen(false)}
            >
              <Icon name="book" />
              <span>技能库</span>
              <span className="chip">共享 · 个人</span>
            </button>
          ) : selectedMember ? (
            <button
              type="button"
              className="btn ghost board-toggle"
              aria-pressed
              aria-controls="agent-files-panel"
              title="收起智能体文件，回到作战室"
              onClick={() => setSelectedMemberId(null)}
            >
              <Icon name="inspect" />
              <span>智能体文件</span>
              <span className="chip">@{selectedMember.name}</span>
            </button>
          ) : newMemberOpen ? (
            <button
              type="button"
              className="btn ghost board-toggle"
              aria-pressed
              aria-controls="new-member-panel"
              title="收起新建成员，回到作战室"
              onClick={() => setNewMemberOpen(false)}
            >
              <Icon name="plus" />
              <span>新建成员</span>
              <span className="chip">按描述生成档案</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost board-toggle"
              aria-pressed={boardOpen}
              aria-controls="side-panel"
              title={boardOpen ? "收起右侧面板" : `展开${rightTabTitle(rightTab)}`}
              onClick={() => setBoardOpen((open) => !open)}
            >
              <Icon name={RIGHT_TAB_META[rightTab].icon} />
              <span>{rightTabTitle(rightTab)}</span>
              <span className="chip">
                {rightTab === "files"
                  ? (workspaceFileCount ?? "·")
                  : rightTab === "archives"
                    ? (archives?.length ?? "·")
                    : tasks.length}
              </span>
            </button>
          )}
        </header>

        {error && (
          <div className="error-bar" role="alert">
            {error}
          </div>
        )}

        {chatNotice && (
          <div className="chat-notice" role="status">
            {chatNotice}
          </div>
        )}

        <div className="chat-main">
          {commandOutput && (
            <section className="command-output" aria-label={commandOutput.title}>
              <header>
                <strong>{commandOutput.title}</strong>
                <button
                  type="button"
                  className="command-output-close"
                  aria-label="关闭命令结果"
                  onClick={() => setCommandOutput(null)}
                >
                  <Icon name="close" size={14} />
                </button>
              </header>
              <pre>{commandOutput.body}</pre>
            </section>
          )}
          <div className="messages">
            <div className="messages-inner">
              {messages.length === 0 && (
                <div className="empty-chat">
                  <span className="empty-mark">
                    <Icon name="users" size={18} />
                  </span>
                  <p>在下面发一条消息开始。</p>
                  <p className="empty-sub">
                    {roomMode === "free"
                      ? "自由交流模式下，成员会直接 @ 彼此讨论；讨论安静后主智能体收集并总结。"
                      : "试试「帮我调研多智能体协同的调度方式」，主智能体会拆任务并用 @ 派给子成员。"}
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
                      {run.text ? (
                        <MarkdownText text={run.text} streaming />
                      ) : (
                        <span className="typing">…</span>
                      )}
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
                ref={composerRef}
                value={draft}
                placeholder={`以 ${user.displayName} 的身份发消息… 用 @成员名 指派任务`}
                aria-expanded={slashMenuOpen}
                aria-controls={slashMenuOpen ? "slash-suggest-menu" : undefined}
                aria-activedescendant={
                  slashMenuOpen && slashActive ? `slash-suggest-${slashActive.name}` : undefined
                }
                onChange={(event) => {
                  setDraft(event.target.value);
                  setSuggestDismissed(false);
                  setSuggestIndex(0);
                }}
                onKeyDown={(event) => {
                  if (slashMenuOpen) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const delta = event.key === "ArrowDown" ? 1 : -1;
                      setSuggestIndex(
                        (current) =>
                          (current + delta + slashSuggestions.length) % slashSuggestions.length,
                      );
                      return;
                    }
                    if (event.key === "Tab") {
                      event.preventDefault();
                      if (slashActive) applySlashCompletion(slashActive.name);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSuggestDismissed(true);
                      return;
                    }
                    // 命令尚未输入完整时，Enter 先补全，再按一次才执行，避免误触 /clear、/stop。
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      slashActive &&
                      draft.trim() !== `/${slashActive.name}`
                    ) {
                      event.preventDefault();
                      applySlashCompletion(slashActive.name);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
              />
              {slashMenuOpen && (
                <div className="slash-suggest" id="slash-suggest-menu" role="listbox" aria-label="命令建议">
                  {slashSuggestions.map((command, index) => (
                    <div
                      key={command.name}
                      id={`slash-suggest-${command.name}`}
                      role="option"
                      aria-selected={index === slashActiveIndex}
                      className={`slash-suggest-item${
                        index === slashActiveIndex ? " active" : ""
                      }`}
                      onMouseEnter={() => setSuggestIndex(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applySlashCompletion(command.name)}
                    >
                      <span className="slash-suggest-name">{command.usage}</span>
                      <span className="slash-suggest-desc">{command.summary}</span>
                    </div>
                  ))}
                  <div className="slash-suggest-tip">↑↓ 选择 · Tab 补全 · Enter 执行</div>
                </div>
              )}
              <button
                type="button"
                className="send-btn"
                aria-label="发送消息"
                disabled={!draft.trim() || clearingChat}
                onClick={() => {
                  if (slashMenuOpen && slashActive && draft.trim() !== `/${slashActive.name}`) {
                    applySlashCompletion(slashActive.name);
                    return;
                  }
                  void handleSend();
                }}
              >
                <Icon name="send" />
              </button>
            </div>
            <div className="composer-hint">
              <span>Enter 发送 · Shift+Enter 换行</span>
              <span>@成员名 指派任务</span>
              <span>输入 /help 查看命令</span>
            </div>
          </div>
        </div>
      </main>

      <PaneResizer
        pane="panel"
        value={panes.panel}
        min={PANEL_MIN}
        max={panelMax(window.innerWidth, panes)}
        dragging={draggedPane === "panel"}
        label="拖拽调整右侧面板宽度"
        onPointerDown={handlePanePointerDown}
        onKeyDown={handlePaneKeyDown}
        onReset={resetPaneWidth}
      />

      {skillsOpen ? (
        <aside id="skills-panel" className="board-panel" aria-label="技能库">
          <SkillLibraryPanel onClose={() => setSkillsOpen(false)} />
        </aside>
      ) : selectedMember ? (
        <aside id="agent-files-panel" className="board-panel" aria-label="智能体文件">
          <AgentFilesPanel
            member={{ id: selectedMember.id, name: selectedMember.name }}
            files={agentFiles}
            fileError={agentFileError}
            activePath={openFilePath}
            content={openFile}
            onSelectPath={setOpenFilePath}
            onRefresh={reloadAgentFiles}
            onSave={saveOpenFile}
            onLoadFull={loadFullFile}
            onClose={closeAgentFiles}
          />
        </aside>
      ) : newMemberOpen ? (
        <aside id="new-member-panel" className="board-panel" aria-label="新建成员">
          <NewMemberPanel
            onClose={() => setNewMemberOpen(false)}
            onCreated={(member) => {
              setNewMemberOpen(false);
              openAgentFiles(member.id);
            }}
          />
        </aside>
      ) : (
      <aside
        id="side-panel"
        className="board-panel"
        aria-label="任务、文件与归档"
        inert={!panelVisible}
      >
        <div className="board-sheet">
          <div className="board-head">
            <div className="right-tabs" role="tablist" aria-label="右侧面板">
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "tasks"}
                className={`right-tab${rightTab === "tasks" ? " active" : ""}`}
                onClick={() => setRightTab("tasks")}
              >
                <Icon name="columns" size={14} />
                <span>任务</span>
                <span className="chip">{tasks.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "files"}
                className={`right-tab${rightTab === "files" ? " active" : ""}`}
                onClick={() => setRightTab("files")}
              >
                <Icon name="folder" size={14} />
                <span>文件</span>
                <span className="chip">{workspaceFileCount ?? "·"}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === "archives"}
                className={`right-tab${rightTab === "archives" ? " active" : ""}`}
                onClick={() => setRightTab("archives")}
              >
                <Icon name="archive" size={14} />
                <span>归档</span>
                <span className="chip">{archives?.length ?? "·"}</span>
              </button>
            </div>
            <div className="board-head-actions">
              <button
                type="button"
                className="btn icon ghost board-close"
                aria-label={`收起${rightTabTitle(rightTab)}`}
                title={`收起${rightTabTitle(rightTab)}`}
                onClick={() => setBoardOpen(false)}
              >
                <Icon name="chevronRight" />
              </button>
            </div>
          </div>
          <input
            ref={workspaceFileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              // FileList 是实时的：清空 value 会把它一起清掉，先复制成普通数组。
              const picked = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (picked.length > 0) void handleUploadFiles(picked, workspaceDir);
            }}
          />
          {rightTab === "tasks" ? (
            <>
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
            </>
          ) : rightTab === "archives" ? (
            <ArchivePanel
              archives={archives}
              owners={nameById}
              error={archivesError}
              openId={openArchiveId}
              detail={archiveDetail}
              detailError={archiveDetailError}
              busy={restoringArchive}
              onRefresh={() => void refreshArchives()}
              onToggle={(id) => setOpenArchiveId((current) => (current === id ? null : id))}
              onRestore={(archive) => void handleRestoreArchive(archive)}
              onDelete={(archive) => void handleDeleteArchive(archive)}
            />
          ) : (
            <WorkspaceFilesPanel
              files={workspaceFiles}
              dir={workspaceDir}
              onDirChange={setWorkspaceDir}
              truncated={workspaceFilesTruncated}
              loading={workspaceFilesLoading}
              uploading={uploadingFiles}
              deletingPath={deletingFilePath}
              error={workspaceFilesError}
              notice={uploadNotice}
              activePath={openWorkspacePath}
              content={workspaceFileContent}
              contentError={workspaceFileContentError}
              richPreview={workspaceRichPreview}
              richPreviewError={workspaceRichPreviewError}
              onRefresh={() => void refreshWorkspaceFiles()}
              onPickFiles={() => workspaceFileInput.current?.click()}
              onUpload={(list) => void handleUploadFiles(list, workspaceDir)}
              onOpenFile={openWorkspaceFile}
              onCloseFile={closeWorkspacePreview}
              onReloadFile={reloadWorkspaceFile}
              onDeleteEntry={(entry) => void handleDeleteWorkspaceEntry(entry)}
              onCreateFolder={handleCreateWorkspaceFolder}
            />
          )}
        </div>
      </aside>
      )}

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
    </div>
  );
}

const MARKDOWN_FILE_RE = /\.(md|markdown)$/i;
const CSV_FILE_RE = /\.(csv|tsv)$/i;
const PDF_FILE_RE = /\.pdf$/i;
const RICH_PREVIEW_FILE_RE = /\.(docx|xlsx|xlsm)$/i;

function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_RE.test(path);
}

function isCsvFile(path: string): boolean {
  return CSV_FILE_RE.test(path);
}

function isTabSeparatedFile(path: string): boolean {
  return /\.tsv$/i.test(path);
}

function isPdfFile(path: string): boolean {
  return PDF_FILE_RE.test(path);
}

function isRichPreviewFile(path: string): boolean {
  return RICH_PREVIEW_FILE_RE.test(path);
}

/** 清单是整棵树的递归结果，这里只取某个目录的直接子项。 */
function childEntries(files: WorkspaceFileEntry[], dir: string): WorkspaceFileEntry[] {
  const prefix = dir ? `${dir}/` : "";
  return files
    .filter((entry) => {
      if (!entry.path.startsWith(prefix)) return false;
      const rest = entry.path.slice(prefix.length);
      return rest.length > 0 && !rest.includes("/");
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function WorkspaceFilesPanel({
  files,
  dir,
  onDirChange,
  truncated,
  loading,
  uploading,
  deletingPath,
  error,
  notice,
  activePath,
  content,
  contentError,
  richPreview,
  richPreviewError,
  onRefresh,
  onPickFiles,
  onUpload,
  onOpenFile,
  onCloseFile,
  onReloadFile,
  onDeleteEntry,
  onCreateFolder,
}: {
  files: WorkspaceFileEntry[] | null;
  dir: string;
  onDirChange: (dir: string) => void;
  truncated: boolean;
  loading: boolean;
  uploading: boolean;
  deletingPath: string | null;
  error: string | null;
  notice: string | null;
  activePath: string | null;
  content: WorkspaceFileContent | null;
  contentError: string | null;
  richPreview: WorkspaceRichPreviewResponse | null;
  richPreviewError: string | null;
  onRefresh: () => void;
  onPickFiles: () => void;
  onUpload: (files: FileList | File[]) => void;
  onOpenFile: (path: string) => void;
  onCloseFile: () => void;
  onReloadFile: () => void;
  onDeleteEntry: (entry: { path: string; name: string; kind: "file" | "dir" }) => void;
  onCreateFolder: (path: string) => Promise<boolean>;
}) {
  const [dragging, setDragging] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);

  const entries = useMemo(() => (files ? childEntries(files, dir) : null), [files, dir]);
  const segments = dir ? dir.split("/") : [];
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of files ?? []) {
      const slash = entry.path.lastIndexOf("/");
      if (slash < 0) continue;
      const parent = entry.path.slice(0, slash);
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    return counts;
  }, [files]);

  function cancelFolder() {
    setCreatingFolder(false);
    setFolderDraft("");
  }

  const dragProps = {
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (event.dataTransfer.types.includes("Files")) setDragging(true);
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files.length > 0) onUpload(event.dataTransfer.files);
    },
  };

  if (activePath) {
    return (
      <div className={`workspace-files${dragging ? " dropping" : ""}`} {...dragProps}>
        <div className="workspace-preview">
          <div className="workspace-preview-head">
            <button
              type="button"
              className="btn icon ghost"
              aria-label="返回文件列表"
              title="返回文件列表"
              onClick={onCloseFile}
            >
              <Icon name="back" />
            </button>
            <span className="workspace-preview-path" title={activePath}>
              {activePath}
            </span>
            <button
              type="button"
              className="btn icon ghost"
              aria-label="重新读取"
              title="重新读取"
              onClick={onReloadFile}
            >
              <Icon name="refresh" />
            </button>
            <a
              className="btn icon ghost"
              href={workspaceFileDownloadUrl(activePath)}
              download
              aria-label="下载文件"
              title="下载文件"
            >
              <Icon name="download" />
            </a>
            <button
              type="button"
              className="btn icon ghost workspace-delete"
              aria-label="删除文件"
              title="删除文件"
              disabled={deletingPath !== null}
              onClick={() =>
                onDeleteEntry({
                  path: activePath,
                  name: activePath.split("/").pop() ?? activePath,
                  kind: "file",
                })
              }
            >
              <Icon name="trash" />
            </button>
          </div>
          {content ? (
            <div className="workspace-preview-meta">
              <span>{formatBytes(content.sizeBytes)}</span>
              <span>{clock(content.updatedAt)}</span>
              {content.truncated && !isRichPreviewFile(activePath) && !isPdfFile(activePath) ? (
                <span className="workspace-preview-warn">仅预览开头部分</span>
              ) : null}
            </div>
          ) : null}
          {contentError ? (
            <div className="workspace-preview-body">
              <p className="files-error">{contentError}</p>
              <button type="button" className="btn sm" onClick={onReloadFile}>
                重试
              </button>
            </div>
          ) : !content ? (
            <div className="workspace-preview-body">
              <p className="files-note">正在读取文件…</p>
            </div>
          ) : content.preview === "image" ? (
            <div className="workspace-preview-image-wrap">
              <img
                className="workspace-preview-image"
                src={workspaceFileDownloadUrl(activePath, { inline: true })}
                alt={content.name}
              />
            </div>
          ) : isPdfFile(activePath) ? (
            <div className="workspace-preview-pdf-wrap">
              <iframe
                className="workspace-preview-pdf"
                src={workspaceFileDownloadUrl(activePath, { inline: true })}
                title={`PDF 预览：${content.name}`}
              />
            </div>
          ) : isCsvFile(activePath) ? (
            <CsvPreview text={content.content} tabSeparated={isTabSeparatedFile(activePath)} />
          ) : isRichPreviewFile(activePath) ? (
            richPreview ? (
              <RichPreviewBody
                preview={richPreview.preview}
                downloadUrl={workspaceFileDownloadUrl(activePath)}
              />
            ) : richPreviewError ? (
              <div className="workspace-preview-body">
                <p className="files-error">{richPreviewError}</p>
                <button type="button" className="btn sm" onClick={onReloadFile}>
                  重试
                </button>
              </div>
            ) : (
              <div className="workspace-preview-body">
                <p className="files-note">正在解析文件…</p>
              </div>
            )
          ) : content.preview === "binary" ? (
            <div className="workspace-preview-body">
              <p className="files-empty">
                这是二进制文件（{formatBytes(content.sizeBytes)}），无法直接预览，请下载后查看。
              </p>
              <a className="btn" href={workspaceFileDownloadUrl(activePath)} download>
                <Icon name="download" />
                <span>下载文件</span>
              </a>
            </div>
          ) : isMarkdownFile(activePath) && content.content.trim() ? (
            <div className="workspace-preview-markdown">
              <MarkdownText text={content.content} variant="document" />
            </div>
          ) : (
            <pre className="workspace-preview-text">{content.content || "（空文件）"}</pre>
          )}
        </div>
        {dragging && <div className="workspace-drop-hint">松开即可上传文件</div>}
      </div>
    );
  }

  return (
    <div className={`workspace-files${dragging ? " dropping" : ""}`} {...dragProps}>
      <div className="board-body workspace-files-body">
        <div className="workspace-toolbar">
          <button type="button" className="btn" onClick={onPickFiles} disabled={uploading}>
            <Icon name="upload" />
            <span>{uploading ? "上传中…" : "上传文件"}</span>
          </button>
          <button
            type="button"
            className="btn icon ghost"
            onClick={() => setCreatingFolder(true)}
            disabled={creatingFolder || creatingBusy}
            aria-label="新建目录"
            title="新建目录"
          >
            <Icon name="folderPlus" />
          </button>
          <button
            type="button"
            className="btn icon ghost"
            onClick={onRefresh}
            disabled={loading}
            aria-label="刷新文件"
            title="刷新文件"
          >
            <Icon name="refresh" />
          </button>
          <span className="workspace-count">
            {loading && files === null ? "读取中" : `${entries?.length ?? 0} 项`}
          </span>
        </div>
        <nav className="workspace-breadcrumb" aria-label="目录路径">
          <button
            type="button"
            className={`workspace-crumb${dir ? "" : " current"}`}
            onClick={() => onDirChange("")}
            disabled={!dir}
          >
            <Icon name="folder" size={13} />
            <span>全部文件</span>
          </button>
          {segments.map((segment, index) => {
            const path = segments.slice(0, index + 1).join("/");
            const current = path === dir;
            return (
              <span className="workspace-crumb-group" key={path}>
                <Icon name="chevronRight" size={11} />
                <button
                  type="button"
                  className={`workspace-crumb${current ? " current" : ""}`}
                  onClick={() => onDirChange(path)}
                  aria-current={current ? "page" : undefined}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>
        {creatingFolder && (
          <form
            className="workspace-folder-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = folderDraft.trim().replace(/^\/+|\/+$/g, "");
              if (!name || creatingBusy) return;
              const path = dir ? `${dir}/${name}` : name;
              setCreatingBusy(true);
              void onCreateFolder(path).then((ok) => {
                setCreatingBusy(false);
                if (ok) cancelFolder();
              });
            }}
          >
            <Icon name="folderPlus" />
            <input
              autoFocus
              value={folderDraft}
              placeholder={dir ? `在 ${dir}/ 下新建目录` : "目录名，可多级如 reports/2026"}
              onChange={(event) => setFolderDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelFolder();
              }}
            />
            <button
              className="btn sm"
              type="submit"
              disabled={creatingBusy || !folderDraft.trim()}
            >
              {creatingBusy ? "创建中…" : "创建"}
            </button>
            <button className="btn sm ghost" type="button" onClick={cancelFolder}>
              取消
            </button>
          </form>
        )}
        <p className="workspace-hint">
          点击目录可进入查看；上传文件与新建目录都会放进当前目录。支持拖拽上传，单文件不超过 25 MB。
          智能体通过 file_list / file_read / file_write 使用同一目录。
        </p>
        {notice && <p className="workspace-notice">{notice}</p>}
        {error && <p className="files-error">{error}</p>}
        {files === null && loading && <p className="empty small">正在读取文件…</p>}
        {entries?.length === 0 && (
          <p className="empty small">
            {dir ? "这个目录还是空的，上传文件或新建子目录来整理。" : "还没有文件。上传资料给智能体，或等它写出成果。"}
          </p>
        )}
        {entries?.map((entry) =>
          entry.kind === "dir" ? (
            <div key={entry.path} className="workspace-file-row is-dir">
              <button
                type="button"
                className="workspace-file-open"
                title={`打开目录 ${entry.name}`}
                onClick={() => onDirChange(entry.path)}
              >
                <span className="workspace-file-icon">
                  <Icon name="folder" />
                </span>
                <span className="workspace-file-main">
                  <span className="workspace-file-name">{entry.name}/</span>
                  <span className="workspace-file-meta">{childCounts.get(entry.path) ?? 0} 项</span>
                </span>
                <span className="workspace-dir-arrow">
                  <Icon name="chevronRight" size={14} />
                </span>
              </button>
              <button
                type="button"
                className="btn icon ghost workspace-delete"
                aria-label={`删除目录 ${entry.name}`}
                title={`删除目录 ${entry.name}（仅空目录）`}
                disabled={deletingPath !== null}
                onClick={() => onDeleteEntry(entry)}
              >
                <Icon name="trash" />
              </button>
            </div>
          ) : (
            <div
              key={entry.path}
              className={`workspace-file-row${activePath === entry.path ? " active" : ""}`}
            >
              <button
                type="button"
                className="workspace-file-open"
                title="预览文件"
                onClick={() => onOpenFile(entry.path)}
              >
                <span className="workspace-file-icon">
                  <Icon name="file" />
                </span>
                <span className="workspace-file-main">
                  <span className="workspace-file-name">{entry.name}</span>
                  <span className="workspace-file-meta">
                    {formatBytes(entry.sizeBytes)} · {clock(entry.updatedAt)}
                  </span>
                </span>
              </button>
              <a
                className="btn icon ghost workspace-download"
                href={workspaceFileDownloadUrl(entry.path)}
                download={entry.name}
                aria-label={`下载 ${entry.name}`}
                title={`下载 ${entry.name}`}
              >
                <Icon name="download" />
              </a>
              <button
                type="button"
                className="btn icon ghost workspace-delete"
                aria-label={`删除 ${entry.name}`}
                title={`删除 ${entry.name}`}
                disabled={deletingPath !== null}
                onClick={() => onDeleteEntry(entry)}
              >
                <Icon name="trash" />
              </button>
            </div>
          ),
        )}
        {truncated && <p className="files-note">文件较多，仅显示前 500 项。</p>}
      </div>
      {dragging && <div className="workspace-drop-hint">松开即可上传文件</div>}
    </div>
  );
}

/** 归档区：列出每次 /clear（以及恢复前的自动交换）存下的会话快照，可展开看内容、整体恢复或永久删除。 */
function ArchivePanel({
  archives,
  owners,
  error,
  openId,
  detail,
  detailError,
  busy,
  onRefresh,
  onToggle,
  onRestore,
  onDelete,
}: {
  archives: SessionArchiveSummary[] | null;
  owners: Map<string, string>;
  error: string | null;
  openId: string | null;
  detail: SessionArchiveDetail | null;
  detailError: string | null;
  busy: boolean;
  onRefresh: () => void;
  onToggle: (id: string) => void;
  onRestore: (archive: SessionArchiveSummary) => void;
  onDelete: (archive: SessionArchiveSummary) => void;
}) {
  const items = archives ?? [];
  return (
    <div className="archive-panel">
      <div className="archive-head">
        <p className="files-note">
          /clear 会把群聊记录、任务卡与文件成果整体存成一份归档。恢复时当前内容先自动存成新归档再交换，所以反复恢复也不会丢东西。
        </p>
        <button
          type="button"
          className="btn icon ghost"
          aria-label="刷新归档列表"
          title="刷新归档列表"
          onClick={onRefresh}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="board-body">
        {archives === null && !error && <p className="empty small">正在读取归档…</p>}
        {archives !== null && items.length === 0 && (
          <p className="empty small">还没有归档。在作战室输入 /clear 即可归档当前内容。</p>
        )}
        {items.map((archive) => {
          const isOpen = archive.id === openId;
          return (
            <article key={archive.id} className={`archive-card${isOpen ? " open" : ""}`}>
              <div className="archive-line">
                <button
                  type="button"
                  className="archive-main"
                  aria-expanded={isOpen}
                  onClick={() => onToggle(archive.id)}
                >
                  <span className="archive-title">
                    <Icon name="archive" size={14} />
                    <span>{archive.roomName}</span>
                  </span>
                  <span className="archive-meta">
                    {archiveStamp(archive.createdAt)} · {archive.messageCount} 条消息 ·{" "}
                    {archive.taskCount} 张任务卡 · {archive.fileCount} 个文件 ·{" "}
                    {formatBytes(archive.totalBytes)}
                  </span>
                </button>
                <div className="archive-actions">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    title="把这份归档放回作战室，当前内容会先自动归档"
                    onClick={() => onRestore(archive)}
                  >
                    <Icon name="restore" size={14} />
                    <span>{busy ? "处理中…" : "恢复"}</span>
                  </button>
                  <button
                    type="button"
                    className="btn icon ghost workspace-delete"
                    disabled={busy}
                    aria-label="永久删除这份归档"
                    title="永久删除这份归档"
                    onClick={() => onDelete(archive)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="archive-detail">
                  {detailError && (
                    <p className="form-error" role="alert">
                      {detailError}
                    </p>
                  )}
                  {detail === null && !detailError && <p className="files-note">正在读取归档内容…</p>}
                  {detail && (
                    <>
                      <h4>任务卡</h4>
                      {detail.tasks.length === 0 ? (
                        <p className="files-note">这份归档里没有任务卡。</p>
                      ) : (
                        <ul className="archive-list">
                          {detail.tasks.map((task) => (
                            <li key={task.id}>
                              <span className={`status-chip ${task.status}`}>
                                {statusLabel(task.status)}
                              </span>
                              <span className="archive-list-title">{task.title}</span>
                              <span className="archive-list-meta">
                                {task.ownerId ? `@${owners.get(task.ownerId) ?? "已移除成员"}` : "未指派"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <h4>文件成果</h4>
                      {detail.files.length === 0 ? (
                        <p className="files-note">这份归档里没有文件。</p>
                      ) : (
                        <ul className="archive-list">
                          {detail.files.slice(0, 100).map((file) => (
                            <li key={file.path}>
                              <Icon name="file" size={14} />
                              <span className="archive-list-title" title={file.path}>
                                {file.path}
                              </span>
                              <span className="archive-list-meta">
                                {formatBytes(file.sizeBytes)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {detail.files.length > 100 && (
                        <p className="files-note">文件较多，仅显示前 100 个。</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function AgentFilesPanel({
  member,
  files,
  fileError,
  activePath,
  content,
  onSelectPath,
  onRefresh,
  onSave,
  onLoadFull,
  onClose,
}: {
  member: { id: string; name: string };
  files: AgentFileEntry[] | null;
  fileError: string | null;
  activePath: string | null;
  content: AgentFileContent | null;
  onSelectPath: (path: string) => void;
  onRefresh: () => void;
  onSave: (path: string, text: string) => Promise<void>;
  onLoadFull: () => Promise<string>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSkills, setShowSkills] = useState(false);
  const [skillView, setSkillView] = useState<MemberSkillsView | null>(null);
  // null = 未限制（全部技能）；数组 = 明确勾选的技能名。
  const [skillDraft, setSkillDraft] = useState<string[] | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const skillRequest = useRef(0);

  // 换文件就退出编辑态，免得把上一份草稿写进另一份文件。
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
  }, [content?.path]);

  // 换智能体时丢掉上一份技能视图，避免把 A 的勾选保存给 B。
  useEffect(() => {
    skillRequest.current += 1;
    setSkillView(null);
    setSkillDraft(null);
    setSkillError(null);
    setSkillNotice(null);
    setSkillLoading(false);
  }, [member.id]);

  async function loadSkills() {
    const seq = ++skillRequest.current;
    setSkillLoading(true);
    setSkillError(null);
    try {
      const view = await fetchMemberSkills(member.id);
      if (seq !== skillRequest.current) return;
      setSkillView(view);
      setSkillDraft(view.enabled);
      setSkillNotice(null);
    } catch (err) {
      if (seq !== skillRequest.current) return;
      setSkillError(
        err instanceof ApiError && err.status === 404
          ? "服务端还没有技能授权接口（404），请重启服务后重试。"
          : messageOf(err),
      );
    } finally {
      if (seq === skillRequest.current) setSkillLoading(false);
    }
  }

  useEffect(() => {
    if (!showSkills) return;
    void loadSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSkills, member.id]);

  const skillDirty = skillView !== null && !sameSkillSet(skillDraft, skillView.enabled);
  const enabledSkillCount = skillView
    ? skillDraft === null
      ? skillView.skills.length
      : skillDraft.length
    : 0;

  function toggleSkill(name: string) {
    setSkillNotice(null);
    setSkillDraft((current) => {
      const all = skillView?.skills.map((skill) => skill.name) ?? [];
      if (current === null) return all.filter((item) => item !== name);
      return current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name];
    });
  }

  async function saveSkills() {
    if (!skillView) return;
    setSkillSaving(true);
    setSkillError(null);
    setSkillNotice(null);
    try {
      const view = await saveMemberSkills(member.id, skillDraft);
      setSkillView(view);
      setSkillDraft(view.enabled);
      setSkillNotice("已保存，从该智能体下一次运行开始生效");
    } catch (err) {
      setSkillError(
        err instanceof ApiError && err.status === 404
          ? "服务端还没有技能授权接口（404），请重启服务后重试。"
          : messageOf(err),
      );
    } finally {
      setSkillSaving(false);
    }
  }

  const dirty = editing && content !== null && draft !== content.content;

  async function startEdit() {
    if (!content || loadingFull) return;
    setSaveError(null);
    if (!content.truncated) {
      setDraft(content.content);
      setEditing(true);
      return;
    }
    setLoadingFull(true);
    try {
      setDraft(await onLoadFull());
      setEditing(true);
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setLoadingFull(false);
    }
  }

  function cancelEdit() {
    setEditing(false);
    setSaveError(null);
    setDraft("");
  }

  function pickFile(path: string) {
    if (path === activePath) return;
    if (dirty && !window.confirm("当前文件有未保存的修改，切换后会丢失。继续吗？")) return;
    onSelectPath(path);
  }

  async function save() {
    if (!content) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(content.path, draft);
      setEditing(false);
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="board-sheet files-sheet">
      <div className="board-head">
        <span className="section-label">智能体文件</span>
        <div className="board-head-actions">
          <span className="chip">@{member.name}</span>
          <button
            type="button"
            className={`btn ghost sm${showSkills ? " active" : ""}`}
            aria-pressed={showSkills}
            title={showSkills ? "返回智能体文件" : "勾选这个智能体能使用的技能"}
            onClick={() => setShowSkills((open) => !open)}
          >
            <Icon name="book" />
            <span>技能</span>
          </button>
          {!showSkills && content && !editing && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void startEdit()}
              disabled={loadingFull}
              title={content.truncated ? "载入全文后编辑并保存" : "编辑这份文件"}
            >
              <Icon name="edit" />
              <span>{loadingFull ? "载入全文…" : "编辑"}</span>
            </button>
          )}
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label={showSkills ? "刷新技能清单" : "刷新文件清单"}
            title={showSkills ? "刷新技能清单" : "刷新文件清单"}
            onClick={showSkills ? () => void loadSkills() : onRefresh}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭智能体文件面板"
            title="关闭面板，回到作战室"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      {!showSkills && (
        <div className="files-tabs" role="tablist" aria-label="文件列表">
          {files === null && !fileError && (
            <span className="chip" role="status">
              载入中…
            </span>
          )}
          {fileError && <span className="files-error">{fileError}</span>}
          {files?.map((file) => (
            <button
              key={file.path}
              type="button"
              role="tab"
              aria-selected={activePath === file.path}
              className={`file-tab${activePath === file.path ? " active" : ""}`}
              title={`${file.path} · ${formatBytes(file.sizeBytes)} · ${clock(file.updatedAt)}`}
              onClick={() => pickFile(file.path)}
            >
              {file.path}
            </button>
          ))}
        </div>
      )}
      <div className="board-body files-body">
        {showSkills ? (
          <div className="agent-skills-view">
            <div className="files-path-line">
              <span className="files-path">技能授权</span>
              <span className="files-lines">
                {skillView ? `已启用 ${enabledSkillCount}/${skillView.skills.length}` : ""}
              </span>
            </div>
            {skillLoading && !skillView ? (
              <p className="files-note" role="status">
                载入可用技能…
              </p>
            ) : null}
            {skillError && (
              <p className="files-save-error" role="alert">
                {skillError}
              </p>
            )}
            {skillView && (
              <>
                <label className="agent-skill-row master">
                  <input
                    type="checkbox"
                    checked={skillDraft === null}
                    onChange={(event) => setSkillDraft(event.target.checked ? null : [])}
                  />
                  <span className="agent-skill-main">
                    <span className="agent-skill-name">全部技能</span>
                    <span className="agent-skill-desc">
                      不限制；以后新增的技能也会自动启用
                    </span>
                  </span>
                </label>
                {skillView.skills.length === 0 ? (
                  <p className="files-empty">技能库还是空的，先到「技能库」创建或导入技能。</p>
                ) : (
                  <ul className="agent-skills-list" aria-label="可用技能">
                    {skillView.skills.map((skill) => {
                      const checked = skillDraft === null || skillDraft.includes(skill.name);
                      return (
                        <li key={skill.name}>
                          <label className="agent-skill-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSkill(skill.name)}
                            />
                            <span className="agent-skill-main">
                              <span className="agent-skill-name">
                                {skill.name}
                                {skill.builtin ? <span className="chip">内置</span> : null}
                              </span>
                              <span className="agent-skill-desc">{skill.description}</span>
                            </span>
                            <span className="agent-skill-scope">
                              {skill.scope === "shared" ? "共享" : "个人"}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="files-note">
                  只勾选这个智能体能看到的技能：提示词只列勾选项，use_skill / read_skill_file
                  也会拒绝未勾选的技能。保存后从它下一次运行开始生效。
                </p>
                <div className="files-edit-actions">
                  <span className="files-note">
                    {skillNotice ?? (skillDirty ? "尚未保存" : "已与服务器一致")}
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setSkillDraft(skillView.enabled);
                      setSkillNotice(null);
                      setSkillError(null);
                    }}
                    disabled={!skillDirty || skillSaving}
                  >
                    重置
                  </button>
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => void saveSkills()}
                    disabled={!skillDirty || skillSaving}
                  >
                    <Icon name="check" />
                    <span>{skillSaving ? "保存中…" : "保存"}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        ) : content ? (
          <>
            <div className="files-path-line">
              <span className="files-path">{content.path}</span>
              <span className="files-lines">
                {editing ? `${draft.split("\n").length} 行 · 未保存` : `${content.totalLines} 行`}
              </span>
            </div>
            {editing ? (
              <>
                <textarea
                  className="files-editor"
                  value={draft}
                  spellCheck={false}
                  aria-label={`编辑 ${content.path}`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      if (!saving) void save();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                />
                {saveError && (
                  <p className="files-save-error" role="alert">
                    {saveError}
                  </p>
                )}
                <div className="files-edit-actions">
                  <span className="files-note">Ctrl/⌘+S 保存 · Esc 取消</span>
                  <button type="button" className="btn sm" onClick={cancelEdit} disabled={saving}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => void save()}
                    disabled={saving || !dirty}
                  >
                    <Icon name="check" />
                    <span>{saving ? "保存中…" : "保存"}</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <pre className="files-content">{content.content}</pre>
                {content.truncated && (
                  <p className="files-note">
                    较长文件只预览前 400 行；点「编辑」会载入全文，保存不会丢内容。
                  </p>
                )}
              </>
            )}
            {saveError && !editing && (
              <p className="files-save-error" role="alert">
                {saveError}
              </p>
            )}
          </>
        ) : fileError ? (
          <p className="files-empty">{fileError}</p>
        ) : (
          <p className="files-empty">
            这个工作区还没有可读的智能体文件。首次加载会自动生成 MEMORY.md、USER.md、SOUL.md
            与 IDENTITY.md 模板；若被删除，重新打开房间会再次补齐。
          </p>
        )}
      </div>
    </div>
  );
}

function NewMemberPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (member: Member) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      setError("请先给成员起个名字，群里用 @名字 找它。");
      return;
    }
    if (!trimmedDescription) {
      setError("请描述这个成员负责什么，创建时会据此生成它的智能体文件。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const member = await createMember({ name: trimmedName, description: trimmedDescription });
      onCreated(member);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "服务端还没有新建成员接口（404），请重启服务后重试。"
          : messageOf(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="board-sheet new-member-sheet">
      <div className="board-head">
        <span className="section-label">新建成员</span>
        <div className="board-head-actions">
          <button
            type="button"
            className="btn icon ghost board-close"
            aria-label="关闭新建成员面板"
            title="关闭面板，回到作战室"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="board-body">
        <p className="new-member-hint">
          新建一个子智能体加入成员列表。名字是群里 @ 它的引用；功能描述会写进它的默认智能体文件（SOUL.md
          与 IDENTITY.md）。每个成员还拥有自己的 MEMORY.md 与 USER.md，记忆检索只在该成员自己的范围内命中；创建后都可在「智能体文件」里继续修改。
        </p>
        <form className="new-member-form" onSubmit={submit}>
          <label className="field">
            <span>成员名</span>
            <input
              value={name}
              maxLength={12}
              placeholder="例如：调研员"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <small className="form-note">1-12 个中英文、数字、下划线或短横线</small>
          </label>
          <label className="field">
            <span>功能描述</span>
            <textarea
              value={description}
              maxLength={800}
              rows={7}
              placeholder="例如：负责检索资料并给出带出处的结论；不需要写代码，遇到需要动手的活就说明清楚交给别人。"
              onChange={(event) => setDescription(event.target.value)}
            />
            <small className="form-note">据此生成 SOUL.md 与 IDENTITY.md，最多 800 字</small>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="new-member-actions">
            <button
              className="btn primary"
              type="submit"
              disabled={busy || !name.trim() || !description.trim()}
            >
              {busy ? "创建中…" : "创建成员"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function PaneResizer({
  pane,
  value,
  min,
  max,
  dragging,
  label,
  onPointerDown,
  onKeyDown,
  onReset,
}: {
  pane: PaneName;
  value: number;
  min: number;
  max: number;
  dragging: boolean;
  label: string;
  onPointerDown: (pane: PaneName, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (pane: PaneName, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onReset: (pane: PaneName) => void;
}) {
  return (
    <button
      type="button"
      className={`pane-resizer ${pane === "sidebar" ? "left" : "right"}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${label}：${value} 像素`}
      title="拖动调整宽度 · 方向键 ±16 · Home 或双击恢复默认"
      onPointerDown={(event) => onPointerDown(pane, event)}
      onKeyDown={(event) => onKeyDown(pane, event)}
      onDoubleClick={() => onReset(pane)}
    />
  );
}

function applyEvent(current: StateSnapshot | null, event: RoomEvent): StateSnapshot | null {
  if (!current) return current;
  if (event.type === "messages-cleared") {
    return current.messages.length === 0 ? current : { ...current, messages: [] };
  }
  if (event.type === "tasks-cleared") {
    return current.tasks.length === 0 ? current : { ...current, tasks: [] };
  }
  if (event.type === "mode") {
    if (current.room.mode === event.mode) return current;
    return { ...current, room: { ...current.room, mode: event.mode } };
  }
  if (event.type === "message") {
    if (current.messages.some((message) => message.id === event.message.id)) return current;
    return { ...current, messages: [...current.messages, event.message].slice(-400) };
  }
  if (event.type === "member") {
    return { ...current, members: upsert(current.members, event.member) };
  }
  if (event.type === "member-removed") {
    if (!current.members.some((member) => member.id === event.memberId)) return current;
    return {
      ...current,
      members: current.members.filter((member) => member.id !== event.memberId),
    };
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
  const [source, setSource] = useState(false);
  if (message.senderKind === "system") {
    return <div className="system-line">{message.text}</div>;
  }
  const isUser = message.senderKind === "user";
  // 结构判断以去掉脚手架后的可见正文为准：否则「整段都是 invoke 块」的消息会被当纯文本原样显示。
  const visible = isUser ? "" : visibleMessageText(message.text);
  const renderPreview = !isUser && visible.length > 0;
  const toggleable = renderPreview && (hasMarkdownStructure(visible) || visible !== message.text);
  return (
    <article className={`bubble ${isUser ? "user" : "member"} ${message.kind}`}>
      <header className="bubble-head">
        <span className="sender">{isUser ? "你" : `@${message.senderName}`}</span>
        {message.kind === "announce" && <span className="chip accent">报告</span>}
        {message.taskId && <span className="chip">{message.taskId.slice(0, 12)}</span>}
        {toggleable && (
          <button
            type="button"
            className={`chip markdown-toggle${source ? " active" : ""}`}
            aria-pressed={source}
            onClick={() => setSource((current) => !current)}
          >
            {source ? "预览" : "原文"}
          </button>
        )}
        <span className="time">{clock(message.ts)}</span>
      </header>
      {renderPreview && !source ? (
        <div className="bubble-text">
          <MarkdownText text={message.text} />
        </div>
      ) : renderPreview ? (
        <div className="bubble-text">{visible}</div>
      ) : !isUser ? (
        // 整条消息都是内部脚手架：没有可见内容，不把原始标签摊给用户看。
        <div className="bubble-text">
          <span className="markdown-empty">…</span>
        </div>
      ) : (
        <div className="bubble-text">{message.text}</div>
      )}
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
