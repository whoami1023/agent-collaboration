import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRichPreview,
  MAX_RICH_PREVIEW_BYTES,
  richPreviewKindFor,
} from "../src/files/rich-preview";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ac-rich-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeXlsx(name: string): Promise<{ abs: string; size: number }> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("数据");
  first.addRow(["姓名", "分数", "备注"]);
  first.addRow(["张三", 95, "很长的备注".repeat(80)]);
  first.addRow(["李四", 88, null]);
  const second = workbook.addWorksheet("空表");
  second.getCell("B3").value = "偏移";

  const data = await workbook.xlsx.writeBuffer();
  const abs = join(dir, name);
  await writeFile(abs, Buffer.from(data));
  return { abs, size: (data as ArrayBuffer).byteLength };
}

async function writeXlsxTooLarge(name: string): Promise<{ abs: string; size: number }> {
  const abs = join(dir, name);
  await writeFile(abs, Buffer.from("not really a workbook"));
  return { abs, size: MAX_RICH_PREVIEW_BYTES + 1 };
}

async function writeDocx(name: string, bodyXml: string): Promise<{ abs: string; size: number }> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}<w:sectPr/></w:body>
</w:document>`,
  );
  const data = await zip.generateAsync({ type: "uint8array" });
  const abs = join(dir, name);
  await writeFile(abs, data);
  return { abs, size: data.byteLength };
}

describe("富格式预览类型判断", () => {
  it("识别 docx 与 xlsx/xlsm，其余返回 null", () => {
    expect(richPreviewKindFor("报告.DOCX")).toBe("docx");
    expect(richPreviewKindFor("a/b/table.xlsx")).toBe("sheet");
    expect(richPreviewKindFor("macro.xlsm")).toBe("sheet");
    expect(richPreviewKindFor("a.pdf")).toBeNull();
    expect(richPreviewKindFor("a.csv")).toBeNull();
    expect(richPreviewKindFor("noext")).toBeNull();
  });
});

describe("buildRichPreview", () => {
  it("解析 XLSX：多个工作表、数字与空单元格、超长单元格截断", async () => {
    const { abs, size } = await writeXlsx("数据.xlsx");
    const preview = await buildRichPreview(abs, size);
    expect(preview?.kind).toBe("sheet");
    if (preview?.kind !== "sheet") throw new Error("expected sheet");
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(["数据", "空表"]);
    expect(preview.sheets[0]!.rows[0]).toEqual(["姓名", "分数", "备注"]);
    expect(preview.sheets[0]!.rows[1]!.slice(0, 2)).toEqual(["张三", "95"]);
    expect(preview.sheets[0]!.rows[1]![2]!.length).toBeLessThanOrEqual(301);
    expect(preview.sheets[0]!.rows[1]![2]!.endsWith("…")).toBe(true);
    expect(preview.sheets[0]!.rowCount).toBe(3);
    expect(preview.sheets[0]!.columnCount).toBe(3);
    // 空表里的 B3 保留左上方空位
    expect(preview.sheets[1]!.rows[2]).toEqual(["", "偏移"]);
    expect(preview.truncated).toBe(false);
  });

  it("解析 DOCX 为 HTML 并转义文本", async () => {
    const { abs, size } = await writeDocx(
      "周报.docx",
      `<w:p><w:r><w:t>季度报告</w:t></w:r></w:p>
       <w:p><w:r><w:t>正文内容 &amp; 结论</w:t></w:r></w:p>
       <w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>`,
    );
    const preview = await buildRichPreview(abs, size);
    expect(preview?.kind).toBe("docx");
    if (preview?.kind !== "docx") throw new Error("expected docx");
    expect(preview.html).toContain("季度报告");
    expect(preview.html).toContain("正文内容 &amp; 结论");
    expect(preview.html).toContain("&lt;script&gt;");
    expect(preview.html).not.toContain("<script>");
    expect(preview.truncated).toBe(false);
  });

  it("超过大小上限、损坏文件与不支持的类型给出明确结果", async () => {
    const big = await writeXlsxTooLarge("大文件.xlsx");
    const tooLarge = await buildRichPreview(big.abs, big.size);
    expect(tooLarge).toMatchObject({ kind: "unavailable" });
    if (tooLarge?.kind === "unavailable") expect(tooLarge.message).toContain("10 MB");

    const broken = join(dir, "broken.docx");
    await writeFile(broken, Buffer.from("definitely not a zip"));
    expect(await buildRichPreview(broken, 20)).toMatchObject({ kind: "unavailable" });

    expect(await buildRichPreview(join(dir, "a.pdf"), 10)).toBeNull();
    expect(await buildRichPreview(join(dir, "a.csv"), 10)).toBeNull();
  });
});
