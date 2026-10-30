import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "check-env.mjs");

describe("环境检查脚本", () => {
  it("以 --json --offline 输出结构化结果", () => {
    const result = spawnSync(process.execPath, [script, "--json", "--offline"], {
      encoding: "utf8",
      timeout: 60000,
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { fail: number };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "node",
        "npm",
        "project-files",
        "write",
        "disk",
        "deps",
        "web-dist",
        "registry",
        "python",
        "port",
      ]),
    );
  });

  it("--help 说明参数并以 0 退出", () => {
    const result = spawnSync(process.execPath, [script, "--help"], {
      encoding: "utf8",
      timeout: 60000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--offline");
    expect(result.stdout).toContain("--json");
  });
});
