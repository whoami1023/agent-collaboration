/**
 * 富格式文件预览：把无法按文本直读的上传文件转成前端可渲染的结构。
 *
 * - DOCX：mammoth 转 HTML，前端再用 DOMPurify 按白名单清洗后渲染；
 *   图片不读入正文，避免 Word 里的大图变成巨型 base64。
 * - XLSX/XLSM：exceljs 读取工作表与单元格显示文本，限制工作表数、行数、
 *   列数与总单元格数，防止大表格拖垮服务端或一次返回过多数据。
 *
 * PDF 走浏览器内置查看器，CSV/TSV 在浏览器端解析，均不进入这里。
 */

import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";

export const MAX_RICH_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_SHEETS = 8;
const MAX_ROWS_PER_SHEET = 200;
const MAX_COLS_PER_SHEET = 40;
const MAX_CELLS = 4000;
const MAX_CELL_CHARS = 300;
const MAX_DOCX_HTML_CHARS = 500_000;

export interface SheetPreview {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
}

export type RichPreview =
  | { kind: "sheet"; sheets: SheetPreview[]; truncated: boolean }
  | { kind: "docx"; html: string; truncated: boolean }
  | { kind: "unavailable"; message: string };

export function richPreviewKindFor(name: string): "docx" | "sheet" | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "sheet";
  return null;
}

export async function buildRichPreview(absPath: string, sizeBytes: number): Promise<RichPreview | null> {
  const kind = richPreviewKindFor(absPath);
  if (!kind) return null;
  if (sizeBytes > MAX_RICH_PREVIEW_BYTES) {
    return {
      kind: "unavailable",
      message: `文件超过 ${MAX_RICH_PREVIEW_BYTES / 1024 / 1024} MB，无法在线预览，请下载后查看。`,
    };
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch {
    return { kind: "unavailable", message: "读取文件失败，请稍后重试。" };
  }
  try {
    return kind === "docx" ? await previewDocx(buffer) : await previewWorkbook(buffer);
  } catch {
    return { kind: "unavailable", message: "无法解析这个文件，可能已损坏或格式不受支持。" };
  }
}

async function previewDocx(buffer: Buffer): Promise<RichPreview> {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      // 不读取图片数据；空 src 的 img 会在前端清洗时被移除。
      convertImage: mammoth.images.imgElement(() => ({ src: "" })),
    },
  );
  let html = result.value;
  const truncated = html.length > MAX_DOCX_HTML_CHARS;
  if (truncated) {
    const cut = html.lastIndexOf("</", MAX_DOCX_HTML_CHARS);
    html = html.slice(0, cut > 0 ? cut : MAX_DOCX_HTML_CHARS);
  }
  return { kind: "docx", html, truncated };
}

function cellText(cell: ExcelJS.Cell): string {
  let text: string;
  try {
    text = cell.text;
  } catch {
    text = cell.value === null || cell.value === undefined ? "" : String(cell.value);
  }
  text = text.replace(/\r\n?/g, "\n").trim();
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

type ExcelLoadInput = Parameters<ExcelJS.Xlsx["load"]>[0];

async function previewWorkbook(buffer: Buffer): Promise<RichPreview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelLoadInput);
  const sheets: SheetPreview[] = [];
  let budget = MAX_CELLS;
  let truncated = false;

  for (const worksheet of workbook.worksheets) {
    if (sheets.length >= MAX_SHEETS || budget <= 0) {
      truncated = true;
      break;
    }
    const rows: string[][] = [];
    let sheetTruncated = false;
    const rowLimit = Math.min(worksheet.rowCount, MAX_ROWS_PER_SHEET);

    for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
      if (budget <= 0) {
        sheetTruncated = true;
        break;
      }
      const row = worksheet.getRow(rowNumber);
      const columnLimit = Math.min(Math.max(row.cellCount, 1), MAX_COLS_PER_SHEET);
      const values: string[] = [];
      for (let column = 1; column <= columnLimit; column += 1) {
        values.push(cellText(row.getCell(column)));
        budget -= 1;
      }
      if (columnLimit < row.cellCount) sheetTruncated = true;
      while (values.length > 0 && values[values.length - 1] === "") values.pop();
      rows.push(values);
    }

    while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
    if (rows.length < worksheet.rowCount) sheetTruncated = true;

    const columnCount =
      worksheet.columnCount ||
      rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    sheets.push({
      name: worksheet.name,
      rows,
      rowCount: worksheet.rowCount,
      columnCount,
      truncated: sheetTruncated,
    });
    if (sheetTruncated) truncated = true;
  }

  return { kind: "sheet", sheets, truncated };
}
