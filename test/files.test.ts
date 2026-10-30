import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFileTools } from "../src/agent/file-tools";
import {
  inlineMimeFor,
  MAX_PREVIEW_BYTES,
  MAX_UPLOAD_BYTES,
  WorkspaceFiles,
} from "../src/files/workspace-files";

let dir: string;
let files: WorkspaceFiles;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-files-"));
  files = new WorkspaceFiles(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceFiles", () => {
  it("写入、递归列出、读取文本并生成下载信息", async () => {
    expect((await files.list()).files).toEqual([]);

    await files.write("reports/总结.md", Buffer.from("# 标题\n\n正文内容", "utf8"));
    const listing = await files.list();
    expect(listing.truncated).toBe(false);
    expect(listing.files.map((file) => [file.path, file.kind])).toEqual([
      ["reports", "dir"],
      ["reports/总结.md", "file"],
    ]);

    const content = await files.read("reports/总结.md");
    expect(content.preview).toBe("text");
    expect(content.binary).toBe(false);
    expect(content.content).toContain("正文内容");
    expect(content.truncated).toBe(false);

    const download = await files.download("reports/总结.md");
    expect(download.name).toBe("总结.md");
    expect(download.sizeBytes).toBe(Buffer.byteLength("# 标题\n\n正文内容"));
    expect(download.inlineMime).toBe("text/plain; charset=utf-8");
  });

  it("同名文件默认拒绝，覆盖开关生效；二进制与图片只给预览类型", async () => {
    await files.write("a.txt", Buffer.from("first"));
    await expect(files.write("a.txt", Buffer.from("second"))).rejects.toMatchObject({
      status: 409,
    });
    await files.write("a.txt", Buffer.from("second"), { overwrite: true });
    expect((await files.read("a.txt")).content).toBe("second");

    await files.write("blob.bin", Buffer.from([0, 1, 2, 3]));
    const binary = await files.read("blob.bin");
    expect(binary.preview).toBe("binary");
    expect(binary.binary).toBe(true);
    expect(binary.content).toBe("");

    await files.write("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await files.read("pic.png");
    expect(image.preview).toBe("image");
    expect(image.inlineMime).toBe("image/png");
    expect(image.content).toBe("");
  });

  it("预览截断到上限，下载仍能拿到完整文件", async () => {
    const body = Buffer.alloc(MAX_PREVIEW_BYTES + 32, 0x61);
    await files.write("long.txt", body);
    const content = await files.read("long.txt");
    expect(content.truncated).toBe(true);
    expect(Buffer.byteLength(content.content)).toBe(MAX_PREVIEW_BYTES);
    expect((await files.download("long.txt")).sizeBytes).toBe(body.length);
  });

  it("拒绝越界、绝对路径、盘符、ADS 与超限文件", async () => {
    await expect(files.write("../escape.txt", Buffer.from("x"))).rejects.toMatchObject({
      status: 400,
    });
    await expect(files.read("../../state.json")).rejects.toMatchObject({ status: 400 });
    await expect(files.read("C:/Windows/win.ini")).rejects.toMatchObject({ status: 400 });
    await expect(files.write("a:b.txt", Buffer.from("x"))).rejects.toMatchObject({
      status: 400,
    });
    await expect(files.read("missing.txt")).rejects.toMatchObject({ status: 404 });
    await expect(
      files.write("big.bin", Buffer.alloc(MAX_UPLOAD_BYTES + 1)),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("新建目录：支持多级，重名/同名文件 409，非法路径 400", async () => {
    expect(await files.createDirectory("reports")).toMatchObject({
      path: "reports",
      name: "reports",
      kind: "dir",
    });
    expect(await files.createDirectory("reports/2026")).toMatchObject({ path: "reports/2026" });

    const listing = await files.list();
    expect(listing.files.map((file) => [file.path, file.kind])).toEqual([
      ["reports", "dir"],
      ["reports/2026", "dir"],
    ]);

    await expect(files.createDirectory("reports")).rejects.toMatchObject({ status: 409 });
    await files.write("notes.md", Buffer.from("x"));
    await expect(files.createDirectory("notes.md")).rejects.toMatchObject({ status: 409 });

    await expect(files.createDirectory("../escape")).rejects.toMatchObject({ status: 400 });
    await expect(files.createDirectory("C:/Windows/temp")).rejects.toMatchObject({ status: 400 });
    await expect(files.createDirectory("")).rejects.toMatchObject({ status: 400 });
  });

  it("删除文件；只允许删除空目录；不存在 404、越界 400", async () => {
    await files.write("reports/周报.md", Buffer.from("v1"));
    await files.write("keep.txt", Buffer.from("keep"));

    expect(await files.remove("reports/周报.md")).toMatchObject({
      path: "reports/周报.md",
      kind: "file",
    });
    await expect(files.read("reports/周报.md")).rejects.toMatchObject({ status: 404 });
    // 删除文件不会自动清空父目录，目录要单独删。
    expect((await files.list()).files.map((file) => file.path)).toEqual(["reports", "keep.txt"]);

    // 非空目录要拒绝，删空文件后才能删目录。
    await files.remove("keep.txt");
    expect(await files.remove("reports")).toMatchObject({ path: "reports", kind: "dir" });
    expect((await files.list()).files).toEqual([]);

    await files.write("full/a.txt", Buffer.from("a"));
    await expect(files.remove("full")).rejects.toMatchObject({ status: 409 });
    expect((await files.list()).files.map((file) => file.path)).toContain("full/a.txt");

    await expect(files.remove("nope.txt")).rejects.toMatchObject({ status: 404 });
    await expect(files.remove("../escape.txt")).rejects.toMatchObject({ status: 400 });
    await expect(files.remove("C:/Windows/win.ini")).rejects.toMatchObject({ status: 400 });
  });

  it("内联类型只放行图片、PDF 与纯文本，HTML/SVG 一律走附件", () => {
    expect(inlineMimeFor("a.PNG")).toBe("image/png");
    expect(inlineMimeFor("a.pdf")).toBe("application/pdf");
    expect(inlineMimeFor("notes.md")).toBe("text/plain; charset=utf-8");
    expect(inlineMimeFor("page.html")).toBe("text/plain; charset=utf-8");
    expect(inlineMimeFor("icon.svg")).toBeNull();
    expect(inlineMimeFor("archive.zip")).toBeNull();
  });
});

describe("文件工具", () => {
  const signal = new AbortController().signal;

  it("file_write / file_read / file_list 共用文件工作区，并提示覆盖参数", async () => {
    const tools = new Map(buildFileTools(files).map((tool) => [tool.schema.name, tool]));
    const write = tools.get("file_write");
    const read = tools.get("file_read");
    const list = tools.get("file_list");
    expect(write && read && list).toBeTruthy();

    const saved = await write!.execute(
      { path: "notes/todo.md", content: "- 调研\n- 汇总" },
      signal,
    );
    expect(saved).toContain("files/notes/todo.md");
    expect(saved).toContain("2 行");

    expect(await list!.execute({ path: "notes" }, signal)).toContain("notes/todo.md");
    expect(await read!.execute({ path: "notes/todo.md" }, signal)).toContain("调研");

    const conflict = await write!.execute(
      { path: "notes/todo.md", content: "覆盖" },
      signal,
    );
    expect(conflict).toContain("overwrite=true");
    await expect(
      write!.execute({ path: "notes/todo.md", content: "覆盖", overwrite: true }, signal),
    ).resolves.toContain("已写入");
    expect(await read!.execute({ path: "notes/todo.md" }, signal)).toContain("覆盖");
  });

  it("file_read 对二进制与图片给出下载提示", async () => {
    await files.write("blob.bin", Buffer.from([0, 1, 2]));
    await files.write("pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const read = buildFileTools(files).find((tool) => tool.schema.name === "file_read")!;
    expect(await read.execute({ path: "blob.bin" }, signal)).toContain("二进制");
    expect(await read.execute({ path: "pic.png" }, signal)).toContain("图片");
  });
});
