import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { htmlToText } from "../web/html";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".csv",
  ".tsv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
]);

export const FOLDER_IMPORT_LIMITS = { maxFiles: 20, maxBytes: 2 * 1024 * 1024 } as const;

export interface ExtractedText {
  text: string;
  format: string;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const rich = value as { richText?: Array<{ text?: string }>; text?: string; result?: unknown };
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text ?? "").join("");
    if (typeof rich.text === "string") return rich.text;
    if (rich.result !== undefined) return String(rich.result);
  }
  return "";
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

async function extractWorkbook(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sections: string[] = [];
  workbook.eachSheet((sheet) => {
    if (sections.length >= 5) return;
    sections.push(`## 工作表：${sheet.name}`);
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 200) return;
      const values = (row.values as ExcelJS.CellValue[]).slice(1, 13).map(cellText);
      if (values.every((value) => !value)) return;
      rows.push(`| ${values.map((value) => value.replace(/\|/g, "\\|")).join(" | ")} |`);
    });
    if (rows.length > 0) {
      sections.push("", rows[0]!.replace(/[^|]/g, "-"), ...rows.slice(1));
    }
  });
  return sections.join("\n").trim();
}

/**
 * 从文件工作区里的文件抽取可摄入正文：文本类直接读，DOCX 用 mammoth，
 * XLSX/XLSM 用 ExcelJS 转 Markdown 表格，PDF 用 unpdf 抽文本层。
 */
export async function extractTextFromFile(absPath: string): Promise<ExtractedText | { error: string }> {
  const ext = extname(absPath).toLowerCase();
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      const raw = await readFile(absPath, "utf8");
      return { text: raw.trim(), format: ext.slice(1) };
    }
    if (ext === ".html" || ext === ".htm") {
      const raw = await readFile(absPath, "utf8");
      return { text: htmlToText(raw).trim(), format: "html" };
    }
    if (ext === ".docx") {
      const buffer = await readFile(absPath);
      return { text: await extractDocx(buffer), format: "docx" };
    }
    if (ext === ".xlsx" || ext === ".xlsm") {
      const buffer = await readFile(absPath);
      return { text: await extractWorkbook(buffer), format: "xlsx" };
    }
    if (ext === ".pdf") {
      const buffer = await readFile(absPath);
      const { extractText, getDocumentProxy } = await import("unpdf");
      const document = await getDocumentProxy(new Uint8Array(buffer));
      const result = await extractText(document, { mergePages: true });
      const text = String(result.text ?? "").trim();
      if (!text) {
        return { error: "PDF 没有可提取的文本层（可能是扫描件），请先 OCR 或转成文本" };
      }
      return { text, format: "pdf" };
    }
    return { error: `不支持的文件类型：${ext || "（无扩展名）"}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
