// file_search：跨文件检索 + 行号定位；片段逐段套信封，密钥在管线出口统一脱敏。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFileTools } from "../src/agent/file-tools";
import { applyRunScope } from "../src/agent/run-scope";
import { transformToolResult } from "../src/agent/content/policy";
import { WorkspaceFiles } from "../src/files/workspace-files";
import type { ToolImpl } from "../src/agent/loop";

const signal = new AbortController().signal;
let dir: string;
let files: WorkspaceFiles;
let tools: Map<string, ToolImpl>;

function makeLog(lines: number, needleLine: number): string {
  return Array.from({ length: lines }, (_, index) =>
    index + 1 === needleLine
      ? `line ${index + 1} NEEDLE_PATTERN found in the middle`
      : `line ${index + 1} routine content ${"x".repeat(40)}`,
  ).join("\n");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-filesearch-"));
  files = new WorkspaceFiles(dir);
  await files.write("reports/long.md", Buffer.from(makeLog(400, 250)));
  await files.write("reports/short.md", Buffer.from("intro\nNEEDLE_PATTERN once\nend"));
  await files.write("notes/other.txt", Buffer.from("nothing relevant here"));
  await files.write("blob.bin", Buffer.from([0, 1, 2, 3]));
  tools = new Map(buildFileTools(files).map((tool) => [tool.schema.name, tool]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("file_search", () => {
  it("跨文件命中，按相关度返回文件、行区间与受信封保护的片段", async () => {
    const out = await tools.get("file_search")!.execute({ query: "NEEDLE_PATTERN" }, signal);
    expect(out).toContain("在工作区 2 个文件里找到");
    expect(out).toContain("reports/long.md 第 ");
    expect(out).toContain("reports/short.md 第 1–3 行");
    expect(out).toContain("NEEDLE_PATTERN");
    expect(out).toContain('<untrusted_tool_result source="file_search">');
    expect(out).toContain("file_read(path=");
    expect(out).not.toContain("blob.bin");
    expect(out).not.toContain("notes/other.txt");
    // 命中 250 行附近，而不是只给文件开头。
    const match = /reports\/long\.md 第 (\d+)–(\d+) 行/.exec(out);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(250);
    expect(Number(match![2])).toBeGreaterThanOrEqual(250);
  });

  it("path 前缀把检索限定在子目录或单个文件", async () => {
    const scoped = await tools.get("file_search")!.execute(
      { query: "NEEDLE_PATTERN", path: "reports/short.md" },
      signal,
    );
    expect(scoped).toContain("reports/short.md");
    expect(scoped).not.toContain("reports/long.md");
    expect(scoped).toContain("在工作区 1 个文件里找到");
  });

  it("无命中给出换词建议；空查询被拒", async () => {
    const tool = tools.get("file_search")!;
    const miss = await tool.execute({ query: "完全不存在的词" }, signal);
    expect(miss).toContain("没有找到匹配的文件内容");
    expect(miss).toContain("file_list");
    expect(await tool.execute({ query: "   " }, signal)).toContain("query 不能为空");
  });

  it("片段里的疑似密钥在管线出口被掩掉", async () => {
    await files.write(
      "reports/secret.md",
      Buffer.from("config\napi_key = sk-abcdefghijklmnopqrstuvwxyz123456\nend"),
    );
    const raw = await tools.get("file_search")!.execute({ query: "api_key" }, signal);
    const out = await transformToolResult("file_search", raw, { query: "api_key" }, {});
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(out).toMatch(/已掩掉 [1-9]\d* 处疑似密钥/);
    expect(out).toContain('<untrusted_tool_result source="file_search">');
  });

  it("计划轮也挂载 file_search：只读检索不受收窄影响", () => {
    const fake: ToolImpl = {
      schema: {
        name: "file_search",
        description: "",
        parameters: { type: "object", properties: {}, required: [] },
      },
      execute: async () => "",
    };
    expect(applyRunScope([fake], "plan")).toEqual([fake]);
  });
});
