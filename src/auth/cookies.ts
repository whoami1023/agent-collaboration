export const SESSION_COOKIE = "ac_session";

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSessionToken(header: string | undefined): string | undefined {
  return parseCookieHeader(header)[SESSION_COOKIE];
}
