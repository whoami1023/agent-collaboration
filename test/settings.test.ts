import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_VERSION } from "../src/core/settings";
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

function legacySettings(limits: Record<string, unknown>): unknown {
  return {
    providers: [{ id: "demo", kind: "mock", model: "mock" }],
    activeProviderId: "demo",
    limits,
  };
}

describe("设置迁移", () => {
  it("旧版默认的 12 步 / 120 秒升级为新默认", async () => {
    const file = await writeSettings(
      legacySettings({ ...DEFAULT_LIMITS, maxStepsPerRun: 12, runTimeoutMs: 120_000 }),
    );
    const settings = await loadSettings(file);
    expect(settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(settings.limits.maxStepsPerRun).toBe(24);
    expect(settings.limits.runTimeoutMs).toBe(180_000);
    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      settingsVersion: number;
      limits: { maxStepsPerRun: number };
    };
    expect(persisted.settingsVersion).toBe(SETTINGS_VERSION);
    expect(persisted.limits.maxStepsPerRun).toBe(24);
  });

  it("用户显式调整过的步数与超时保持不变", async () => {
    const file = await writeSettings(
      legacySettings({ ...DEFAULT_LIMITS, maxStepsPerRun: 30, runTimeoutMs: 90_000 }),
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
    expect(settings.limits.maxStepsPerRun).toBe(24);
    expect(settings.limits.runTimeoutMs).toBe(180_000);
  });
});
