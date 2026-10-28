import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "../core/types";
import { maskSettings, mergeSettings, type Settings } from "../core/settings";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { Orchestrator } from "../agent/orchestrator";

export interface AppDeps {
  bus: RoomBus;
  board: Workboard;
  orchestrator: Orchestrator;
  getSettings(): Settings;
  setSettings(next: Settings): Promise<void>;
  webDist: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/state", (_req: Request, res: Response) => {
    res.json({
      room: { id: deps.bus.roomId, name: deps.bus.roomName },
      members: deps.bus.listMembers(),
      messages: deps.bus.listMessages(300),
      tasks: deps.board.list(),
      settings: maskSettings(deps.getSettings()),
    });
  });

  app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const send = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribeBus = deps.bus.subscribe(send);
    const unsubscribeBoard = deps.board.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribeBus();
      unsubscribeBoard();
      res.end();
    });
  });

  app.post("/api/messages", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body["text"] === "string" ? body["text"] : "";
    if (!text.trim()) {
      res.status(400).json({ error: "消息不能为空" });
      return;
    }
    try {
      const message = deps.orchestrator.sendUserMessage(text);
      res.status(201).json({ message });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.post("/api/members/:id/cancel", (req: Request, res: Response) => {
    const cancelled = deps.orchestrator.cancelMember(String(req.params["id"] ?? ""));
    res.json({ cancelled });
  });

  app.post("/api/tasks", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body["title"] === "string" ? body["title"].trim() : "";
    if (!title) {
      res.status(400).json({ error: "title 不能为空" });
      return;
    }
    try {
      const task = deps.board.create({
        title,
        ...(typeof body["detail"] === "string" ? { detail: body["detail"] } : {}),
        createdBy: "user",
        ...(typeof body["ownerId"] === "string" ? { ownerId: body["ownerId"] } : {}),
      });
      res.status(201).json({ task });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.patch("/api/tasks/:id", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const task = deps.board.update(String(req.params["id"] ?? ""), {
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
    try {
      const body = (req.body ?? {}) as Parameters<typeof mergeSettings>[1];
      const next = mergeSettings(deps.getSettings(), body);
      await deps.setSettings(next);
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

  return app;
}
