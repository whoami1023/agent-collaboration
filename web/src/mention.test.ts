import { describe, expect, it } from "vitest";
import { readMentionQuery } from "./mention";

describe("@成员补全的输入判定", () => {
  it("开头或空白后的 @ 会弹出成员列表，查询词取 @ 之后", () => {
    expect(readMentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    expect(readMentionQuery("@调", 2)).toEqual({ query: "调", start: 0 });
    expect(readMentionQuery("你好 @研", 5)).toEqual({ query: "研", start: 3 });
  });

  it("邮箱、行中与已被空白隔断的 @ 不触发", () => {
    expect(readMentionQuery("a@b", 3)).toBeNull();
    expect(readMentionQuery("@研究员 继续", 7)).toBeNull();
    expect(readMentionQuery("没有艾特", 4)).toBeNull();
  });

  it("只看光标前的片段：光标在 @ 前不弹，在 @ 后只取已输入部分", () => {
    expect(readMentionQuery("@研究员 继续", 1)).toEqual({ query: "", start: 0 });
    expect(readMentionQuery("@研究员 继续", 0)).toBeNull();
    expect(readMentionQuery("prefix @主", 9)).toEqual({ query: "主", start: 7 });
  });

  it("换行也是边界；更近的 @ 覆盖前面的", () => {
    expect(readMentionQuery("第一行\n@研", 6)).toEqual({ query: "研", start: 4 });
    expect(readMentionQuery("@a @b", 5)).toEqual({ query: "b", start: 3 });
  });
});
