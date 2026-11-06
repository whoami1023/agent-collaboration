import { describe, expect, it } from "vitest";
import {
  ToolGuardrails,
  looksLikeFailure,
  toolClass,
  type GuardrailVerdict,
} from "../src/agent/loop/guardrails";

const LONG = "x".repeat(600);

function observe(
  guard: ToolGuardrails,
  name: string,
  args: Record<string, unknown>,
  raw: string,
): { content: string; note?: string; halt?: string } {
  return guard.observe(name, args, raw);
}

function verdictText(verdict: GuardrailVerdict): string {
  return "reason" in verdict ? verdict.reason : "";
}

describe("工具分类", () => {
  it("变更型 / 容错型 / 幂等型各自归位，未登记的工具按幂等处理", () => {
    expect(toolClass("file_write")).toBe("mutating");
    expect(toolClass("run_command")).toBe("failure-tolerant");
    expect(toolClass("file_read")).toBe("idempotent");
    expect(toolClass("brand_new_tool")).toBe("idempotent");
  });

  it("命令退出码非零算失败，限流文案也算失败", () => {
    expect(looksLikeFailure("错误：路径不存在")).toBe(true);
    expect(looksLikeFailure("退出码：1\n出错了")).toBe(true);
    expect(looksLikeFailure("退出码：0\n一切正常")).toBe(false);
    expect(looksLikeFailure(LONG)).toBe(false);
  });
});

describe("同参数失败护栏", () => {
  it("第二次同参失败给出提醒，第五次拒绝执行", () => {
    const guard = new ToolGuardrails();
    const args = { path: "a.md" };
    expect(guard.beforeCall("file_read", args)).toEqual({ action: "allow" });
    const first = observe(guard, "file_read", args, "错误：读取失败");
    expect(first.note).toBeUndefined();
    observe(guard, "file_read", args, "错误：读取失败");
    const second = guard.beforeCall("file_read", args);
    expect(second.action).toBe("allow");
    for (let i = 0; i < 3; i += 1) observe(guard, "file_read", args, "错误：读取失败");
    const blocked = guard.beforeCall("file_read", args);
    expect(blocked.action).toBe("block");
    expect(verdictText(blocked)).toContain("连续失败 5 次");
  });

  it("换了参数就是新的一次尝试，不受旧失败影响", () => {
    const guard = new ToolGuardrails();
    for (let i = 0; i < 6; i += 1) observe(guard, "file_read", { path: "a.md" }, "错误：读取失败");
    expect(guard.beforeCall("file_read", { path: "b.md" })).toEqual({ action: "allow" });
  });

  it("参数只是 JSON 键序不同仍算同一次调用", () => {
    const guard = new ToolGuardrails();
    for (let i = 0; i < 3; i += 1) {
      observe(guard, "file_read", { path: "a.md", max_bytes: 10 }, "错误：读取失败");
      observe(guard, "file_read", { max_bytes: 10, path: "a.md" }, "错误：读取失败");
    }
    expect(guard.beforeCall("file_read", { path: "a.md", max_bytes: 10 }).action).toBe("block");
  });

  it("成功一次就把同参失败计数清零", () => {
    const guard = new ToolGuardrails();
    const args = { path: "a.md" };
    for (let i = 0; i < 4; i += 1) observe(guard, "file_read", args, "错误：读取失败");
    observe(guard, "file_read", args, "内容读到了");
    expect(guard.beforeCall("file_read", args)).toEqual({ action: "allow" });
  });

  it("限流失败不累加同参失败次数：等冷却后重试是正确行为", () => {
    const guard = new ToolGuardrails();
    const args = { url: "https://example.com" };
    for (let i = 0; i < 6; i += 1) {
      observe(guard, "web_fetch", args, "工具执行失败：HTTP 429 Too Many Requests");
    }
    expect(guard.beforeCall("web_fetch", args)).toEqual({ action: "allow" });
  });

  it("容错型工具三次同参失败就拦：同一条命令重跑没意义", () => {
    const guard = new ToolGuardrails();
    const args = { command: "python build.py" };
    for (let i = 0; i < 3; i += 1) observe(guard, "run_command", args, "退出码：1");
    const verdict = guard.beforeCall("run_command", args);
    expect(verdict.action).toBe("block");
    expect(verdictText(verdict)).toContain("连续失败 3 次");
  });

  it("同一个非容错工具连续失败到上限时中止本轮", () => {
    const guard = new ToolGuardrails();
    let halt: string | undefined;
    for (let i = 0; i < 8; i += 1) {
      halt = observe(guard, "file_read", { path: `missing-${i}.md` }, "错误：读取失败").halt;
    }
    expect(halt).toContain("已中止本次运行");
  });

  it("容错型工具不会因为反复试错被中止：排查本身就是进展", () => {
    const guard = new ToolGuardrails();
    let halt: string | undefined;
    for (let i = 0; i < 9; i += 1) {
      halt = observe(guard, "run_command", { command: `pytest -k case${i}` }, "退出码：1").halt;
    }
    expect(halt).toBeUndefined();
  });

  it("一次成功的变更清空该工具此前的失败痕迹", () => {
    const guard = new ToolGuardrails();
    for (let i = 0; i < 7; i += 1) {
      observe(guard, "file_write", { path: `a${i}.md` }, "写入失败：磁盘满");
    }
    observe(guard, "file_write", { path: "ok.md" }, "已写入 files/ok.md");
    const after = observe(guard, "file_write", { path: "again.md" }, "写入失败：磁盘满");
    expect(after.halt).toBeUndefined();
  });
});

describe("无进展与重复结果", () => {
  it("同参同结果第三次给提醒，第六次拒绝再读", () => {
    const guard = new ToolGuardrails();
    const args = { path: "a.md" };
    observe(guard, "file_read", args, LONG);
    expect(observe(guard, "file_read", args, LONG).note).not.toContain("没有新进展");
    expect(observe(guard, "file_read", args, LONG).note).toContain("没有新进展");
    for (let i = 0; i < 4; i += 1) observe(guard, "file_read", args, LONG);
    const blocked = guard.beforeCall("file_read", args);
    expect(blocked.action).toBe("block");
    expect(verdictText(blocked)).toContain("完全相同的内容");
  });

  it("结果内容变了就不算无进展", () => {
    const guard = new ToolGuardrails();
    const args = { query: "关键词" };
    observe(guard, "memory_search", args, "第一批命中");
    const second = observe(guard, "memory_search", args, "第二批命中");
    expect(second.note).toBeUndefined();
  });

  it("长结果第 2 次起换成引用桩，短结果原样保留", () => {
    const guard = new ToolGuardrails();
    observe(guard, "file_read", { path: "big.md" }, LONG);
    const repeated = observe(guard, "file_read", { path: "big.md" }, LONG);
    expect(repeated.content).toContain("已省略");
    expect(repeated.content.length).toBeLessThan(LONG.length);
    expect(repeated.note).toContain("重复内容");
    observe(guard, "file_read", { path: "small.md" }, "只有几个字");
    const small = observe(guard, "file_read", { path: "small.md" }, "只有几个字");
    expect(small.content).toBe("只有几个字");
  });

  it("引用桩保留回看提示：省上下文但不丢可寻址性", () => {
    const guard = new ToolGuardrails();
    observe(guard, "file_read", { path: "big.md" }, LONG);
    const repeated = observe(guard, "file_read", { path: "big.md" }, LONG);
    expect(repeated.content).toContain("回看第 1 次调用的结果");
  });
});

describe("批次循环检测", () => {
  const pair = [
    { name: "file_read", args: { path: "a.md" } },
    { name: "file_read", args: { path: "b.md" } },
  ];
  const swapped = [pair[1], pair[0]];

  it("同一组调用来回重排到第四批被拦下", () => {
    const guard = new ToolGuardrails();
    expect(guard.beforeBatch(pair).action).toBe("allow");
    expect(guard.beforeBatch(swapped).action).toBe("allow");
    expect(guard.beforeBatch(pair).action).toBe("allow");
    const blocked = guard.beforeBatch(swapped);
    expect(blocked.action).toBe("block");
    expect(verdictText(blocked)).toContain("重复同一组 2 个工具调用");
  });

  it("重复到第三轮之后直接中止本轮，而不是无限拦下去", () => {
    const guard = new ToolGuardrails();
    expect(guard.beforeBatch(pair).action).toBe("allow");
    expect(guard.beforeBatch(swapped).action).toBe("allow");
    expect(guard.beforeBatch(pair).action).toBe("allow");
    expect(guard.beforeBatch(swapped).action).toBe("block");
    expect(guard.beforeBatch(pair).action).toBe("block");
    expect(verdictText(guard.beforeBatch(swapped))).toContain("已中止本次运行");
  });

  it("批次循环已经成立时，单个新调用也一并被中止", () => {
    const guard = new ToolGuardrails();
    for (let i = 0; i < 6; i += 1) guard.beforeBatch(i % 2 === 0 ? pair : swapped);
    expect(guard.beforeCall("file_read", { path: "c.md" }).action).toBe("halt");
  });

  it("每批都换新目标时不会误判", () => {
    const guard = new ToolGuardrails();
    for (let i = 0; i < 8; i += 1) {
      expect(
        guard.beforeBatch([
          { name: "file_read", args: { path: `a-${i}.md` } },
          { name: "file_read", args: { path: `b-${i}.md` } },
        ]).action,
      ).toBe("allow");
    }
  });
});
