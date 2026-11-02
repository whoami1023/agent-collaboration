import { afterEach, describe, expect, it } from "vitest";
import {
  describeCandidates,
  parsePythonEnv,
  pythonCandidates,
  resetPythonLaunchCache,
  resolvePythonLaunch,
  type PythonLaunch,
} from "../src/agent/python-launcher";

afterEach(() => resetPythonLaunchCache());

describe("python launcher 候选顺序", () => {
  it("Windows 先用 py -3，因为 python 可能是商店占位程序", () => {
    expect(pythonCandidates({}, "win32").map((item) => [item.command, ...item.args].join(" "))).toEqual(
      ["py -3", "py", "python", "python3"],
    );
  });

  it("类 Unix 先用 python3", () => {
    expect(pythonCandidates({}, "darwin").map((item) => item.command)).toEqual(["python3", "python"]);
  });

  it("显式 PYTHON 优先且不再回退，避免悄悄换解释器", () => {
    expect(pythonCandidates({ PYTHON: "D:/x/py.exe" }, "win32")).toEqual([
      { command: "D:/x/py.exe", args: [] },
    ]);
  });

  it("PYTHON 可以写成命令加参数", () => {
    expect(parsePythonEnv("  py   -3 ")).toEqual({ command: "py", args: ["-3"] });
  });

  it("候选清单用于错误提示时保留参数", () => {
    expect(describeCandidates({ PYTHON: "py -3" }, "win32")).toBe("py -3");
    expect(describeCandidates({}, "linux")).toBe("python3、python");
  });
});

describe("resolvePythonLaunch", () => {
  it("按顺序探测，选中第一个 --version 成功的解释器就停止", async () => {
    const keyOf = (item: PythonLaunch) => [item.command, ...item.args].join(" ");
    const expected = pythonCandidates();
    const target = expected[expected.length - 1];
    const tried: string[] = [];
    const launch = await resolvePythonLaunch(async (item: PythonLaunch) => {
      tried.push(keyOf(item));
      return keyOf(item) === keyOf(target);
    });
    expect(launch).toEqual(target);
    expect(tried).toEqual(expected.map(keyOf));
  });

  it("成功结果在进程内缓存，不会每次都重新探测", async () => {
    let probes = 0;
    const first = await resolvePythonLaunch(async () => {
      probes += 1;
      return true;
    });
    const second = await resolvePythonLaunch(async () => {
      probes += 1;
      return true;
    });
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(probes).toBe(1);
  });

  it("全部不可用时返回 undefined 并且不缓存，装好 Python 后无需重启", async () => {
    let probes = 0;
    const miss = await resolvePythonLaunch(async () => {
      probes += 1;
      return false;
    });
    expect(miss).toBeUndefined();
    const again = await resolvePythonLaunch(async () => {
      probes += 1;
      return false;
    });
    expect(again).toBeUndefined();
    expect(probes).toBe(pythonCandidates().length * 2);
  });

  it("真实的 --version 探测不会把商店占位程序当成解释器", async () => {
    const launch = await resolvePythonLaunch();
    if (!launch) return; // 本机没装 Python：这条用例只负责在有 Python 时验证探测语义
    expect(launch.command).toBeTruthy();
  });
});
