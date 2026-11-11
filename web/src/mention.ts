/**
 * @成员补全的输入判定：只看光标前的最后一段 `@查询`。
 * 抽成纯函数是为了把「什么时候弹、弹什么词、从哪个位置替换」固定在测试里。
 */
export interface MentionQuery {
  /** @ 后面的查询词，可能为空（刚输入 @）。 */
  query: string;
  /** @ 在整段文本里的下标，补全时从这里替换。 */
  start: number;
}

export function readMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|[\s])@([^\s@]*)$/u.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { query, start: before.length - query.length - 1 };
}
