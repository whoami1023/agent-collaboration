import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Member } from "../core/types";
import type { WorkspaceFiles } from "../files/workspace-files";
import type { SkillLibrary } from "../skills/library";
import { isSkillSelected } from "../skills/selection";
import type { ToolImpl } from "./loop";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_CHARS = 4_000;
export const MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_SCRIPT_ARGS = 20;
export const MAX_SCRIPT_ARG_CHARS = 500;

export interface ShellToolDeps {
  files: WorkspaceFiles;
  skills: SkillLibrary;
  userId: string;
  member: Member;
}

interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  shell: boolean;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spawnError?: Error;
}

const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTHORIZATION)/i;

/** 子进程不继承密钥类环境变量，其余保持原样以复用本机 PATH 与 Python/Node 安装。 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.NO_COLOR = "1";
  return env;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 进程已退出 */
    }
  }
}

function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | undefined;

    const push = (target: Buffer[], chunk: Buffer): void => {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length > room) {
        target.push(chunk.subarray(0, room));
        bytes = MAX_OUTPUT_BYTES;
        truncated = true;
      } else {
        target.push(chunk);
        bytes += chunk.length;
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: sanitizedEnv(),
        shell: options.shell,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        truncated: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => push(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => push(stderr, chunk));
    child.on("error", (err) => {
      spawnError = err;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
        truncated,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

function formatResult(header: string, result: RunResult, timeoutMs: number): string {
  if (result.spawnError) {
    return `${header}\n启动失败：${result.spawnError.message}（确认可执行文件已安装并在 PATH 中）`;
  }
  const lines = [header];
  if (result.timedOut) lines.push(`状态：执行超过 ${Math.round(timeoutMs / 1000)} 秒，已终止进程树`);
  else if (result.aborted) lines.push("状态：运行被中止，已终止进程树");
  lines.push(`退出码：${result.code ?? "无"}${result.signal ? `（信号 ${result.signal}）` : ""}`);
  if (result.stdout.trim()) {
    lines.push(`标准输出：\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    lines.push(`标准错误：\n${result.stderr.trimEnd()}`);
  }
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push("（没有输出）");
  if (result.truncated) {
    lines.push(`（输出超过 ${MAX_OUTPUT_BYTES / 1024} KB，已截断；请缩小输出范围后重跑）`);
  }
  return lines.join("\n");
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, Math.round(raw)));
}

function resolveCwd(root: string, raw: string | undefined): string {
  const abs = path.resolve(root, raw ?? ".");
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("cwd 必须位于文件工作区内");
  }
  return abs;
}

interface Interpreter {
  command: string;
  args: string[];
}

function interpreterFor(scriptRel: string, scriptAbs: string, args: string[]): Interpreter | string {
  const ext = path.extname(scriptRel).toLowerCase();
  switch (ext) {
    case ".py":
      return {
        command: process.env.PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3"),
        args: [scriptAbs, ...args],
      };
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: process.execPath, args: [scriptAbs, ...args] };
    case ".sh":
    case ".bash":
      return {
        command: process.platform === "win32" ? "bash" : "sh",
        args: [scriptAbs, ...args],
      };
    case ".ps1":
      return {
        command: process.platform === "win32" ? "powershell" : "pwsh",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptAbs, ...args],
      };
    case ".cmd":
    case ".bat":
      return process.platform === "win32"
        ? { command: "cmd", args: ["/c", scriptAbs, ...args] }
        : { command: "sh", args: [scriptAbs, ...args] };
    default:
      return `不支持直接执行 ${ext || "无扩展名"} 文件；支持 .py / .js / .mjs / .sh / .ps1 / .cmd / .bat`;
  }
}

export function buildShellTools(deps: ShellToolDeps): ToolImpl[] {
  const runtimeRoot = path.join(deps.files.rootDir, ".skill-runtime");

  return [
    {
      schema: {
        name: "run_command",
        description:
          "在文件工作区（files/）里执行一条命令，例如 python 脚本、node 脚本、pip/npm 安装依赖、数据校验。默认 30 秒超时、输出截断到 32 KB；子进程有服务进程的文件系统权限。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的命令，如 python analyze.py 或 node scripts/x.mjs" },
            cwd: { type: "string", description: "可选：相对文件工作区的运行目录，默认 files/ 根目录" },
            timeout_ms: {
              type: "number",
              description: "可选：超时毫秒数，默认 30000，最大 120000",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      executionMode: "sequential",
      execute: async (args, signal) => {
        const command = readString(args, "command");
        if (!command) return "错误：command 不能为空";
        if (command.length > MAX_COMMAND_CHARS) {
          return `错误：命令不能超过 ${MAX_COMMAND_CHARS} 字符；请拆成多条或写成脚本文件`;
        }
        await fs.mkdir(deps.files.rootDir, { recursive: true });
        let cwd: string;
        try {
          cwd = resolveCwd(deps.files.rootDir, readString(args, "cwd"));
          const stat = await fs.stat(cwd);
          if (!stat.isDirectory()) return "错误：cwd 不是目录";
        } catch (err) {
          return `错误：${err instanceof Error ? err.message : String(err)}`;
        }
        const timeoutMs = clampTimeout(args["timeout_ms"]);
        const result = await runProcess(command, [], {
          cwd,
          timeoutMs,
          signal,
          shell: true,
        });
        const relCwd = path.relative(deps.files.rootDir, cwd).split(path.sep).join("/") || ".";
        return formatResult(`$ ${command}\n工作目录：files/${relCwd === "." ? "" : relCwd}`, result, timeoutMs);
      },
    },
    {
      schema: {
        name: "run_skill_script",
        description:
          "执行技能附带的脚本。会把该技能的全部附带文件展开到 files/.skill-runtime/<技能名>/ 后运行指定脚本（参数不会经过 shell），产出保留在该目录。支持 .py / .js / .mjs / .sh / .ps1 / .cmd / .bat。",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string", description: "技能名称" },
            path: { type: "string", description: "脚本在技能里的相对路径，如 scripts/analyze.py" },
            args: {
              type: "array",
              items: { type: "string" },
              description: "可选：传给脚本的参数数组",
            },
            timeout_ms: { type: "number", description: "可选：超时毫秒数，默认 30000，最大 120000" },
          },
          required: ["skill", "path"],
          additionalProperties: false,
        },
      },
      executionMode: "sequential",
      execute: async (args, signal) => {
        const skillName = readString(args, "skill");
        const scriptPath = readString(args, "path");
        if (!skillName) return "错误：skill 不能为空";
        if (!scriptPath) return "错误：path 不能为空";

        const skill = deps.skills.readForAgent(deps.userId, skillName);
        if (!skill) return `错误：没有可用的技能 ${skillName}`;
        if (!isSkillSelected(deps.member.skillNames, skill.name)) {
          return `错误：技能 ${skill.name} 未对 @${deps.member.name} 启用`;
        }
        const hit = deps.skills.readSkillFile(deps.userId, skillName, scriptPath);
        if (!hit) {
          const list = (skill.files ?? []).map((file) => file.path);
          return list.length > 0
            ? `错误：技能 ${skill.name} 里没有文件 ${scriptPath}。可选路径：${list.join("、")}`
            : `错误：技能 ${skill.name} 没有附带文件`;
        }

        const rawArgs = args["args"];
        if (rawArgs !== undefined && !Array.isArray(rawArgs)) return "错误：args 必须是字符串数组";
        const scriptArgs: string[] = [];
        for (const item of (rawArgs as unknown[] | undefined) ?? []) {
          if (typeof item !== "string") return "错误：args 里的每一项都必须是字符串";
          if (item.length > MAX_SCRIPT_ARG_CHARS) {
            return `错误：单个参数不能超过 ${MAX_SCRIPT_ARG_CHARS} 字符`;
          }
          scriptArgs.push(item);
        }
        if (scriptArgs.length > MAX_SCRIPT_ARGS) return `错误：参数最多 ${MAX_SCRIPT_ARGS} 个`;

        const skillDir = path.join(runtimeRoot, skill.name);
        try {
          await fs.mkdir(skillDir, { recursive: true });
          for (const file of skill.files ?? []) {
            const target = path.join(skillDir, ...file.path.split("/"));
            const rel = path.relative(runtimeRoot, target);
            if (rel.startsWith("..") || path.isAbsolute(rel)) {
              return `错误：技能文件路径越界：${file.path}`;
            }
            await fs.mkdir(path.dirname(target), { recursive: true });
            const data =
              file.encoding === "base64"
                ? Buffer.from(file.content, "base64")
                : Buffer.from(file.content, "utf8");
            await fs.writeFile(target, data);
          }
        } catch (err) {
          return `展开技能文件失败：${err instanceof Error ? err.message : String(err)}`;
        }

        const scriptAbs = path.join(skillDir, ...hit.file.path.split("/"));
        const interpreter = interpreterFor(hit.file.path, scriptAbs, scriptArgs);
        if (typeof interpreter === "string") return `错误：${interpreter}`;

        const timeoutMs = clampTimeout(args["timeout_ms"]);
        const relDir = path.relative(deps.files.rootDir, skillDir).split(path.sep).join("/");
        const result = await runProcess(interpreter.command, interpreter.args, {
          cwd: skillDir,
          timeoutMs,
          signal,
          shell: false,
        });
        return formatResult(
          `脚本：${skill.name}/${hit.file.path}\n解释器：${interpreter.command}\n工作目录：files/${relDir}`,
          result,
          timeoutMs,
        );
      },
    },
  ];
}
