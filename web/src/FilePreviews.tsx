import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import type { WorkspaceRichPreview, WorkspaceSheetPreview } from "./api";
import { CSV_MAX_COLS, CSV_MAX_ROWS, parseCsv } from "./files/csv";

const DOCX_ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];
const DOCX_ALLOWED_ATTR = ["href", "title", "colspan", "rowspan"];

/** 首行作为表头；行号列显示原始行号，方便和 Excel 对照。 */
function TableGrid({ rows }: { rows: string[][] }) {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const [header = [], ...body] = rows;
  return (
    <div className="workspace-preview-table-wrap">
      <table className="workspace-preview-table">
        <thead>
          <tr>
            <th className="workspace-preview-rownum">#</th>
            {Array.from({ length: width }, (_, index) => (
              <th key={index}>{header[index] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="workspace-preview-rownum">{rowIndex + 2}</td>
              {Array.from({ length: width }, (_, index) => (
                <td key={index}>{row[index] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CsvPreview({ text, tabSeparated }: { text: string; tabSeparated: boolean }) {
  const table = useMemo(
    () => parseCsv(text, tabSeparated ? { delimiter: "\t" } : {}),
    [text, tabSeparated],
  );
  if (table.rows.length === 0) {
    return <p className="files-empty">（空文件）</p>;
  }
  const width = table.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return (
    <div className="workspace-preview-rich">
      <TableGrid rows={table.rows} />
      <p className="workspace-preview-table-note">
        共 {table.totalRows} 行 × {width} 列
        {table.truncated ? `，仅显示前 ${CSV_MAX_ROWS} 行 / ${CSV_MAX_COLS} 列` : ""}
      </p>
    </div>
  );
}

export function SheetPreview({
  sheets,
  truncated,
}: {
  sheets: WorkspaceSheetPreview[];
  truncated: boolean;
}) {
  const [selected, setSelected] = useState(0);
  if (sheets.length === 0) {
    return <p className="files-empty">这个工作簿没有工作表。</p>;
  }
  const active = sheets[Math.min(selected, sheets.length - 1)]!;
  return (
    <div className="workspace-preview-rich">
      {sheets.length > 1 && (
        <div className="workspace-preview-sheet-tabs" role="tablist" aria-label="工作表">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={index === Math.min(selected, sheets.length - 1)}
              className={`workspace-preview-sheet-tab${index === Math.min(selected, sheets.length - 1) ? " active" : ""}`}
              onClick={() => setSelected(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      {active.rows.length > 0 ? (
        <TableGrid rows={active.rows} />
      ) : (
        <p className="files-empty">这个工作表没有内容。</p>
      )}
      <p className="workspace-preview-table-note">
        {active.name}：共 {active.rowCount} 行 × {active.columnCount} 列
        {active.truncated ? "，仅显示开头部分" : ""}
        {truncated ? "；工作表较多，只解析了前几个" : ""}
      </p>
    </div>
  );
}

export function DocxPreview({ html, truncated }: { html: string; truncated: boolean }) {
  const clean = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: DOCX_ALLOWED_TAGS,
        ALLOWED_ATTR: DOCX_ALLOWED_ATTR,
      }),
    [html],
  );
  if (!clean.trim()) {
    return <p className="files-empty">文档没有可显示的正文。</p>;
  }
  return (
    <div className="workspace-preview-rich">
      <div
        className="workspace-preview-docx chat-text"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
      {truncated ? <p className="workspace-preview-table-note">文档较长，仅显示开头部分。</p> : null}
    </div>
  );
}

export function RichPreviewBody({
  preview,
  downloadUrl,
}: {
  preview: WorkspaceRichPreview;
  downloadUrl: string;
}) {
  if (preview.kind === "sheet") {
    return <SheetPreview sheets={preview.sheets} truncated={preview.truncated} />;
  }
  if (preview.kind === "docx") {
    return <DocxPreview html={preview.html} truncated={preview.truncated} />;
  }
  return (
    <div className="workspace-preview-body">
      <p className="files-empty">{preview.message}</p>
      <a className="btn" href={downloadUrl} download>
        下载文件
      </a>
    </div>
  );
}
