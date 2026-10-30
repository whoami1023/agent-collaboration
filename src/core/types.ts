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
  maxStepsPerRun: 12,
  maxRoomWindowChars: 12000,
  maxTurnsPerUserMessage: 12,
  runTimeoutMs: 120000,
  contextWindowTokens: 64000,
  maxActiveTranscriptBytes: "2mb",
};

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
  | { type: "member"; member: Member }
  | { type: "member-removed"; memberId: string }
  | { type: "task"; task: TaskCard }
  | { type: "run"; event: AgentEvent }
  | { type: "notice"; text: string };
