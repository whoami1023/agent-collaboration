import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newId } from "../core/ids";
import type { PublicUser } from "../core/types";
import { writeJsonAtomic } from "../store/persist";

export type { PublicUser, UserRole } from "../core/types";

interface UserRecord extends PublicUser {
  salt: string;
  passwordHash: string;
}

interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthData {
  users: UserRecord[];
  sessions: SessionRecord[];
}

export interface AuthOptions {
  sessionTtlMs?: number;
  maxAttempts?: number;
  failureWindowMs?: number;
  lockoutMs?: number;
  now?: () => number;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
  expiresAt: number;
}

export interface CreateUserInput {
  username: string;
  displayName?: string;
  password: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const DISPLAY_NAME_MAX = 24;
const DEFAULT_MAIN_AGENT_ID = "m_main";
const DEFAULT_ROOM_ID = "room_main";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const FAILURE_WINDOW_MS = 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;
const LIMITER_MAX_KEYS = 5000;
const DUMMY_SALT = "00112233445566778899aabbccddeeff";

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeUsername(raw: unknown): string {
  if (typeof raw !== "string") throw new AuthError(400, "用户名不能为空");
  const username = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new AuthError(400, "用户名需为 3-24 位字母、数字、下划线或连字符");
  }
  return username;
}

function normalizeDisplayName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") throw new AuthError(400, "显示名称格式不正确");
  const displayName = raw.trim();
  if (!displayName) return fallback;
  if (displayName.length > DISPLAY_NAME_MAX) {
    throw new AuthError(400, `显示名称不能超过 ${DISPLAY_NAME_MAX} 个字符`);
  }
  return displayName;
}

function normalizePassword(raw: unknown): string {
  if (typeof raw !== "string") throw new AuthError(400, "密码不能为空");
  if (raw.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(400, `密码不能超过 ${MAX_PASSWORD_LENGTH} 位`);
  }
  return raw;
}

function normalizeLoginPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AuthError(400, "密码不能为空");
  }
  if (raw.length > MAX_PASSWORD_LENGTH) throw new AuthError(400, "密码过长");
  return raw;
}

function publicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    createdAt: record.createdAt,
    mainAgentId: record.mainAgentId,
    roomId: record.roomId,
  };
}

interface LimitEntry {
  attempts: number[];
  lockedUntil?: number;
}

export class AuthService {
  private data: AuthData = { users: [], sessions: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private limits = new Map<string, LimitEntry>();
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly maxAttempts: number;
  private readonly failureWindowMs: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly file: string,
    options: AuthOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.failureWindowMs = options.failureWindowMs ?? FAILURE_WINDOW_MS;
    this.lockoutMs = options.lockoutMs ?? LOCKOUT_MS;
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<AuthData>;
      this.data = {
        users: Array.isArray(raw.users) ? raw.users : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const now = this.now();
    this.data.sessions = this.data.sessions.filter((session) => session.expiresAt > now);
  }

  needsSetup(): boolean {
    return this.data.users.length === 0;
  }

  listUsers(): PublicUser[] {
    return this.data.users
      .map(publicUser)
      .sort((a, b) => (a.role === b.role ? a.createdAt - b.createdAt : a.role === "admin" ? -1 : 1));
  }

  async setupAdmin(input: CreateUserInput): Promise<AuthResult> {
    return this.mutate(async () => {
      if (!this.needsSetup()) throw new AuthError(409, "管理员已存在，请直接登录");
      const username = normalizeUsername(input.username);
      const password = normalizePassword(input.password);
      const displayName = normalizeDisplayName(input.displayName, username);
      const { salt, passwordHash } = await hashPassword(password);
      const user: UserRecord = {
        id: newId("u"),
        username,
        displayName,
        role: "admin",
        salt,
        passwordHash,
        createdAt: this.now(),
        mainAgentId: DEFAULT_MAIN_AGENT_ID,
        roomId: DEFAULT_ROOM_ID,
      };
      this.data.users.push(user);
      const result = this.issueSession(user);
      await this.persist();
      return result;
    });
  }

  async createUser(actor: PublicUser, input: CreateUserInput): Promise<PublicUser> {
    return this.mutate(async () => {
      if (actor.role !== "admin") throw new AuthError(403, "只有管理员可以创建账号");
      const username = normalizeUsername(input.username);
      const password = normalizePassword(input.password);
      const displayName = normalizeDisplayName(input.displayName, username);
      if (this.data.users.some((user) => user.username === username)) {
        throw new AuthError(409, "用户名已被占用");
      }
      const { salt, passwordHash } = await hashPassword(password);
      const user: UserRecord = {
        id: newId("u"),
        username,
        displayName,
        role: "user",
        salt,
        passwordHash,
        createdAt: this.now(),
        mainAgentId: DEFAULT_MAIN_AGENT_ID,
        roomId: DEFAULT_ROOM_ID,
      };
      this.data.users.push(user);
      await this.persist();
      return publicUser(user);
    });
  }

  async login(usernameRaw: unknown, passwordRaw: unknown, ip: string): Promise<AuthResult> {
    return this.mutate(async () => {
      const username = normalizeUsername(usernameRaw);
      const password = normalizeLoginPassword(passwordRaw);
      const key = `${ip}|${username}`;
      const retryAfterMs = this.checkLimit(key);
      if (retryAfterMs > 0) {
        throw new AuthError(429, "尝试次数过多，请稍后再试", retryAfterMs);
      }
      const user = this.data.users.find((candidate) => candidate.username === username);
      if (!user) {
        await scryptAsync(password, DUMMY_SALT);
        this.recordFailure(key);
        throw new AuthError(401, "用户名或密码错误");
      }
      const candidateHash = await scryptAsync(password, user.salt);
      const expected = Buffer.from(user.passwordHash, "hex");
      const matches =
        candidateHash.length === expected.length && timingSafeEqual(candidateHash, expected);
      if (!matches) {
        this.recordFailure(key);
        throw new AuthError(401, "用户名或密码错误");
      }
      this.limits.delete(key);
      const result = this.issueSession(user);
      this.pruneSessions();
      await this.persist();
      return result;
    });
  }

  async authenticate(token: string | undefined): Promise<PublicUser | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.data.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session || session.expiresAt <= this.now()) return null;
    const user = this.data.users.find((candidate) => candidate.id === session.userId);
    return user ? publicUser(user) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    await this.mutate(async () => {
      const before = this.data.sessions.length;
      this.data.sessions = this.data.sessions.filter(
        (session) => session.tokenHash !== tokenHash,
      );
      if (this.data.sessions.length !== before) await this.persist();
    });
  }

  private issueSession(user: UserRecord): AuthResult {
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + this.sessionTtlMs;
    this.data.sessions.push({
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt,
      expiresAt,
    });
    return { user: publicUser(user), token, expiresAt };
  }

  private pruneSessions(): void {
    const now = this.now();
    this.data.sessions = this.data.sessions.filter((session) => session.expiresAt > now);
  }

  private checkLimit(key: string): number {
    const entry = this.limits.get(key);
    if (!entry) return 0;
    const now = this.now();
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      this.limits.delete(key);
      return 0;
    }
    if (entry.lockedUntil) return entry.lockedUntil - now;
    entry.attempts = entry.attempts.filter((ts) => ts > now - this.failureWindowMs);
    if (entry.attempts.length >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
      return this.lockoutMs;
    }
    if (entry.attempts.length === 0) this.limits.delete(key);
    return 0;
  }

  private recordFailure(key: string): void {
    const now = this.now();
    if (this.limits.size >= LIMITER_MAX_KEYS) {
      for (const [candidate, entry] of this.limits) {
        if (!entry.lockedUntil || entry.lockedUntil <= now) this.limits.delete(candidate);
        if (this.limits.size < LIMITER_MAX_KEYS) break;
      }
    }
    const entry = this.limits.get(key) ?? { attempts: [] };
    entry.attempts = entry.attempts.filter((ts) => ts > now - this.failureWindowMs);
    entry.attempts.push(now);
    if (entry.attempts.length >= this.maxAttempts) entry.lockedUntil = now + this.lockoutMs;
    this.limits.set(key, entry);
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.data);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function hashPassword(password: string): Promise<{ salt: string; passwordHash: string }> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt);
  return { salt, passwordHash: derived.toString("hex") };
}
