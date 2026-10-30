import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "./csv";

describe("CSV 解析", () => {
  it("解析逗号分隔、引号内的逗号/换行与转义引号", () => {
    const table = parseCsv('姓名,备注\n张三,"第一行,\n第二行"\n李四,"他说""你好"""');
    expect(table.delimiter).toBe(",");
    expect(table.rows).toEqual([
      ["姓名", "备注"],
      ["张三", "第一行,\n第二行"],
      ["李四", '他说"你好"'],
    ]);
    expect(table.totalRows).toBe(3);
    expect(table.truncated).toBe(false);
  });

  it("识别制表符与分号分隔，并去掉 BOM", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(parseCsv("a;b\n1;2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);

    const withBom = parseCsv("\ufeffname,age\n张三,20");
    expect(withBom.rows[0]).toEqual(["name", "age"]);
  });

  it("兼容 CRLF 并裁掉行尾空单元格", () => {
    const table = parseCsv("a,b,,\r\n1,2,,\r\n");
    expect(table.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(table.totalRows).toBe(2);
  });

  it("超过行/列上限时截断并标记", () => {
    const csv = "a,b,c\n" + Array.from({ length: 5 }, (_, i) => `${i},${i},${i}`).join("\n");
    const limited = parseCsv(csv, { maxRows: 2, maxCols: 2 });
    expect(limited.rows).toEqual([
      ["a", "b"],
      ["0", "0"],
    ]);
    expect(limited.totalRows).toBe(6);
    expect(limited.truncated).toBe(true);
  });

  it("空文本返回空表格", () => {
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("a,b\n").rows).toEqual([["a", "b"]]);
  });
});
