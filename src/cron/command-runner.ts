// Ported and adapted from OpenClaw src/cron/command-runner.ts
// (MIT License — Copyright (c) 2026 OpenClaw Foundation).
// 与原版一致的语义：argv 直接 spawn 不经 shell、超时必须终止整棵进程树、
// 只有「退出码 0 且没被杀且没超时」才算成功、摘要优先取 stdout。
// 进程 spawn 复用作战室 run_command 已经踩平 Windows 坑的那套（runProcess + Python 占位程序解析）。

import { mkdir } from "node:fs/promises";
import { runProcess } from "../agent/shell-tools";
import { resolvePythonLaunch } from "../agent/python-launcher";

export const DEFAULT_CRON_COMMAND_TIMEOUT_MS = 600_000;
/** timeoutSeconds <= 0 表示「不给超时」：用一个事实上去不到的上限表达。 */
const EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_PRESERVED_LINES = 16;

export interface CronCommandResult {
  ok: boolean;
  /** 永久失败（可执行文件不存在等）：重试没有意义。 */
  permanent: boolean;
  summary: string;
  error?: string;
  exitCode: number | null;
  durationMs: number;
}

export interface CronCommandInput {
  argv: string[];
  cwd: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

function timeoutMsOf(timeoutSeconds: number | undefined): number {
  if (timeoutSeconds === undefined) return DEFAULT_CRON_COMMAND_TIMEOUT_MS;
  if (timeoutSeconds <= 0) return EFFECTIVELY_UNBOUNDED_TIMEOUT_MS;
  return Math.min(EFFECTIVELY_UNBOUNDED_TIMEOUT_MS, Math.max(1_000, Math.round(timeoutSeconds * 1000)));
}

/** 与 OpenClaw 同形的脱敏：URL 查询串、明显的代码片段、key*** 形式的密钥尾巴。 */
function redact(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+\?[^\s]+/gi, (match) => `${match.split("?")[0]}?[redacted-url]`)
    .replace(/\b(?:ghp|gho|xox[bp]|sk)-[A-Za-z0-9_-]{8,}/g, "[redacted-code]")
    .replace(/([A-Za-z0-9_-]{4,}?)\*{3,}/g, "$1***");
}

/** stdout 优先，其次 stderr，都有就拼起来；只留尾部若干行，避免把历史文件撑爆。 */
function summarize(stdout: string, stderr: string): string {
  const pick = (text: string) =>
    text
      .trimEnd()
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-MAX_PRESERVED_LINES)
      .join("\n");
  const out = pick(stdout);
  const err = pick(stderr);
  const summary = out && err ? `${out}\n${err}` : out || err;
  if (!summary) return "（命令没有输出）";
  return summary.length > MAX_SUMMARY_CHARS
    ? `${summary.slice(summary.length - MAX_SUMMARY_CHARS)}\n…（输出过长，仅保留末尾）`
    : summary;
}

export async function runCronCommand(input: CronCommandInput): Promise<CronCommandResult> {
  const startedAt = Date.now();
  const [head, ...rest] = input.argv;
  if (!head) {
    return {
      ok: false,
      permanent: true,
      summary: "",
      error: "命令任务缺少可执行文件",
      exitCode: null,
      durationMs: 0,
    };
  }

  // Windows 的 python/python3 常常是商店占位程序：和 run_skill_script 一样换成真解释器。
  let command = head;
  let args = rest;
  if (/^python3?$/i.test(head)) {
    const launch = await resolvePythonLaunch().catch(() => undefined);
    if (launch) {
      command = launch.command;
      args = [...launch.args, ...rest];
    }
  }

  const timeoutMs = timeoutMsOf(input.timeoutSeconds);
  // 账号的 files/ 目录是懒创建的：cwd 不存在时 spawn 也报 ENOENT，会被误判成「可执行文件没装」。
  await mkdir(input.cwd, { recursive: true }).catch(() => undefined);
  const result = await runProcess(command, args, {
    cwd: input.cwd,
    timeoutMs,
    shell: false,
    signal: input.signal ?? new AbortController().signal,
  });
  const durationMs = Date.now() - startedAt;

  if (result.spawnError) {
    const missing = (result.spawnError as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      permanent: missing,
      summary: redact(summarize("", result.spawnError.message)),
      error: `命令启动失败：${result.spawnError.message}${missing ? "（确认可执行文件已安装并在 PATH 中）" : ""}`,
      exitCode: null,
      durationMs,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      permanent: false,
      summary: redact(summarize(result.stdout, result.stderr)),
      error: `命令超时（${Math.round(timeoutMs / 1000)} 秒）并已终止进程树`,
      exitCode: result.code,
      durationMs,
    };
  }
  if (result.aborted) {
    return {
      ok: false,
      permanent: false,
      summary: redact(summarize(result.stdout, result.stderr)),
      error: "命令被中止",
      exitCode: result.code,
      durationMs,
    };
  }
  if (result.signal) {
    return {
      ok: false,
      permanent: false,
      summary: redact(summarize(result.stdout, result.stderr)),
      error: `命令收到信号 ${result.signal} 停止`,
      exitCode: result.code,
      durationMs,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      permanent: false,
      summary: redact(summarize(result.stdout, result.stderr)),
      error: `命令以退出码 ${result.code ?? "无"} 失败`,
      exitCode: result.code,
      durationMs,
    };
  }
  return {
    ok: true,
    permanent: false,
    summary: redact(summarize(result.stdout, result.stderr)),
    exitCode: result.code,
    durationMs,
  };
}
