// 定时任务的 HTTP 面：REST 路由、SSE 广播与账号隔离。
// 运行内容用 command payload（跑 node 自身）而不是 agentTurn，接口测试因此不依赖任何模型调用。

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service";
import { CRON_LIMITS } from "../src/cron/normalize";
import type { CronJob, CronRunRecord } from "../src/cron/types";
import { SkillLibrary } from "../src/skills/library";
import { TemplateLibrary } from "../src/templates/template-library";
import { WorkspaceRegistry } from "../src/workspace/workspace";
import { createApp } from "../src/server/app";

let dir: string;
let registry: WorkspaceRegistry;
let server: Server;
let baseUrl: string;
let cookie: string;
let otherCookie: string;

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

/** SSE 抓取：后台把 data: 帧解析成事件对象，测试按类型轮询。 */
interface SseCapture {
  events: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function openEvents(auth: string): Promise<SseCapture> {
  const response = await fetch(`${baseUrl}/api/events`, { headers: { cookie: auth } });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE 没有可读流");
  // body 已经被 getReader 锁住，只能从 reader 这一侧取消。
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
          // 心跳与非 JSON 帧不属于本测试关心的事件。
          try {
            capture.events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          } catch {
            /* ignore */
          }
        }
      }
    }
  })();
  return capture;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function commandInput(name: string, output: string): Record<string, unknown> {
  return {
    name,
    schedule: { kind: "every", everyMs: 3_600_000 },
    payload: { kind: "command", argv: [process.execPath, "-e", `console.log('${output}')`] },
  };
}

function jobOf(result: ApiResult): CronJob {
  return result.body["job"] as CronJob;
}

function viewOf(result: ApiResult): { job: CronJob; state: { nextRunAtMs?: number }; lastRun?: CronRunRecord } {
  return result.body["view"] as never;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-cronapi-"));
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
  cookie = (setup.headers.getSetCookie()[0] ?? "").split(";")[0];
  await call("/api/users", {
    method: "POST",
    auth: cookie,
    body: { username: "alice", displayName: "Alice", password: "alicepass1" },
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alicepass1" }),
  });
  otherCookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
});

afterEach(async () => {
  // SSE 与 keep-alive 连接不会自己断：先关连接再等 server.close，否则钩子会挂到超时。
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registry.closeAll();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      // Windows 上原子写留下的临时文件会和递归删除抢 rmdir。
      if (attempt >= 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

describe("定时任务 REST", () => {
  it("未登录拒绝，登录后创建返回 201、视图带下一次触发与账号限额", async () => {
    expect((await call("/api/crons")).status).toBe(401);

    const created = await call("/api/crons", { method: "POST", auth: cookie, body: commandInput("夜间巡检", "ok-1") });
    expect(created.status).toBe(201);
    const job = jobOf(created);
    expect(job.name).toBe("夜间巡检");
    expect(job.ownerId).toBeDefined();
    const view = viewOf(created);
    expect(view.state.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(view.job.id).toBe(job.id);

    const listed = await call("/api/crons", { auth: cookie });
    expect(listed.status).toBe(200);
    expect(listed.body["jobs"]).toHaveLength(1);
    expect(listed.body["status"]).toMatchObject({ total: 1, enabled: 1, running: 0 });
    expect(listed.body["limits"]).toMatchObject({ jobsPerUser: CRON_LIMITS.jobsPerUser, minEveryMs: CRON_LIMITS.minEveryMs });
    // 下一次触发汇总到 status，面板顶部「下一次」不用自己翻作业数组。
    expect((listed.body["status"] as Record<string, unknown>)["nextRunAtMs"]).toBe(view.state.nextRunAtMs);
  });

  it("校验原因用中文直达前端：非法表达式、间隔过小、时间已过、缺字段", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "坏表达式", schedule: { kind: "cron", expr: "0 9 * *" }, payload: { kind: "command", argv: ["node"] } }, /cron 表达式无法解析/],
      [{ name: "太密", schedule: { kind: "every", everyMs: 1000 }, payload: { kind: "command", argv: ["node"] } }, /固定间隔最少 10 秒/],
      [{ name: "过去", schedule: { kind: "at", at: new Date(Date.now() - 3_600_000).toISOString() }, payload: { kind: "command", argv: ["node"] } }, /时间已经过去了/],
      [{ name: "缺内容", schedule: { kind: "every", everyMs: 60_000 } }, /缺少任务内容 payload/],
      [{ name: "空命令", schedule: { kind: "every", everyMs: 60_000 }, payload: { kind: "command", argv: [] } }, /命令任务需要 argv/],
      [{ name: "x".repeat(60), schedule: { kind: "every", everyMs: 60_000 }, payload: { kind: "command", argv: ["node"] } }, /任务名最多 40 字/],
    ];
    for (const [body, pattern] of cases) {
      const response = await call("/api/crons", { method: "POST", auth: cookie, body });
      expect(response.status).toBe(400);
      expect(String(response.body["error"])).toMatch(pattern);
    }
    expect((await call("/api/crons", { auth: cookie })).body["jobs"]).toEqual([]);
  });

  it("PATCH 改调度等于换触发器：重排下一次；enabled 开关保留定义与历史", async () => {
    const created = await call("/api/crons", { method: "POST", auth: cookie, body: commandInput("巡检", "ok-2") });
    const jobId = jobOf(created).id;

    const patched = await call(`/api/crons/${jobId}`, {
      method: "PATCH",
      auth: cookie,
      body: { schedule: { kind: "cron", expr: "30 4 * * *", tz: "Asia/Shanghai", staggerMs: 0 }, description: "每天四点四十" },
    });
    expect(patched.status).toBe(200);
    expect(jobOf(patched).schedule).toMatchObject({ kind: "cron", expr: "30 4 * * *" });
    expect(viewOf(patched).state.nextRunAtMs).toBeGreaterThan(Date.now());

    const paused = await call(`/api/crons/${jobId}/enabled`, { method: "POST", auth: cookie, body: { enabled: false } });
    expect(paused.status).toBe(200);
    expect(jobOf(paused).enabled).toBe(false);
    expect(viewOf(paused).state.nextRunAtMs).toBeUndefined();
    expect((await call("/api/crons", { auth: cookie })).body["status"]).toMatchObject({ total: 1, enabled: 0 });

    const resumed = await call(`/api/crons/${jobId}/enabled`, { method: "POST", auth: cookie, body: { enabled: true } });
    expect(jobOf(resumed).enabled).toBe(true);
    expect(viewOf(resumed).state.nextRunAtMs).toBeGreaterThan(Date.now());

    expect((await call(`/api/crons/cron_missing`, { method: "PATCH", auth: cookie, body: { name: "改名" } })).status).toBe(404);
  });

  it("run 试跑命令任务：默认等落账，输出代投进群，runs 与 state 都能查到", async () => {
    const created = await call("/api/crons", { method: "POST", auth: cookie, body: commandInput("打印口令", "cron-api-ok") });
    const jobId = jobOf(created).id;

    const fired = await call(`/api/crons/${jobId}/run`, { method: "POST", auth: cookie, body: {} });
    expect(fired.status).toBe(200);
    const run = fired.body["run"] as CronRunRecord;
    expect(run).toMatchObject({ jobId, ownerId: run.ownerId, trigger: "manual", status: "ok" });
    expect(run.summary).toContain("cron-api-ok");

    const fireAndForget = await call(`/api/crons/${jobId}/run`, { method: "POST", auth: cookie, body: { wait: false } });
    expect(fireAndForget.status).toBe(200);
    expect(fireAndForget.body["run"]).toBeUndefined();

    // wait:false 只发起：靠轮询历史确认这一轮也落了账。
    await until(async () => {
      const page = await call(`/api/crons/runs?job_id=${jobId}`, { auth: cookie });
      return Number(page.body["total"]) === 2;
    }, "第二次试跑落账");

    const listed = await call(`/api/crons/runs?job_id=${jobId}&limit=1`, { auth: cookie });
    const entries = listed.body["entries"] as CronRunRecord[];
    expect(listed.body["total"]).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain("cron-api-ok");

    const state = await call("/api/state", { auth: cookie });
    const messages = (state.body["messages"] as Array<{ kind?: string; text?: string }>);
    expect(messages.some((msg) => msg.text?.includes("定时命令") && msg.text?.includes("cron-api-ok"))).toBe(true);

    // 试跑不消耗槽位：下一次触发仍是原时刻。
    const after = await call("/api/crons", { auth: cookie });
    expect((after.body["jobs"] as Array<{ state: { nextRunAtMs?: number } }>)[0].state.nextRunAtMs).toBe(
      viewOf(created).state.nextRunAtMs,
    );
  });

  it(
    "一次性任务：提前试跑保住 occurrence，到点由定时器真的触发并按 deleteAfterRun 删除或停用",
    async () => {
      // 提前手动试跑：这一次 occurrence 还在未来，借用一次不算消耗，任务不会被删。
      const future = await call("/api/crons", {
        method: "POST",
        auth: cookie,
        body: {
          name: "一小时后提醒",
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          payload: { kind: "command", argv: [process.execPath, "-e", "console.log('once-1')"] },
        },
      });
      const futureId = jobOf(future).id;
      expect((await call(`/api/crons/${futureId}/run`, { method: "POST", auth: cookie, body: {} })).status).toBe(200);
      const stillArmed = await call("/api/crons", { auth: cookie });
      expect(stillArmed.body["jobs"]).toHaveLength(1);
      expect((stillArmed.body["jobs"] as Array<{ state: { nextRunAtMs?: number } }>)[0].state.nextRunAtMs).toBe(
        viewOf(future).state.nextRunAtMs,
      );

      // 两条两秒钟后到点的一次性任务：这一轮走真实定时器，验证调度器真的会把槽位跑掉。
      const at = (delayMs: number) => new Date(Date.now() + delayMs).toISOString();
      const disappearing = await call("/api/crons", {
        method: "POST",
        auth: cookie,
        body: {
          name: "跑完就删",
          schedule: { kind: "at", at: at(2_000) },
          payload: { kind: "command", argv: [process.execPath, "-e", "console.log('once-2')"] },
        },
      });
      const kept = await call("/api/crons", {
        method: "POST",
        auth: cookie,
        body: {
          name: "跑完留着",
          deleteAfterRun: false,
          schedule: { kind: "at", at: at(2_000) },
          payload: { kind: "command", argv: [process.execPath, "-e", "console.log('once-3')"] },
        },
      });
      const disappearingId = jobOf(disappearing).id;
      const keptId = jobOf(kept).id;

      await until(async () => {
        const jobs = (await call("/api/crons", { auth: cookie })).body["jobs"] as Array<{ job: CronJob }>;
        return (
          !jobs.some((entry) => entry.job.id === disappearingId) &&
          jobs.some((entry) => entry.job.id === keptId && entry.job.enabled === false)
        );
      }, "两条一次性任务被定时器跑掉并各自收尾");

      // 定义删掉了，历史还在：面板按 jobId 仍然翻得到那一次，且触发方式是 schedule。
      const runs = await call(`/api/crons/runs?job_id=${disappearingId}`, { auth: cookie });
      expect(runs.body["total"]).toBe(1);
      expect((runs.body["entries"] as CronRunRecord[])[0]).toMatchObject({
        trigger: "schedule",
        status: "ok",
        summary: "once-2",
      });
      const notices = (await call("/api/state", { auth: cookie })).body["messages"] as Array<{
        kind?: string;
        text?: string;
      }>;
      expect(notices.some((msg) => msg.text?.includes("已完成一次性运行并从面板移除"))).toBe(true);
      // 停用留下的那条不会再被排期：只剩「一小时后提醒」还占着调度。
      expect((await call("/api/crons", { auth: cookie })).body["status"]).toMatchObject({
        total: 2,
        enabled: 1,
      });
    },
    30_000,
  );

  it("DELETE 移除定义并广播，重复删除 404", async () => {
    const created = await call("/api/crons", { method: "POST", auth: cookie, body: commandInput("待删", "ok-3") });
    const jobId = jobOf(created).id;
    expect((await call(`/api/crons/${jobId}`, { method: "DELETE", auth: cookie })).body["removed"]).toBe(jobId);
    expect((await call(`/api/crons/${jobId}`, { method: "DELETE", auth: cookie })).status).toBe(404);
    expect((await call("/api/crons", { auth: cookie })).body["jobs"]).toEqual([]);
  });

  it("另一个账号完全看不到别人的任务", async () => {
    const created = await call("/api/crons", { method: "POST", auth: cookie, body: commandInput("老板的任务", "ok-4") });
    const jobId = jobOf(created).id;

    expect((await call("/api/crons", { auth: otherCookie })).body["jobs"]).toEqual([]);
    expect((await call("/api/crons", { auth: otherCookie })).body["status"]).toMatchObject({ total: 0 });
    expect((await call(`/api/crons/${jobId}`, { method: "PATCH", auth: otherCookie, body: { name: "抢过来" } })).status).toBe(404);
    expect((await call(`/api/crons/${jobId}/run`, { method: "POST", auth: otherCookie, body: {} })).status).toBe(404);
    expect((await call(`/api/crons/${jobId}`, { method: "DELETE", auth: otherCookie })).status).toBe(404);
    expect((await call(`/api/crons/runs?job_id=${jobId}`, { auth: otherCookie })).body["total"]).toBe(0);
    // 老板那边一切如常：隔离不是把作业删了，只是别人看不见。
    expect((await call("/api/crons", { auth: cookie })).body["jobs"]).toHaveLength(1);
  });

  it("SSE 把 cron-job、cron-run、cron-job-removed 推给前端", async () => {
    const capture = await openEvents(cookie);
    try {
      const created = await call("/api/crons", { method: "POST", auth: cookie, body: commandInput("事件任务", "ok-5") });
      const jobId = jobOf(created).id;
      await until(() => capture.events.some((e) => e["type"] === "cron-job"), "cron-job 事件");
      const jobEvent = capture.events.find((e) => e["type"] === "cron-job") as {
        job: CronJob;
        state: { nextRunAtMs?: number };
      };
      expect(jobEvent.job.id).toBe(jobId);
      expect(jobEvent.state.nextRunAtMs).toBeGreaterThan(Date.now());

      await call(`/api/crons/${jobId}/run`, { method: "POST", auth: cookie, body: {} });
      await until(
        () =>
          capture.events.some(
            (e) => e["type"] === "cron-run" && (e["run"] as CronRunRecord).jobId === jobId,
          ),
        "cron-run 事件",
      );

      await call(`/api/crons/${jobId}`, { method: "DELETE", auth: cookie });
      await until(
        () =>
          capture.events.some(
            (e) => e["type"] === "cron-job-removed" && e["jobId"] === jobId,
          ),
        "cron-job-removed 事件",
      );
    } finally {
      await capture.close();
    }
  });
});
