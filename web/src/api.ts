import type { RoomEvent, RoomMessage, TaskCard, Member } from "../../src/core/types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body["error"] === "string" ? body["error"] : `请求失败 ${response.status}`);
  }
  return body as T;
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

export function subscribeEvents(onEvent: (event: RoomEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as RoomEvent);
    } catch {
      // ignore malformed frames
    }
  };
  return () => source.close();
}
