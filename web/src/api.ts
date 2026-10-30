import type {
  Limits,
  Member,
  PublicUser,
  RoomEvent,
  RoomMessage,
  RoomMode,
  TaskCard,
} from "../../src/core/types";

export interface MaskedProvider {
  id: string;
  kind: "mock" | "openai";
  baseUrl?: string;
  model: string;
  hasApiKey: boolean;
}

export interface MaskedSettings {
  providers: MaskedProvider[];
  activeProviderId: string;
  limits: Partial<Limits>;
}

export interface StateSnapshot {
  room: { id: string; name: string; mode: RoomMode };
  members: Member[];
  messages: RoomMessage[];
  tasks: TaskCard[];
  settings: MaskedSettings;
}

export interface BootstrapInfo {
  needsSetup: boolean;
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

export function fetchState(): Promise<StateSnapshot> {
  return request<StateSnapshot>("/api/state");
}

export async function setRoomMode(
  mode: RoomMode,
): Promise<{ id: string; name: string; mode: RoomMode }> {
  const body = await request<{ room: { id: string; name: string; mode: RoomMode } }>("/api/room", {
    method: "PATCH",
    body: JSON.stringify({ mode }),
  });
  return body.room;
}

export async function sendMessage(text: string): Promise<RoomMessage> {
  const body = await request<{ message: RoomMessage }>("/api/messages", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  return body.message;
}

export function clearMessages(): Promise<{ cleared: number; cancelled: number }> {
  return request<{ cleared: number; cancelled: number }>("/api/messages", {
    method: "DELETE",
  });
}

export async function cancelAllMembers(): Promise<number> {
  const body = await request<{ cancelled: number }>("/api/members/cancel-all", {
    method: "POST",
  });
  return body.cancelled;
}

export async function cancelMember(memberId: string): Promise<boolean> {
  const body = await request<{ cancelled: boolean }>(`/api/members/${memberId}/cancel`, {
    method: "POST",
  });
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
  const body = await request<{ task: TaskCard }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return body.task;
}

export async function patchTask(taskId: string, patch: { status?: string }): Promise<TaskCard> {
  const body = await request<{ task: TaskCard }>(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.task;
}

export async function saveSettings(patch: {
  activeProviderId?: string;
  providers?: Array<{ id: string; apiKey?: string; baseUrl?: string; model?: string }>;
}): Promise<MaskedSettings> {
  const body = await request<{ settings: MaskedSettings }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return body.settings;
}

export function subscribeEvents(
  onEvent: (event: RoomEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as RoomEvent);
    } catch {
      // ignore malformed frames
    }
  };
  if (onError) source.onerror = () => onError();
  return () => source.close();
}
