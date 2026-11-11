import express, { type NextFunction, type Request, type Response } from "express";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import type { Member, RunScopeKind, TaskStatus } from "../core/types";
import {
  clearProviderKey,
  maskSettings,
  mergeSettings,
  removeProvider,
  sanitizeAdvisors,
  sanitizeCuration,
  sanitizeLearning,
  sanitizeLimits,
  type Settings,
} from "../core/settings";
import {
  THINKING_LEVELS,
  type ProviderConfig,
  type ResolvedModel,
} from "../model/types";
import { listModelRefs, resolveModelChain, splitModelRef, ModelResolutionError } from "../model/refs";
import { catalogSuggestions } from "../model/catalog";
import { probeModel } from "../model/probe";
import {
  sanitizeProviderPatch,
  sanitizeProvidersPatch,
  sanitizeSelectionPatch,
} from "../model/sanitize";
import { AuthError, type AuthService, type PublicUser } from "../auth/auth-service";
import { buildClearSessionCookie, buildSessionCookie, readSessionToken } from "../auth/cookies";
import { SkillError, type SkillRecord, type SkillLibrary } from "../skills/library";
import type { SkillLifecycleState } from "../skills/curation/types";
import { TemplateError, type AgentTemplateRecord, type TemplateLibrary } from "../templates/template-library";
import { draftTemplateFromMember } from "../templates/member-template";
import { CronError, CRON_LIMITS } from "../cron/normalize";
import {
  DEFAULT_SKILL_CATEGORY,
  SKILL_CATEGORIES,
  builtinCategoryOf,
} from "../skills/categories";
import { resolveSkillSelection } from "../skills/selection";
import { MAX_UPLOAD_BYTES, WorkspaceFileError } from "../files/workspace-files";
import { summaryOf } from "../archive/session-archive";
import { buildRichPreview } from "../files/rich-preview";
import { RoomError, roomIdFromQuery } from "../room/registry";
import { ROOM_ROUTING_MODES, isRoomRoutingMode } from "../core/types";
import type { RoomInstance, Workspace, WorkspaceRegistry } from "../workspace/workspace";
import type { RoomInfo } from "../core/types";

export interface AppDeps {
  auth: AuthService;
  workspaces: WorkspaceRegistry;
  skills: SkillLibrary;
  templates: TemplateLibrary;
  webDist: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 归档相关接口的错误口径：找不到归档是 404，ID 不合法等输入问题一律 400。 */
function archiveErrorStatus(err: unknown): number {
  return errorMessage(err) === "归档不存在" ? 404 : 400;
}

function bodyOf(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function queryField(req: Request, key: string): string {
  const value = req.query[key];
  return typeof value === "string" ? value : "";
}

function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** 模型卡片对外展示：请求头可能含密钥引用，一律不外传。 */
function publicModelCard(model: ResolvedModel): Omit<ResolvedModel, "headers"> {
  const { headers: _headers, ...rest } = model;
  return rest;
}

/**
 * 保存选择层时只硬校验默认模型。
 * 别名与备用链是「尽力而为」的引用：内置别名表里 gpt / qwen 这类指向的供应商多半还没配好，
 * 备用链在 `resolveModelChain` 里本来就是静默跳过坏引用，保存时同样不该拦住整个表单。
 */
function assertSelectionUsable(settings: Settings): void {
  const ref = settings.selection.defaultModel.trim();
  if (!ref) {
    if (firstUsableRef(settings) !== undefined) {
      throw new ModelResolutionError("还没有选择默认模型，请在模型设置里挑一个已登记的模型");
    }
    return; // 一个模型都还没配（例如刚新建的空供应商）：允许先把 baseUrl / Key 存下来。
  }
  resolveModelChain(settings, ref);
}

/** 第一个还能用的 `provider/model` 引用；跳过停用模型与没有模型的供应商。 */
function firstUsableRef(settings: Settings): string | undefined {
  return listModelRefs(settings).find((model) => model.status !== "disabled")?.ref;
}

/**
 * 默认模型指向的供应商整个不见了（删掉最后一个供应商的典型后果）时，
 * 自动回落到第一个仍然可用的引用。供应商还在、只是模型没登记，则原样保留，
 * 让 `assertSelectionUsable` 把可读的错误抛回面板，而不是悄悄换掉用户选的东西。
 */
function repairDefaultModel(settings: Settings): Settings {
  const current = settings.selection.defaultModel.trim();
  if (current) {
    try {
      resolveModelChain(settings, current);
      return settings;
    } catch {
      const providerId = splitModelRef(current).providerId;
      if (settings.providers.some((provider) => provider.id === providerId)) return settings;
    }
  }
  const fallback = firstUsableRef(settings);
  if (!fallback || fallback === current) return settings;
  return { ...settings, selection: { ...settings.selection, defaultModel: fallback } };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const jsonBody = express.json({ limit: "1mb" });
  // 技能可以带脚本/模板等附带文件：写技能的接口放宽到 12 MB，其余接口保持 1 MB。
  const skillWriteBody = express.json({ limit: "12mb" });
  // 文件工作区上传走原始字节，单文件上限与 WorkspaceFiles 保持一致。
  const fileUploadBody = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
  app.use((req, res, next) => {
    const path = req.path;
    if (path === "/api/files" && req.method === "POST") {
      return fileUploadBody(req, res, next);
    }
    if (
      (path === "/api/skills/import" || path === "/api/skills") &&
      (req.method === "POST" || req.method === "PATCH")
    ) {
      return skillWriteBody(req, res, next);
    }
    return jsonBody(req, res, next);
  });

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

  /** `?room=` 定位到某间房（缺省就是作战室，所以旧的调用一律不用改）。 */
  const roomScope = async (
    req: Request,
    res: Response,
  ): Promise<{ workspace: Workspace; room: RoomInstance } | null> => {
    const workspace = await workspaceFor(res);
    try {
      return { workspace, room: workspace.room(roomIdFromQuery(req.query["room"])) };
    } catch (err) {
      res
        .status(err instanceof RoomError ? err.status : 400)
        .json({ error: errorMessage(err) });
      return null;
    }
  };

  const roomView = (room: RoomInstance) => ({
    id: room.bus.roomId,
    name: room.bus.roomName,
    kind: room.descriptor.kind,
    ...(room.descriptor.topic ? { topic: room.descriptor.topic } : {}),
    mode: room.bus.roomMode,
    routing: room.bus.roomRouting,
  });

  const skillView = (record: SkillRecord) => {
    const owner = record.ownerId
      ? deps.auth.listUsers().find((candidate) => candidate.id === record.ownerId)
      : undefined;
    const { files, ...rest } = record;
    return {
      ...rest,
      category:
        record.category ??
        (record.builtin ? builtinCategoryOf(record.name) : DEFAULT_SKILL_CATEGORY),
      // 附带文件可能上 MB，列表只回目录；正文用 /api/skills/:id/file 按需取。
      ...(files
        ? { files: files.map(({ path, encoding, size }) => ({ path, encoding, size })) }
        : {}),
      ownerName: owner?.displayName ?? (record.ownerId ? "已注销账号" : null),
    };
  };

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

  app.patch("/api/auth/profile", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const before = currentUser(res);
    const user = await deps.auth.updateProfile(
      before.id,
      {
        ...("displayName" in body ? { displayName: body["displayName"] } : {}),
        ...("currentPassword" in body ? { currentPassword: body["currentPassword"] } : {}),
        ...("newPassword" in body ? { newPassword: body["newPassword"] } : {}),
      },
      res.locals["sessionToken"] as string | undefined,
    );
    if (user.displayName !== before.displayName) {
      const workspace = await workspaceFor(res);
      workspace.renameRoom(user.displayName);
    }
    if (body["newPassword"] !== undefined) closeUserStreams(user.id);
    res.json({ user });
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

  app.post("/api/users/:id/password", async (req: Request, res: Response) => {
    const actor = currentUser(res);
    if (actor.role !== "admin") {
      res.status(403).json({ error: "只有管理员可以重置密码" });
      return;
    }
    const user = await deps.auth.resetPassword(
      actor,
      String(req.params["id"] ?? ""),
      bodyOf(req)["newPassword"],
      res.locals["sessionToken"] as string | undefined,
    );
    if (user.id !== actor.id) closeUserStreams(user.id);
    res.json({ user });
  });

  app.delete("/api/users/:id", async (req: Request, res: Response) => {
    const actor = currentUser(res);
    if (actor.role !== "admin") {
      res.status(403).json({ error: "只有管理员可以删除账号" });
      return;
    }
    const userId = String(req.params["id"] ?? "");
    const deleted = await deps.auth.deleteUser(actor, userId);
    closeUserStreams(userId);
    const removedSkills = await deps.skills.removeOwnedBy(userId);
    const removedTemplates = await deps.templates.removeOwnedBy(userId);
    const workspaceRemoved = await deps.workspaces.drop(userId);
    res.json({ deleted, removedSkills, removedTemplates, workspaceRemoved });
  });

  app.get("/api/skills", (_req: Request, res: Response) => {
    const user = currentUser(res);
    res.json({
      shared: deps.skills.listShared().map(skillView),
      personal: deps.skills.listPersonal(user.id).map(skillView),
      categories: SKILL_CATEGORIES,
      canManageShared: user.role === "admin",
    });
  });

  app.post("/api/skills", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const skill = await deps.skills.create(currentUser(res), {
      scope: body["scope"],
      name: body["name"],
      description: body["description"],
      instructions: body["instructions"],
      ...("category" in body ? { category: body["category"] } : {}),
      ...("files" in body ? { files: body["files"] } : {}),
    });
    res.status(201).json({ skill: skillView(skill) });
  });

  app.get("/api/skills/:id/file", (req: Request, res: Response) => {
    const raw = req.query["path"];
    const file = deps.skills.readFile(
      currentUser(res),
      String(req.params["id"] ?? ""),
      typeof raw === "string" ? raw : undefined,
    );
    res.json({ file });
  });

  app.post("/api/skills/import", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const results = await deps.skills.importMany(currentUser(res), {
      scope: body["scope"],
      overwrite: body["overwrite"],
      files: body["files"],
    });
    res.json({
      results: results.map((item) => ({
        ...item,
        skill: item.skill ? skillView(item.skill) : undefined,
      })),
    });
  });

  app.patch("/api/skills/:id", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const skill = await deps.skills.update(currentUser(res), String(req.params["id"] ?? ""), {
      ...("name" in body ? { name: body["name"] } : {}),
      ...("description" in body ? { description: body["description"] } : {}),
      ...("instructions" in body ? { instructions: body["instructions"] } : {}),
      ...("category" in body ? { category: body["category"] } : {}),
      ...("files" in body ? { files: body["files"] } : {}),
    });
    res.json({ skill: skillView(skill) });
  });

  app.delete("/api/skills/:id", async (req: Request, res: Response) => {
    await deps.skills.remove(currentUser(res), String(req.params["id"] ?? ""));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- 技能策展（P3）

  /**
   * 策展面板的读路径：顺手触发一次「到点才跑」的扫描（间隔闸门在服务里），
   * 所以打开面板就能看到最新的闲置标记与待确认提案，不需要额外的后台定时器。
   */
  app.get("/api/skills/curation", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const sweep = await workspace.curation.sweep();
    const [proposals, log, usage] = await Promise.all([
      workspace.curation.listProposals(),
      workspace.curation.listLog(20),
      workspace.curation.usageSnapshot(),
    ]);
    res.json({ settings: workspace.curation.curationSettings, proposals, log, usage, sweep });
  });

  /** 手动跑一遍扫描：`force` 跳开间隔闸门，`consolidate` 顺带问一次模型有没有重复技能。 */
  app.post("/api/skills/curation/sweep", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const body = bodyOf(req);
    try {
      const result = await workspace.curation.sweep({
        ...(body["force"] === true ? { force: true } : {}),
        ...(body["consolidate"] === true ? { consolidate: true } : {}),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  /** 采纳：闲置/归档直接落生命周期，合并按「一条来源不归本人管就整组拒绝」落地。 */
  app.post("/api/skills/curation/proposals/:id/apply", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const proposal = await workspace.curation.applyProposal(
        currentUser(res),
        String(req.params["id"] ?? ""),
      );
      res.json({ proposal });
    } catch (err) {
      const message = errorMessage(err);
      // 权限类错误沿用技能库自己的状态码（403），只有「提案不存在」才是 404。
      const status =
        err instanceof SkillError ? err.status : message === "策展提案不存在" ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  app.post(
    "/api/skills/curation/proposals/:id/dismiss",
    async (req: Request, res: Response) => {
      const workspace = await workspaceFor(res);
      const reason = stringField(bodyOf(req), "reason").trim();
      try {
        const proposal = await workspace.curation.dismissProposal(
          String(req.params["id"] ?? ""),
          reason || "用户忽略",
        );
        res.json({ proposal });
      } catch (err) {
        const message = errorMessage(err);
        res.status(message === "策展提案不存在" ? 404 : 400).json({ error: message });
      }
    },
  );

  /** 不等扫描，直接为某条技能立一条归档提案（技能卡片上的「提议归档」）。 */
  app.post("/api/skills/curation/archive", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const proposal = await workspace.curation.proposeArchiveNow(
        currentUser(res),
        stringField(bodyOf(req), "skillId"),
      );
      res.status(201).json({ proposal });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  /** 技能卡片上的手动操作：固定、归档、恢复。权限与提案通道共用一套口径。 */
  app.put("/api/skills/:id/lifecycle", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const body = bodyOf(req);
    const state = body["state"];
    const pinned = body["pinned"];
    if (state !== undefined && state !== "active" && state !== "stale" && state !== "archived") {
      res.status(400).json({ error: "生命周期只能是 active、stale 或 archived" });
      return;
    }
    if (pinned !== undefined && typeof pinned !== "boolean") {
      res.status(400).json({ error: "固定标记必须是布尔值" });
      return;
    }
    try {
      const skill = await workspace.curation.setSkillLifecycle(currentUser(res), String(req.params["id"] ?? ""), {
        ...(state !== undefined ? { state: state as SkillLifecycleState } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
      });
      res.json({ skill: skillView(skill) });
    } catch (err) {
      res.status(err instanceof SkillError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  app.get("/api/templates", (_req: Request, res: Response) => {
    const user = currentUser(res);
    res.json({
      builtin: deps.templates.listBuiltin(),
      personal: deps.templates.listPersonal(user.id),
      categories: SKILL_CATEGORIES,
      availableSkills: deps.skills
        .listForAgent(user.id)
        .map((skill) => ({ name: skill.name, description: skill.description })),
    });
  });

  app.post("/api/templates", async (req: Request, res: Response) => {
    const template = await deps.templates.create(currentUser(res), bodyOf(req));
    res.status(201).json({ template });
  });

  // 导出个人模板为可迁移的 JSON；内置模板与别人的个人模板都不导出。
  app.get("/api/templates/:id/export", (req: Request, res: Response) => {
    const document = deps.templates.exportFor(
      currentUser(res),
      String(req.params["id"] ?? ""),
    );
    res.setHeader(
      "content-disposition",
      `attachment; filename="template-${document.template.key}.json"`,
    );
    res.json(document);
  });

  // 导入只落到导入者自己的「我的模板」；每个文件逐个模板给结果，部分失败不影响其余。
  app.post("/api/templates/import", async (req: Request, res: Response) => {
    const results = await deps.templates.importMany(currentUser(res), bodyOf(req));
    res.status(201).json({ results });
  });

  app.patch("/api/templates/:id", async (req: Request, res: Response) => {
    const template = await deps.templates.update(
      currentUser(res),
      String(req.params["id"] ?? ""),
      bodyOf(req),
    );
    res.json({ template });
  });

  app.delete("/api/templates/:id", async (req: Request, res: Response) => {
    const removed = await deps.templates.remove(currentUser(res), String(req.params["id"] ?? ""));
    res.json({ removed: removed.id });
  });

  // 引用模板生成成员：成员名由用户当场决定，其余（功能描述、工作方式、技能白名单）来自模板。
  app.post("/api/templates/apply", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const user = currentUser(res);
    const template = deps.templates.getFor(user, String(body["id"] ?? ""));
    const workspace = await workspaceFor(res);
    try {
      const member = await workspace.orchestrator.createMember({
        name: stringField(body, "name"),
        description: template.brief,
        ...(template.skillNames ? { skillNames: template.skillNames } : {}),
        profile: {
          ...(template.vibe ? { vibe: template.vibe } : {}),
          ...(template.emoji ? { emoji: template.emoji } : {}),
          ...(template.workstyle ? { workstyle: template.workstyle } : {}),
        },
        template: { key: template.key, title: template.title },
      });
      res.status(201).json({ member, template });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.get("/api/state", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json({
      room: roomView(scope.room),
      members: scope.room.bus.listMembers(),
      messages: scope.room.bus.listMessages(300),
      tasks: scope.room.board.list(),
      questions: scope.workspace.listQuestions(scope.room.descriptor.id),
      activity: scope.workspace.listActivity(scope.room.descriptor.id),
      audits: scope.workspace.listAudits(scope.room.descriptor.id),
      settings: maskSettings(scope.workspace.getSettings()),
    });
  });

  // 结构化提问：只读列表（state 里也带一份；单独接口便于面板轮询）。
  app.get("/api/questions", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json({
      roomId: scope.room.descriptor.id,
      questions: scope.workspace.listQuestions(scope.room.descriptor.id),
    });
  });

  // 回答一题：选项或文本二选一；全部答完后后端把答案作为用户消息回灌并唤醒提问者。
  app.post("/api/questions/:id/answer", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    const body = bodyOf(req);
    const fieldId = typeof body["fieldId"] === "string" ? body["fieldId"].trim() : "";
    const optionId = typeof body["optionId"] === "string" ? body["optionId"].trim() : "";
    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    if (!fieldId) {
      res.status(400).json({ error: "fieldId 不能为空" });
      return;
    }
    if (!optionId && !text) {
      res.status(400).json({ error: "必须选择选项或填写回答" });
      return;
    }
    const user = currentUser(res);
    try {
      const result = await scope.workspace.answerQuestion(
        scope.room.descriptor.id,
        String(req.params["id"] ?? ""),
        fieldId,
        { ...(optionId ? { optionId } : {}), ...(text ? { text } : {}) },
        user?.id ?? "user",
      );
      res.json(result);
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  // 持久工作队列：只读投影，附派生健康度（排队过久 / 运行过久）。
  app.get("/api/queue", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json({
      roomId: scope.room.descriptor.id,
      items: scope.workspace.listWorkItems(scope.room.descriptor.id),
    });
  });

  // 房间列表：作战室排在最前，其后是「群聊区」里自建的每间群聊。
  app.get("/api/rooms", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    res.json({ rooms: workspace.listRooms() });
  });

  /** 群聊区面板要按成员池勾选，但页面当前看的可能是某间群聊：单独给一份池名单。 */
  app.get("/api/members", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    res.json({ members: workspace.listPoolMembers() });
  });

  /** 某间房间的花名册：作战室即成员池。 */
  app.get("/api/rooms/:id/members", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      res.json({ members: workspace.room(String(req.params["id"] ?? "")).bus.listMembers() });
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  /** 开一间群聊：名称必填、可选主题，memberIds 从成员池里拉人（主智能体默认在场）。 */
  app.post("/api/rooms", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const room = await workspace.createRoom({
        name: bodyOf(req)["name"],
        topic: bodyOf(req)["topic"],
        memberIds: bodyOf(req)["memberIds"],
      });
      res.status(201).json({ room });
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  app.patch("/api/rooms/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const room = await workspace.updateRoom(String(req.params["id"] ?? ""), {
        ...(req.body && "name" in req.body ? { name: bodyOf(req)["name"] } : {}),
        ...(req.body && "topic" in req.body ? { topic: bodyOf(req)["topic"] } : {}),
      });
      res.json({ room });
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  /** 删除群聊：转录与房间档案一起清掉；成员池、文件工作区与智能体记忆都不动。 */
  app.delete("/api/rooms/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      res.json(await workspace.deleteRoom(String(req.params["id"] ?? "")));
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  /** 拉成员进群。 */
  app.post("/api/rooms/:id/members", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const result = await workspace.inviteMember(
        String(req.params["id"] ?? ""),
        stringField(bodyOf(req), "memberId"),
      );
      res.status(201).json({ room: result.room, member: result.member });
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  /** 把成员移出某间群聊（它在作战室和其他群里照旧）。 */
  app.delete("/api/rooms/:id/members/:memberId", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const memberId = String(req.params["memberId"] ?? "");
    try {
      const room = await workspace.kickMember(String(req.params["id"] ?? ""), memberId);
      res.json({ removed: memberId, room });
    } catch (err) {
      res.status(err instanceof RoomError ? err.status : 400).json({ error: errorMessage(err) });
    }
  });

  // 房间的两个独立开关：mode = delegate（主智能体委派）/ free（成员自由交流）；
  // routing = lead（没点名就交给主智能体）/ everyone（唤醒全员，不相关的回 pass）/ auto（先小调用挑人）。
  // 两者都支持 ?room=，所以作战室和每间群聊各调各的。
  app.patch("/api/room", async (req: Request, res: Response) => {
    const mode = bodyOf(req)["mode"];
    const routing = bodyOf(req)["routing"];
    if (mode === undefined && routing === undefined) {
      res.status(400).json({ error: "请至少提供 mode 或 routing" });
      return;
    }
    if (mode !== undefined && mode !== "delegate" && mode !== "free") {
      res.status(400).json({ error: "mode 必须是 delegate 或 free" });
      return;
    }
    if (routing !== undefined && !isRoomRoutingMode(routing)) {
      res.status(400).json({ error: `routing 必须是 ${ROOM_ROUTING_MODES.join(" / ")}` });
      return;
    }
    const scope = await roomScope(req, res);
    if (!scope) return;
    if (mode !== undefined) scope.workspace.setRoomMode(mode, scope.room.bus.roomId);
    if (routing !== undefined) scope.workspace.setRoomRouting(routing, scope.room.bus.roomId);
    await scope.workspace.persistRoom(scope.room.bus.roomId);
    res.json({ room: roomView(scope.room) });
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
    // 每帧都带上 roomId：一个连接要同时喂作战室和「群聊区」里的所有群，
    // 前端按当前房间过滤，别的房间靠它来刷新群聊列表上的人数与消息数。
    const send = (roomId: string, event: unknown) => {
      res.write(`data: ${JSON.stringify({ roomId, event })}\n\n`);
    };
    const unsubscribeRooms = workspace.subscribeRooms(send);
    const open = streams.get(user.id) ?? new Set<Response>();
    open.add(res);
    streams.set(user.id, open);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribeRooms();
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
    const scope = await roomScope(req, res);
    if (!scope) return;
    // 运行姿态是外部输入：只认已登记的取值，别的（含拼错的 plan）一律按普通轮处理。
    const rawRunScope = stringField(bodyOf(req), "runScope");
    const runScope: RunScopeKind | undefined = rawRunScope === "plan" ? "plan" : undefined;
    try {
      const message = scope.room.orchestrator.sendUserMessage(text, runScope);
      res.status(201).json({ message });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  // /clear：静默中止本房间在跑的成员，把群聊记录与任务卡归档，再清空这间房并落盘。
  // 智能体长期记忆与成员档案不进归档、也不受影响；恢复入口在 /api/archives。
  app.delete("/api/messages", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json(await scope.workspace.clearRoomSession(scope.room.bus.roomId));
  });

  // /new：开一个新会话——群聊记录与任务卡归档（可恢复），文件工作区、成员与智能体记忆都留在原地。
  app.post("/api/session/new", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json(await scope.workspace.newSession(scope.room.bus.roomId));
  });

  app.get("/api/archives", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json({ archives: await scope.workspace.listArchivesForRoom(scope.room.bus.roomId) });
  });

  app.get("/api/archives/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      res.json({ archive: await workspace.archives.read(String(req.params["id"] ?? "")) });
    } catch (err) {
      res.status(archiveErrorStatus(err)).json({ error: errorMessage(err) });
    }
  });

  // 恢复一份归档：当前内容会先自动存成新归档，因此这一步不会丢任何东西。恢复放回 `?room=` 指定的房间。
  app.post("/api/archives/:id/restore", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    try {
      const result = await scope.workspace.restoreArchive(
        String(req.params["id"] ?? ""),
        scope.room.bus.roomId,
      );
      res.json({
        archive: summaryOf(result.archive),
        autoArchived: result.autoArchived,
        restoredFiles: result.restoredFiles,
        conflicts: result.conflicts,
        cancelled: result.cancelled,
      });
    } catch (err) {
      res.status(archiveErrorStatus(err)).json({ error: errorMessage(err) });
    }
  });

  app.delete("/api/archives/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const removed = await workspace.archives.remove(String(req.params["id"] ?? ""));
      res.json({ removed: removed.id });
    } catch (err) {
      res.status(archiveErrorStatus(err)).json({ error: errorMessage(err) });
    }
  });

  // ------------------------------------------------------------ 定时任务（cron）
  // 定义、运行期状态与运行历史都归当前账号的工作区；REST 面用用户权限，可以看到整个账号的任务。

  app.get("/api/crons", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    res.json({
      jobs: workspace.cron.listJobs(currentUser(res).id),
      status: workspace.cron.status(currentUser(res).id),
      limits: CRON_LIMITS,
    });
  });

  app.get("/api/crons/runs", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const jobId = queryField(req, "job_id");
    const limit = Number(queryField(req, "limit")) || undefined;
    const offset = Number(queryField(req, "offset")) || undefined;
    res.json(
      workspace.cron.listRuns(currentUser(res).id, {
        ...(jobId ? { jobId } : {}),
        ...(limit ? { limit } : {}),
        ...(offset ? { offset } : {}),
      }),
    );
  });

  app.post("/api/crons", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const job = await workspace.cron.createJob(currentUser(res).id, bodyOf(req));
    res.status(201).json({ job, view: workspace.cron.getJob(currentUser(res).id, job.id) });
  });

  app.patch("/api/crons/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const userId = currentUser(res).id;
    const job = await workspace.cron.updateJob(userId, String(req.params["id"] ?? ""), bodyOf(req));
    res.json({ job, view: workspace.cron.getJob(userId, job.id) });
  });

  /** 只切启用开关：停用保留记录与历史，重新启用会清掉自动停用标记并按新调度武装。 */
  app.post("/api/crons/:id/enabled", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const userId = currentUser(res).id;
    const job = await workspace.cron.setEnabled(
      userId,
      String(req.params["id"] ?? ""),
      bodyOf(req)["enabled"] === true,
    );
    res.json({ job, view: workspace.cron.getJob(userId, job.id) });
  });

  /** 立刻试跑一次：默认等这一轮落账再返回记录；wait=false 只发起，结果靠 SSE 的 cron-run 事件。 */
  app.post("/api/crons/:id/run", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const run = await workspace.cron.runNow(currentUser(res).id, String(req.params["id"] ?? ""), {
      wait: bodyOf(req)["wait"] !== false,
    });
    res.json({ run });
  });

  app.delete("/api/crons/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const removed = await workspace.cron.removeJob(
      currentUser(res).id,
      String(req.params["id"] ?? ""),
    );
    res.json({ removed: removed.id });
  });

  /** 学习层：待确认的记忆提案 + 复盘流水。面板据此展示「这轮学到了什么、为什么没学」。 */
  app.get("/api/learning", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const limit = Number(queryField(req, "limit")) || undefined;
    res.json({
      proposals: await workspace.learning.listProposals(),
      log: await workspace.learning.listLog(limit),
    });
  });

  /** 采纳提案：走受控追加通道写入长期记忆（主智能体→账号 MEMORY.md，子成员→自己的档案）。 */
  app.post("/api/learning/:id/apply", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      res.json({ proposal: await workspace.learning.applyProposal(String(req.params["id"] ?? "")) });
    } catch (err) {
      const message = errorMessage(err);
      res.status(message === "提案不存在" ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/learning/:id/dismiss", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const reason = stringField(bodyOf(req), "reason").trim();
    try {
      res.json({
        proposal: await workspace.learning.dismissProposal(
          String(req.params["id"] ?? ""),
          reason || "用户忽略",
        ),
      });
    } catch (err) {
      const message = errorMessage(err);
      res.status(message === "提案不存在" ? 404 : 400).json({ error: message });
    }
  });

  app.post("/api/members", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const name = stringField(body, "name");
    const description = stringField(body, "description");
    const workspace = await workspaceFor(res);
    try {
      const member = await workspace.orchestrator.createMember({ name, description });
      res.status(201).json({ member });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.post("/api/members/cancel-all", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    res.json({ cancelled: scope.room.orchestrator.stopAllRuns() });
  });

  app.post("/api/members/:id/cancel", async (req: Request, res: Response) => {
    const scope = await roomScope(req, res);
    if (!scope) return;
    const cancelled = scope.room.orchestrator.cancelMember(String(req.params["id"] ?? ""));
    res.json({ cancelled });
  });

  app.delete("/api/members/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    try {
      const member = await workspace.orchestrator.removeMember(String(req.params["id"] ?? ""));
      // 成员池里删掉的人，也要从各间群聊的花名册里退出。
      await workspace.dropMemberFromRooms(member.id);
      res.json({ removed: member.id });
    } catch (err) {
      const message = errorMessage(err);
      res.status(message === "成员不存在" ? 404 : 400).json({ error: message });
    }
  });

  app.get("/api/members/:id/files", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const memberId = String(req.params["id"] ?? "");
    if (!workspace.bus.listMembers().some((member) => member.id === memberId)) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    try {
      res.json({ files: await workspace.memory.listAgentFiles(memberId) });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.get("/api/members/:id/files/content", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const memberId = String(req.params["id"] ?? "");
    if (!workspace.bus.listMembers().some((member) => member.id === memberId)) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    const relPath = typeof req.query["path"] === "string" ? req.query["path"] : "";
    const full = req.query["full"] === "1";
    try {
      const file = await workspace.memory.readAgentFile(relPath, { full });
      res.json({
        path: relPath.trim().replaceAll("\\", "/").replace(/^\.\//, ""),
        content: file.content,
        totalLines: file.totalLines,
        truncated: file.truncated,
      });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.put("/api/members/:id/files/content", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const memberId = String(req.params["id"] ?? "");
    if (!workspace.bus.listMembers().some((member) => member.id === memberId)) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    const body = bodyOf(req);
    const relPath = typeof body["path"] === "string" ? body["path"] : "";
    try {
      const saved = await workspace.memory.writeAgentFile(relPath, body["content"]);
      res.json(saved);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  // 成员 → 个人模板草稿：把成员的职责、档案里改过的工作方式与技能白名单打包成模板预填值，
  // 用户在模板库的新建表单里确认后再保存（保存仍走 POST /api/templates 的同一套校验）。
  app.get("/api/members/:id/template-draft", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const user = currentUser(res);
    const memberId = String(req.params["id"] ?? "");
    const member = workspace.bus.listMembers().find((candidate) => candidate.id === memberId);
    if (!member) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    const prefix = member.role === "main" ? "" : `agents/${member.id}/`;
    const readProfile = async (name: string): Promise<string | undefined> => {
      const file = await workspace.memory
        .readAgentFile(`${prefix}${name}`, { full: true })
        .catch(() => null);
      return file?.content;
    };
    const [soul, identity] = await Promise.all([readProfile("SOUL.md"), readProfile("IDENTITY.md")]);
    const origin = member.templateKey
      ? [...deps.templates.listBuiltin(), ...deps.templates.listPersonal(user.id)].find(
          (template) => template.key === member.templateKey,
        )
      : undefined;
    res.json({
      member: { id: member.id, name: member.name, role: member.role },
      draft: draftTemplateFromMember({
        member,
        ...(soul ? { soul } : {}),
        ...(identity ? { identity } : {}),
        ...(origin ? { categoryHint: origin.category } : {}),
      }),
    });
  });

  app.get("/api/files", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    res.json(await workspace.files.list());
  });

  app.get("/api/files/content", async (req: Request, res: Response) => {
    const relPath = queryField(req, "path");
    if (!relPath.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    res.json(await workspace.files.read(relPath));
  });

  /** DOCX/XLSX 无法按文本预览，这里按需解析成前端可渲染的结构。 */
  app.get("/api/files/rich-preview", async (req: Request, res: Response) => {
    const relPath = queryField(req, "path");
    if (!relPath.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    const file = await workspace.files.download(relPath);
    const preview = await buildRichPreview(file.absPath, file.sizeBytes);
    if (!preview) {
      res.status(415).json({ error: "该文件类型不支持富格式预览" });
      return;
    }
    res.json({
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes,
      updatedAt: file.updatedAt,
      preview,
    });
  });

  app.get("/api/files/download", async (req: Request, res: Response) => {
    const relPath = queryField(req, "path");
    if (!relPath.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    const file = await workspace.files.download(relPath);
    // 只有图片、PDF 与纯文本允许内联；其余一律附件下载，避免同源执行上传的 HTML/SVG。
    const inline = req.query["inline"] === "1" && file.inlineMime !== null;
    res.setHeader("content-type", inline ? file.inlineMime! : "application/octet-stream");
    res.setHeader("content-length", String(file.sizeBytes));
    res.setHeader("content-disposition", contentDisposition(file.name, inline));
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=0, must-revalidate");
    const stream = createReadStream(file.absPath);
    stream.on("error", (err) => {
      if (res.headersSent) res.destroy(err);
      else res.status(500).json({ error: "读取文件失败" });
    });
    stream.pipe(res);
  });

  app.post("/api/files/folder", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const relPath = typeof body["path"] === "string" ? body["path"] : "";
    if (!relPath.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    const folder = await workspace.files.createDirectory(relPath);
    res.status(201).json({ folder });
  });

  app.delete("/api/files", async (req: Request, res: Response) => {
    const relPath = queryField(req, "path");
    if (!relPath.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    const workspace = await workspaceFor(res);
    const removed = await workspace.files.remove(relPath);
    res.json({ removed: removed.path });
  });

  app.post("/api/files", async (req: Request, res: Response) => {
    const relPath = queryField(req, "path");
    if (!relPath.trim()) {
      res.status(400).json({ error: "path 不能为空" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "请求体必须是文件字节" });
      return;
    }
    const workspace = await workspaceFor(res);
    const file = await workspace.files.write(relPath, req.body, {
      overwrite: req.query["overwrite"] === "1",
    });
    res.status(201).json({ file });
  });

  /** 成员级技能视图：enabled=null 表示未限制（跟随技能库全部技能）。 */
  const memberSkillsView = (member: Member, userId: string) => ({
    memberId: member.id,
    enabled: member.skillNames ?? null,
    skills: deps.skills.listForAgent(userId).map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      builtin: skill.builtin === true,
    })),
  });

  app.get("/api/members/:id/skills", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const member = workspace.bus.getMember(String(req.params["id"] ?? ""));
    if (!member) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    res.json(memberSkillsView(member, currentUser(res).id));
  });

  app.put("/api/members/:id/skills", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const member = workspace.bus.getMember(String(req.params["id"] ?? ""));
    if (!member) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    const userId = currentUser(res).id;
    const body = bodyOf(req);
    if (!("names" in body)) {
      res.status(400).json({ error: "names 不能省略；全部启用请传 null" });
      return;
    }
    let selection: string[] | undefined;
    try {
      selection = resolveSkillSelection(
        body["names"],
        deps.skills.listForAgent(userId).map((skill) => skill.name),
      );
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    // 原对象就地更新：MemberRuntime 缓存的引用与总线上的成员是同一条记录。
    if (selection === undefined) delete member.skillNames;
    else member.skillNames = selection;
    workspace.bus.updateMember(member);
    await workspace.propagateMember(member.id);
    await workspace.persist();
    // 技能授权变了：成员能力档案里的「技能」一行要跟着刷新，面板才不会显示旧白名单。
    await workspace.memory.syncTeamFile();
    res.json(memberSkillsView(member, userId));
  });

  app.post("/api/tasks", async (req: Request, res: Response) => {
    const body = bodyOf(req);
    const title = stringField(body, "title").trim();
    if (!title) {
      res.status(400).json({ error: "title 不能为空" });
      return;
    }
    const scope = await roomScope(req, res);
    if (!scope) return;
    try {
      const task = scope.room.board.create({
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
    const scope = await roomScope(req, res);
    if (!scope) return;
    try {
      const task = scope.room.board.update(String(req.params["id"] ?? ""), {
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
      const body = bodyOf(req);
      const current = workspace.getSettings();
      const providers =
        body.providers !== undefined ? sanitizeProvidersPatch(body.providers) : undefined;
      const selection =
        body.selection !== undefined
          ? sanitizeSelectionPatch(body.selection, current.selection)
          : undefined;
      const limits = body.limits !== undefined ? sanitizeLimits(body.limits) : undefined;
      const learning = body.learning !== undefined ? sanitizeLearning(body.learning) : undefined;
      const advisors = body.advisors !== undefined ? sanitizeAdvisors(body.advisors) : undefined;
      const curation = body.curation !== undefined ? sanitizeCuration(body.curation) : undefined;
      const next = mergeSettings(current, {
        ...(providers ? { providers } : {}),
        ...(selection ? { selection } : {}),
        ...(limits ? { limits } : {}),
        ...(learning ? { learning } : {}),
        ...(advisors ? { advisors } : {}),
        ...(curation ? { curation } : {}),
      });
      // 默认模型失效（指向已删/已停用的模型）时先回落到仍然可用的引用，再校验。
      const ready = repairDefaultModel(next);
      // 只硬校验默认模型：别名与备用链里的坏引用不该阻塞保存。
      assertSelectionUsable(ready);
      await workspace.setSettings(ready);
      res.json({ settings: maskSettings(ready) });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.delete("/api/settings/providers/:id", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const providerId = String(req.params["id"] ?? "").trim();
    if (!workspace.getSettings().providers.some((provider) => provider.id === providerId)) {
      res.status(404).json({ error: "供应商不存在" });
      return;
    }
    const next = repairDefaultModel(removeProvider(workspace.getSettings(), providerId));
    await workspace.setSettings(next);
    res.json({ settings: maskSettings(next) });
  });

  // 清除已存密钥：面板上密钥输入框留空提交不会清除，必须走这个显式入口。
  app.delete("/api/settings/providers/:id/key", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const providerId = String(req.params["id"] ?? "").trim();
    if (!workspace.getSettings().providers.some((provider) => provider.id === providerId)) {
      res.status(404).json({ error: "供应商不存在" });
      return;
    }
    const next = clearProviderKey(workspace.getSettings(), providerId);
    await workspace.setSettings(next);
    res.json({ settings: maskSettings(next) });
  });

  // 可选模型清单（含目录解析后的窗口/输出上限与定价），供成员模型选择器和设置面板展示。
  app.get("/api/models", async (_req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const settings = workspace.getSettings();
    res.json({
      defaultModel: settings.selection.defaultModel,
      aliases: settings.selection.aliases,
      models: listModelRefs(settings).map(publicModelCard),
    });
  });

  // 内置模型目录建议：新增供应商时一键带出窗口、输出上限与定价。
  app.get("/api/models/catalog", (req: Request, res: Response) => {
    const provider = queryField(req, "provider").trim();
    if (!provider) {
      res.status(400).json({ error: "缺少 provider 参数" });
      return;
    }
    res.json({
      suggestions: catalogSuggestions(provider).map(({ ref, row }) => ({
        ref,
        modelId: ref.slice(provider.length + 1),
        ...row,
      })),
    });
  });

  // 测试连接：ref 为已保存的模型引用；provider 允许直接测面板里未保存的表单配置。
  app.post("/api/models/probe", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const body = bodyOf(req);
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    const temp = body.provider;
    if (!ref && (!temp || typeof temp !== "object")) {
      res.status(400).json({ error: "请提供 ref 或 provider" });
      return;
    }
    let providerPatch: Partial<ProviderConfig> & { id: string } | undefined;
    try {
      providerPatch = temp
        ? sanitizeProviderPatch(temp)
        : undefined;
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    try {
      const result = await probeModel(
        { ...(ref ? { ref } : {}), ...(providerPatch ? { provider: providerPatch } : {}) },
        { settings: workspace.getSettings(), dataDir: workspace.dirPath },
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.get("/api/models/usage", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const rawDays = Number(req.query.days);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(120, Math.floor(rawDays))) : 7;
    const providerId = typeof req.query.providerId === "string" ? req.query.providerId : undefined;
    res.json(await workspace.usage.snapshot({ days, ...(providerId ? { providerId } : {}) }));
  });

  // 成员级模型：`provider/model`、别名或 default（跟随设置里的默认模型）。
  app.put("/api/members/:id/model", async (req: Request, res: Response) => {
    const workspace = await workspaceFor(res);
    const member = workspace.bus.getMember(String(req.params["id"] ?? ""));
    if (!member) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    const body = bodyOf(req);
    const modelRef = typeof body.ref === "string" ? body.ref.trim() : "";
    if (!modelRef) {
      res.status(400).json({ error: "ref 不能为空" });
      return;
    }
    const level = body.thinkingLevel;
    if (level !== undefined && level !== null && !THINKING_LEVELS.includes(level as never)) {
      res.status(400).json({ error: "thinkingLevel 只支持 off、minimal、low、medium、high、xhigh、max" });
      return;
    }
    try {
      // 校验引用可解析（存在、未被允许列表排除），再落到成员档案上。
      resolveModelChain(workspace.getSettings(), modelRef);
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    // 原对象就地更新：MemberRuntime 缓存的引用与总线上的成员是同一条记录。
    member.modelRef = modelRef;
    if (level === null || level === undefined) delete member.thinkingLevel;
    else member.thinkingLevel = level as Member["thinkingLevel"];
    workspace.bus.updateMember(member);
    // 各群聊里的副本跟着换模型，否则同一个成员在群里和作战室用的不是同一个脑子。
    await workspace.propagateMember(member.id);
    await workspace.persist();
    res.json({ member });
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

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof WorkspaceFileError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (
      err instanceof AuthError ||
      err instanceof SkillError ||
      err instanceof TemplateError ||
      err instanceof RoomError ||
      err instanceof CronError
    ) {
      const retryAfterMs = err instanceof AuthError ? err.retryAfterMs : undefined;
      if (retryAfterMs) {
        res.setHeader("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      }
      res.status(err.status).json({
        error: err.message,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      });
      return;
    }
    const clientStatus = (err as { status?: number; statusCode?: number } | null)?.status
      ?? (err as { statusCode?: number } | null)?.statusCode;
    if (typeof clientStatus === "number" && clientStatus >= 400 && clientStatus < 500) {
      res
        .status(clientStatus)
        .json({
          error:
            clientStatus === 413
              ? req.path === "/api/files"
                ? `文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`
                : "内容过大：技能接口单次请求不超过 12 MB，单个文件不超过 256 KB，每个技能最多 40 个附带文件"
              : "请求体格式不正确",
        });
      return;
    }
    console.error("请求处理失败", err);
    res.status(500).json({ error: "服务器内部错误" });
  });
  return app;
}
