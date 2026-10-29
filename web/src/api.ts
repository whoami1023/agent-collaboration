import type {
  Member,
  PublicUser,
  RoomEvent,
  RoomMessage,
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
  limits: Record<string, number>;
}

export interface StateSnapshot {
  room: { id: string; name: string };
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

export interface SkillView {
  id: string;
  scope: SkillScope;
  ownerId: string | null;
  ownerName: string | null;
  name: string;
  description: string;
  instructions: string;
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
  canManageShared: boolean;
}

export async function fetchSkills(): Promise<SkillSnapshot> {
  return request<SkillSnapshot>("/api/skills");
}

export async function createSkill(input: {
  scope: SkillScope;
  name: string;
  description: string;
  instructions: string;
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
  files: { filename: string; content: string }[];
}): Promise<{ results: SkillImportResult[] }> {
  return request<{ results: SkillImportResult[] }>("/api/skills/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateSkill(
  skillId: string,
  patch: { name?: string; description?: string; instructions?: string },
): Promise<SkillView> {
  const body = await request<{ skill: SkillView }>(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.skill;
}

export async function deleteSkill(skillId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
  });
}

export function fetchState(): Promise<StateSnapshot> {
  return request<StateSnapshot>("/api/state");
}

export async function sendMessage(text: string): Promise<RoomMessage> {
  const body = await request<{ message: RoomMessage }>("/api/messages", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  return body.message;
}

export async function cancelMember(memberId: string): Promise<boolean> {
  const body = await request<{ cancelled: boolean }>(`/api/members/${memberId}/cancel`, {
    method: "POST",
  });
  return body.cancelled;
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

export async function fetchMemberFiles(memberId: string): Promise<AgentFileEntry[]> {
  const body = await request<{ files: AgentFileEntry[] }>(
    `/api/members/${encodeURIComponent(memberId)}/files`,
  );
  return body.files;
}

export async function fetchMemberFileContent(
  memberId: string,
  path: string,
): Promise<AgentFileContent> {
  return request<AgentFileContent>(
    `/api/members/${encodeURIComponent(memberId)}/files/content?path=${encodeURIComponent(path)}`,
  );
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
