export const USER_ID = "user";
export const SYSTEM_ID = "system";
export const DEFAULT_PROVIDER_ID = "default";

export type MemberRole = "main" | "sub";
export type MemberStatus = "idle" | "running" | "cancelled" | "error";
export type ContextMode = "fork" | "isolated";
export type ControlScope = "children" | "none";
export type SenderKind = "user" | "member" | "system";
export type MessageKind = "chat" | "announce" | "system";
export type TaskStatus = "todo" | "doing" | "blocked" | "done" | "failed";
export type UserRole = "admin" | "user";
/**
 * 作战室的任务完成模式：
 * - delegate：主智能体拆解并 @ 成员分派，成员只对分内任务汇报（对应 OpenClaw announce 语义）；
 * - free：成员之间可直接 @ 讨论，安静下来后由主智能体统一收集并总结（对应 collector 语义）。
 */
export type RoomMode = "delegate" | "free";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  /** The main agent this account is bound to inside its own room. */
  mainAgentId: string;
  roomId: string;
}

export interface Limits {
  maxConcurrent: number;
  maxChildrenPerAgent: number;
  maxSpawnDepth: number;
  maxStepsPerRun: number;
  maxRoomWindowChars: number;
  maxTurnsPerUserMessage: number;
  runTimeoutMs: number;
  /** Provider context window in tokens; >0 enables automatic context compaction. */
  contextWindowTokens?: number;
  /** Hard model-view byte ceiling (number or "2mb" style string); unset disables bounding. */
  maxActiveTranscriptBytes?: number | string;
}

export const DEFAULT_LIMITS: Limits = {
  maxConcurrent: 8,
  maxChildrenPerAgent: 5,
  maxSpawnDepth: 5,
  maxStepsPerRun: 48,
  maxRoomWindowChars: 12000,
  maxTurnsPerUserMessage: 12,
  runTimeoutMs: 420000,
  contextWindowTokens: 64000,
  maxActiveTranscriptBytes: "2mb",
};

/** `Limits` 里按整数校验的字段（可选的 token 预算/字节上限除外）。 */
export type LimitCountKey =
  | "maxConcurrent"
  | "maxChildrenPerAgent"
  | "maxSpawnDepth"
  | "maxStepsPerRun"
  | "maxRoomWindowChars"
  | "maxTurnsPerUserMessage"
  | "runTimeoutMs";

export interface LimitFieldSpec {
  key: LimitCountKey;
  label: string;
  /** 合法区间以存储单位表示（`runTimeoutMs` 为毫秒）。 */
  min: number;
  max: number;
  displayUnit: string;
  /** 界面编辑值 = 存储值 / displayDivisor；省略表示与存储单位一致。 */
  displayDivisor?: number;
  /** 是否在设置面板「运行限额」分组里暴露给用户。 */
  inSettingsPanel?: boolean;
  hint?: string;
}

/**
 * 运行限额的合法区间：服务端 `sanitizeLimits()` 用它拒绝越界值，
 * 设置面板用它渲染表单，两边共用一套，避免 UI 与校验漂移。
 */
export const LIMIT_FIELDS: readonly LimitFieldSpec[] = [
  {
    key: "maxStepsPerRun",
    label: "单次运行工具步数",
    min: 4,
    max: 120,
    displayUnit: "步",
    inSettingsPanel: true,
    hint: "一个成员被派发一次最多能调用多少轮工具；用尽后会自动收尾并给出「继续」。",
  },
  {
    key: "runTimeoutMs",
    label: "单次运行超时",
    min: 15_000,
    max: 900_000,
    displayUnit: "秒",
    displayDivisor: 1000,
    inSettingsPanel: true,
    hint: "整轮运行的墙上时钟上限，与步数同时生效：只调大步数不调超时会先触发超时中止。",
  },
  {
    key: "maxConcurrent",
    label: "同时运行成员数",
    min: 1,
    max: 32,
    displayUnit: "个",
    inSettingsPanel: true,
    hint: "同一时刻最多允许多少个智能体并发跑。",
  },
  {
    key: "maxChildrenPerAgent",
    label: "每个智能体子成员上限",
    min: 1,
    max: 20,
    displayUnit: "个",
    inSettingsPanel: true,
  },
  {
    key: "maxSpawnDepth",
    label: "最大层级深度",
    min: 1,
    max: 8,
    displayUnit: "层",
    inSettingsPanel: true,
  },
  {
    key: "maxRoomWindowChars",
    label: "群聊上下文窗口",
    min: 2000,
    max: 60000,
    displayUnit: "字符",
  },
  {
    key: "maxTurnsPerUserMessage",
    label: "单条消息接力轮数",
    min: 1,
    max: 24,
    displayUnit: "轮",
  },
];

/** 系统提示里「这次没跑完」的恢复入口：前端据此渲染一键「继续」。 */
export interface ResumeHint {
  memberId: string;
  memberName: string;
  taskId?: string;
}

export interface Member {
  id: string;
  roomId: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  depth: number;
  spawnedBy: string | null;
  controlScope: ControlScope;
  contextMode: ContextMode;
  systemPrompt: string;
  /** 用户的角色描述（新建成员时填写）：生成成员档案、写进子成员提示词。 */
  brief?: string;
  /**
   * 该成员可用的技能白名单（对应 OpenClaw 的 agents.entries.*.skills）；
   * undefined = 跟随技能库全部可用技能，[] = 全部禁用。
   */
  skillNames?: string[];
  providerId: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  ts: number;
  senderId: string;
  senderName: string;
  senderKind: SenderKind;
  kind: MessageKind;
  text: string;
  mentions: string[];
  mentionsRaw: string[];
  taskId?: string;
  runId?: string;
  replyTo?: string;
  chainRootId?: string;
  depthTurn?: number;
  resume?: ResumeHint;
}

export interface ArtifactRef {
  name: string;
  path?: string;
  summary?: string;
  addedAt: number;
  addedBy: string;
}

export interface TaskCard {
  id: string;
  roomId: string;
  title: string;
  detail: string;
  ownerId: string | null;
  status: TaskStatus;
  deps: string[];
  artifacts: ArtifactRef[];
  messageIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** 一次归档的摘要：群聊记录、任务卡与文件工作区的整体快照说明。 */
export interface SessionArchiveSummary {
  id: string;
  createdAt: number;
  roomName: string;
  messageCount: number;
  taskCount: number;
  fileCount: number;
  totalBytes: number;
}

/** 归档里保存的一个文件工作区条目（只收文件，目录不单列）。 */
export interface SessionArchiveFileEntry {
  path: string;
  sizeBytes: number;
  updatedAt: number;
}

/** 归档全文：恢复要放回的消息、任务卡与文件清单。 */
export interface SessionArchiveDetail extends SessionArchiveSummary {
  seq: number;
  messages: RoomMessage[];
  tasks: TaskCard[];
  files: SessionArchiveFileEntry[];
}

export type AgentEvent =
  | { type: "run-start"; runId: string; memberId: string }
  | { type: "delta"; runId: string; memberId: string; text: string }
  | { type: "tool"; runId: string; memberId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; runId: string; memberId: string; name: string; content: string }
  | { type: "run-final"; runId: string; memberId: string; text: string }
  | { type: "run-error"; runId: string; memberId: string; error: string }
  | { type: "run-aborted"; runId: string; memberId: string };

export type RoomEvent =
  | { type: "message"; message: RoomMessage }
  | { type: "messages-cleared" }
  | { type: "tasks-cleared" }
  | { type: "session-archived"; archive: SessionArchiveSummary }
  | { type: "session-restored"; archive: SessionArchiveSummary }
  | { type: "mode"; mode: RoomMode }
  | { type: "member"; member: Member }
  | { type: "member-removed"; memberId: string }
  | { type: "task"; task: TaskCard }
  | { type: "run"; event: AgentEvent }
  | { type: "notice"; text: string };
