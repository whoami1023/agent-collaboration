// 知识库 HTTP 面：建库/导入/取消/页面编辑/体检与账号隔离；事件走 SSE 的 knowledge 帧。

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { SkillLibrary } from "../src/skills/library";
import { TemplateLibrary } from "../src/templates/template-library";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import { createApp } from "../src/server/app";
import type { KnowledgeBaseMeta, KnowledgeSnapshot } from "../src/knowledge/types";

let dir: string;
let registry: WorkspaceRegistry;
let server: Server;
let baseUrl: string;
let ownerCookie: string;
let aliceCookie: string;

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

async function until(predicate: () => Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-knowledgeapi-"));
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
  await call("/api/users", {
    method: "POST",
    auth: ownerCookie,
    body: { username: "alice", displayName: "Alice", password: "alicepass1" },
  });
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

describe("知识库 REST", () => {
  it("未登录拒绝；建库、重名拒绝、列表与快照", async () => {
    expect((await call("/api/knowledge")).status).toBe(401);

    const created = await call("/api/knowledge", {
      method: "POST",
      auth: ownerCookie,
      body: { name: "协同框架", description: "竞品资料" },
    });
    expect(created.status).toBe(201);
    const base = created.body["base"] as KnowledgeBaseMeta;
    expect(base.id).toMatch(/^kb_[0-9a-f]{12}$/);
    expect(base.name).toBe("协同框架");

    const duplicate = await call("/api/knowledge", {
      method: "POST",
      auth: ownerCookie,
      body: { name: "协同框架" },
    });
    expect(duplicate.status).toBe(400);
    expect(String(duplicate.body["error"])).toContain("已经存在");

    const listed = await call("/api/knowledge", { auth: ownerCookie });
    expect((listed.body["bases"] as KnowledgeBaseMeta[]).map((item) => item.name)).toEqual(["协同框架"]);

    const snapshot = await call(`/api/knowledge/${base.id}`, { auth: ownerCookie });
    expect(snapshot.status).toBe(200);
    const data = snapshot.body["snapshot"] as KnowledgeSnapshot;
    expect(data.base.id).toBe(base.id);
    expect(data.pages).toEqual([]);
    expect(data.index).toBe("");

    // 改名与删除
    const renamed = await call(`/api/knowledge/${base.id}`, {
      method: "PATCH",
      auth: ownerCookie,
      body: { name: "竞品资料" },
    });
    expect((renamed.body["base"] as KnowledgeBaseMeta).name).toBe("竞品资料");
    const removed = await call(`/api/knowledge/${base.id}`, { method: "DELETE", auth: ownerCookie });
    expect(removed.status).toBe(200);
    expect((await call(`/api/knowledge/${base.id}`, { auth: ownerCookie })).status).toBe(404);
  });

  it("导入材料进入队列，可取消；重复材料 409；非法库 ID 400", async () => {
    const created = await call("/api/knowledge", {
      method: "POST",
      auth: ownerCookie,
      body: { name: "资料库" },
    });
    const base = created.body["base"] as KnowledgeBaseMeta;

    const added = await call(`/api/knowledge/${base.id}/sources`, {
      method: "POST",
      auth: ownerCookie,
      body: { title: "演示材料", content: "# 演示\n\n中心编排把分派与回报分开记录。" },
    });
    expect(added.status).toBe(202);
    const queueItem = added.body["queueItem"] as { id: string; state: string };
    expect(queueItem.state).toBe("queued");

    const duplicate = await call(`/api/knowledge/${base.id}/sources`, {
      method: "POST",
      auth: ownerCookie,
      body: { title: "副本", content: "# 演示\n\n中心编排把分派与回报分开记录。" },
    });
    expect(duplicate.status).toBe(409);

    await call(`/api/knowledge/${base.id}/queue/cancel`, {
      method: "POST",
      auth: ownerCookie,
      body: { itemId: queueItem.id },
    });
    // 演示模型很快：取消请求可能赶在完成之前（cancelled）也可能晚一步（done），
    // 两种都是合法收尾；这里断言队列不会卡在 queued/running。
    await until(async () => {
      const snapshot = (await call(`/api/knowledge/${base.id}`, { auth: ownerCookie })).body[
        "snapshot"
      ] as KnowledgeSnapshot | undefined;
      // 负载高时快照请求可能晚一拍拿到空响应，继续轮询，不把它当成终态。
      if (!snapshot) return false;
      const state = snapshot.queue[0]?.state;
      // 来源状态与索引在队列状态之后落盘：两者都终态再断言。
      return (
        (state === "cancelled" || state === "done") &&
        (snapshot.sources[0]?.status === "failed" || snapshot.sources[0]?.status === "ready")
      );
    }, "队列收尾");

    const snapshot = (await call(`/api/knowledge/${base.id}`, { auth: ownerCookie })).body[
      "snapshot"
    ] as KnowledgeSnapshot;
    expect(["cancelled", "done"]).toContain(snapshot.queue[0]?.state);
    expect(["failed", "ready"]).toContain(snapshot.sources[0]?.status);
    expect(snapshot.base.pendingCount).toBe(0);

    expect((await call("/api/knowledge/kb_bad", { auth: ownerCookie })).status).toBe(400);
  });

  it("页面可新建、读取原始文本、删除；体检与图谱接口可用", async () => {
    const created = await call("/api/knowledge", {
      method: "POST",
      auth: ownerCookie,
      body: { name: "手写库" },
    });
    const base = created.body["base"] as KnowledgeBaseMeta;

    const saved = await call(`/api/knowledge/${base.id}/page`, {
      method: "PUT",
      auth: ownerCookie,
      body: {
        path: "concepts/缓存.md",
        content: ["---", "type: concept", "title: 缓存", "tags: [性能]", "related: []", "sources: []", "---", "", "缓存把重复计算的结果留在本地。"].join("\n"),
      },
    });
    expect(saved.status).toBe(200);
    expect((saved.body["page"] as { path: string }).path).toBe("concepts/缓存.md");

    const read = await call(
      `/api/knowledge/${base.id}/page?path=${encodeURIComponent("concepts/缓存.md")}`,
      { auth: ownerCookie },
    );
    expect(read.status).toBe(200);
    expect(String(read.body["raw"])).toContain("type: concept");

    const lint = await call(`/api/knowledge/${base.id}/lint`, { auth: ownerCookie });
    expect(lint.status).toBe(200);
    expect((lint.body["report"] as { pageCount: number }).pageCount).toBe(1);

    const graph = await call(`/api/knowledge/${base.id}/graph`, { auth: ownerCookie });
    expect((graph.body["graph"] as { nodes: unknown[] }).nodes).toHaveLength(1);

    const reindexed = await call(`/api/knowledge/${base.id}/reindex`, {
      method: "POST",
      auth: ownerCookie,
    });
    expect(reindexed.status).toBe(200);
    expect(String((reindexed.body["snapshot"] as KnowledgeSnapshot).index)).toContain("缓存");

    const search = await call(`/api/knowledge/search?q=${encodeURIComponent("缓存")}&kbId=${base.id}`, {
      auth: ownerCookie,
    });
    expect((search.body["hits"] as Array<{ path: string }>)[0]?.path).toBe("concepts/缓存.md");
    expect(typeof search.body["mode"]).toBe("string");

    // 链接补全：第二条页面提到「缓存」，默认只出提案，apply 后正文出现 wikilink。
    await call(`/api/knowledge/${base.id}/page`, {
      method: "PUT",
      auth: ownerCookie,
      body: {
        path: "notes/缓存笔记.md",
        content: ["---", "type: note", "title: 缓存笔记", "tags: []", "related: []", "sources: []", "---", "", "缓存可以避免重复计算，细节见缓存页。"].join("\n"),
      },
    });
    const dry = await call(`/api/knowledge/${base.id}/enrich`, {
      method: "POST",
      auth: ownerCookie,
      body: { apply: false },
    });
    expect(
      (dry.body["proposals"] as Array<{ pagePath: string; targetPath: string }>).some(
        (item) => item.pagePath === "notes/缓存笔记.md" && item.targetPath === "concepts/缓存.md",
      ),
    ).toBe(true);
    const applied = await call(`/api/knowledge/${base.id}/enrich`, {
      method: "POST",
      auth: ownerCookie,
      body: { apply: true, maxLinks: 10 },
    });
    expect(Number(applied.body["applied"])).toBeGreaterThanOrEqual(1);
    const linked = await call(
      `/api/knowledge/${base.id}/page?path=${encodeURIComponent("notes/缓存笔记.md")}`,
      { auth: ownerCookie },
    );
    expect(String(linked.body["raw"])).toContain("[[concepts/缓存|缓存]]");

    const deleted = await call(
      `/api/knowledge/${base.id}/page?path=${encodeURIComponent("concepts/缓存.md")}`,
      { method: "DELETE", auth: ownerCookie },
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await call(`/api/knowledge/${base.id}/page?path=${encodeURIComponent("concepts/缓存.md")}`, {
          auth: ownerCookie,
        })
      ).status,
    ).toBe(404);
  });

  it("账号之间知识库互不可见，事件以 knowledge 帧广播", async () => {
    const events: Array<Record<string, unknown>> = [];
    const response = await fetch(`${baseUrl}/api/events`, { headers: { cookie: ownerCookie } });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE 没有可读流");
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
              if (payload["event"] && typeof payload["event"] === "object") {
                events.push(payload["event"] as Record<string, unknown>);
              }
            } catch {
              /* 忽略心跳 */
            }
          }
        }
      }
    })();

    await call("/api/knowledge", { method: "POST", auth: ownerCookie, body: { name: "老板的库" } });
    await until(
      () => Promise.resolve(events.some((event) => event["type"] === "knowledge")),
      "SSE knowledge 事件",
    );

    const aliceList = await call("/api/knowledge", { auth: aliceCookie });
    expect(aliceList.body["bases"]).toEqual([]);

    const aliceCreate = await call("/api/knowledge", {
      method: "POST",
      auth: aliceCookie,
      body: { name: "Alice 的库" },
    });
    const aliceBase = aliceCreate.body["base"] as KnowledgeBaseMeta;
    const ownerList = await call("/api/knowledge", { auth: ownerCookie });
    expect((ownerList.body["bases"] as KnowledgeBaseMeta[]).map((base) => base.id)).not.toContain(
      aliceBase.id,
    );

    await reader.cancel();
  });
});

describe("知识库整库迁移与扫描", () => {
  it("导出 ZIP、导入为新库、重新扫描 raw/sources", async () => {
    const created = await call("/api/knowledge", {
      method: "POST",
      auth: ownerCookie,
      body: { name: "迁移库" },
    });
    const base = created.body["base"] as KnowledgeBaseMeta;
    await call(`/api/knowledge/${base.id}/page`, {
      method: "PUT",
      auth: ownerCookie,
      body: {
        path: "notes/页面.md",
        content: ["---", "type: note", "title: 页面", "tags: []", "related: []", "sources: []", "---", "", "迁移测试正文。"].join("\n"),
      },
    });

    const exported = await fetch(`${baseUrl}/api/knowledge/${base.id}/export`, {
      headers: { cookie: ownerCookie },
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("zip");
    const buffer = Buffer.from(await exported.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(100);

    const imported = await fetch(`${baseUrl}/api/knowledge/import`, {
      method: "POST",
      headers: { cookie: ownerCookie, "content-type": "application/zip" },
      body: buffer,
    });
    expect(imported.status).toBe(201);
    const importedBase = ((await imported.json()) as { base: KnowledgeBaseMeta }).base;
    expect(importedBase.id).not.toBe(base.id);
    expect(importedBase.name).toContain("导入");
    const snapshot = await call(`/api/knowledge/${importedBase.id}`, { auth: ownerCookie });
    expect(
      ((snapshot.body["snapshot"] as KnowledgeSnapshot).pages).map((page) => page.path),
    ).toEqual(["notes/页面.md"]);

    const rescanned = await call(`/api/knowledge/${importedBase.id}/rescan`, {
      method: "POST",
      auth: ownerCookie,
    });
    expect(rescanned.status).toBe(200);
    expect(rescanned.body["result"]).toEqual({ added: 0, updated: 0, removed: 0 });
  });
});
