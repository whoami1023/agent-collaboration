import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "../core/types";
import { maskSettings, mergeSettings } from "../core/settings";
import { AuthError, type AuthService, type PublicUser } from "../auth/auth-service";
import { buildClearSessionCookie, buildSessionCookie, readSessionToken } from "../auth/cookies";
import type { Workspace, WorkspaceRegistry } from "../workspace/workspace";

export interface AppDeps {
  auth: AuthService;
  workspaces: WorkspaceRegistry;
  webDist: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bodyOf(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const streams = new Map<string, Set<Response>>();
  const closeUserStreams = (userId: string): void => {
    const open = streams.get(userId);
    if (!open) return;
    streams.delete(userId);
    for (const response of open) response.end();
  };

  const currentUser = (res: Response): PublicUser => res.locals["user"] as PublicUser;
  const workspaceFor = (res: Response): Promise<Workspace> =>
    deps.workspaces.get(currentUser(res));

  const startSession = (res: Response, result: { token: string; expiresAt: number }): void => {
    const maxAge = Math.max(1, Math.floor((result.expiresAt - Date.now()) / 1000));
    res.append("set-cookie", buildSessionCookie(result.token, maxAge));
  };

  app.get("/api/auth/bootstrap", (_req: Request, res: Response) => {
    res.json({ needsSetup: deps.auth.needsSetup() });
  });

  app.post("/api/auth/setup", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const result = await deps.auth.setupAdmin({
      username: stringField(body, "username"),
      displayName: stringField(body, "displayName"),
      password: stringField(body, "password"),
    });
    startSession(res, result);
    res.status(201).json({ user: result.user });
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const result = await deps.auth.login(
      stringField(body, "username"),
      stringField(body, "password"),
      req.ip ?? "unknown",
    );
    startSession(res, result);
    res.json({ user: result.user });
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    const token = readSessionToken(req.headers.cookie);
    const user = await deps.auth.authenticate(token);
    if (user) closeUserStreams(user.id);
    await deps.auth.logout(token);
    res.append("set-cookie", buildClearSessionCookie());
    res.json({ ok: true });
  });

  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
    const token = readSessionToken(req.headers.cookie);
    const user = await deps.auth.authenticate(token);
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    res.locals["user"] = user;
    res.locals["sessionToken"] = token;
    next();
  });

  app.get("/api/auth/me", (_req: Request, res: Response) => {
    res.json({ user: currentUser(res) });
  });

  app.get("/api/users", (_req: Request, res: Response) => {
    if (currentUser(res).role !== "admin") {
      res.status(403).json({ error: "只有管理员可以查看账号列表" });
      return;
    }
    res.json({ users: deps.auth.listUsers() });
  });

  app.post("/api/users", async (req: Request, res: Response) => {
    if (currentUser(res).role !== "admin") {
      res.status(403).json({ error: "只有管理员可以创建账号" });
      return;
    }
    const body = bodyOf(req);
    const user = await deps.auth.createUser(currentUser(res), {
      username: stringField(body, "username"),
      displayName: stringField(body, "displayName"),
      password: stringField(body, "password"),
    });
    res.status(201).json({ user });
  });

  app.get("/api/state", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    res.json({
      room: { id: workspace.bus.roomId, name: workspace.bus.roomName },
      members: workspace.bus.listMembers(),
      messages: workspace.bus.listMessages(300),
      tasks: workspace.board.list(),
      settings: maskSettings(workspace.getSettings()),
    });
  });

  app.get("/api/events", async (req: Request, res: Response) => {
    const user = currentUser(res);
    const workspace = await workspaceFor(res);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribeBus = workspace.bus.subscribe(send);
    const unsubscribeBoard = workspace.board.subscribe(send);
    const open = streams.get(user.id) ?? new Set<Response>();
    open.add(res);
    streams.set(user.id, open);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribeBus();
      unsubscribeBoard();
      open.delete(res);
      if (open.size === 0) streams.delete(user.id);
      res.end();
    });
  });

  app.post("/api/messages", async (req: Request, res: Response) => {
    const text = stringField(bodyOf(req), "text");
    if (!text.trim()) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    try {
      const message = workspace.orchestrator.sendUserMessage(text);
      res.status(201).json({ message });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.post("/api/members/:id/cancel", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const cancelled = workspace.orchestrator.cancelMember(String(req.params["id"] ?? ""));
    res.json({ cancelled });
  });

  app.post("/api/tasks", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const title = stringField(body, "title").trim();
    if (!title) {
      res.status(400).json({ error: "title 不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    try {
      const task = workspace.board.create({
        title,
        ...(typeof body["detail"] === "string" ? { detail: body["detail"] } : {}),
        createdBy: currentUser(res).id,
        ...(typeof body["ownerId"] === "string" ? { ownerId: body["ownerId"] } : {}),
      });
      res.status(201).json({ task });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.patch("/api/tasks/:id", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const workspace = await workspaceFor(res);
    try {
      const task = workspace.board.update(String(req.params["id"] ?? ""), {
        ...(typeof body["status"] === "string" ? { status: body["status"] as TaskStatus } : {}),
        ...(typeof body["title"] === "string" ? { title: body["title"] } : {}),
        ...(typeof body["detail"] === "string" ? { detail: body["detail"] } : {}),
      });
      res.json({ task });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.put("/api/settings", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const body = bodyOf(req) as Parameters<typeof mergeSettings>[1];
      const next = mergeSettings(workspace.getSettings(), body);
      await workspace.setSettings(next);
      res.json({ settings: maskSettings(next) });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  if (existsSync(deps.webDist)) {
    app.use(express.static(deps.webDist));
    app.use((req: Request, res: Response, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(join(deps.webDist, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof AuthError) {
      if (err.retryAfterMs) {
        res.setHeader("retry-after", String(Math.ceil(err.retryAfterMs / 1000)));
      }
      res.status(err.status).json({
        error: err.message,
        ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}),
      });
      return;
    }
    console.error("请求处理失败", err);
    res.status(500).json({ error: "服务器内部错误" });
  });

  return app;
}
