import type {
  Limits,
  Member,
  PublicUser,
  RoomEvent,
  RoomInfo,
  RoomKind,
  RoomMessage,
  RoomMode,
  RoomRoutingMode,
  RunScopeKind,
  SessionArchiveDetail,
  SessionArchiveSummary,
  TaskCard,
} from "../../src/core/types";
import type {
  CronActiveHours,
  CronJob,
  CronJobState,
  CronPayload,
  CronRunRecord,
  CronSchedule,
} from "../../src/cron/types";
import type { ProviderApi } from "../../src/model/types";
import type { QuestionItem } from "../../src/room/questions";
import type { ActivityEvent } from "../../src/room/activity-log";
import type { AuditRecord } from "../../src/agent/audit/types";
import type { AdvisorSettings, CurationSettings } from "../../src/core/settings";
import type {
  CurationLog,
  CurationProposal,
  SkillLifecycle,
  SkillLifecycleState,
  SkillUsageRecord,
} from "../../src/skills/curation/types";
import type {
  LearningProposal,
  LearningSettings,
  MemoryProposal,
  ReviewLog,
  SkillProposal,
} from "../../src/agent/learning/types";
import type {
  KnowledgeBaseMeta,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeLintReport,
  KnowledgeLinkProposal,
  KnowledgePage,
  KnowledgeQueueItem,
  KnowledgeReview,
  KnowledgeSearchHit,
  KnowledgeSearchMode,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  KnowledgeSource,
} from "../../src/knowledge/types";

export type { LearningProposal, LearningSettings, MemoryProposal, ReviewLog, SkillProposal };
export type { AdvisorSettings, CurationSettings };
export type { CurationLog, CurationProposal, SkillLifecycle, SkillLifecycleState, SkillUsageRecord };
export type {
  KnowledgeBaseMeta,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeLintReport,
  KnowledgeLinkProposal,
  KnowledgePage,
  KnowledgeQueueItem,
  KnowledgeReview,
  KnowledgeSearchHit,
  KnowledgeSearchMode,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  KnowledgeSource,
};

export type { RoomInfo, RoomKind, RoomMode, RoomRoutingMode };

export interface MaskedModel {
  id: string;
  name: string;
  api?: ProviderApi;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  status: string;
}

export interface MaskedProvider {
  id: string;
  api: ProviderApi;
  baseUrl?: string;
  auth: "api-key" | "none";
  hasApiKey: boolean;
  apiKeyHint?: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  maxTokens?: number;
  models: MaskedModel[];
}

export interface ModelSelectionView {
  defaultModel: string;
  aliases: Record<string, string>;
  fallbacks: string[];
  modelParams: Record<string, Record<string, unknown>>;
  params: Record<string, unknown>;
  allow: string[];
}

export interface MaskedSettings {
  providers: MaskedProvider[];
  selection: ModelSelectionView;
  limits: Limits;
  learning: LearningSettings;
  advisors: AdvisorSettings;
  curation: CurationSettings;
}

export interface StateSnapshot {
  room: {
    id: string;
    name: string;
    kind: RoomKind;
    topic?: string;
    mode: RoomMode;
    routing: RoomRoutingMode;
  };
  members: Member[];
  messages: RoomMessage[];
  tasks: TaskCard[];
  questions: QuestionItem[];
  activity: ActivityEvent[];
  audits: AuditRecord[];
  settings: MaskedSettings;
}

export interface BootstrapInfo {
  needsSetup: boolean;
}

/** 作战室的房间 ID：与 src/room/registry.ts 里的常量一致（前端不能引服务端模块）。 */
export const MAIN_ROOM_ID = "room_main";

/**
 * 当前正在看的房间。「群聊区」里进入哪间群，这里就是哪间：
 * 所有按房间走的路由都自动带上 `?room=`，页面其余部分（聊天、看板、归档）因此和作战室完全同一套界面。
 */
let activeRoomId = MAIN_ROOM_ID;

export function activeRoom(): string {
  return activeRoomId;
}

/** 恢复上次停留的房间；形状不对一律回落到作战室。 */
export function restoreActiveRoom(value: string | null | undefined): string {
  activeRoomId = typeof value === "string" && /^room_[0-9a-f]{12}$/.test(value) ? value : MAIN_ROOM_ID;
  return activeRoomId;
}

export function setActiveRoom(roomId: string): string {
  activeRoomId = roomId || MAIN_ROOM_ID;
  return activeRoomId;
}

/** 给按房间走的路径追加 `?room=`：作战室保持原样，请求 URL 与旧版一致。 */
function withRoom(path: string, roomId = activeRoomId): string {
  if (roomId === MAIN_ROOM_ID) return path;
  return `${path}${path.includes("?") ? "&" : "?"}room=${encodeURIComponent(roomId)}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      typeof body["error"] === "string" ? body["error"] : `请求失败 ${response.status}`,
      response.status,
      typeof body["retryAfterMs"] === "number" ? body["retryAfterMs"] : undefined,
    );
  }
  return body as T;
}

export function fetchBootstrap(): Promise<BootstrapInfo> {
  return request<BootstrapInfo>("/api/auth/bootstrap");
}

export async function fetchMe(): Promise<PublicUser> {
  const body = await request<{ user: PublicUser }>("/api/auth/me");
  return body.user;
}

export async function setupAdmin(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<PublicUser> {
  const body = await request<{ user: PublicUser }>("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.user;
}

export async function loginUser(input: {
  username: string;
  password: string;
}): Promise<PublicUser> {
  const body = await request<{ user: PublicUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.user;
}

export async function logoutUser(): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export async function updateProfile(input: {
  displayName?: string;
  currentPassword?: string;
  newPassword?: string;
}): Promise<PublicUser> {
  const body = await request<{ user: PublicUser }>("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return body.user;
}

export async function listUsers(): Promise<PublicUser[]> {
  const body = await request<{ users: PublicUser[] }>("/api/users");
  return body.users;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<PublicUser> {
  const body = await request<{ user: PublicUser }>("/api/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.user;
}

export async function resetUserPassword(
  userId: string,
  newPassword: string,
): Promise<PublicUser> {
  const body = await request<{ user: PublicUser }>(
    `/api/users/${encodeURIComponent(userId)}/password`,
    { method: "POST", body: JSON.stringify({ newPassword }) },
  );
  return body.user;
}

export interface DeleteUserResult {
  deleted: PublicUser;
  /** 一并删除的个人技能数量；共享技能不会被动。 */
  removedSkills: number;
  /** 一并删除的个人模板数量。 */
  removedTemplates: number;
  /** 工作区目录（聊天、任务卡、文件、归档、智能体文件）是否已删除。 */
  workspaceRemoved: boolean;
}

export async function deleteUser(userId: string): Promise<DeleteUserResult> {
  return request<DeleteUserResult>(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export type SkillScope = "shared" | "personal";

/** 技能附带文件的元信息：正文要单独调 /api/skills/:id/file 取。 */
export interface SkillFileView {
  path: string;
  encoding: "utf8" | "base64";
  size: number;
}

export interface SkillFileContent extends SkillFileView {
  content: string;
}

export type SkillCategory =
  | "planning"
  | "research"
  | "data"
  | "engineering"
  | "product"
  | "design"
  | "web"
  | "agent"
  | "other";

export interface SkillCategoryView {
  id: SkillCategory;
  label: string;
  hint: string;
}

export interface SkillView {
  id: string;
  scope: SkillScope;
  ownerId: string | null;
  ownerName: string | null;
  name: string;
  description: string;
  instructions: string;
  category: SkillCategory;
  files?: SkillFileView[];
  builtin?: boolean;
  imported?: boolean;
  source?: string;
  /** 策展生命周期：缺省视作 active，归档的技能不会再进入智能体的技能清单。 */
  lifecycle?: SkillLifecycle;
  createdAt: number;
  updatedAt: number;
}

export interface SkillImportResult {
  filename: string;
  ok: boolean;
  action?: "created" | "updated";
  skill?: SkillView;
  error?: string;
  warnings?: string[];
}

export interface SkillSnapshot {
  shared: SkillView[];
  personal: SkillView[];
  categories: SkillCategoryView[];
  canManageShared: boolean;
}

export interface SkillFileInput {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

export async function fetchSkills(): Promise<SkillSnapshot> {
  return request<SkillSnapshot>("/api/skills");
}

export async function createSkill(input: {
  scope: SkillScope;
  name: string;
  description: string;
  instructions: string;
  category?: SkillCategory;
  files?: SkillFileInput[];
}): Promise<SkillView> {
  const body = await request<{ skill: SkillView }>("/api/skills", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.skill;
}

export async function importSkills(input: {
  scope: SkillScope;
  overwrite: boolean;
  files: { filename: string; content: string; encoding?: "utf8" | "base64" }[];
}): Promise<{ results: SkillImportResult[] }> {
  return request<{ results: SkillImportResult[] }>("/api/skills/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateSkill(
  skillId: string,
  patch: {
    name?: string;
    description?: string;
    instructions?: string;
    category?: SkillCategory;
    files?: SkillFileInput[];
  },
): Promise<SkillView> {
  const body = await request<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.skill;
}

export async function fetchSkillFile(
  skillId: string,
  path: string,
): Promise<SkillFileContent> {
  const body = await request<{ file: SkillFileContent }>(
    `/api/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(path)}`,
  );
  return body.file;
}

export async function deleteSkill(skillId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
  });
}

export type TemplateScope = "builtin" | "personal";

/** 智能体模板：引用它可以直接生成一个成员。 */
export interface TemplateView {
  id: string;
  key: string;
  scope: TemplateScope;
  ownerId: string | null;
  title: string;
  category: SkillCategory;
  description: string;
  suggestedName: string;
  brief: string;
  emoji?: string;
  vibe?: string;
  workstyle?: string[];
  skillNames?: string[];
  builtin?: boolean;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateInput {
  key?: string;
  title: string;
  description: string;
  brief: string;
  category?: SkillCategory;
  suggestedName?: string;
  emoji?: string;
  vibe?: string;
  workstyle?: string[];
  skillNames?: string[];
}

export interface TemplateSnapshot {
  builtin: TemplateView[];
  personal: TemplateView[];
  categories: SkillCategoryView[];
  availableSkills: Array<{ name: string; description: string }>;
}

/** 个人模板导出文件：只带设定字段，可导入到任意账号的「我的模板」。 */
export interface TemplateExportDocument {
  format: "agent-collaboration/template";
  version: number;
  exportedAt: string;
  template: {
    key: string;
    title: string;
    category: SkillCategory;
    description: string;
    suggestedName: string;
    brief: string;
    emoji?: string;
    vibe?: string;
    workstyle?: string[];
    skillNames?: string[];
  };
}

export interface TemplateImportResult {
  filename: string;
  ok: boolean;
  created: TemplateView[];
  errors: string[];
  warnings: string[];
}

export async function fetchTemplates(): Promise<TemplateSnapshot> {
  return request<TemplateSnapshot>("/api/templates");
}

export async function exportTemplate(templateId: string): Promise<TemplateExportDocument> {
  return request<TemplateExportDocument>(
    `/api/templates/${encodeURIComponent(templateId)}/export`,
  );
}

export async function importTemplates(
  files: Array<{ filename: string; content: string }>,
): Promise<{ results: TemplateImportResult[] }> {
  return request<{ results: TemplateImportResult[] }>("/api/templates/import", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

export async function createTemplate(input: TemplateInput): Promise<TemplateView> {
  const body = await request<{ template: TemplateView }>("/api/templates", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.template;
}

export async function updateTemplate(
  templateId: string,
  input: Partial<TemplateInput>,
): Promise<TemplateView> {
  const body = await request<{ template: TemplateView }>(
    `/api/templates/${encodeURIComponent(templateId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return body.template;
}

export async function deleteTemplate(templateId: string): Promise<void> {
  await request<{ removed: string }>(`/api/templates/${encodeURIComponent(templateId)}`, {
    method: "DELETE",
  });
}

/** 引用模板生成成员：只传成员名，其余设定都来自模板。 */
export async function applyTemplate(
  templateId: string,
  name: string,
): Promise<{ member: Member; template: TemplateView }> {
  return request<{ member: Member; template: TemplateView }>("/api/templates/apply", {
    method: "POST",
    body: JSON.stringify({ id: templateId, name }),
  });
}

/** 把某个成员导出成个人模板草稿（职责、档案里的工作方式、技能白名单）。 */
export interface MemberTemplateDraft {
  title: string;
  description: string;
  suggestedName: string;
  category: SkillCategory;
  brief: string;
  emoji?: string;
  vibe?: string;
  workstyle?: string[];
  skillNames?: string[];
}

export async function fetchMemberTemplateDraft(
  memberId: string,
): Promise<{ member: { id: string; name: string; role: string }; draft: MemberTemplateDraft }> {
  return request<{ member: { id: string; name: string; role: string }; draft: MemberTemplateDraft }>(
    `/api/members/${encodeURIComponent(memberId)}/template-draft`,
  );
}

/** 定时任务：定义 + 运行期状态 + 上一次运行，一次给全面板用。 */
export interface CronJobView {
  job: CronJob;
  state: CronJobState;
  lastRun?: CronRunRecord;
}

export interface CronStatusView {
  total: number;
  enabled: number;
  running: number;
  nextRunAtMs?: number;
}

export interface CronSnapshot {
  jobs: CronJobView[];
  status: CronStatusView;
  limits: {
    name: number;
    description: number;
    message: number;
    argvItems: number;
    argvItem: number;
    jobsPerUser: number;
    minEveryMs: number;
  };
}

/** 新建与编辑共用：schedule/payload 直接是后端的归一化输入形状。 */
export interface CronInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: CronPayload;
  activeHours?: CronActiveHours | null;
  deleteAfterRun?: boolean;
}

export async function fetchCrons(): Promise<CronSnapshot> {
  return request<CronSnapshot>("/api/crons");
}

export async function createCron(input: CronInput): Promise<CronJobView> {
  const body = await request<{ view: CronJobView }>("/api/crons", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.view;
}

export async function updateCron(jobId: string, input: CronInput): Promise<CronJobView> {
  const body = await request<{ view: CronJobView }>(`/api/crons/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return body.view;
}

export async function setCronEnabled(jobId: string, enabled: boolean): Promise<CronJobView> {
  const body = await request<{ view: CronJobView }>(
    `/api/crons/${encodeURIComponent(jobId)}/enabled`,
    { method: "POST", body: JSON.stringify({ enabled }) },
  );
  return body.view;
}

/** 立刻试跑：默认等这一轮落账；wait=false 只发起，结果由 SSE 的 cron-run 事件带回。 */
export async function runCronNow(
  jobId: string,
  options: { wait?: boolean } = {},
): Promise<CronRunRecord | undefined> {
  const body = await request<{ run?: CronRunRecord }>(
    `/api/crons/${encodeURIComponent(jobId)}/run`,
    { method: "POST", body: JSON.stringify({ wait: options.wait !== false }) },
  );
  return body.run;
}

export async function deleteCron(jobId: string): Promise<void> {
  await request<{ removed: string }>(`/api/crons/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export interface CronRunPage {
  entries: CronRunRecord[];
  total: number;
  offset: number;
  limit: number;
}

export async function fetchCronRuns(query: { jobId?: string; limit?: number } = {}): Promise<CronRunPage> {
  const params = new URLSearchParams();
  if (query.jobId) params.set("job_id", query.jobId);
  if (query.limit) params.set("limit", String(query.limit));
  return request<CronRunPage>(`/api/crons/runs?${params.toString()}`);
}

/** 学习层：账号内所有房间累计的待确认提案（记忆 + 技能）与复盘流水。 */
export interface LearningSnapshot {
  proposals: LearningProposal[];
  log: ReviewLog[];
}

export async function fetchLearning(): Promise<LearningSnapshot> {
  return request<LearningSnapshot>("/api/learning");
}

/** 采纳提案：记忆走受控追加写入，技能在技能库里创建个人技能；返回落地后的提案。 */
export async function applyLearningProposal(proposalId: string): Promise<LearningProposal> {
  const body = await request<{ proposal: LearningProposal }>(
    `/api/learning/${encodeURIComponent(proposalId)}/apply`,
    { method: "POST", body: "{}" },
  );
  return body.proposal;
}

export async function dismissLearningProposal(proposalId: string): Promise<LearningProposal> {
  const body = await request<{ proposal: MemoryProposal }>(
    `/api/learning/${encodeURIComponent(proposalId)}/dismiss`,
    { method: "POST", body: "{}" },
  );
  return body.proposal;
}

export interface CurationSnapshot {
  settings: CurationSettings;
  proposals: CurationProposal[];
  log: CurationLog[];
  /** skillId → 使用账本；已归档的技能也在这里，卡片徽章靠它。 */
  usage: Record<string, SkillUsageRecord>;
  /** 本次读路径顺带跑的扫描；未到间隔时只给 skipped 说明。 */
  sweep: { proposals: CurationProposal[]; skipped?: string };
}

/** 策展面板的读路径：GET 会触发一次「到点才跑」的扫描，所以打开就能看到最新状态。 */
export async function fetchCuration(): Promise<CurationSnapshot> {
  return request<CurationSnapshot>("/api/skills/curation");
}

export async function sweepCuration(options: {
  force?: boolean;
  consolidate?: boolean;
} = {}): Promise<{ proposals: CurationProposal[]; skipped?: string }> {
  return request("/api/skills/curation/sweep", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function applyCurationProposal(proposalId: string): Promise<CurationProposal> {
  const body = await request<{ proposal: CurationProposal }>(
    `/api/skills/curation/proposals/${encodeURIComponent(proposalId)}/apply`,
    { method: "POST", body: "{}" },
  );
  return body.proposal;
}

export async function dismissCurationProposal(
  proposalId: string,
  reason?: string,
): Promise<CurationProposal> {
  const body = await request<{ proposal: CurationProposal }>(
    `/api/skills/curation/proposals/${encodeURIComponent(proposalId)}/dismiss`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  return body.proposal;
}

/** 技能卡片上的手动操作：固定、归档、恢复。权限口径与编辑技能一致。 */
export async function putSkillLifecycle(
  skillId: string,
  patch: { state?: SkillLifecycleState; pinned?: boolean },
): Promise<SkillView> {
  const body = await request<{ skill: SkillView }>(
    `/api/skills/${encodeURIComponent(skillId)}/lifecycle`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
  return body.skill;
}

/** 不等扫描，直接为某条技能立一条归档提案（只进待确认清单，不真的归档）。 */
export async function proposeSkillArchive(skillId: string): Promise<CurationProposal> {
  const body = await request<{ proposal: CurationProposal }>("/api/skills/curation/archive", {
    method: "POST",
    body: JSON.stringify({ skillId }),
  });
  return body.proposal;
}

export function fetchState(): Promise<StateSnapshot> {
  return request<StateSnapshot>(withRoom("/api/state"));
}

/** 房间列表：作战室在第一间，其后是「群聊区」里自建的每间群聊。 */
export async function fetchRooms(): Promise<RoomInfo[]> {
  const body = await request<{ rooms: RoomInfo[] }>("/api/rooms");
  return body.rooms;
}

/** 成员池（作战室的花名册）：群聊区拉人时按这份名单勾选。 */
export async function fetchPoolMembers(): Promise<Member[]> {
  const body = await request<{ members: Member[] }>("/api/members");
  return body.members;
}

/** 某间房间当前的花名册。 */
export async function fetchRoomMembers(roomId: string): Promise<Member[]> {
  const body = await request<{ members: Member[] }>(
    `/api/rooms/${encodeURIComponent(roomId)}/members`,
  );
  return body.members;
}

export async function createRoom(input: {
  name: string;
  topic?: string;
  memberIds?: string[];
}): Promise<RoomInfo> {
  const body = await request<{ room: RoomInfo }>("/api/rooms", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.room;
}

export async function updateRoom(
  roomId: string,
  patch: { name?: string; topic?: string },
): Promise<RoomInfo> {
  const body = await request<{ room: RoomInfo }>(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.room;
}

export async function deleteRoom(roomId: string): Promise<string> {
  const body = await request<{ removed: string }>(`/api/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE",
  });
  return body.removed;
}

export async function inviteRoomMember(
  roomId: string,
  memberId: string,
): Promise<{ room: RoomInfo; member: Member }> {
  return request<{ room: RoomInfo; member: Member }>(
    `/api/rooms/${encodeURIComponent(roomId)}/members`,
    { method: "POST", body: JSON.stringify({ memberId }) },
  );
}

export async function kickRoomMember(roomId: string, memberId: string): Promise<RoomInfo> {
  const body = await request<{ removed: string; room: RoomInfo }>(
    `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
  return body.room;
}

export async function setRoomMode(
  mode: RoomMode,
): Promise<{ id: string; name: string; kind: RoomKind; mode: RoomMode; routing: RoomRoutingMode }> {
  const body = await request<{
    room: { id: string; name: string; kind: RoomKind; mode: RoomMode; routing: RoomRoutingMode };
  }>(withRoom("/api/room"), { method: "PATCH", body: JSON.stringify({ mode }) });
  return body.room;
}

/**
 * 房间取人方式：一条没点名的用户消息交给谁。
 * 和 mode 一样按当前房间走（`withRoom` 自动带 `?room=`），所以作战室和每间群聊各调各的。
 */
export async function setRoomRouting(
  routing: RoomRoutingMode,
): Promise<{ id: string; name: string; kind: RoomKind; mode: RoomMode; routing: RoomRoutingMode }> {
  const body = await request<{
    room: { id: string; name: string; kind: RoomKind; mode: RoomMode; routing: RoomRoutingMode };
  }>(withRoom("/api/room"), { method: "PATCH", body: JSON.stringify({ routing }) });
  return body.room;
}

/**
 * 发一条群聊消息。runScope 把这一轮收窄成某种运行姿态（如计划轮）：
 * 服务端据此挑工具清单与唤醒规则，这一轮智能体发回的消息都继承同一个姿态。
 */
export async function sendMessage(
  text: string,
  runScope?: RunScopeKind,
): Promise<RoomMessage> {
  const body = await request<{ message: RoomMessage }>(withRoom("/api/messages"), {
    method: "POST",
    body: JSON.stringify(runScope ? { text, runScope } : { text }),
  });
  return body.message;
}

/** 回答结构化提问的一题；全部答完后服务端会回灌一条用户消息并唤醒提问者。 */
export async function answerQuestion(
  questionId: string,
  payload: { fieldId: string; optionId?: string; text?: string },
): Promise<{ question: QuestionItem; message: RoomMessage | null }> {
  return request(withRoom(`/api/questions/${encodeURIComponent(questionId)}/answer`), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** /clear 与 /new 的返回：被清掉的消息数、任务卡数、中止的运行，以及生成的归档摘要（原本为空则是 null）。 */
export interface SessionResetResult {
  cleared: number;
  tasksCleared: number;
  cancelled: number;
  archived: SessionArchiveSummary | null;
}

/** /clear：中止在跑的成员，把群聊记录、任务卡与文件成果归档后清空作战室。 */
export function clearMessages(): Promise<SessionResetResult> {
  return request<SessionResetResult>(withRoom("/api/messages"), { method: "DELETE" });
}

/** /new：归档聊天记录与任务卡后开一个新会话；文件工作区、成员与智能体记忆都保留。 */
export function startNewSession(): Promise<SessionResetResult> {
  return request<SessionResetResult>(withRoom("/api/session/new"), { method: "POST" });
}

/** 归档列表按房间过滤：恢复时要能把内容放回原来那间房。 */
export async function fetchArchives(): Promise<SessionArchiveSummary[]> {
  const body = await request<{ archives: SessionArchiveSummary[] }>(withRoom("/api/archives"));
  return body.archives;
}

export async function fetchArchive(id: string): Promise<SessionArchiveDetail> {
  const body = await request<{ archive: SessionArchiveDetail }>(
    `/api/archives/${encodeURIComponent(id)}`,
  );
  return body.archive;
}

/** 恢复归档：服务端会先把当前内容自动存成新归档，返回里的 autoArchived 为 null 表示当前本来就是空的。 */
export function restoreArchive(id: string): Promise<{
  archive: SessionArchiveSummary;
  autoArchived: SessionArchiveSummary | null;
  restoredFiles: string[];
  conflicts: string[];
  cancelled: number;
}> {
  return request<{
    archive: SessionArchiveSummary;
    autoArchived: SessionArchiveSummary | null;
    restoredFiles: string[];
    conflicts: string[];
    cancelled: number;
  }>(withRoom(`/api/archives/${encodeURIComponent(id)}/restore`), { method: "POST" });
}

export async function deleteArchive(id: string): Promise<string> {
  const body = await request<{ removed: string }>(`/api/archives/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return body.removed;
}

/** 时间旅行：房间内可回看的运行日志与检查点。 */
export interface RunJournalView {
  runId: string;
  memberId: string;
  workItemId?: string;
  createdAt: number;
  updatedAt: number;
  steps: number;
  done: boolean;
  status?: "ok" | "error" | "aborted";
}

export interface RunCheckpointView {
  step: number;
  text: string;
  calls: string[];
  toolResults: number;
}

export async function fetchRuns(roomId: string): Promise<RunJournalView[]> {
  const body = await request<{ runs: RunJournalView[] }>(withRoom("/api/runs", roomId));
  return body.runs;
}

export async function fetchRunCheckpoints(runId: string, roomId: string): Promise<RunCheckpointView[]> {
  const body = await request<{ checkpoints: RunCheckpointView[] }>(
    withRoom(`/api/runs/${encodeURIComponent(runId)}/checkpoints`, roomId),
  );
  return body.checkpoints;
}

export function forkRun(
  runId: string,
  input: { step: number; instruction: string },
  roomId: string,
): Promise<{ runId: string; messageId: string; roomId: string }> {
  return request<{ runId: string; messageId: string; roomId: string }>(
    withRoom(`/api/runs/${encodeURIComponent(runId)}/fork`, roomId),
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function cancelAllMembers(): Promise<number> {
  const body = await request<{ cancelled: number }>(withRoom("/api/members/cancel-all"), {
    method: "POST",
  });
  return body.cancelled;
}

export async function cancelMember(memberId: string): Promise<boolean> {
  const body = await request<{ cancelled: boolean }>(
    withRoom(`/api/members/${memberId}/cancel`),
    { method: "POST" },
  );
  return body.cancelled;
}

export async function createMember(input: {
  name: string;
  description: string;
}): Promise<Member> {
  const body = await request<{ member: Member }>("/api/members", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.member;
}

export interface AgentFileEntry {
  path: string;
  sizeBytes: number;
  updatedAt: number;
}

export interface AgentFileContent {
  path: string;
  content: string;
  totalLines: number;
  truncated: boolean;
}

export async function removeMember(memberId: string): Promise<void> {
  await request<{ removed: string }>(`/api/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
  });
}

export async function fetchMemberFiles(memberId: string): Promise<AgentFileEntry[]> {
  const body = await request<{ files: AgentFileEntry[] }>(
    `/api/members/${encodeURIComponent(memberId)}/files`,
  );
  return body.files;
}

export async function fetchMemberFileContent(
  memberId: string,
  path: string,
  options: { full?: boolean } = {},
): Promise<AgentFileContent> {
  const query = `path=${encodeURIComponent(path)}${options.full ? "&full=1" : ""}`;
  return request<AgentFileContent>(
    `/api/members/${encodeURIComponent(memberId)}/files/content?${query}`,
  );
}

export async function createWorkspaceFolder(path: string): Promise<{ path: string; name: string }> {
  const body = await request<{ folder: { path: string; name: string } }>("/api/files/folder", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  return body.folder;
}

export async function deleteWorkspaceFile(path: string): Promise<void> {
  await request<{ removed: string }>(`/api/files?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
}

export async function saveMemberFile(
  memberId: string,
  path: string,
  content: string,
): Promise<{ path: string; sizeBytes: number; totalLines: number }> {
  return request<{ path: string; sizeBytes: number; totalLines: number }>(
    `/api/members/${encodeURIComponent(memberId)}/files/content`,
    { method: "PUT", body: JSON.stringify({ path, content }) },
  );
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  sizeBytes: number;
  updatedAt: number;
}

export interface WorkspaceFileListing {
  files: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface WorkspaceFileContent {
  path: string;
  name: string;
  sizeBytes: number;
  updatedAt: number;
  binary: boolean;
  preview: "text" | "image" | "binary";
  inlineMime: string | null;
  content: string;
  truncated: boolean;
}

export interface WorkspaceSheetPreview {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
}

export type WorkspaceRichPreview =
  | { kind: "sheet"; sheets: WorkspaceSheetPreview[]; truncated: boolean }
  | { kind: "docx"; html: string; truncated: boolean }
  | { kind: "unavailable"; message: string };

export interface WorkspaceRichPreviewResponse {
  path: string;
  name: string;
  sizeBytes: number;
  updatedAt: number;
  preview: WorkspaceRichPreview;
}

export function fetchWorkspaceFiles(): Promise<WorkspaceFileListing> {
  return request<WorkspaceFileListing>("/api/files");
}

export function fetchWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
  return request<WorkspaceFileContent>(`/api/files/content?path=${encodeURIComponent(path)}`);
}

export function fetchWorkspaceRichPreview(path: string): Promise<WorkspaceRichPreviewResponse> {
  return request<WorkspaceRichPreviewResponse>(
    `/api/files/rich-preview?path=${encodeURIComponent(path)}`,
  );
}

export function workspaceFileDownloadUrl(path: string, options: { inline?: boolean } = {}): string {
  return `/api/files/download?path=${encodeURIComponent(path)}${options.inline ? "&inline=1" : ""}`;
}

export async function uploadWorkspaceFile(
  file: File,
  options: { path?: string; overwrite?: boolean } = {},
): Promise<WorkspaceFileEntry> {
  const relPath = options.path ?? file.name;
  const query = `path=${encodeURIComponent(relPath)}${options.overwrite ? "&overwrite=1" : ""}`;
  const response = await fetch(`/api/files?${query}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      typeof body["error"] === "string" ? body["error"] : `上传失败 ${response.status}`,
      response.status,
    );
  }
  return body["file"] as WorkspaceFileEntry;
}

export interface MemberSkillEntry {
  name: string;
  description: string;
  scope: SkillScope;
  builtin: boolean;
}

export interface MemberSkillsView {
  memberId: string;
  /** null = 未限制：跟随技能库的全部技能（以后新增的也自动启用）。 */
  enabled: string[] | null;
  skills: MemberSkillEntry[];
}

export async function fetchMemberSkills(memberId: string): Promise<MemberSkillsView> {
  return request<MemberSkillsView>(`/api/members/${encodeURIComponent(memberId)}/skills`);
}

export async function saveMemberSkills(
  memberId: string,
  names: string[] | null,
): Promise<MemberSkillsView> {
  return request<MemberSkillsView>(`/api/members/${encodeURIComponent(memberId)}/skills`, {
    method: "PUT",
    body: JSON.stringify({ names }),
  });
}

export async function createTask(title: string): Promise<TaskCard> {
  const body = await request<{ task: TaskCard }>(withRoom("/api/tasks"), {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return body.task;
}

export async function patchTask(taskId: string, patch: { status?: string }): Promise<TaskCard> {
  const body = await request<{ task: TaskCard }>(withRoom(`/api/tasks/${taskId}`), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.task;
}

/** 供应商补丁：apiKey 省略即保持原值，清除密钥请调用 deleteProviderKey。 */
export interface ProviderPatch {
  id: string;
  api?: ProviderApi;
  baseUrl?: string;
  apiKey?: string;
  auth?: "api-key" | "none";
  authHeader?: boolean;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  maxTokens?: number;
  params?: Record<string, unknown>;
  models?: ModelPatch[];
}

export interface ModelPatch {
  id: string;
  name?: string;
  api?: ProviderApi;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  status?: string;
}

export interface SelectionPatch {
  defaultModel?: string;
  /** 传 null/空串表示删除该别名。 */
  aliases?: Record<string, string | null>;
  fallbacks?: string[];
  allow?: string[];
  params?: Record<string, unknown>;
  modelParams?: Record<string, Record<string, unknown>>;
}

export async function saveSettings(patch: {
  providers?: ProviderPatch[];
  selection?: SelectionPatch;
  /** 以存储单位提交（超时为毫秒），服务端按 LIMIT_FIELDS 区间校验。 */
  limits?: Partial<Limits>;
  /** 学习层开关：模式 / 复盘频率 / 每日上限 / 复盘模型。 */
  learning?: Partial<LearningSettings>;
  /** 顾问扇出开关：是否启用 / 顾问人数 / 询问节奏 / every_n 间隔 / 失败处理 / 顾问模型。 */
  advisors?: Partial<AdvisorSettings>;
  /** 技能策展开关：是否启用 / 闲置与归档阈值 / 扫描间隔 / 自动归档 / 合并建议 / 策展模型。 */
  curation?: Partial<CurationSettings>;
}): Promise<MaskedSettings> {
  const body = await request<{ settings: MaskedSettings }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return body.settings;
}

export async function deleteProvider(providerId: string): Promise<MaskedSettings> {
  const body = await request<{ settings: MaskedSettings }>(
    `/api/settings/providers/${encodeURIComponent(providerId)}`,
    { method: "DELETE" },
  );
  return body.settings;
}

export async function deleteProviderKey(providerId: string): Promise<MaskedSettings> {
  const body = await request<{ settings: MaskedSettings }>(
    `/api/settings/providers/${encodeURIComponent(providerId)}/key`,
    { method: "DELETE" },
  );
  return body.settings;
}

export interface ModelCardView {
  ref: string;
  providerId: string;
  id: string;
  name: string;
  api: ProviderApi;
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  tiers?: Array<Record<string, unknown>>;
  status: string;
}

export async function fetchModels(): Promise<{
  defaultModel: string;
  aliases: Record<string, string>;
  models: ModelCardView[];
}> {
  return request("/api/models");
}

export interface CatalogSuggestion {
  ref: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelPatch["cost"];
}

export async function fetchCatalogSuggestions(providerId: string): Promise<CatalogSuggestion[]> {
  const body = await request<{ suggestions: CatalogSuggestion[] }>(
    `/api/models/catalog?provider=${encodeURIComponent(providerId)}`,
  );
  return body.suggestions;
}

export interface ProbeResult {
  providerId: string;
  ref?: string;
  status: "ok" | "auth" | "rate_limit" | "billing" | "timeout" | "format" | "unknown" | "no_model";
  reasonCode?: string;
  error?: string;
  latencyMs?: number;
  model?: { ref: string; name?: string };
}

export async function probeModel(input: {
  ref?: string;
  provider?: ProviderPatch;
}): Promise<ProbeResult> {
  return request("/api/models/probe", { method: "POST", body: JSON.stringify(input) });
}

export interface UsageSnapshotView {
  days: number;
  runs: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  byRef: Array<{
    ref: string;
    providerId: string;
    modelId: string;
    runs: number;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd: number;
  }>;
  byDay: Array<{
    day: string;
    runs: number;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    costUsd: number;
  }>;
}

export async function fetchModelUsage(days: number): Promise<UsageSnapshotView> {
  return request(`/api/models/usage?days=${days}`);
}

export async function setMemberModel(
  memberId: string,
  ref: string,
  thinkingLevel?: string | null,
): Promise<Member> {
  const body = await request<{ member: Member }>(`/api/members/${memberId}/model`, {
    method: "PUT",
    body: JSON.stringify({ ref, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }),
  });
  return body.member;
}

/** 一帧 SSE：事件本身 + 它来自哪间房。一个连接要喂作战室和「群聊区」里所有的群。 */
export interface RoomFrame {
  /** 服务端单调序号；重连时浏览器自动带 Last-Event-ID，服务端据此补发。 */
  seq?: number;
  roomId: string;
  event: RoomEvent;
}

export function subscribeEvents(
  onFrame: (frame: RoomFrame) => void,
  onError?: () => void,
  onResync?: () => void,
): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data) as RoomFrame;
      if (frame && typeof frame.roomId === "string" && frame.event) onFrame(frame);
    } catch {
      // ignore malformed frames
    }
  };
  // 断线太久（回放缓冲已滑出窗口）时服务端要求全量重拉，前端不能假装事件流还是连续的。
  if (onResync) source.addEventListener("resync", () => onResync());
  if (onError) source.onerror = () => onError();
  return () => source.close();
}

// ---- 知识库（LLM Wiki 式资料库） ----

export interface KnowledgeBaseInput {
  name: string;
  description?: string;
  purpose?: string;
  schema?: string;
  modelRef?: string;
  embeddingRef?: string;
}

export async function fetchKnowledgeBases(): Promise<KnowledgeBaseMeta[]> {
  const body = await request<{ bases: KnowledgeBaseMeta[] }>("/api/knowledge");
  return body.bases;
}

export async function createKnowledgeBase(input: KnowledgeBaseInput): Promise<KnowledgeBaseMeta> {
  const body = await request<{ base: KnowledgeBaseMeta }>("/api/knowledge", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.base;
}

export async function updateKnowledgeBase(
  id: string,
  patch: Partial<KnowledgeBaseInput>,
): Promise<KnowledgeBaseMeta> {
  const body = await request<{ base: KnowledgeBaseMeta }>(`/api/knowledge/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.base;
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  await request<{ removed: string }>(`/api/knowledge/${id}`, { method: "DELETE" });
}

export async function fetchKnowledgeSnapshot(id: string): Promise<KnowledgeSnapshot> {
  const body = await request<{ snapshot: KnowledgeSnapshot }>(`/api/knowledge/${id}`);
  return body.snapshot;
}

export async function addKnowledgeSource(
  id: string,
  input: { title?: string; content?: string; filePath?: string },
): Promise<{ source: KnowledgeSource; queueItem: KnowledgeQueueItem }> {
  return request(`/api/knowledge/${id}/sources`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function removeKnowledgeSource(id: string, sourceId: string): Promise<void> {
  await request<{ removed: string }>(`/api/knowledge/${id}/sources/${sourceId}`, {
    method: "DELETE",
  });
}

export async function retryKnowledgeQueue(
  id: string,
  itemId?: string,
): Promise<KnowledgeQueueItem[]> {
  const body = await request<{ queue: KnowledgeQueueItem[] }>(`/api/knowledge/${id}/queue/retry`, {
    method: "POST",
    body: JSON.stringify(itemId ? { itemId } : {}),
  });
  return body.queue;
}

export async function cancelKnowledgeQueue(
  id: string,
  itemId?: string,
): Promise<KnowledgeQueueItem[]> {
  const body = await request<{ queue: KnowledgeQueueItem[] }>(`/api/knowledge/${id}/queue/cancel`, {
    method: "POST",
    body: JSON.stringify(itemId ? { itemId } : {}),
  });
  return body.queue;
}

export async function fetchKnowledgePage(
  id: string,
  path: string,
): Promise<{ page: KnowledgePage; raw: string }> {
  return request(`/api/knowledge/${id}/page?path=${encodeURIComponent(path)}`);
}

export async function saveKnowledgePage(
  id: string,
  path: string,
  content: string,
): Promise<KnowledgePage> {
  const body = await request<{ page: KnowledgePage }>(`/api/knowledge/${id}/page`, {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
  return body.page;
}

export async function deleteKnowledgePage(id: string, path: string): Promise<void> {
  await request<{ removed: string }>(
    `/api/knowledge/${id}/page?path=${encodeURIComponent(path)}`,
    { method: "DELETE" },
  );
}

export async function reindexKnowledge(id: string): Promise<KnowledgeSnapshot> {
  const body = await request<{ snapshot: KnowledgeSnapshot }>(`/api/knowledge/${id}/reindex`, {
    method: "POST",
  });
  return body.snapshot;
}

export async function fetchKnowledgeLint(id: string): Promise<KnowledgeLintReport> {
  const body = await request<{ report: KnowledgeLintReport }>(`/api/knowledge/${id}/lint`);
  return body.report;
}

export async function fetchKnowledgeGraph(id: string): Promise<KnowledgeGraph> {
  const body = await request<{ graph: KnowledgeGraph }>(`/api/knowledge/${id}/graph`);
  return body.graph;
}

export async function searchKnowledge(
  query: string,
  kbId?: string,
): Promise<KnowledgeSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (kbId) params.set("kbId", kbId);
  return request<KnowledgeSearchResult>(`/api/knowledge/search?${params.toString()}`);
}

export async function enrichKnowledge(
  id: string,
  input: { apply?: boolean; maxLinks?: number } = {},
): Promise<{ proposals: KnowledgeLinkProposal[]; applied: number }> {
  return request(`/api/knowledge/${id}/enrich`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchKnowledgeReviews(id: string): Promise<KnowledgeReview[]> {
  const body = await request<{ reviews: KnowledgeReview[] }>(`/api/knowledge/${id}/reviews`);
  return body.reviews;
}

export async function resolveKnowledgeReview(
  id: string,
  reviewId: string,
  action: "create-page" | "research" | "skip",
): Promise<KnowledgeReview> {
  const body = await request<{ review: KnowledgeReview }>(
    `/api/knowledge/${id}/reviews/${reviewId}/resolve`,
    { method: "POST", body: JSON.stringify({ action }) },
  );
  return body.review;
}

export async function researchKnowledge(
  id: string,
  input: { topic: string; queries?: string[] },
): Promise<{
  source: KnowledgeSource;
  queueItem: KnowledgeQueueItem;
  queries: string[];
  documents: number;
  warning?: string;
}> {
  return request(`/api/knowledge/${id}/research`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function importKnowledgeFolder(
  id: string,
  input: { path: string; maxFiles?: number },
): Promise<{
  added: KnowledgeSource[];
  skipped: Array<{ path: string; reason: string }>;
  unsupported: Array<{ path: string; reason: string }>;
}> {
  return request(`/api/knowledge/${id}/sources/folder`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function knowledgeExportUrl(id: string): string {
  return `/api/knowledge/${id}/export`;
}

export async function importKnowledgeBundle(file: File): Promise<KnowledgeBaseMeta> {
  const response = await fetch("/api/knowledge/import", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/zip" },
    body: file,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      typeof body["error"] === "string" ? body["error"] : `导入失败 ${response.status}`,
      response.status,
    );
  }
  return body["base"] as KnowledgeBaseMeta;
}

export async function rescanKnowledgeSources(
  id: string,
): Promise<{ added: number; updated: number; removed: number }> {
  const body = await request<{ result: { added: number; updated: number; removed: number } }>(
    `/api/knowledge/${id}/rescan`,
    { method: "POST" },
  );
  return body.result;
}
