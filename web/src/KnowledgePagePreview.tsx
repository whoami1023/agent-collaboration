import type { MouseEvent } from "react";
import MarkdownText from "./markdown/MarkdownText";

/** 去掉页面开头的 YAML frontmatter，预览只显示正文。 */
export function stripFrontmatter(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return text;
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/**
 * `[[目标]]` / `[[目标|显示名]]` → Markdown 链接，指向 `#wiki:<urlencoded 目标>`。
 * 预览容器统一拦截这类 href，再交给面板打开对应页面。
 */
export function wikilinksToMarkdown(body: string): string {
  return body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (whole, target: string, label?: string) => {
    const clean = target.trim();
    if (!clean) return whole;
    const text = (label ?? target).trim().replace(/[[\]]/g, "");
    return `[${text}](#wiki:${encodeURIComponent(clean)})`;
  });
}

export default function KnowledgePagePreview({
  raw,
  onOpen,
}: {
  raw: string;
  onOpen(path: string): void;
}) {
  const body = bodyText(raw);
  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    const anchor = (event.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href") ?? "";
    if (!href.startsWith("#wiki:")) return;
    event.preventDefault();
    const target = decodeURIComponent(href.slice("#wiki:".length));
    if (target) onOpen(target);
  }
  return (
    <div className="knowledge-preview" onClick={handleClick}>
      <MarkdownText text={body} variant="document" />
    </div>
  );
}

function bodyText(raw: string): string {
  return wikilinksToMarkdown(stripFrontmatter(raw).trim());
}
