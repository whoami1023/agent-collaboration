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
