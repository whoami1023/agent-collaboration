import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Member } from "../core/types";
import type { WorkspaceFiles } from "../files/workspace-files";
import type { SkillLibrary } from "../skills/library";
import type { SkillUsageRecorder } from "../skills/curation/types";
import { isSkillSelected } from "../skills/selection";
import {
  commandHandle,
  recordFileChanges,
  stampFiles,
  type EvidenceLedger,
} from "./evidence";
import type { ToolImpl } from "./loop";
import { describeCandidates, resolvePythonLaunch } from "./python-launcher";
import type { ToolOutputStore } from "./content/offload";
import { clipForContext, CONTEXT_BUDGET_BYTES, formatByteSize } from "./content/offload";
import { guardExternalContent } from "./content/envelope";
import { redactSecrets } from "./content/redact";
import { redactionNote } from "./content/policy";
import { toolFailureText } from "./tool-errors";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_CHARS = 4_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SCRIPT_ARGS = 20;
export const MAX_SCRIPT_ARG_CHARS = 500;
/** run_batch：一次最多几条命令、几个查询，以及单次回复里查询片段的总预算。 */
export const MAX_BATCH_COMMANDS = 8;
export const MAX_BATCH_QUERIES = 6;
export const BATCH_QUERY_BUDGET_BYTES = 2 * 1024;
export const BATCH_REPLY_BUDGET_BYTES = 8 * 1024;

export interface ShellToolDeps {
  files: WorkspaceFiles;
  skills: SkillLibrary;
  userId: string;
  member: Member;
  /** 工具输出存档：run_batch 在本次调用内直接检索刚产生的输出。 */
  toolOutputs?: ToolOutputStore;
  runId?: string;
  /** 本轮证据台账：命令退出码 0 才记账，作为交付闸门的核验来源。 */
  evidence?: EvidenceLedger;
  /** 技能使用记账：跑技能自带脚本算一次真实使用（比展开正文更强的信号）。 */
  skillUsage?: SkillUsageRecorder;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  shell: boolean;
}

export interface RunResult {
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

export function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
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
    lines.push(
      `（输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已截断；请缩小输出范围后重跑）`,
    );
  }
  // Windows 的 python/python3 常常是商店占位程序：给出可执行的下一步，而不是让用户读那句英文提示。
  if (/Python was not found|python\.exe.*WindowsApps/i.test(`${result.stdout}\n${result.stderr}`)) {
    lines.push(
      "提示：这条命令的 python 指向 Microsoft Store 占位程序，不是真实解释器。" +
        "Windows 上请改用 py -3（或 run_skill_script 执行 .py，它会自动挑选可用的 Python）。",
    );
  }
  return lines.join("\n");
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBatchList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
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

async function interpreterFor(
  scriptRel: string,
  scriptAbs: string,
  args: string[],
): Promise<Interpreter | string> {
  const ext = path.extname(scriptRel).toLowerCase();
  switch (ext) {
    case ".py": {
      const python = await resolvePythonLaunch();
      if (!python) {
        return (
          `找不到可用的 Python 解释器（已尝试：${describeCandidates()}）；` +
          "请确认可执行文件已安装并在 PATH 中，或用 PYTHON 指定，例如 PYTHON=py -3"
        );
      }
      return { command: python.command, args: [...python.args, scriptAbs, ...args] };
    }
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
          "在文件工作区（files/）里执行一条命令，例如 python 脚本、node 脚本、pip/npm 安装依赖、数据校验。默认 30 秒超时，输出最多保留 1 MB（大输出会存档，上下文只显示相关片段）；子进程有服务进程的文件系统权限。",
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
        const before = deps.evidence
          ? stampFiles(await deps.files.list().catch(() => undefined))
          : undefined;
        const result = await runProcess(command, [], {
          cwd,
          timeoutMs,
          signal,
          shell: true,
        });
        const relCwd = path.relative(deps.files.rootDir, cwd).split(path.sep).join("/") || ".";
        if (result.code === 0 && !result.timedOut && !result.aborted && !result.spawnError) {
          deps.evidence?.record(
            "command",
            commandHandle(command),
            `files/${relCwd === "." ? "" : relCwd} 退出码 0`,
          );
          if (before) {
            const changed = recordFileChanges(
              deps.evidence!,
              before,
              await deps.files.list().catch(() => undefined),
              `$ ${commandHandle(command)}`,
            );
            if (changed.length > 0) {
              return `${formatResult(
                `$ ${command}\n工作目录：files/${relCwd === "." ? "" : relCwd}`,
                result,
                timeoutMs,
              )}\n\n本次运行改变了这些文件，可直接作为验收证据（verify_kind=file）：${changed
                .map((item) => `files/${item}`)
                .join("、")}`;
            }
          }
        }
        return formatResult(`$ ${command}\n工作目录：files/${relCwd === "." ? "" : relCwd}`, result, timeoutMs);
      },
    },
    {
      schema: {
        name: "run_batch",
        description:
          "一次顺序执行多条命令（最多 8 条）并汇总退出码，适合同时查测试、类型错误、构建、日志等多件事。完整输出会存入工具输出存档；queries 里的问题会在同一次调用里从完整输出中挑相关片段回答，不需要再单独检索。",
        parameters: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              items: { type: "string" },
              description: "要顺序执行的命令列表（1–8 条），每条与 run_command 的 command 写法相同",
            },
            queries: {
              type: "array",
              items: { type: "string" },
              description: "可选：要从合并输出里回答的问题或关键词（最多 6 个），如「失败的测试名」「端口冲突」",
            },
            cwd: { type: "string", description: "可选：相对文件工作区的运行目录，默认 files/ 根目录" },
            timeout_ms: {
              type: "number",
              description: "可选：每条命令的超时毫秒数，默认 30000，最大 120000",
            },
          },
          required: ["commands"],
          additionalProperties: false,
        },
      },
      executionMode: "sequential",
      execute: async (args, signal) => {
        const commands = readBatchList(args["commands"]);
        if (!commands) {
          return toolFailureText("invalid_argument", "commands 不能为空", {
            next: "传 1–8 条要顺序执行的命令，例如 [\"npm test\", \"npx tsc --noEmit\"]。",
          });
        }
        if (commands.length > MAX_BATCH_COMMANDS) {
          return toolFailureText("invalid_argument", `一次最多 ${MAX_BATCH_COMMANDS} 条命令`, {
            next: "把互不依赖的检查拆成两次 run_batch，或只保留与当前问题最相关的命令。",
          });
        }
        const tooLong = commands.find((command) => command.length > MAX_COMMAND_CHARS);
        if (tooLong) {
          return toolFailureText("invalid_argument", `单条命令不能超过 ${MAX_COMMAND_CHARS} 字符`, {
            next: "把长命令写成脚本文件，再用 run_batch 调用脚本。",
          });
        }
        const queries = readBatchList(args["queries"]) ?? [];
        if (queries.length > MAX_BATCH_QUERIES) {
          return toolFailureText("invalid_argument", `一次最多 ${MAX_BATCH_QUERIES} 个查询`, {
            next: "合并相近的问题，或分两次 run_batch。",
          });
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
        const relCwd = path.relative(deps.files.rootDir, cwd).split(path.sep).join("/") || ".";
        const before = deps.evidence
          ? stampFiles(await deps.files.list().catch(() => undefined))
          : undefined;

        const blocks: string[] = [];
        const summaries: string[] = [];
        for (let index = 0; index < commands.length; index += 1) {
          const command = commands[index]!;
          if (signal.aborted) {
            summaries.push(`- ${index + 1}. \`${oneLine(command)}\` 未执行（运行已中止）`);
            continue;
          }
          const result = await runProcess(command, [], { cwd, timeoutMs, signal, shell: true });
          if (result.code === 0 && !result.timedOut && !result.aborted && !result.spawnError) {
            deps.evidence?.record(
              "command",
              commandHandle(command),
              `files/${relCwd === "." ? "" : relCwd} 退出码 0（run_batch）`,
            );
          }
          const block = formatResult(`$ ${command}`, result, timeoutMs);
          blocks.push(block);
          summaries.push(
            `- ${index + 1}. \`${oneLine(command)}\` 退出码 ${result.code ?? "无"}` +
              `（${formatByteSize(Buffer.byteLength(block, "utf8"))} / ${countTextLines(block)} 行）`,
          );
        }
        if (before) {
          recordFileChanges(
            deps.evidence!,
            before,
            await deps.files.list().catch(() => undefined),
            "run_batch",
          );
        }

        const combined = blocks.join("\n\n");
        const redacted = redactSecrets(combined);
        const note =
          redacted.replaced > 0 ? redactionNote(redacted.replaced, redacted.families) : "";
        const executed = blocks.length;
        const summaryText = summaries.join("\n");

        const store = deps.toolOutputs;
        if (!store || (queries.length === 0 && !store.shouldOffload(redacted.text))) {
          return [
            `批量执行：${executed} 条命令（工作目录：files/${relCwd === "." ? "" : relCwd}）`,
            summaryText,
            guardExternalContent("run_batch", redacted.text),
            note,
          ]
            .filter((part) => part.length > 0)
            .join("\n\n");
        }

        const record = await store.capture({
          tool: "run_batch",
          roomId: deps.member.roomId,
          memberId: deps.member.id,
          ...(deps.runId ? { runId: deps.runId } : {}),
          argsPreview: `run_batch: ${oneLine(commands.join(" ; "), 200)}`,
          text: redacted.text,
        });
        if (!record) {
          return [
            `批量执行：${executed} 条命令（本次存档失败）`,
            summaryText,
            guardExternalContent("run_batch", clipForContext(redacted.text, CONTEXT_BUDGET_BYTES)),
            "（批量输出较大，本次存档失败；上面只保留开头与结尾，请缩小输出范围后重跑。）",
            note,
          ]
            .filter((part) => part.length > 0)
            .join("\n\n");
        }

        const header =
          `批量执行：${executed} 条命令，共 ${formatByteSize(record.bytes)} / ${record.lines} 行；` +
          `完整输出已存档 ${record.id}`;
        const sections: string[] = [];
        const seen = new Set<string>();
        let replyBytes = 0;
        for (const query of queries.length > 0 ? queries : [""]) {
          const selection = store.selectForContext(record, redacted.text, query, BATCH_QUERY_BUDGET_BYTES);
          if (selection.spans.length === 0) continue;
          const key = selection.spans.map((span) => `${span.startLine}-${span.endLine}`).join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          const section = `${query ? `## 查询：${query}` : "## 开头片段"}\n\n${guardExternalContent(
            "run_batch",
            selection.excerpts,
          )}`;
          const size = Buffer.byteLength(section, "utf8");
          if (sections.length > 0 && replyBytes + size > BATCH_REPLY_BUDGET_BYTES) {
            sections.push("（其余查询结果未展示；用 output_search 继续检索这份存档。）");
            break;
          }
          sections.push(section);
          replyBytes += size;
        }
        const footer =
          `（其余内容用 output_search(query="…", id="${record.id}") 检索，` +
          `或 output_read(id="${record.id}", start_line=…, end_line=…) 按行读取；不要重跑命令。）`;
        return [header, summaryText, ...sections, footer, note]
          .filter((part) => part.length > 0)
          .join("\n\n");
      },
    },
    {
      schema: {
        name: "run_skill_script",
        description:
          "执行技能附带的脚本。会把该技能的全部附带文件展开到 files/.skill-runtime/<技能名>/ 后运行指定脚本（参数不会经过 shell）。默认在技能脚本目录里跑，产出也留在那里；要读写文件工作区里的成果时传 cwd（相对 files/），这样输入输出都是右侧「文件」能看到的路径。支持 .py / .js / .mjs / .sh / .ps1 / .cmd / .bat。",
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
            cwd: {
              type: "string",
              description:
                '可选：运行目录，相对文件工作区（"." = files/ 根目录，也可 "reports"）。省略时在 files/.skill-runtime/<技能名>/ 里跑',
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
        // 按「发起了这次执行」记账，不看退出码：脚本因为本机没装运行时而失败，
        // 不该让这份技能被算成没人用进而归档。
        deps.skillUsage?.(skill.id, "use");

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
        const interpreter = await interpreterFor(hit.file.path, scriptAbs, scriptArgs);
        if (typeof interpreter === "string") return `错误：${interpreter}`;

        let runDir = skillDir;
        const rawCwd = readString(args, "cwd");
        if (rawCwd !== undefined) {
          try {
            runDir = resolveCwd(deps.files.rootDir, rawCwd);
          } catch (err) {
            return `错误：${err instanceof Error ? err.message : String(err)}`;
          }
          try {
            if (!(await fs.stat(runDir)).isDirectory()) return "错误：cwd 不是目录";
          } catch {
            return `错误：cwd 目录不存在：files/${rawCwd}`;
          }
        }

        const timeoutMs = clampTimeout(args["timeout_ms"]);
        const relDir = path.relative(deps.files.rootDir, runDir).split(path.sep).join("/");
        const before = deps.evidence
          ? stampFiles(await deps.files.list().catch(() => undefined))
          : undefined;
        const result = await runProcess(interpreter.command, interpreter.args, {
          cwd: runDir,
          timeoutMs,
          signal,
          shell: false,
        });
        const scriptHandle = `${skill.name}/${hit.file.path}${
          scriptArgs.length > 0 ? ` ${scriptArgs.join(" ")}` : ""
        }`;
        if (result.code === 0 && !result.timedOut && !result.aborted && !result.spawnError) {
          deps.evidence?.record("command", commandHandle(scriptHandle), `退出码 0`);
          if (before) {
            recordFileChanges(
              deps.evidence!,
              before,
              await deps.files.list().catch(() => undefined),
              `$ ${commandHandle(scriptHandle)}`,
            );
          }
        }
        return formatResult(
          `脚本：${skill.name}/${hit.file.path}\n解释器：${interpreter.command}\n工作目录：files/${relDir}`,
          result,
          timeoutMs,
        );
      },
    },
  ];
}
