#!/usr/bin/env node
// 安装前 / 安装后的环境自检。只用 Node 内置模块，未安装依赖时也能运行。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const offline = args.has("--offline");

if (args.has("--help") || args.has("-h")) {
  console.log(`用法：node scripts/check-env.mjs [--offline] [--json]

  --offline  跳过 npm 源连通性检查（离线或使用本地缓存安装时）
  --json     输出机器可读的 JSON，退出码 0=可安装，1=存在阻断问题`);
  process.exit(0);
}

const checks = [];
let npmAvailable = false;
const add = (id, group, label, status, detail, hint) =>
  checks.push({ id, group, label, status, detail, hint });

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const pkg = readJson(path.join(root, "package.json"));

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, commandArgs, timeout = 15000) {
  return spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    shell: process.platform === "win32",
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function checkSystem() {
  const platformLabel = { win32: "Windows", linux: "Linux", darwin: "macOS" }[process.platform] ?? process.platform;
  const known = ["win32", "linux", "darwin"].includes(process.platform);
  add(
    "system",
    "基础环境",
    "操作系统",
    known ? "pass" : "warn",
    `${platformLabel} ${os.release()} · ${process.arch} · CPU ${os.cpus().length} 核 · 内存 ${formatBytes(os.totalmem())}`,
    known ? undefined : "该项目仅在 Windows / Linux / macOS 上验证过。",
  );
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    add(
      "node",
      "基础环境",
      "Node.js",
      "fail",
      `当前 v${process.versions.node}，要求 ≥ 20`,
      "安装 Node.js 22 或 24 LTS：https://nodejs.org/",
    );
  } else if (major < 22) {
    add(
      "node",
      "基础环境",
      "Node.js",
      "warn",
      `当前 v${process.versions.node}（要求 ≥ 20，推荐 22/24）`,
      "Node 20 已停止维护，建议升级到 22 或 24。",
    );
  } else {
    add("node", "基础环境", "Node.js", "pass", `当前 v${process.versions.node}`);
  }
}

async function checkNpm() {
  const result = run(npmCommand(), ["--version"]);
  const version = (result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !version) {
    add(
      "npm",
      "基础环境",
      "npm",
      "fail",
      "未检测到可用的 npm",
      "随 Node.js 一起安装 npm，或执行 corepack enable 后重试。",
    );
    return;
  }
  npmAvailable = true;
  const major = Number(version.split(".")[0]);
  if (major < 9) {
    add(
      "npm",
      "基础环境",
      "npm",
      "warn",
      `当前 ${version}（建议 ≥ 9）`,
      "旧版 npm 对 package-lock v3 支持不完整，建议执行 npm install -g npm@latest。",
    );
  } else {
    add("npm", "基础环境", "npm", "pass", `当前 ${version}`);
  }
}

async function checkProjectFiles() {
  const required = ["package.json", "tsconfig.json", "src/server/index.ts", "web/index.html", "web/vite.config.ts"];
  const missing = required.filter((file) => !existsSync(path.join(root, file)));
  if (missing.length > 0) {
    add(
      "project-files",
      "项目文件",
      "必需文件",
      "fail",
      `缺少 ${missing.join("、")}`,
      "请确认在项目根目录执行，且源码完整（不是只复制了部分目录）。",
    );
  } else {
    add("project-files", "项目文件", "必需文件", "pass", "源码与构建配置齐全");
  }
  if (!existsSync(path.join(root, "package-lock.json"))) {
    add(
      "lockfile",
      "项目文件",
      "依赖锁文件",
      "warn",
      "缺少 package-lock.json",
      "没有锁文件时依赖版本可能漂移，建议从仓库完整克隆。",
    );
  } else {
    add("lockfile", "项目文件", "依赖锁文件", "pass", "package-lock.json 存在");
  }
}

async function checkWritable() {
  const probe = `.env-check-${process.pid}`;
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    for (const dir of [root, path.join(root, "data")]) {
      const file = path.join(dir, probe);
      await writeFile(file, "ok");
      await rm(file, { force: true });
    }
    add("write", "项目文件", "目录可写", "pass", "项目根目录与 data/ 均可写入");
  } catch (error) {
    add(
      "write",
      "项目文件",
      "目录可写",
      "fail",
      error instanceof Error ? error.message : String(error),
      "把项目放到有写权限的目录（不要放在 Program Files 等受保护位置）。",
    );
  }
}

function checkDisk() {
  try {
    const stats = statfsSync(root);
    const free = stats.bsize * stats.bavail;
    if (free < 512 * 1024 * 1024) {
      add("disk", "项目文件", "磁盘空间", "fail", `剩余 ${formatBytes(free)}`, "依赖与构建产物约需 500 MB，请先清理磁盘。");
    } else if (free < 2 * 1024 * 1024 * 1024) {
      add("disk", "项目文件", "磁盘空间", "warn", `剩余 ${formatBytes(free)}`, "空间偏紧，建议保留 2 GB 以上。");
    } else {
      add("disk", "项目文件", "磁盘空间", "pass", `剩余 ${formatBytes(free)}`);
    }
  } catch {
    add("disk", "项目文件", "磁盘空间", "warn", "当前平台无法读取磁盘剩余空间", "请自行确认至少保留 500 MB。");
  }
}

function checkDependencies() {
  const modulesDir = path.join(root, "node_modules");
  if (!existsSync(modulesDir)) {
    add(
      "deps",
      "依赖与构建",
      "项目依赖",
      "warn",
      "node_modules 尚未安装（安装前检查时的正常状态）",
      "执行 npm install；安装完成后重新运行 npm run check:env 复查。",
    );
    return;
  }
  const required = [
    "express",
    "react",
    "react-dom",
    "markdown-it",
    "yaml",
    "exceljs",
    "mammoth",
    "dompurify",
    "tsx",
    "typescript",
    "vite",
    "vitest",
  ];
  const missing = required.filter((name) => !existsSync(path.join(modulesDir, name, "package.json")));
  if (missing.length > 0) {
    add(
      "deps",
      "依赖与构建",
      "项目依赖",
      "fail",
      `缺少 ${missing.length} 个：${missing.join("、")}`,
      "重新执行 npm install。不要加 --omit=dev：tsx 用于启动服务、vite 用于构建前端，均在 devDependencies 中。",
    );
  } else {
    add("deps", "依赖与构建", "项目依赖", "pass", `${required.length} 个关键依赖已就绪`);
  }
}

async function checkWebDist() {
  try {
    await access(path.join(root, "web", "dist", "index.html"));
    add("web-dist", "依赖与构建", "前端产物", "pass", "web/dist 已就绪");
  } catch {
    add(
      "web-dist",
      "依赖与构建",
      "前端产物",
      "warn",
      "web/dist 尚未构建",
      "执行 npm run web:build；未构建时主页无法打开（API 仍可用）。",
    );
  }
}

function registryUrl() {
  const fromEnv = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const result = run(npmCommand(), ["config", "get", "registry"], 10000);
  const value = (result.stdout ?? "").trim();
  return (value || "https://registry.npmjs.org").replace(/\/+$/, "");
}

async function checkRegistry() {
  if (offline) {
    add("registry", "安装来源", "npm 源", "warn", "已跳过（--offline）", "确认本机 npm 缓存或私有源可用。");
    return;
  }
  const registry = registryUrl();
  try {
    const started = Date.now();
    if (npmAvailable) {
      // 走 npm 自身的网络配置（代理、镜像、证书），比直接 fetch 更贴近真实安装。
      const result = run(npmCommand(), ["ping", "--loglevel=error"], 20000);
      if (result.error || result.status !== 0) {
        const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
        const reason = output.split("\n").filter(Boolean).pop() ?? result.error?.message ?? "未知错误";
        throw new Error(reason);
      }
    } else {
      const response = await fetch(`${registry}/-/ping`, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
    add("registry", "安装来源", "npm 源", "pass", `可访问 ${registry}（${Date.now() - started} ms）`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    add(
      "registry",
      "安装来源",
      "npm 源",
      "fail",
      `无法访问 ${registry}（${reason}）`,
      "检查网络 / 代理 / 镜像源；离线安装可加 --offline 跳过此检查。",
    );
  }
}

function parsePythonVersion(text) {
  const match = text.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  return match ? `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ""}` : null;
}

/** spec 形如 `py -3`：第一段是命令，其余是固定参数，与 src/agent/python-launcher.ts 保持一致。 */
function splitSpec(spec) {
  const [command, ...args] = spec.trim().split(/\s+/);
  return { command, args };
}

function runPythonSpec(spec, extraArgs) {
  const { command, args } = splitSpec(spec);
  return spawnSync(command, [...args, ...extraArgs], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
}

function probePython(spec) {
  const result = runPythonSpec(spec, ["--version"]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (/Microsoft Store|was not found|not found|未找到/i.test(output)) return null;
  if (result.error || result.status !== 0) return null;
  const version = parsePythonVersion(output);
  return version ? { command: spec, version } : null;
}

/** 与运行时同一套候选顺序：显式 PYTHON 优先且不回退。 */
function pythonSpecs() {
  const explicit = process.env.PYTHON?.trim();
  if (explicit) return [explicit];
  if (process.platform === "win32") return ["py -3", "py", "python", "python3"];
  return ["python3", "python"];
}

function addPythonResult(found, source) {
  const [major, minor] = found.version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 8)) {
    add(
      "python",
      "可选能力",
      "Python",
      "warn",
      `检测到 ${found.version}（${source}），建议 3.10+`,
      "较旧版本可能缺少部分标准库特性；Python 技能脚本仍可能运行。",
    );
  } else {
    add("python", "可选能力", "Python", "pass", `${found.version}（${source}）`);
  }
}

/** Word 技能脚本依赖 python-docx + lxml：能跑 Python 但缺库时，技能会在第一步就失败。 */
function checkPythonLibraries(spec) {
  const result = runPythonSpec(spec, [
    "-c",
    "import docx, lxml.etree; print('docx-libs-ok')",
  ]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!result.error && result.status === 0 && output.includes("docx-libs-ok")) {
    add("python-docx", "可选能力", "Word 技能依赖", "pass", "python-docx 与 lxml 可用（docx 技能可直接运行）");
    return;
  }
  add(
    "python-docx",
    "可选能力",
    "Word 技能依赖",
    "warn",
    "当前 Python 缺少 python-docx 或 lxml",
    `内置 Word 技能需要它们：${spec} -m pip install python-docx lxml`,
  );
}

function checkPython() {
  const explicit = process.env.PYTHON?.trim();
  const specs = pythonSpecs();
  for (const spec of specs) {
    const found = probePython(spec);
    if (!found) continue;
    addPythonResult(found, explicit ? `PYTHON=${spec}` : `${spec}，run_skill_script 会选用它`);
    checkPythonLibraries(spec);
    return;
  }

  if (explicit) {
    add(
      "python",
      "可选能力",
      "Python",
      "warn",
      `PYTHON 已设为 ${explicit}，但无法执行`,
      "修正或删除该环境变量；删除后 run_skill_script 会自动尝试 py -3 / python / python3。",
    );
    return;
  }

  add(
    "python",
    "可选能力",
    "Python",
    "warn",
    "未检测到可用的 Python 3（可选）",
    "只影响 run_skill_script 执行 .py 技能脚本（含内置 Word 技能）；Node / Shell 脚本不受影响。安装后可用 PYTHON 环境变量指定解释器。",
  );
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (value) => {
      server.removeAllListeners();
      resolve(value);
    };
    server.once("error", (error) => finish({ free: false, code: error.code ?? "ERROR" }));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => finish({ free: true }));
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {
        // ignore
      }
      finish({ free: false, code: "TIMEOUT" });
    }, 2000).unref();
  });
}

async function checkPort() {
  const configured = Number(process.env.PORT ?? 8788);
  const port = Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : 8788;
  const result = await probePort(port);
  if (result.free) {
    add("port", "可选能力", `端口 ${port}`, "pass", "可绑定");
  } else {
    add(
      "port",
      "可选能力",
      `端口 ${port}`,
      "warn",
      result.code === "EADDRINUSE" ? "已被占用" : `无法绑定（${result.code}）`,
      "可能已有实例在运行；换端口启动：PORT=8790 npm start（Windows PowerShell 用 $env:PORT=8790）。",
    );
  }
}

const ICONS = { pass: "✔", warn: "⚠", fail: "✖" };
const STATUS_LABEL = { pass: "通过", warn: "警告", fail: "失败" };

function printHuman() {
  const name = pkg?.name ?? "agent-collaboration";
  const version = pkg?.version ? ` v${pkg.version}` : "";
  console.log(`\n${name}${version} 环境检查`);
  console.log("─".repeat(64));
  let group = "";
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      console.log(`\n[${group}]`);
    }
    console.log(`  ${ICONS[check.status]} ${check.label}：${check.detail}`);
    if (check.hint && check.status !== "pass") console.log(`    → ${check.hint}`);
  }
  const counts = count();
  console.log("\n" + "─".repeat(64));
  console.log(`通过 ${counts.pass} · 警告 ${counts.warn} · 失败 ${counts.fail}`);
  if (counts.fail > 0) {
    const failed = checks.filter((check) => check.status === "fail").map((check) => check.label);
    console.log(`结论：环境不满足安装条件，请先处理：${failed.join("、")}。`);
  } else if (existsSync(path.join(root, "node_modules"))) {
    console.log(`结论：环境满足运行要求（${counts.warn} 项警告）。`);
  } else if (counts.warn > 0) {
    console.log("结论：环境满足安装条件。安装完成后重新运行 npm run check:env 复查依赖与前端产物。");
  } else {
    console.log("结论：环境满足安装与运行要求。");
  }
}

function count() {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

async function main() {
  checkSystem();
  checkNode();
  await checkNpm();
  await checkProjectFiles();
  await checkWritable();
  checkDisk();
  checkDependencies();
  await checkWebDist();
  await checkRegistry();
  checkPython();
  await checkPort();

  const counts = count();
  const ok = counts.fail === 0;
  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          ok,
          summary: counts,
          checks: checks.map(({ id, group, label, status, detail, hint }) => ({
            id,
            group,
            label,
            status,
            detail,
            ...(hint ? { hint } : {}),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    printHuman();
  }
  process.exitCode = ok ? 0 : 1;
}

await main();
