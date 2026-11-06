import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type {
  LimitFieldSpec,
  Limits,
  Member,
  PublicUser,
  RoomEvent,
  RoomMessage,
  RoomMode,
  SessionArchiveDetail,
  SessionArchiveSummary,
  TaskCard,
} from "../../src/core/types";
import { DEFAULT_LIMITS, LIMIT_FIELDS, RUN_SCOPE_LABELS } from "../../src/core/types";
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
import TemplateLibraryPanel from "./TemplateLibrary";
import CronPanel from "./CronPanel";
import LearningPanel from "./LearningPanel";
import RoomsPanel from "./RoomsPanel";
import { ModelSettings } from "./ModelSettings";
import {
  buildContextReport,
  buildHelpReport,
  buildModelReport,
  buildStatusReport,
  getSlashQuery,
  parseModelCommand,
  parseSlashCommand,
  suggestSlashCommands,
  type CommandData,
  type SlashCommandDef,
} from "./commands";
import {
  ApiError,
  MAIN_ROOM_ID,
  activeRoom,
  cancelAllMembers,
  cancelMember,
  clearMessages,
  createMember,
  createTask,
  createUser,
  createWorkspaceFolder,
  deleteArchive,
  deleteUser,
  deleteWorkspaceFile,
  fetchArchive,
  fetchArchives,
  fetchBootstrap,
  fetchLearning,
  fetchMe,
  fetchMemberFileContent,
  fetchMemberFiles,
  fetchMemberSkills,
  fetchMemberTemplateDraft,
  fetchRooms,
  fetchState,
  fetchWorkspaceFile,
  fetchWorkspaceFiles,
  fetchWorkspaceRichPreview,
  inviteRoomMember,
  kickRoomMember,
  listUsers,
  loginUser,
  logoutUser,
  patchTask,
  removeMember,
  resetUserPassword,
  restoreActiveRoom,
  restoreArchive,
  saveMemberFile,
  saveMemberSkills,
  saveSettings,
  sendMessage,
  setActiveRoom,
  setMemberModel,
  setRoomMode,
  setupAdmin,
  startNewSession,
  subscribeEvents,
  updateProfile,
  uploadWorkspaceFile,
  workspaceFileDownloadUrl,
  type AgentFileContent,
  type AgentFileEntry,
  type LearningSettings,
  type MaskedSettings,
  type MemberSkillsView,
  type MemberTemplateDraft,
  type RoomFrame,
  type RoomInfo,
  type StateSnapshot,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
  type WorkspaceRichPreviewResponse,
} from "./api";
import MarkdownText, { hasMarkdownStructure, visibleMessageText } from "./markdown/MarkdownText";
import { CsvPreview, RichPreviewBody } from "./FilePreviews";

type ThemeMode = "light" | "dark";
type SettingsTab = "profile" | "model" | "limits" | "learning" | "appearance";
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

/**
 * 别名目标在当前配置里是否真的可用：供应商要存在，写了模型 id 还要已登记且没停用。
 * 内置别名表里 gpt / qwen 这类目标在没配对应供应商时解析不了，别放进成员模型下拉。
 */
function isRefConfigured(settings: MaskedSettings, target: string): boolean {
  const ref = target.trim();
  if (!ref) return false;
  const slash = ref.indexOf("/");
  const providerId = slash < 0 ? ref : ref.slice(0, slash);
  const modelId = slash < 0 ? undefined : ref.slice(slash + 1);
  const provider = settings.providers.find((item) => item.id === providerId);
  if (!provider) return false;
  if (!modelId) return provider.models.length > 0;
  return provider.models.some((model) => model.id === modelId && model.status !== "disabled");
}

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
  const [startingSession, setStartingSession] = useState(false);
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
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [roomsTab, setRoomsTab] = useState<"list" | "members">("list");
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  /** 当前所在房间：页面所有按房间走的请求都跟着它换 `?room=`（见 api.ts 的 withRoom）。 */
  const [activeRoomId, setActiveRoomIdState] = useState(() => {
    try {
      return restoreActiveRoom(localStorage.getItem("ac_room"));
    } catch {
      return restoreActiveRoom(null);
    }
  });
  const [templatesOpen, setTemplatesOpen] = useState(false);
  /** 成员导出的模板草稿：非空时模板库面板直接打开新建表单并预填（用后即清）。 */
  const [memberTemplateDraft, setMemberTemplateDraft] = useState<{
    seed: MemberTemplateDraft;
    memberName: string;
  } | null>(null);
  const [cronOpen, setCronOpen] = useState(false);
  /** 定时任务事件到达时自增：面板据此重新拉取定义与状态，不重挂载（编辑器状态保留）。 */
  const [cronTick, setCronTick] = useState(0);
  const [learningOpen, setLearningOpen] = useState(false);
  /** 复盘事件到达时自增：学习面板据此重拉提案与流水。 */
  const [learningTick, setLearningTick] = useState(0);
  /** 待确认提案数：侧边栏角标，让用户知道「有东西等你确认」。 */
  const [learningPending, setLearningPending] = useState(0);
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

  /** 拉房间清单；当前停留的群聊被删（或换了账号残留了旧 ID）时回落到作战室。 */
  const refreshRooms = useCallback(async () => {
    try {
      const list = await fetchRooms();
      setRooms(list);
      if (activeRoom() !== MAIN_ROOM_ID && !list.some((room) => room.id === activeRoom())) {
        await enterRoom(MAIN_ROOM_ID);
      }
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
  }, [onSessionLost]);

  /** 学习层待确认提案数：侧边栏角标用；复盘事件与面板操作都会重拉。 */
  const refreshLearningPending = useCallback(async () => {
    try {
      const snapshot = await fetchLearning();
      setLearningPending(
        snapshot.proposals.filter((proposal) => proposal.status === "pending").length,
      );
    } catch {
      // 角标只是提示，拉不到就保留上一次的数字，不打扰聊天。
    }
  }, []);

  useEffect(() => {
    void refreshLearningPending();
  }, [refreshLearningPending]);

  /** 群聊区改动了房间（新建/改名/删群/拉人/移人）：列表与当前视图一起刷新。 */
  const syncRoomView = useCallback(async () => {
    await refreshRooms();
    try {
      setState(await fetchState());
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
  }, [refreshRooms, onSessionLost]);

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

    const unsubscribe = subscribeEvents((frame: RoomFrame) => {
      const event = frame.event;
      if (event.type === "rooms-changed") void refreshRooms();
      // 复盘是账号级的事：不管事件来自哪间房，都要刷新角标与学习面板。
      if (event.type === "learning") {
        setLearningTick((tick) => tick + 1);
        void refreshLearningPending();
      }
      // 消息、任务卡、成员进出会改变群聊卡片上的统计；其余事件（运行增量等）不重拉列表。
      const affectsRoomStats =
        event.type === "message" ||
        event.type === "messages-cleared" ||
        event.type === "task" ||
        event.type === "tasks-cleared" ||
        event.type === "member" ||
        event.type === "member-removed" ||
        event.type === "session-archived" ||
        event.type === "session-restored";
      // 别的房间的事件只用来刷新群聊列表上的统计，不碰当前房间的聊天与运行态。
      if (frame.roomId !== activeRoom()) {
        if (affectsRoomStats) void refreshRooms();
        return;
      }
      if (affectsRoomStats) void refreshRooms();
      setState((current) => applyEvent(current, event));
      if (event.type === "messages-cleared") setRuns({});
      if (
        event.type === "cron-job" ||
        event.type === "cron-job-removed" ||
        event.type === "cron-run"
      ) {
        setCronTick((tick) => tick + 1);
      }
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
  }, [onSessionLost, reloadSession, refreshRooms]);

  // 房间清单与状态快照各自独立：群聊区、侧边栏计数与「返回作战室」都靠它。
  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

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
  const inWarRoom =
    !skillsOpen &&
    !roomsOpen &&
    !templatesOpen &&
    !cronOpen &&
    !learningOpen &&
    !newMemberOpen &&
    !selectedMember;
  /** 技能库 / 群聊区 / 模板库 / 定时任务 / 学习 / 智能体文件 / 新建成员独占右侧整块区域：此时连聊天一起收起。 */
  const takeover =
    skillsOpen ||
    roomsOpen ||
    templatesOpen ||
    cronOpen ||
    learningOpen ||
    newMemberOpen ||
    Boolean(selectedMember);
  const isGroupRoom = state?.room.kind === "group";
  /** 文案里的房间称呼：作战室或本群。 */
  const roomLabel = isGroupRoom ? "本群" : "作战室";
  const groupRooms = (rooms ?? []).filter((room) => room.kind === "group");
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

  async function runSlashCommand(command: SlashCommandDef, args: string) {
    if (args && !command.acceptsArgs) {
      setCommandOutput({
        title: `/${command.name}`,
        body: `/${command.name} 不接受参数。用法：${command.usage}`,
      });
      return;
    }
    // 带姿态的命令不本机执行：把议题作为这一轮的消息发出去，服务端按姿态表收窄工具集与唤醒规则。
    if (command.runScope) {
      setCommandOutput(null);
      setError(null);
      try {
        await sendMessage(
          args || "请针对群里最近的用户议题出一份执行计划：先查清现状，再给出可验收的步骤与任务卡。",
          command.runScope,
        );
      } catch (err) {
        setError(messageOf(err));
      }
      return;
    }
    switch (command.name) {
      case "new":
        setCommandOutput(null);
        await handleNewSession();
        return;
      case "clear":
        setCommandOutput(null);
        await handleClearChat();
        return;
      case "stop":
        await handleStopAll();
        return;
      case "model":
        await handleModelCommand(args);
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

  /**
   * /model：不带参数就列清单；带模型引用时改主智能体或指定成员的 modelRef。
   * 服务端会广播 member 事件，所以这里只发请求，成员状态由 SSE 收敛。
   */
  async function handleModelCommand(args: string) {
    const plan = parseModelCommand(args, members);
    if (plan.kind === "list" || !plan.memberId || !plan.ref) {
      const report = buildModelReport(commandData());
      setCommandOutput({ title: "模型", body: plan.error ? `${plan.error}\n\n${report}` : report });
      return;
    }
    const target = members.find((member) => member.id === plan.memberId);
    if (!target) {
      setCommandOutput({ title: "模型", body: buildModelReport(commandData()) });
      return;
    }
    setError(null);
    try {
      const updated = await setMemberModel(plan.memberId, plan.ref);
      setCommandOutput({
        title: "模型",
        body: `已把 @${target.name} 的模型切换为 ${updated.modelRef}。下一轮回复开始生效，进行中的运行不受影响。`,
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        onSessionLost();
        return;
      }
      setCommandOutput({ title: "模型", body: `切换失败：${messageOf(err)}` });
    }
  }

  /**
   * /new：把当前会话（消息+任务卡）归档起来，开一个与之无关的新会话。
   * 文件工作区、成员、智能体记忆都不动，因此不关预览、也不重拉文件列表。
   */
  async function handleNewSession() {
    if (startingSession || clearingChat) return;
    const runningNote =
      runningCount > 0 ? `\n\n正在运行的 ${runningCount} 个智能体会先被中止本轮回复。` : "";
    const confirmed = window.confirm(
      `开启新会话？当前聊天记录与任务卡会归档起来，可在右侧「归档」随时恢复；新会话里的任务与之前无关。${runningNote}\n\n文件工作区、成员与智能体记忆（MEMORY.md、USER.md、memory/）保持不变。`,
    );
    if (!confirmed) return;
    setStartingSession(true);
    setError(null);
    try {
      const result = await startNewSession();
      // 服务端会在新会话里写一条起点提示，直接以服务端为准重拉视图（同时刷新归档列表）。
      await reloadSession();
      if (result.archived) {
        setRightTab("archives");
        setOpenArchiveId(result.archived.id);
      }
      setChatNotice(
        result.archived
          ? `已开启新会话：上一个会话的 ${result.archived.messageCount} 条消息、${result.archived.taskCount} 张任务卡已归档，可在右侧「归档」恢复${
              result.cancelled > 0 ? `，并中止了 ${result.cancelled} 个正在运行的成员` : ""
            }；文件工作区保持不变。`
          : "已开启新会话：之前没有需要归档的内容。",
      );
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    } finally {
      setStartingSession(false);
    }
  }

  async function handleClearChat() {
    if (clearingChat) return;
    const runningNote =
      runningCount > 0 ? `\n\n正在运行的 ${runningCount} 个智能体会先被中止本轮回复。` : "";
    const confirmed = window.confirm(
      isGroupRoom
        ? `确定清空${roomLabel}吗？聊天记录与任务卡会归档，随时可以在右侧「归档」里恢复。${runningNote}\n\n文件工作区是全账号共享的，不会被搬走；智能体记忆与成员档案也不受影响。`
        : `确定清空当前作战室吗？聊天记录、任务卡与文件工作区里的成果会整体归档，随时可以在右侧「归档」里恢复。${runningNote}\n\n智能体记忆（MEMORY.md、USER.md、memory/）与成员档案不进归档，也不受影响。`,
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
      // 作战室的顶层成果被整体移进了归档，当前打开的预览也不再存在；群聊不动文件工作区。
      if (!isGroupRoom) closeWorkspacePreview();
      await Promise.all([
        refreshArchives(),
        isGroupRoom ? Promise.resolve(null) : refreshWorkspaceFiles(),
      ]);
      if (result.archived) {
        // 刚存好的归档直接展开，用户一眼能看到自己清掉了什么。
        setRightTab("archives");
        setOpenArchiveId(result.archived.id);
      }
      setChatNotice(
        result.archived
          ? `已归档 ${result.archived.messageCount} 条消息、${result.archived.taskCount} 张任务卡${
              result.archived.fileCount > 0 ? `、${result.archived.fileCount} 个文件` : ""
            }${
              result.cancelled > 0 ? `，并中止了 ${result.cancelled} 个正在运行的成员` : ""
            }；${roomLabel}已清空，可在右侧「归档」恢复。`
          : `${roomLabel}本来就是空的，没有生成归档。`,
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
      `恢复这份归档？会放回 ${archive.messageCount} 条消息、${archive.taskCount} 张任务卡、${archive.fileCount} 个文件。\n\n${roomLabel}当前的内容会先自动存成一份新归档，所以这一步不会丢东西。`,
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
    if (!text || clearingChat || startingSession) return;
    const parsed = parseSlashCommand(text);
    if (parsed) {
      setDraft("");
      if (parsed.kind === "unknown") {
        setError(`未知命令 /${parsed.name}，输入 /help 查看可用命令。`);
        return;
      }
      setError(null);
      await runSlashCommand(parsed.command, parsed.args);
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

  /** 一键续跑：走普通 @ mention 派发，让同一个成员带着当前进展再来一轮。 */
  async function handleResume(memberName: string) {
    setError(null);
    try {
      await sendMessage(
        `@${memberName} 接着刚才没做完的继续：先回顾上一轮的进展与未完成项，` +
          "把剩下的做完后汇报结论、关键产出路径和仍未解决的地方。",
      );
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

  /** 群聊里的「移除」只摘本群花名册：成员池、作战室与其他群都不动。 */
  async function handleKickMember(member: Member) {
    const roomId = state?.room.id;
    if (!roomId) return;
    const confirmed = window.confirm(
      `把 @${member.name} 移出本群？\n\n历史消息会保留，它在作战室与其他群聊里不受影响。`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      await kickRoomMember(roomId, member.id);
      await reloadSession();
      void refreshRooms();
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

  /**
   * 成员可用的模型引用：`default`（跟随设置里的默认模型）、别名、以及各供应商已登记的模型。
   * 别名表里带着内置的 gpt / qwen 等指向，供应商没配就跳过，避免选中后运行期才报「未登记」。
   */
  const modelChoices = useMemo(() => {
    const settings = state?.settings;
    const choices: { ref: string; label: string }[] = [];
    if (!settings) return choices;
    choices.push({ ref: "default", label: `跟随默认（${settings.selection.defaultModel || "未配置"}）` });
    for (const [alias, target] of Object.entries(settings.selection.aliases)) {
      if (!isRefConfigured(settings, target)) continue;
      choices.push({ ref: alias, label: `别名 ${alias} → ${target}` });
    }
    for (const provider of settings.providers) {
      for (const model of provider.models) {
        const needsKey = provider.api !== "mock" && provider.auth === "api-key" && !provider.hasApiKey;
        choices.push({
          ref: `${provider.id}/${model.id}`,
          label: `${provider.id}/${model.id}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k` : ""}${needsKey ? "（未配置密钥）" : ""}`,
        });
      }
    }
    return choices;
  }, [state?.settings]);

  async function handleSelectMemberModel(memberId: string, ref: string) {
    const target = members.find((member) => member.id === memberId);
    if (!target) return;
    setError(null);
    try {
      await setMemberModel(memberId, ref);
      // 主智能体跟随默认模型时，成员档案上写回真正的引用，界面才不会显示成空的 default。
      const resolved = ref === "default" ? (state?.settings.selection.defaultModel ?? "default") : ref;
      setCommandOutput({
        title: "模型",
        body: `已把 @${target.name} 的模型设为 ${ref}${ref === "default" ? `（当前解析为 ${resolved}）` : ""}。下一轮回复开始生效。`,
      });
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
  }

  function openAgentFiles(memberId: string) {
    setSelectedMemberId(memberId);
    setNewMemberOpen(false);
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setRoomsOpen(false);
    setBoardOpen(true);
    setNavOpen(false);
  }

  function openNewMember() {
    setNewMemberOpen(true);
    setSelectedMemberId(null);
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setRoomsOpen(false);
    setBoardOpen(true);
    setNavOpen(false);
  }

  function openSkills() {
    setSkillsOpen(true);
    setNewMemberOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setRoomsOpen(false);
    setBoardOpen(true);
    setNavOpen(false);
  }

  function openTemplates() {
    setTemplatesOpen(true);
    setSkillsOpen(false);
    setNewMemberOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setRoomsOpen(false);
    setSelectedMemberId(null);
    setBoardOpen(true);
    setNavOpen(false);
  }

  /** 成员 → 我的模板：先向服务端要一份草稿，再让模板库面板用新建表单接住它。 */
  async function handleSaveMemberAsTemplate(memberId: string, memberName: string) {
    if (memberTemplateDraft) return;
    try {
      const { draft } = await fetchMemberTemplateDraft(memberId);
      setMemberTemplateDraft({ seed: draft, memberName });
      openTemplates();
    } catch (err) {
      if (isUnauthorized(err)) onSessionLost();
      else setError(messageOf(err));
    }
  }

  function openCron() {
    setCronOpen(true);
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setNewMemberOpen(false);
    setRoomsOpen(false);
    setSelectedMemberId(null);
    setBoardOpen(true);
    setNavOpen(false);
  }

  /** 学习面板：右侧整块区域，展示复盘产出的待确认记忆/技能提案与流水。 */
  function openLearning() {
    setLearningOpen(true);
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setRoomsOpen(false);
    setNewMemberOpen(false);
    setSelectedMemberId(null);
    setBoardOpen(true);
    setNavOpen(false);
  }

  /** 群聊区面板：列表或花名册，两个标签共用同一个右侧区域。 */
  function openRooms(tab: "list" | "members") {
    setRoomsTab(tab);
    setRoomsOpen(true);
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setNewMemberOpen(false);
    setSelectedMemberId(null);
    setBoardOpen(true);
    setNavOpen(false);
  }

  /**
   * 进入某间房：切换 api 层的当前房间（后续请求都会带 `?room=`），
   * 再以服务端为准重拉状态。房间没变时只把焦点还给输入框。
   */
  async function enterRoom(roomId: string) {
    if (roomId === activeRoom()) {
      goToRoom();
      return;
    }
    setActiveRoom(roomId);
    setActiveRoomIdState(roomId);
    try {
      localStorage.setItem("ac_room", roomId);
    } catch {
      // storage can be unavailable in private mode
    }
    setRoomsOpen(false);
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setNewMemberOpen(false);
    setSelectedMemberId(null);
    setOpenArchiveId(null);
    setArchiveDetail(null);
    setCommandOutput(null);
    setChatNotice(null);
    setError(null);
    await reloadSession();
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  /** 聊天本身：收起右侧的技能库/群聊区/智能体文件，把焦点还给输入框。 */
  function goToRoom() {
    setSkillsOpen(false);
    setTemplatesOpen(false);
    setCronOpen(false);
    setLearningOpen(false);
    setRoomsOpen(false);
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

  const defaultRef = state.settings.selection.defaultModel;
  const defaultProvider = state.settings.providers.find(
    (provider) => provider.id === defaultRef.split("/")[0],
  );
  const modelNeedsKey =
    defaultProvider !== undefined &&
    defaultProvider.api !== "mock" &&
    defaultProvider.auth === "api-key" &&
    !defaultProvider.hasApiKey;

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
            className={`room-entry${!isGroupRoom && inWarRoom ? " active" : ""}`}
            aria-pressed={!isGroupRoom && inWarRoom}
            title="回到作战室"
            onClick={() => void enterRoom(MAIN_ROOM_ID)}
          >
            <span className="room-entry-icon">
              <Icon name="chat" size={15} />
            </span>
            <span className="room-entry-text">
              <strong>作战室</strong>
              <small>{user.displayName} 的群聊 · 任务看板</small>
            </span>
            {!isGroupRoom && runningCount > 0 && (
              <span className="room-entry-live">{runningCount} 运行中</span>
            )}
          </button>

          {isGroupRoom && (
            <button
              type="button"
              className={`room-entry current${inWarRoom ? " active" : ""}`}
              aria-pressed={inWarRoom}
              title="回到当前群聊"
              onClick={goToRoom}
            >
              <span className="room-entry-icon">
                <Icon name="users" size={15} />
              </span>
              <span className="room-entry-text">
                <strong>{state.room.name}</strong>
                <small>{state.room.topic || "群聊"} · 与作战室同一套界面</small>
              </span>
              {runningCount > 0 && <span className="room-entry-live">{runningCount} 运行中</span>}
            </button>
          )}

          <div className="sidebar-quick">
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
          </div>

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
              className={`nav-item${templatesOpen ? " active" : ""}`}
              aria-pressed={templatesOpen}
              onClick={() => (templatesOpen ? setTemplatesOpen(false) : openTemplates())}
            >
              <Icon name="template" />
              <span className="nav-label">模板库</span>
              <span className="nav-hint">引用模板生成成员</span>
            </button>

            <button
              type="button"
              className={`nav-item${cronOpen ? " active" : ""}`}
              aria-pressed={cronOpen}
              onClick={() => (cronOpen ? setCronOpen(false) : openCron())}
            >
              <Icon name="clock" />
              <span className="nav-label">定时任务</span>
              <span className="nav-hint">提醒 · 周期工作 · 无人值守</span>
            </button>

            <button
              type="button"
              className={`nav-item${learningOpen ? " active" : ""}`}
              aria-pressed={learningOpen}
              onClick={() => (learningOpen ? setLearningOpen(false) : openLearning())}
            >
              <Icon name="sparkles" />
              <span className="nav-label">学习</span>
              <span className="nav-hint">复盘产出 · 记忆与技能</span>
              {learningPending > 0 && <span className="nav-count">{learningPending}</span>}
            </button>

            <button
              type="button"
              className={`nav-item${roomsOpen ? " active" : ""}`}
              aria-pressed={roomsOpen}
              onClick={() => (roomsOpen ? setRoomsOpen(false) : openRooms("list"))}
            >
              <Icon name="users" />
              <span className="nav-label">群聊区</span>
              <span className="nav-count">{groupRooms.length}</span>
            </button>

            <button
              type="button"
              className="nav-item"
              aria-expanded={membersOpen}
              onClick={() => setMembersOpen((open) => !open)}
            >
              <Icon name="users" />
              <span className="nav-label">{isGroupRoom ? "群成员" : "成员"}</span>
              <span className="nav-count">{members.length}</span>
              <span className={`chevron${membersOpen ? " up" : ""}`}>
                <Icon name="chevron" />
              </span>
            </button>
          </nav>
          {membersOpen && (
            <ul className="member-list">
            {isGroupRoom && (
              <li className="member-invite-row">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => openRooms("members")}
                  title="从成员池拉人进这个群"
                >
                  <Icon name="plus" size={13} />
                  拉成员进群
                </button>
              </li>
            )}
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
                    {member.templateTitle && (
                      <span className="member-template" title={`来自模板「${member.templateTitle}」`}>
                        · {member.templateTitle}
                      </span>
                    )}
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
                    aria-label={`${isGroupRoom ? "移出群聊" : "移除成员"} @${member.name}`}
                    title={isGroupRoom ? "移出群聊（成员池与其他群不受影响）" : "移除成员"}
                    onClick={() =>
                      void (isGroupRoom ? handleKickMember(member) : handleRemoveMember(member))
                    }
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
                  <span className="menu-hint">资料 · 模型 · 限额 · 学习 · 外观</span>
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
                    <span className="menu-hint">账号 · 重置密码 · 删除</span>
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
          <div className="content-title">
            {state.room.name}
            {isGroupRoom && <span className="room-kind-pill">群聊</span>}
          </div>
          {isGroupRoom && state.room.topic && (
            <span className="room-head-topic" title={state.room.topic}>
              {state.room.topic}
            </span>
          )}
          {isGroupRoom && (
            <button
              type="button"
              className="btn ghost sm room-back"
              title="回到作战室"
              onClick={() => void enterRoom(MAIN_ROOM_ID)}
            >
              <Icon name="back" size={13} />
              <span>作战室</span>
            </button>
          )}
          <span className="env-pill">
            {defaultRef ? `${defaultRef}${modelNeedsKey ? "（未配置密钥）" : ""}` : "未配置模型"}
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
              title="关闭技能库，回到聊天"
              onClick={() => setSkillsOpen(false)}
            >
              <Icon name="book" />
              <span>技能库</span>
              <span className="chip">共享 · 个人</span>
            </button>
          ) : roomsOpen ? (
            <button
              type="button"
              className="btn ghost board-toggle"
              aria-pressed
              aria-controls="rooms-panel"
              title="关闭群聊区，回到聊天"
              onClick={() => setRoomsOpen(false)}
            >
              <Icon name="users" />
              <span>群聊区</span>
              <span className="chip">{groupRooms.length}</span>
            </button>
          ) : templatesOpen ? (
            <button
              type="button"
              className="btn ghost board-toggle"
              aria-pressed
              aria-controls="templates-panel"
              title="关闭模板库，回到作战室"
              onClick={() => setTemplatesOpen(false)}
            >
              <Icon name="template" />
              <span>模板库</span>
              <span className="chip">内置 · 个人</span>
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
                <MessageBubble
                  key={message.id}
                  message={message}
                  nameById={nameById}
                  onResume={handleResume}
                />
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
                disabled={!draft.trim() || clearingChat || startingSession}
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
              <div className="composer-actions">
                <button
                  type="button"
                  className="btn composer-btn new-session"
                  aria-label="新建会话（同 /new）"
                  title="开启一个与上一个任务无关的新会话：当前聊天与任务卡归档起来，文件工作区、成员与智能体记忆不动（等同于 /new）"
                  disabled={startingSession || clearingChat}
                  onClick={() => void handleNewSession()}
                >
                  <Icon name="plus" size={15} />
                  <span>{startingSession ? "新建中…" : "新建会话"}</span>
                </button>
                <button
                  type="button"
                  className="btn composer-btn clear-session"
                  aria-label="清除会话（同 /clear）"
                  title="清空作战室：聊天记录、任务卡与文件成果整体归档，可在右侧「归档」恢复（等同于 /clear）"
                  disabled={startingSession || clearingChat}
                  onClick={() => void handleClearChat()}
                >
                  <Icon name="archive" size={15} />
                  <span>{clearingChat ? "清除中…" : "清除会话"}</span>
                </button>
              </div>
              <div className="composer-tips">
                <span>Enter 发送 · Shift+Enter 换行</span>
                <span>@成员名 指派任务</span>
                <span>输入 /help 查看命令</span>
              </div>
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
      ) : roomsOpen ? (
        <aside id="rooms-panel" className="board-panel" aria-label="群聊区">
          <RoomsPanel
            rooms={rooms}
            activeRoomId={activeRoomId}
            initialTab={roomsTab}
            onClose={() => setRoomsOpen(false)}
            onEnter={(roomId) => void enterRoom(roomId)}
            onChanged={syncRoomView}
          />
        </aside>
      ) : templatesOpen ? (
        <aside id="templates-panel" className="board-panel" aria-label="模板库">
          <TemplateLibraryPanel
            onClose={() => setTemplatesOpen(false)}
            takenNames={members.map((member) => member.name)}
            memberDraft={memberTemplateDraft}
            onMemberDraftUsed={() => setMemberTemplateDraft(null)}
            onApplied={(member, template) => {
              openAgentFiles(member.id);
              setChatNotice(
                `已按模板「${template.title}」创建 @${member.name}，在群里 @${member.name} 就能派活。`,
              );
            }}
          />
        </aside>
      ) : cronOpen ? (
        <aside id="cron-panel" className="board-panel" aria-label="定时任务">
          <CronPanel onClose={() => setCronOpen(false)} members={members} refreshToken={cronTick} />
        </aside>
      ) : learningOpen ? (
        <aside id="learning-panel" className="board-panel" aria-label="学习">
          <LearningPanel
            onClose={() => setLearningOpen(false)}
            refreshToken={learningTick}
            learning={state?.settings.learning}
            onPendingChange={setLearningPending}
          />
        </aside>
      ) : selectedMember ? (
        <aside id="agent-files-panel" className="board-panel" aria-label="智能体文件">
          <AgentFilesPanel
            member={selectedMember}
            files={agentFiles}
            fileError={agentFileError}
            activePath={openFilePath}
            content={openFile}
            modelChoices={modelChoices}
            onSelectModel={handleSelectMemberModel}
            onSelectPath={setOpenFilePath}
            onRefresh={reloadAgentFiles}
            onSave={saveOpenFile}
            onLoadFull={loadFullFile}
            onSaveAsTemplate={() => void handleSaveMemberAsTemplate(selectedMember.id, selectedMember.name)}
            onClose={closeAgentFiles}
          />
        </aside>
      ) : newMemberOpen ? (
        <aside id="new-member-panel" className="board-panel" aria-label="新建成员">
          <NewMemberPanel
            onClose={() => setNewMemberOpen(false)}
            onCreated={(member) => {
              setNewMemberOpen(false);
              // 在群聊里新建成员：顺手拉进本群，省得再回群聊区操作一次。
              if (isGroupRoom && state) {
                void (async () => {
                  try {
                    await inviteRoomMember(state.room.id, member.id);
                    await reloadSession();
                    void refreshRooms();
                    setChatNotice(`已把 @${member.name} 拉进本群，@ 它就能派活。`);
                  } catch (err) {
                    if (isUnauthorized(err)) onSessionLost();
                    else setError(messageOf(err));
                  }
                  openAgentFiles(member.id);
                })();
                return;
              }
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
          modelChoices={modelChoices}
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

      {usersOpen && user.role === "admin" && (
        <AdminPanel me={user} onClose={() => setUsersOpen(false)} />
      )}
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
          /new 只把群聊记录与任务卡存成归档（文件留在工作区），/clear 连文件成果一起存。恢复时当前内容先自动存成新归档再交换，所以反复恢复也不会丢东西。
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
  modelChoices,
  onSelectModel,
  onSelectPath,
  onRefresh,
  onSave,
  onLoadFull,
  onSaveAsTemplate,
  onClose,
}: {
  member: { id: string; name: string; modelRef: string; templateTitle?: string };
  files: AgentFileEntry[] | null;
  fileError: string | null;
  activePath: string | null;
  content: AgentFileContent | null;
  modelChoices: { ref: string; label: string }[];
  onSelectModel: (memberId: string, ref: string) => Promise<void>;
  onSelectPath: (path: string) => void;
  onRefresh: () => void;
  onSave: (path: string, text: string) => Promise<void>;
  onLoadFull: () => Promise<string>;
  onSaveAsTemplate: () => void;
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
      setSkillNotice("已保存，从该智能体下一次运行开始生效；主智能体 TEAM.md 里的技能一行同步更新");
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
          {member.templateTitle && (
            <span className="chip template-source-chip" title={`该成员由模板库的「${member.templateTitle}」创建`}>
              模板 · {member.templateTitle}
            </span>
          )}
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
          {!showSkills && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={onSaveAsTemplate}
              title="把这个成员的设定存为「我的模板」，之后可以重复引用"
            >
              <Icon name="template" />
              <span>存为模板</span>
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
      {!showSkills && modelChoices.length > 0 && (
        <div className="member-model-row">
          <span className="section-label">模型</span>
          <select
            aria-label={`为 @${member.name} 选择模型`}
            value={modelChoices.some((choice) => choice.ref === member.modelRef) ? member.modelRef : "default"}
            onChange={(event) => void onSelectModel(member.id, event.target.value)}
          >
            {modelChoices.map((choice) => (
              <option key={choice.ref} value={choice.ref}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      )}
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
            这个工作区还没有可读的智能体文件。首次加载会自动生成 MEMORY.md、USER.md、SOUL.md、IDENTITY.md
            模板与成员能力档案 TEAM.md；若被删除，重新打开房间会再次补齐。
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
          与 IDENTITY.md），同时记入主智能体的成员能力档案 TEAM.md，主智能体据此决定把活派给谁；技能按描述从技能库里挑几个对口的启用（不会把整个技能库都塞给它）。每个成员还拥有自己的 MEMORY.md
          与 USER.md，记忆检索只在该成员自己的范围内命中；创建后技能与档案都可在「智能体文件」里继续修改。
          想省事可以先到侧边栏「模板库」引用一个现成角色。
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
            <small className="form-note">据此生成 SOUL.md、IDENTITY.md 与主智能体的 TEAM.md 能力档案，并挑选对口技能，最多 800 字</small>
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
  onResume,
}: {
  message: RoomMessage;
  nameById: Map<string, string>;
  onResume: (memberName: string) => void;
}) {
  const [source, setSource] = useState(false);
  if (message.senderKind === "system") {
    // 「继续」只对还在花名册里的成员出现：被移除的成员没有可重派的对象。
    const resume = message.resume;
    const targetName = resume ? nameById.get(resume.memberId) : undefined;
    return (
      <div className="system-line">
        {message.text}
        {resume && targetName && (
          <button
            type="button"
            className="system-resume"
            title={`把未完成的任务重新派给 @${targetName}`}
            onClick={() => onResume(targetName)}
          >
            <Icon name="restore" size={13} />
            继续
          </button>
        )}
      </div>
    );
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
        {message.runScope && (
          <span
            className="chip"
            title="这一轮的工具集被收窄：只能读、只能写计划文件，改动要等你批准后另行派发"
          >
            {RUN_SCOPE_LABELS[message.runScope]}
          </span>
        )}
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

function AdminPanel({ me, onClose }: { me: PublicUser; onClose: () => void }) {
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
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  async function handleDelete(target: PublicUser) {
    if (deletingId) return;
    const confirmed = window.confirm(
      `确定删除 @${target.username} 吗？\n\n会一并删除：作战室聊天记录与任务卡、文件工作区里的文件、会话归档、该账号的个人技能与个人模板，以及已登录的会话。\n共享技能、内置模板与其他账号不受影响。此操作不可恢复。`,
    );
    if (!confirmed) return;
    setDeletingId(target.id);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteUser(target.id);
      const tail = result.workspaceRemoved
        ? "作战室数据与文件已一并删除。"
        : `作战室目录暂时被占用，重启服务后可手动清理 data/workspaces/${result.deleted.id}。`;
      const cleaned = [
        result.removedSkills ? `${result.removedSkills} 个个人技能` : "",
        result.removedTemplates ? `${result.removedTemplates} 个个人模板` : "",
      ]
        .filter(Boolean)
        .join(" 和 ");
      setNotice(
        `已删除 @${result.deleted.username}${cleaned ? `，同时清理 ${cleaned}` : ""}。${tail}`,
      );
      if (resetFor === target.id) {
        setResetFor(null);
        setResetPassword("");
      }
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDeletingId(null);
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
            <span className="modal-sub">每个账号拥有独立房间与绑定的主智能体；删除账号会一并清除其作战室数据</span>
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
                      disabled={deletingId !== null}
                      onClick={() => startReset(item)}
                    >
                      {resetFor === item.id ? "收起" : "重置密码"}
                    </button>
                    {item.id !== me.id && (
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={deletingId !== null}
                        onClick={() => void handleDelete(item)}
                      >
                        {deletingId === item.id ? "删除中…" : "删除"}
                      </button>
                    )}
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
  modelChoices,
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
  modelChoices: { ref: string; label: string }[];
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
            <span className="modal-sub">账号资料、模型、运行限额与界面偏好</span>
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
              className={`settings-tab${tab === "limits" ? " active" : ""}`}
              onClick={() => setTab("limits")}
            >
              <Icon name="sliders" />
              运行限额
            </button>
            <button
              type="button"
              className={`settings-tab${tab === "learning" ? " active" : ""}`}
              onClick={() => setTab("learning")}
            >
              <Icon name="sparkles" />
              学习
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
            {tab === "model" && <ModelSettings settings={settings} onSaved={onSettingsSaved} />}
            {tab === "limits" && <LimitsSection settings={settings} onSaved={onSettingsSaved} />}
            {tab === "learning" && (
              <LearningSection
                settings={settings}
                modelChoices={modelChoices}
                onSaved={onSettingsSaved}
              />
            )}
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


/** 存储值 → 界面编辑值（`runTimeoutMs` 存毫秒、按秒编辑）。 */
function limitToDisplay(value: number | undefined, field: LimitFieldSpec): number {
  return (value ?? DEFAULT_LIMITS[field.key]) / (field.displayDivisor ?? 1);
}

/**
 * 设置面板的「运行限额」分组：字段、区间、单位全部取 `LIMIT_FIELDS`，
 * 与服务端 `sanitizeLimits()` 同源，界面不会比校验宽。
 */
function LimitsSection({
  settings,
  onSaved,
}: {
  settings: MaskedSettings;
  onSaved: (next: MaskedSettings) => void;
}) {
  const fields = LIMIT_FIELDS.filter((field) => field.inSettingsPanel);
  const paneValues = (limits: Partial<Limits>) =>
    Object.fromEntries(fields.map((field) => [field.key, String(limitToDisplay(limits[field.key], field))]));

  const [values, setValues] = useState<Record<string, string>>(() => paneValues(settings.limits));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function handleSave() {
    if (busy) return;
    setError(null);
    setNote(null);
    const patch: Record<string, number> = {};
    for (const field of fields) {
      const raw = (values[field.key] ?? "").trim();
      const parsed = Number(raw);
      if (!raw || !Number.isFinite(parsed)) {
        setError(`${field.label}必须是数字`);
        return;
      }
      patch[field.key] = Math.round(parsed * (field.displayDivisor ?? 1));
    }
    setBusy(true);
    try {
      const next = await saveSettings({ limits: patch });
      onSaved(next);
      setValues(paneValues(next.limits));
      setNote("已保存，下一次运行起生效");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-form">
      <div className="section-label">运行限额</div>
      {fields.map((field) => {
        const divisor = field.displayDivisor ?? 1;
        const min = field.min / divisor;
        const max = field.max / divisor;
        const fallback = limitToDisplay(DEFAULT_LIMITS[field.key], field);
        const customised =
          settings.limits[field.key] !== undefined &&
          limitToDisplay(settings.limits[field.key], field) !== fallback;
        return (
          <label className="field" key={field.key}>
            <span>
              {field.label}
              <em>
                （{min}–{max}
                {field.displayUnit} · 默认 {fallback}
                {field.displayUnit}）
              </em>
              {customised && <span className="chip">已自定义</span>}
            </span>
            <input
              type="number"
              value={values[field.key] ?? ""}
              min={min}
              max={max}
              step={1}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
            {field.hint && <span className="hint">{field.hint}</span>}
          </label>
        );
      })}
      {error && <p className="form-error">{error}</p>}
      {note && <p className="form-note">{note}</p>}
      <div className="modal-actions">
        <button className="btn primary" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "保存中…" : "保存限额"}
        </button>
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => {
            setError(null);
            setNote(null);
            setValues(paneValues(DEFAULT_LIMITS));
          }}
        >
          填入默认值
        </button>
      </div>
      <p className="hint">
        步数与超时同时生效：只调大步数、不调超时，长任务会先被整轮超时中止。超限的值服务端会拒绝保存。
      </p>
    </div>
  );
}

/**
 * 学习层设置：复盘模式、频率、每日上限与复盘用模型。
 * 取值区间与服务端 `sanitizeLearning()` 同源，界面不会比校验宽。
 */
function LearningSection({
  settings,
  modelChoices,
  onSaved,
}: {
  settings: MaskedSettings;
  modelChoices: { ref: string; label: string }[];
  onSaved: (next: MaskedSettings) => void;
}) {
  const learning = settings.learning;
  const [mode, setMode] = useState<LearningSettings["mode"]>(learning?.mode ?? "propose");
  const [everyNRuns, setEveryNRuns] = useState(String(learning?.everyNRuns ?? 2));
  const [dailyCap, setDailyCap] = useState(String(learning?.dailyCap ?? 20));
  const [modelRef, setModelRef] = useState(learning?.modelRef ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function handleSave() {
    if (busy) return;
    setError(null);
    setNote(null);
    const every = Number(everyNRuns.trim());
    const cap = Number(dailyCap.trim());
    if (!Number.isInteger(every) || every < 1 || every > 20) {
      setError("复盘频率需在 1–20 次运行之间（整数）");
      return;
    }
    if (!Number.isInteger(cap) || cap < 1 || cap > 200) {
      setError("每日复盘上限需在 1–200 次之间（整数）");
      return;
    }
    setBusy(true);
    try {
      const next = await saveSettings({
        learning: { mode, everyNRuns: every, dailyCap: cap, modelRef: modelRef.trim() },
      });
      onSaved(next);
      const saved = next.learning;
      setMode(saved.mode);
      setEveryNRuns(String(saved.everyNRuns));
      setDailyCap(String(saved.dailyCap));
      setModelRef(saved.modelRef ?? "");
      setNote("已保存，成员下一轮运行起生效");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-form">
      <div className="section-label">学习</div>
      <p className="hint">
        成员每轮交付后，服务端另起一次不带工具的模型调用，只判断「这轮有没有值得长期记住的事实」，
        产出候选记忆。采纳后写入该成员的长期记忆，不会改动人格与身份文件，也不会自动删除任何已写入的内容。
      </p>
      <label className="field">
        <span>
          复盘模式
          <em>（待确认最稳：提案要你点「写入记忆」才生效）</em>
        </span>
        <select value={mode} onChange={(event) => setMode(event.target.value as LearningSettings["mode"])}>
          <option value="off">关闭（不复盘）</option>
          <option value="propose">待确认（产出提案，等你采纳）</option>
          <option value="auto">自动写入（产出即落盘，不经确认）</option>
        </select>
      </label>
      <label className="field">
        <span>
          复盘频率
          <em>（1–20 · 每几轮运行复盘一次）</em>
        </span>
        <input
          type="number"
          value={everyNRuns}
          min={1}
          max={20}
          step={1}
          disabled={mode === "off"}
          onChange={(event) => setEveryNRuns(event.target.value)}
        />
      </label>
      <label className="field">
        <span>
          每日上限
          <em>（1–200 · 一天最多复盘几次，控住额外成本）</em>
        </span>
        <input
          type="number"
          value={dailyCap}
          min={1}
          max={200}
          step={1}
          disabled={mode === "off"}
          onChange={(event) => setDailyCap(event.target.value)}
        />
      </label>
      <label className="field">
        <span>
          复盘模型
          <em>（留空则跟随成员自己用的模型）</em>
        </span>
        <select value={modelRef} onChange={(event) => setModelRef(event.target.value)}>
          <option value="">跟随成员的模型</option>
          {modelChoices
            .filter((choice) => choice.ref !== "default")
            .map((choice) => (
              <option key={choice.ref} value={choice.ref}>
                {choice.label}
              </option>
            ))}
        </select>
        <span className="hint">
          建议挑一个便宜的小模型：复盘每轮都要花一次调用，账本里会按同一口径计入成本。
        </span>
      </label>
      {error && <p className="form-error">{error}</p>}
      {note && <p className="form-note">{note}</p>}
      <div className="modal-actions">
        <button className="btn primary" disabled={busy} onClick={() => void handleSave()}>
          {busy ? "保存中…" : "保存学习设置"}
        </button>
      </div>
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
