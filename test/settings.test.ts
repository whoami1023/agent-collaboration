import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  sanitizeLimits,
  SETTINGS_VERSION,
} from "../src/core/settings";
import { DEFAULT_LIMITS } from "../src/core/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeSettings(raw: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ac-settings-"));
  tempDirs.push(dir);
  const file = join(dir, "settings.json");
  await writeFile(file, JSON.stringify(raw), "utf8");
  return file;
}

function legacySettings(limits: Record<string, unknown>, settingsVersion?: number): unknown {
  return {
    providers: [{ id: "demo", kind: "mock", model: "mock" }],
    activeProviderId: "demo",
    ...(settingsVersion === undefined ? {} : { settingsVersion }),
    limits,
  };
}

describe("设置迁移", () => {
  it("v1 旧默认的 12 步 / 120 秒升级为 v3 默认", async () => {
    const file = await writeSettings(
      legacySettings({ ...DEFAULT_LIMITS, maxStepsPerRun: 12, runTimeoutMs: 120_000 }),
    );
    const settings = await loadSettings(file);
    expect(settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(settings.limits.maxStepsPerRun).toBe(48);
    expect(settings.limits.runTimeoutMs).toBe(420_000);
    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      settingsVersion: number;
      limits: { maxStepsPerRun: number };
    };
    expect(persisted.settingsVersion).toBe(SETTINGS_VERSION);
    expect(persisted.limits.maxStepsPerRun).toBe(48);
  });

  it("v2 旧默认的 24 步 / 180 秒升级为 v3 默认", async () => {
    const file = await writeSettings(
      legacySettings({ ...DEFAULT_LIMITS, maxStepsPerRun: 24, runTimeoutMs: 180_000 }, 2),
    );
    const settings = await loadSettings(file);
    expect(settings.limits.maxStepsPerRun).toBe(48);
    expect(settings.limits.runTimeoutMs).toBe(420_000);
  });

  it("用户在 v1 显式改成的 24 步不被当成旧默认覆盖", async () => {
    const file = await writeSettings(
      legacySettings({ ...DEFAULT_LIMITS, maxStepsPerRun: 24, runTimeoutMs: 180_000 }, 1),
    );
    const settings = await loadSettings(file);
    expect(settings.limits.maxStepsPerRun).toBe(24);
    expect(settings.limits.runTimeoutMs).toBe(180_000);
  });

  it("用户显式调整过的步数与超时保持不变", async () => {
    const file = await writeSettings(
      legacySettings({ ...DEFAULT_LIMITS, maxStepsPerRun: 30, runTimeoutMs: 90_000 }, 2),
    );
    const settings = await loadSettings(file);
    expect(settings.limits.maxStepsPerRun).toBe(30);
    expect(settings.limits.runTimeoutMs).toBe(90_000);
  });

  it("没有配置文件时使用新默认", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-settings-"));
    tempDirs.push(dir);
    const settings = await loadSettings(join(dir, "settings.json"));
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.limits.maxStepsPerRun).toBe(48);
    expect(settings.limits.runTimeoutMs).toBe(420_000);
  });
});

describe("sanitizeLimits", () => {
  it("只回传出现过的字段", () => {
    expect(sanitizeLimits({ maxStepsPerRun: 60 })).toEqual({ maxStepsPerRun: 60 });
  });

  it("接受区间内的整数，包括按毫秒提交的超时", () => {
    expect(
      sanitizeLimits({ maxStepsPerRun: 96, runTimeoutMs: 900_000, maxConcurrent: 32 }),
    ).toEqual({ maxStepsPerRun: 96, runTimeoutMs: 900_000, maxConcurrent: 32 });
  });

  it("越界的步数与超时被拒绝，错误文案给出合法区间", () => {
    expect(() => sanitizeLimits({ maxStepsPerRun: 200 })).toThrow(
      "单次运行工具步数需在 4–120 步之间",
    );
    expect(() => sanitizeLimits({ runTimeoutMs: 1_000 })).toThrow(
      "单次运行超时需在 15–900 秒之间",
    );
  });

  it("非整数与非数字被拒绝", () => {
    expect(() => sanitizeLimits({ maxSpawnDepth: 2.5 })).toThrow("最大层级深度必须是整数（层）");
    expect(() => sanitizeLimits({ maxConcurrent: "8" })).toThrow("同时运行成员数必须是整数（个）");
  });

  it("未知字段与非法形状报错，避免把 limits 写成不可运行的值", () => {
    expect(() => sanitizeLimits({ maxStepsPerRunx: 10 })).toThrow("未知的限额字段 maxStepsPerRunx");
    expect(() => sanitizeLimits("48")).toThrow("limits 必须是对象");
    expect(() => sanitizeLimits(null)).toThrow("limits 必须是对象");
  });
});
