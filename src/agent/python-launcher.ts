/*!
 * Windows 上 `python` 经常解析到 Microsoft Store 的占位程序（执行时输出
 * 「Python was not found」并以 49 退出），直接调用会让所有附带 .py 的技能失败。
 * 这里按显式配置优先、可用则回退的顺序探测出一个真正能跑的解释器。
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface PythonLaunch {
  command: string;
  args: string[];
}

const PROBE_TIMEOUT_MS = 4_000;

/** `PYTHON` 支持写成 `py -3` 这类「命令 + 固定参数」的形式。 */
export function parsePythonEnv(raw: string): PythonLaunch {
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const [command, ...args] = parts;
  return { command: command ?? "python", args };
}

export function pythonCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PythonLaunch[] {
  const explicit = env["PYTHON"]?.trim();
  if (explicit) return [parsePythonEnv(explicit)];
  if (platform === "win32") {
    return [
      { command: "py", args: ["-3"] },
      { command: "py", args: [] },
      { command: "python", args: [] },
      { command: "python3", args: [] },
    ];
  }
  return [
    { command: "python3", args: [] },
    { command: "python", args: [] },
  ];
}

async function defaultProbe(launch: PythonLaunch): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.command, [...launch.args, "--version"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      finish(false);
    }, PROBE_TIMEOUT_MS);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => finish(false));
    // Store 占位程序会把提示打到 stderr 且退出码非 0；真正的解释器 --version 输出含 Python。
    child.on("close", (code) => finish(code === 0 && /python/i.test(stdout)));
  });
}

let cached: PythonLaunch | undefined;
let pending: Promise<PythonLaunch | undefined> | undefined;

/**
 * 探测顺序：显式 `PYTHON`（失败即报错，不悄悄回退）→ 系统上第一个能跑的解释器。
 * 成功结果在进程内缓存；全部失败时不缓存，方便用户装好 Python 后无需重启服务。
 */
export function resolvePythonLaunch(
  probe: (launch: PythonLaunch) => Promise<boolean> = defaultProbe,
): Promise<PythonLaunch | undefined> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  const candidates = pythonCandidates();
  pending = (async () => {
    for (const launch of candidates) {
      if (await probe(launch).catch(() => false)) {
        cached = launch;
        return launch;
      }
    }
    return undefined;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

export function describeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return pythonCandidates(env, platform)
    .map((launch) => [launch.command, ...launch.args].join(" "))
    .join("、");
}

/** 仅供测试：清掉进程内缓存，让下一次调用重新探测。 */
export function resetPythonLaunchCache(): void {
  cached = undefined;
  pending = undefined;
}
