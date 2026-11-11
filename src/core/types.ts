import type { CronJob, CronJobState, CronRunRecord } from "../cron/types";
import type { LearningProposal, ReviewLog } from "../agent/learning/types";
import type { QuestionItem } from "../room/questions";
import type { ActivityEvent } from "../room/activity-log";
import type { AuditRecord } from "../agent/audit/types";

export const USER_ID = "user";
export const SYSTEM_ID = "system";
/** 成员未指定模型时的占位引用：跟随设置里的默认模型。 */
export const DEFAULT_MODEL_REF = "default";

export type MemberRole = "main" | "sub";
export type MemberStatus = "idle" | "running" | "cancelled" | "error";
export type ContextMode = "fork" | "isolated";
export type ControlScope = "children" | "none";
export type SenderKind = "user" | "member" | "system";
export type MessageKind = "chat" | "announce" | "system" | "question";
export type TaskStatus = "todo" | "doing" | "blocked" | "done" | "failed";
export type UserRole = "admin" | "user";
/**
 * 作战室的任务完成模式：
 * - delegate：主智能体拆解并 @ 成员分派，成员只对分内任务汇报（对应 OpenClaw announce 语义）；
 * - free：成员之间可直接 @ 讨论，安静下来后由主智能体统一收集并总结（对应 collector 语义）。
 */
export type RoomMode = "delegate" | "free";
/**
 * 房间的取人方式（移植 Hermes 的 ROUTING_MODES）：决定一条没有点名任何人的用户消息交给谁。
 * - lead：交给主智能体，由它拆解与 @ 分派——本项目的既有行为，因此是默认值；
 * - everyone：本条消息唤醒花名册上所有成员，不相关的成员回 `pass` 保持沉默；
 * - auto：先用一次不带工具、低温、短输出的小调用从花名册里挑人，挑不出来回落到 lead。
 *
 * 它是房间属性而不是功能开关：任何「一条消息该由谁接」的场景（问答、分工、讨论）都走同一套规则。
 */
export type RoomRoutingMode = "everyone" | "lead" | "auto";

export const ROOM_ROUTING_MODES: readonly RoomRoutingMode[] = ["everyone", "lead", "auto"];

export function isRoomRoutingMode(value: unknown): value is RoomRoutingMode {
  return (ROOM_ROUTING_MODES as readonly unknown[]).includes(value);
}

export const ROOM_ROUTING_LABELS: Record<RoomRoutingMode, string> = {
  lead: "主智能体",
  everyone: "全员",
  auto: "自动选人",
};

/**
 * 房间类型：
 * - warroom：账号绑定的作战室（`room_main`），成员名册就是账号的成员池，任务与归档都以它为主；
 * - group：「群聊区」里自建的群聊，只能从成员池拉人进来讨论，界面与作战室一致。
 */
export type RoomKind = "warroom" | "group";

/** 房间清单（`rooms.json`）里持久化的一条房间档案。 */
export interface RoomDescriptor {
  id: string;
  kind: RoomKind;
  name: string;
  topic?: string;
  createdAt: number;
  updatedAt: number;
}

/** 房间清单对外的一行：附带实时人数、消息量与模式，供侧边栏群聊列表展示。 */
export interface RoomInfo extends RoomDescriptor {
  mode: RoomMode;
  routing: RoomRoutingMode;
  memberIds: string[];
  memberCount: number;
  messageCount: number;
  taskCount: number;
  runningCount: number;
}

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
  maxStepsPerRun: 24,
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
  /** 引用「模板库」里的模板创建时记录的来源模板，用于成员列表展示与再编辑。 */
  templateKey?: string;
  templateTitle?: string;
  /** `provider/model`、别名或 "default"（跟随设置里的默认模型）。 */
  modelRef: string;
  /** 该成员的推理档位偏好；未设置则跟随模型默认。 */
  thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
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
  /**
   * 本轮的运行姿态（run scope）。由用户消息带上，该轮里智能体发回的消息继承同一个值，
   * 于是「这一轮被收窄成什么」既能决定工具清单，也能决定唤醒规则。缺省等于 normal。
   */
  runScope?: RunScopeKind;
}

/**
 * 运行姿态：对「这一轮允许做什么」的一次性声明，移植自 Hermes 的 plan mode，
 * 但做成通用闸门而不是某个命令的专属逻辑——姿态表决定只读工具白名单与写入前缀，
 * 将来「危险动作先要批准」「无人值守不许删」都往这里加，不新增别的语义。
 */
export type RunScopeKind = "plan";

/** 计划轮允许写入的文件前缀（相对文件工作区根）；其余一律只读。 */
export const PLAN_WRITABLE_PREFIX = "plans/";

/** 姿态在界面上的标记：让「这一轮被收窄成什么」看得见，而不是只藏在工具清单里。 */
export const RUN_SCOPE_LABELS: Record<RunScopeKind, string> = { plan: "计划轮" };

export interface ArtifactRef {
  name: string;
  path?: string;
  summary?: string;
  addedAt: number;
  addedBy: string;
}

/**
 * 完成核验：交付闸门放行 done 时写下的事实凭据。
 * 与验收条款一样留在卡上，供他人与后续会话看到「这条完成是被什么核对过的」。
 */
export interface TaskCompletionProof {
  verifiedBy: { kind: TaskEvidenceKind; handle: string };
  at: number;
  detail?: string;
}

/** 证据类别：写出的文件、跑成功的命令、登记过的成果。 */
export type TaskEvidenceKind = "file" | "command" | "artifact";

/**
 * 一条运行期真实发生过的事实（工具在成功返回的那一刻记下）。
 * 存在卡上，成员被「继续」唤醒时重新装进本轮台账，闸门才认它。
 */
export interface TaskEvidenceRecord {
  kind: TaskEvidenceKind;
  handle: string;
  detail: string;
  at: number;
}

export interface TaskCard {
  id: string;
  roomId: string;
  title: string;
  detail: string;
  /** 验收条款：每条一个可独立核对的客体。写了它，done 就必须带查得通的证据。 */
  acceptance?: string;
  /** 本轮台账留在卡上的证据（最多 40 条），供续跑核验。 */
  evidence?: TaskEvidenceRecord[];
  /** 通过闸门时的核验凭据（未通过则不写）。 */
  completion?: TaskCompletionProof;
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
  /** 归档来自哪间房；老归档没有这个字段，读取时按作战室处理。 */
  roomId?: string;
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
  | { type: "reasoning"; runId: string; memberId: string; text: string }
  | { type: "delta"; runId: string; memberId: string; text: string }
  | { type: "tool"; runId: string; memberId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; runId: string; memberId: string; name: string; content: string; ok: boolean; code?: string }
  | { type: "run-final"; runId: string; memberId: string; text: string }
  | { type: "run-error"; runId: string; memberId: string; error: string }
  | {
      type: "run-aborted";
      runId: string;
      memberId: string;
      /** 中止原因：超时、用户取消、清会话静默取消、成员被移除。缺省按普通取消处理。 */
      reason?: "timeout" | "cancelled" | "silent" | "removed";
    };

export type RoomEvent =
  | { type: "message"; message: RoomMessage }
  | { type: "messages-cleared" }
  | { type: "tasks-cleared" }
  | { type: "session-archived"; archive: SessionArchiveSummary }
  | { type: "session-restored"; archive: SessionArchiveSummary }
  | { type: "mode"; mode: RoomMode }
  | { type: "routing"; routing: RoomRoutingMode }
  | { type: "member"; member: Member }
  | { type: "member-removed"; memberId: string }
  | { type: "task"; task: TaskCard }
  | { type: "question"; question: QuestionItem }
  | { type: "activity"; event: ActivityEvent }
  | { type: "audit"; record: AuditRecord }
  | { type: "run"; event: AgentEvent }
  | { type: "model-usage"; usage: ModelUsageEvent }
  /** 一次后台复盘的产出：提案（可能为空）+ 流水，前端据此刷新「学习」面板。 */
  | { type: "learning"; proposals: readonly LearningProposal[]; log: ReviewLog }
  | { type: "cron-job"; job: CronJob; state: CronJobState }
  | { type: "cron-job-removed"; jobId: string }
  | { type: "cron-run"; run: CronRunRecord }
  | { type: "notice"; text: string }
  /** 房间被新建、改名或删除时广播：前端据此重拉群聊列表。 */
  | { type: "rooms-changed"; roomId: string };

/** token 计量口径：input 已扣除缓存命中，cacheRead/cacheWrite 单独计。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一次运行结束后按模型上报的用量，供设置面板的用量统计实时刷新。 */
export interface ModelUsageEvent {
  ref: string;
  providerId: string;
  modelId: string;
  usage: TokenUsage;
  costUsd: number;
}
