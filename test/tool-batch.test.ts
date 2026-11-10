// run_batch：一次调用跑多条命令，并在同一次调用里从完整输出中检索要回答的问题。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildShellTools } from "../src/agent/shell-tools";
import { ToolOutputStore } from "../src/agent/content/offload";
import type { Member } from "../src/core/types";
import { WorkspaceFiles } from "../src/files/workspace-files";
import { SkillLibrary } from "../src/skills/library";

const signal = new AbortController().signal;
const member: Member = {
  id: "m_main",
  roomId: "room_test",
  name: "主智能体",
  role: "main",
  status: "idle",
  depth: 0,
  spawnedBy: null,
  controlScope: "children",
  contextMode: "isolated",
  systemPrompt: "",
  modelRef: "default",
  createdAt: 0,
  lastActiveAt: 0,
};

let dir: string;
let files: WorkspaceFiles;
let library: SkillLibrary;
let store: ToolOutputStore;
let tools: Map<string, ReturnType<typeof buildShellTools>[number]>;

function build(withStore: boolean): void {
  tools = new Map(
    buildShellTools({
      files,
      skills: library,
      userId: "u_test",
      member,
      ...(withStore ? { toolOutputs: store, runId: "run_test" } : {}),
    }).map((tool) => [tool.schema.name, tool]),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-batch-"));
  files = new WorkspaceFiles(dir);
  library = new SkillLibrary(join(dir, "skills.json"), { seedShared: false });
  await library.init();
  store = new ToolOutputStore(join(dir, "tool-outputs"));
  build(true);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const node = (script: string): string => `node -e "${script}"`;

describe("run_batch", () => {
  it("按顺序执行多条命令，逐条给出退出码，小输出整份返回并套外部内容信封", async () => {
    const out = await tools.get("run_batch")!.execute(
      { commands: [node("console.log('alpha')"), node("console.log('beta')")] },
      signal,
    );
    expect(out).toContain("批量执行：2 条命令");
    expect(out).toContain("`node -e \"console.log('alpha')\"` 退出码 0");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain('<untrusted_tool_result source="run_batch">');
    expect(out).not.toContain("完整输出已存档");
  });

  it("中途某条失败不影响后续命令，退出码如实汇总", async () => {
    const out = await tools.get("run_batch")!.execute(
      { commands: [node("process.exit(3)"), node("console.log('after-failure')")] },
      signal,
    );
    expect(out).toContain("退出码 3");
    expect(out).toContain("退出码 0");
    expect(out).toContain("after-failure");
  });

  it("大输出存档，并在同一次调用里用 queries 检索到关键行", async () => {
    const big = node(
      "process.stdout.write(Array.from({length:1200},(_,i)=>'row '+i+(i===900?' NEEDLE_X':'')+' '+'y'.repeat(60)).join('\\n'))",
    );
    const out = await tools.get("run_batch")!.execute(
      { commands: [big, node("console.log('second done')")], queries: ["NEEDLE_X"] },
      signal,
    );
    expect(out).toContain("完整输出已存档 out_");
    expect(out).toContain("## 查询：NEEDLE_X");
    expect(out).toContain("NEEDLE_X");
    expect(out).toContain("second done");
    // 取回说明在信封外，检索片段在信封内。
    expect(out.indexOf("完整输出已存档")).toBeLessThan(out.indexOf('<untrusted_tool_result source="run_batch">'));
    expect(out.indexOf("不要重跑命令")).toBeGreaterThan(out.indexOf("</untrusted_tool_result>"));

    const id = /out_[A-Za-z0-9]{8,}/.exec(out)?.[0] ?? "";
    const read = await store.read("m_main", id, 1, 12);
    expect(read?.text).toContain("标准输出");
    expect(read?.text).toContain("row 0");
    const hits = await store.search("m_main", "NEEDLE_X");
    expect(hits[0]?.record.tool).toBe("run_batch");
    expect(hits[0]?.text).toContain("NEEDLE_X");
  });

  it("存档前先脱敏：返回与存档里都没有原密钥", async () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const big = node(
      `process.stdout.write(Array.from({length:1200},(_,i)=>'row '+i+' ${key} '+'x'.repeat(40)).join('\\n'))`,
    );
    const out = await tools.get("run_batch")!.execute({ commands: [big], queries: ["row"] }, signal);
    expect(out).not.toContain(key);
    expect(out).toMatch(/已掩掉 [1-9]\d* 处疑似密钥/);
    const id = /out_[A-Za-z0-9]{8,}/.exec(out)?.[0] ?? "";
    const read = await store.read("m_main", id, 1, 3);
    expect(read?.text).not.toContain(key);
    expect(read?.text).toContain("已脱敏");
  });

  it("没有接存档时仍能跑批，只是不做查询选段", async () => {
    build(false);
    const out = await tools.get("run_batch")!.execute(
      { commands: [node("console.log('no-store-ok')")], queries: ["no-store"] },
      signal,
    );
    expect(out).toContain("no-store-ok");
    expect(out).not.toContain("完整输出已存档");
  });

  it("参数闸门：空命令、过多命令、过多查询、非法 cwd 都被拒", async () => {
    const tool = tools.get("run_batch")!;
    expect(await tool.execute({ commands: [] }, signal)).toContain("commands 不能为空");
    expect(await tool.execute({ commands: Array.from({ length: 9 }, () => node("true")) }, signal)).toContain(
      "一次最多 8 条命令",
    );
    expect(
      await tool.execute({ commands: [node("true")], queries: Array.from({ length: 7 }, (_, i) => `q${i}`) }, signal),
    ).toContain("一次最多 6 个查询");
    expect(await tool.execute({ commands: [node("true")], cwd: ".." }, signal)).toContain(
      "cwd 必须位于文件工作区内",
    );
  });
});
