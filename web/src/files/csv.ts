/** 轻量 CSV/TSV 解析：支持引号包裹、转义引号与字段内换行，带行/列上限。 */

export interface CsvTable {
  rows: string[][];
  delimiter: "," | "\t" | ";";
  totalRows: number;
  truncated: boolean;
}

export const CSV_MAX_ROWS = 300;
export const CSV_MAX_COLS = 50;

const DELIMITERS = [",", "\t", ";"] as const;

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

/** 按首行在引号外的分隔符数量选一个；并列时优先逗号。 */
export function detectDelimiter(text: string): "," | "\t" | ";" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best: "," | "\t" | ";" = ",";
  let bestCount = -1;
  for (const delimiter of DELIMITERS) {
    const count = countOutsideQuotes(firstLine, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(
  text: string,
  options: { delimiter?: "," | "\t" | ";" | undefined; maxRows?: number; maxCols?: number } = {},
): CsvTable {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(source);
  const maxRows = Math.max(1, options.maxRows ?? CSV_MAX_ROWS);
  const maxCols = Math.max(1, options.maxCols ?? CSV_MAX_COLS);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let totalRows = 0;
  let truncated = false;

  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else truncated = true;
    field = "";
  };
  const endRow = () => {
    endField();
    if (rows.length < maxRows) rows.push(row);
    else truncated = true;
    totalRows += 1;
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      endRow();
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) endRow();

  for (const line of rows) {
    while (line.length > 0 && line[line.length - 1] === "") line.pop();
  }
  return { rows, delimiter, totalRows, truncated };
}
