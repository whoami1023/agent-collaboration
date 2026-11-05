// 学习层的 HTTP 面：提案/流水 REST 路由、采纳写入记忆、账号隔离与 SSE 广播。
// 复盘内容走工作区自带的演示模型（演示 handler 不会输出复盘要求的 JSON，正好用来验证「解析失败也留痕」）。

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { MAIN_ROOM_ID } from "../src/room/registry";
import { SkillLibrary } from "../src/skills/library";
import { TemplateLibrary } from "../src/templates/template-library";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import type { LearningProposal, LearningRunInput, MemoryProposal, SkillProposal } from "../src/agent/learning/types";
import { createApp } from "../src/server/app";

let dir: string;
let registry: WorkspaceRegistry;
let server: Server;
let baseUrl: string;
let ownerCookie: string;
let ownerId: string;
let aliceCookie: string;
let aliceId: string;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; auth?: string } = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.auth ? { cookie: options.auth } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

interface SseCapture {
  events: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function openEvents(auth: string): Promise<SseCapture> {
  const response = await fetch(`${baseUrl}/api/events`, { headers: { cookie: auth } });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE 没有可读流");
  const capture: SseCapture = { events: [], close: async () => void (await reader.cancel()) };
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
            const event =
              typeof payload["roomId"] === "string" && payload["event"] && typeof payload["event"] === "object"
                ? (payload["event"] as Record<string, unknown>)
                : payload;
            capture.events.push(event);
          } catch {
            /* 心跳与非 JSON 帧忽略 */
          }
        }
      }
    }
  })();
  return capture;
}

async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function proposalOf(
  id: string,
  createdAt: number,
  overrides: Partial<MemoryProposal> = {},
): MemoryProposal {
  return {
    id,
    kind: "memory",
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    memberId: "m_main",
    memberName: "主智能体",
    memberRole: "main",
    roomId: MAIN_ROOM_ID,
    roomName: "老板 的作战室",
    runId: "run_seed",
    target: "account",
    content: `第 ${id} 条：这个仓库统一使用 pnpm 作为包管理器。`,
    triggers: ["包管理器"],
    importance: 7,
    rationale: "用户：以后统一用 pnpm",
    ...overrides,
  };
}

async function seedLearning(proposals: readonly LearningProposal[]): Promise<void> {
  // LearningStore 懒加载：只要在任何学习接口之前把文件写好，工作区就会按这份账本继续。
  await writeFile(join(dir, "workspaces", ownerId, "learning.json"), JSON.stringify({ proposals, log: [] }), "utf8");
}

function skillProposalOf(
  id: string,
  createdAt: number,
  overrides: Partial<SkillProposal> = {},
): SkillProposal {
  return {
    id,
    kind: "skill",
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    memberId: "m_main",
    memberName: "主智能体",
    memberRole: "main",
    roomId: MAIN_ROOM_ID,
    roomName: "老板 的作战室",
    runId: "run_seed",
    rationale: "本轮完整跑通了切换流程",
    skill: {
      name: "pnpm-migration",
      description: "把一个 Node 仓库从 npm 切换到 pnpm",
      instructions: "1. 读取 package.json，确认现有包管理器。\n2. 生成 pnpm 锁文件。\n3. 更新脚本与文档。\n4. 运行测试确认依赖一致。",
      category: "engineering",
      triggers: ["迁移 pnpm"],
    },
    ...overrides,
  };
}

function learningInput(overrides: Partial<LearningRunInput> = {}): LearningRunInput {
  return {
    memberId: "m_main",
    memberName: "主智能体",
    memberRole: "main",
    modelRef: "demo/mock",
    roomId: MAIN_ROOM_ID,
    roomName: "Alice 的作战室",
    runId: "run_http_1",
    triggerText: "以后统一用 pnpm。",
    finalText: "已把包管理器统一换成 pnpm，README 和脚本里的 npm 命令也一并改好了，后续沿用这个口径。",
    toolNames: [],
    transcript: "",
    unattended: false,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-learningapi-"));
  const auth = new AuthService(join(dir, "auth.json"));
  await auth.init();
  const skills = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await skills.init();
  const templates = new TemplateLibrary(join(dir, "templates.json"));
  await templates.init();
  registry = new WorkspaceRegistry(join(dir, "workspaces"), skills);
  const app = createApp({ auth, workspaces: registry, skills, templates, webDist: join(dir, "missing-dist") });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器未监听");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", displayName: "老板", password: "secret123" }),
  });
  ownerCookie = (setup.headers.getSetCookie()[0] ?? "").split(";")[0];
  ownerId = String(((await setup.json()) as Record<string, { id: string }>).user.id);
  await mkdir(join(dir, "workspaces", ownerId), { recursive: true });

  const alice = await call("/api/users", {
    method: "POST",
    auth: ownerCookie,
    body: { username: "alice", displayName: "Alice", password: "alicepass1" },
  });
  aliceId = String((alice.body["user"] as { id: string }).id);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alicepass1" }),
  });
  aliceCookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registry.closeAll();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

describe("学习层 REST", () => {
  it("未登录拒绝；登录后 GET 返回提案与流水，账号之间互不可见", async () => {
    expect((await call("/api/learning")).status).toBe(401);

    await seedLearning([
      proposalOf("mem_old", 1000),
      proposalOf("mem_new", 2000, { memberId: "m_doc", memberName: "调研员", memberRole: "sub", target: "member" }),
    ]);

    const listed = await call("/api/learning", { auth: ownerCookie });
    expect(listed.status).toBe(200);
    const proposals = listed.body["proposals"] as MemoryProposal[];
    expect(proposals.map((item) => item.id)).toEqual(["mem_new", "mem_old"]);
    expect(proposals[1]?.target).toBe("account");
    expect(listed.body["log"]).toEqual([]);

    // 另一个账号看不到别人的复盘产出
    const other = await call("/api/learning", { auth: aliceCookie });
    expect(other.body["proposals"]).toEqual([]);
  });

  it("apply 走受控追加入写 MEMORY.md，回填 appliedPath；重复 apply 幂等", async () => {
    await seedLearning([proposalOf("mem_1", 1000, { content: "这个仓库统一使用 pnpm 作为包管理器。" })]);
    const applied = await call("/api/learning/mem_1/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(applied.status).toBe(200);
    expect(applied.body["proposal"]).toMatchObject({
      id: "mem_1",
      status: "applied",
      appliedPath: "MEMORY.md",
    });

    // 工作区的 MEMORY.md 是引导生成的模板文件：采纳的条目追加到它的条目区，不改标题结构。
    const memory = await readFile(join(dir, "workspaces", ownerId, "MEMORY.md"), "utf8");
    expect(memory).toContain(
      "- 这个仓库统一使用 pnpm 作为包管理器。 <!-- trigger: 包管理器 --> <!-- importance: 7 -->",
    );

    const again = await call("/api/learning/mem_1/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(again.status).toBe(200);
    expect(again.body["proposal"]).toMatchObject({ status: "applied" });
    const persisted = await readFile(join(dir, "workspaces", ownerId, "MEMORY.md"), "utf8");
    expect(persisted.match(/pnpm 作为包管理器/g)).toHaveLength(1);
  });

  it("技能提案 apply 创建个人技能并回填技能库路径，REST 列表与账本一致", async () => {
    await seedLearning([skillProposalOf("skill_1", 1000)]);
    const applied = await call("/api/learning/skill_1/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(applied.status).toBe(200);
    expect(applied.body["proposal"]).toMatchObject({
      id: "skill_1",
      kind: "skill",
      status: "applied",
      appliedPath: "技能库/pnpm-migration",
      appliedSkillName: "pnpm-migration",
    });
    expect(String((applied.body["proposal"] as Record<string, unknown>)["appliedSkillId"])).toMatch(/^sk_/);

    const listed = await call("/api/skills", { auth: ownerCookie });
    const personal = listed.body["personal"] as Array<Record<string, unknown>>;
    expect(personal.filter((item) => item["name"] === "pnpm-migration")).toHaveLength(1);
    expect(personal.find((item) => item["name"] === "pnpm-migration")).toMatchObject({
      scope: "personal",
      ownerId,
      category: "engineering",
      description: "把一个 Node 仓库从 npm 切换到 pnpm",
    });
    expect(String(personal.find((item) => item["name"] === "pnpm-migration")?.["instructions"])).toContain(
      "生成 pnpm 锁文件",
    );

    // 重复采纳幂等，技能不会被建第二份；已创建的提案不能再忽略。
    const again = await call("/api/learning/skill_1/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(again.status).toBe(200);
    const relisted = await call("/api/skills", { auth: ownerCookie });
    expect(
      (relisted.body["personal"] as Array<Record<string, unknown>>).filter((item) => item["name"] === "pnpm-migration"),
    ).toHaveLength(1);
    const dismissed = await call("/api/learning/skill_1/dismiss", {
      method: "POST",
      auth: ownerCookie,
      body: {},
    });
    expect(dismissed.status).toBe(400);
    expect(dismissed.body["error"]).toContain("已创建的技能提案不能忽略");

    // 账号隔离：别人的提案在别的账号里不存在。
    const other = await call("/api/learning/skill_1/apply", { method: "POST", auth: aliceCookie, body: {} });
    expect(other.status).toBe(404);
  });

  it("技能提案可以忽略，忽略后不创建技能", async () => {
    await seedLearning([skillProposalOf("skill_2", 1000)]);
    const dismissed = await call("/api/learning/skill_2/dismiss", {
      method: "POST",
      auth: ownerCookie,
      body: { reason: "暂不需要这个技能" },
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body["proposal"]).toMatchObject({
      kind: "skill",
      status: "dismissed",
      dismissReason: "暂不需要这个技能",
    });

    const listed = await call("/api/skills", { auth: ownerCookie });
    expect(
      (listed.body["personal"] as Array<Record<string, unknown>>).some((item) => item["name"] === "pnpm-migration"),
    ).toBe(false);
  });

  it("来源成员有技能白名单时，采纳后自动把新技能加进名单", async () => {
    const member = await call("/api/members", {
      method: "POST",
      auth: ownerCookie,
      body: { name: "调研员", description: "负责资料调研与整理" },
    });
    expect(member.status).toBe(201);
    const memberId = String((member.body["member"] as { id: string }).id);
    const limited = await call(`/api/members/${memberId}/skills`, {
      method: "PUT",
      auth: ownerCookie,
      body: { names: [] },
    });
    expect(limited.status).toBe(200);
    expect(limited.body["enabled"]).toEqual([]);

    await seedLearning([
      skillProposalOf("skill_grant", 1000, { memberId, memberName: "调研员", memberRole: "sub" }),
    ]);
    const applied = await call("/api/learning/skill_grant/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(applied.status).toBe(200);
    expect(applied.body["proposal"]).toMatchObject({ status: "applied" });

    const after = await call(`/api/members/${memberId}/skills`, { auth: ownerCookie });
    expect(after.body["enabled"]).toEqual(["pnpm-migration"]);
  });

  it("子成员提案写入它自己的 agents/<id>/MEMORY.md，不碰账号记忆", async () => {
    await seedLearning([
      proposalOf("mem_sub", 1000, {
        memberId: "m_doc",
        memberName: "调研员",
        memberRole: "sub",
        target: "member",
        content: "调研员产出的文档统一放到 docs/research/ 目录。",
      }),
    ]);
    const applied = await call("/api/learning/mem_sub/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(applied.body["proposal"]).toMatchObject({ appliedPath: "agents/m_doc/MEMORY.md" });
    const own = await readFile(join(dir, "workspaces", ownerId, "agents", "m_doc", "MEMORY.md"), "utf8");
    expect(own).toContain("docs/research/");
  });

  it("dismiss 只标记不删除；已写入的提案不能忽略；未知 ID 404", async () => {
    await seedLearning([proposalOf("mem_1", 1000), proposalOf("mem_2", 2000)]);

    const dismissed = await call("/api/learning/mem_1/dismiss", {
      method: "POST",
      auth: ownerCookie,
      body: { reason: "一次性的过程流水" },
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body["proposal"]).toMatchObject({ status: "dismissed", dismissReason: "一次性的过程流水" });

    const defaultReason = await call("/api/learning/mem_2/dismiss", { method: "POST", auth: ownerCookie, body: {} });
    expect(defaultReason.body["proposal"]).toMatchObject({ status: "dismissed", dismissReason: "用户忽略" });

    const listed = await call("/api/learning", { auth: ownerCookie });
    expect(listed.body["proposals"]).toHaveLength(2);
    expect((listed.body["proposals"] as MemoryProposal[]).every((item) => item.status === "dismissed")).toBe(true);

    const missing = await call("/api/learning/mem_none/dismiss", { method: "POST", auth: ownerCookie, body: {} });
    expect(missing.status).toBe(404);
    expect(missing.body["error"]).toBe("提案不存在");
    const missingApply = await call("/api/learning/mem_none/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(missingApply.status).toBe(404);

    const rejected = await call("/api/learning/mem_1/apply", { method: "POST", auth: ownerCookie, body: {} });
    expect(rejected.status).toBe(400);
    expect(rejected.body["error"]).toContain("提案已忽略");
  });

  it("已写入记忆的提案既不能忽略也不能改状态", async () => {
    await seedLearning([proposalOf("mem_applied", 1000, { status: "applied", appliedPath: "MEMORY.md" })]);
    const dismissed = await call("/api/learning/mem_applied/dismiss", { method: "POST", auth: ownerCookie, body: {} });
    expect(dismissed.status).toBe(400);
    expect(dismissed.body["error"]).toContain("已写入记忆的提案不能忽略");
  });

  it("limit 参数裁剪流水长度", async () => {
    await seedLearning([]);
    const saved = await call("/api/settings", {
      method: "PUT",
      auth: ownerCookie,
      body: { learning: { everyNRuns: 1 } },
    });
    expect(saved.status).toBe(200);

    const workspace = await registry.get({ id: ownerId, displayName: "老板" });
    for (let index = 0; index < 3; index += 1) {
      await workspace.learning.afterRun(learningInput({ runId: `run_${index}` }));
    }
    const all = await call("/api/learning", { auth: ownerCookie });
    expect(all.body["log"]).toHaveLength(3);
    const limited = await call("/api/learning?limit=2", { auth: ownerCookie });
    expect(limited.body["log"]).toHaveLength(2);
  });
});

describe("学习层设置与 SSE", () => {
  it("PUT /api/settings 收口 learning 字段，坏值 400 中文原因", async () => {
    const saved = await call("/api/settings", {
      method: "PUT",
      auth: ownerCookie,
      body: { learning: { mode: "auto", everyNRuns: 4, dailyCap: 9, modelRef: "demo/mock" } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body["settings"]).toHaveProperty("learning", {
      mode: "auto",
      everyNRuns: 4,
      dailyCap: 9,
      modelRef: "demo/mock",
    });

    const cleared = await call("/api/settings", {
      method: "PUT",
      auth: ownerCookie,
      body: { learning: { modelRef: "" } },
    });
    const clearedLearning = (cleared.body["settings"] as { learning: Record<string, unknown> }).learning;
    expect(clearedLearning).toMatchObject({ mode: "auto", everyNRuns: 4, dailyCap: 9 });
    expect(clearedLearning["modelRef"] ?? undefined).toBeUndefined();

    const bad = await call("/api/settings", {
      method: "PUT",
      auth: ownerCookie,
      body: { learning: { mode: "always" } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body["error"]).toContain("复盘模式只能是");
  });

  it("复盘流水经 SSE 广播：前端收到 learning 事件即可刷新面板", async () => {
    // 演示 handler 不会输出复盘要求的 JSON，所以这一轮必然以 failed 收场——正好验证「没学到也留痕」。
    const prepared = await call("/api/settings", {
      method: "PUT",
      auth: aliceCookie,
      body: { learning: { everyNRuns: 1 } },
    });
    expect(prepared.status).toBe(200);

    const events = await openEvents(aliceCookie);
    const workspace = await registry.get({ id: aliceId, displayName: "Alice" });
    await workspace.learning.afterRun(learningInput({ memberId: "m_main", runId: "run_sse" }));

    await until(() => events.events.some((event) => event["type"] === "learning"), "等待 learning 事件");
    const event = events.events.find((candidate) => candidate["type"] === "learning") as Record<string, unknown>;
    expect(event["proposals"]).toEqual([]);
    const log = event["log"] as Record<string, unknown>;
    expect(log).toMatchObject({ outcome: "failed", memberId: "m_main", runId: "run_sse" });
    expect(String(log["detail"])).toContain("不是可解析的 JSON");
    expect(String(log["modelRef"])).toBe("demo/mock");

    const snapshot = await call("/api/learning", { auth: aliceCookie });
    expect(snapshot.body["proposals"]).toEqual([]);
    const rows = snapshot.body["log"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "failed", runId: "run_sse" });

    await events.close();
  });

  it("mode=off 的工作区不复盘：没有任何流水，也没有 SSE 事件", async () => {
    const prepared = await call("/api/settings", {
      method: "PUT",
      auth: aliceCookie,
      body: { learning: { mode: "off" } },
    });
    expect(prepared.status).toBe(200);

    const events = await openEvents(aliceCookie);
    const workspace = await registry.get({ id: aliceId, displayName: "Alice" });
    await workspace.learning.afterRun(learningInput({ runId: "run_off" }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(await workspace.learning.listLog()).toEqual([]);
    expect(events.events.some((event) => event["type"] === "learning")).toBe(false);
    await events.close();
  });
});
