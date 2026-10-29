/*!
 * Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
 * MIT License, Copyright (c) OpenClaw contributors.
 * Sources: ui/src/components/markdown.ts (limits + LRU + plain-text fallback),
 * markdown-parser.ts (engine options, hand-added task-list rule, autolink rules),
 * markdown-tokens.ts (build elements from an allowlist instead of string HTML),
 * markdown-sanitizer.ts (tag/attribute allowlist), markdown-assistant-transcript.ts
 * (remote images collapsed to label + Open link), markdown-code-blocks.ts (fence handling).
 * Adaptations: markdown-it runs with `html:false` and we build React elements from the token
 * tree, so raw HTML is escaped by construction and a DOMPurify pass is unnecessary — the
 * element set below *is* our sanitiser surface. OpenClaw's settled-prefix streaming cache is
 * not re-implemented: we re-render each append from a memoised token tree, which is cheap at
 * chat message sizes. No syntax highlighting (OpenClaw lazy-loads highlight.js + a worker).
 */
import { Fragment, createElement, useMemo } from "react";
import type { ReactNode } from "react";
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import CodeBlock from "./CodeBlock";
import { isBlockArtText, normalizeLineBreaks, stripAssistantScaffolding } from "./scaffolding";
import { safeImage, safeLink } from "./links";

/** 与 OpenClaw 相同的两级上限：超过 40k 字符不再解析，超过 140k 截断为纯文本。 */
export const MARKDOWN_PARSE_LIMIT = 40_000;
export const MARKDOWN_CHAR_LIMIT = 140_000;

// breaks:true → softbreak 渲染成 <br>，和 OpenClaw 的聊天排版一致。
const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
md.enable("strikethrough");

interface TreeNode {
  token: Token;
  children: TreeNode[];
}

/** markdown-it 的扁平 token 流靠 *_open / *_close 配对，先还原成树再映射成元素。 */
export function buildTokenTree(tokens: readonly Token[]): TreeNode[] {
  const root: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const token of tokens) {
    if (token.type.endsWith("_close")) {
      stack.pop();
      continue;
    }
    const node: TreeNode = { token, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root.push(node);
    if (token.type.endsWith("_open")) stack.push(node);
  }
  return root;
}

const TASK_MARKER_RE = /^\[([ xX])\]\s+/;

function firstTextToken(node: TreeNode | undefined): Token | undefined {
  const inline = node?.children.find((child) => child.token.type === "inline");
  return inline?.token.children?.find((child) => child.type === "text");
}

function taskOf(node: TreeNode): { checked: boolean; paragraph?: TreeNode; marker?: Token } | null {
  const paragraph = node.children.find((child) => child.token.type === "paragraph_open");
  const marker = firstTextToken(paragraph);
  if (!marker) return null;
  const match = TASK_MARKER_RE.exec(marker.content);
  if (!match) return null;
  return { checked: match[1] !== " ", paragraph, marker };
}

function inlineNodes(token: Token): TreeNode[] {
  return token.children ? buildTokenTree(token.children) : [];
}

function renderLink(node: TreeNode, key: string): ReactNode {
  const href = attrText(node.token, "href");
  const title = node.token.attrGet("title") ?? undefined;
  const label = node.token.children?.map((child) => child.content).join("").trim() ?? "";
  const children = renderList(inlineChildren(node));
  const safe = safeLink(href, label);
  if (safe.kind === "label") {
    return createElement("span", { className: "markdown-link-label", title, key }, children);
  }
  return createElement(
    "a",
    {
      href: safe.href,
      title,
      key,
      className: "markdown-link",
      ...(safe.external ? { target: "_blank", rel: "noreferrer noopener" } : {}),
    },
    children,
  );
}

function inlineChildren(node: TreeNode): TreeNode[] {
  return node.token.children ? buildTokenTree(node.token.children) : node.children;
}

/** markdown-it 的 attrs 允许数字（如 start），取字符串属性时统一转文本。 */
function attrText(token: Token, name: string): string {
  const value = token.attrGet(name);
  return value === null || value === undefined ? "" : String(value);
}

function imageAlt(node: TreeNode): string {
  const declared = node.token.attrGet("alt");
  // markdown-it 只在渲染字符串 HTML 时把子节点文本回填进 alt 属性；我们自建元素时
  // 空串要回退到子节点文本，否则 ![截图](url) 会丢掉「截图」。
  if (declared) return String(declared);
  return inlineChildren(node).map((child) => child.token.content).join("");
}

function renderImage(node: TreeNode, key: string): ReactNode {
  const src = attrText(node.token, "src");
  const alt = imageAlt(node);
  const image = safeImage(src);
  if (image?.kind === "inline") {
    return createElement("img", { className: "markdown-inline-image", src: image.src, alt, loading: "lazy", key });
  }
  if (image?.kind === "external") {
    return createElement(
      "span",
      { className: "markdown-external-image", key },
      createElement("span", { className: "markdown-external-image-label" }, `图片 · ${alt || "未命名"}`),
      createElement(
        "a",
        { className: "markdown-external-image-link", href: image.href, target: "_blank", rel: "noreferrer noopener" },
        "打开",
      ),
    );
  }
  return createElement("span", { className: "markdown-external-image", key }, alt || src);
}

function renderNode(node: TreeNode, index: number): ReactNode {
  const token = node.token;
  const key = `${index}-${token.level ?? 0}-${token.type}`;
  const kids = inlineChildren(node);

  switch (token.type) {
    case "text":
      return token.children?.length ? renderList(kids) : token.content;
    case "code_inline":
      return createElement("code", { className: "inline-code", key }, token.content);
    case "softbreak":
    case "hardbreak":
      return createElement("br", { key });
    case "hr":
      return createElement("hr", { key });
    case "fence":
      return createElement(CodeBlock, { key, code: token.content, lang: token.info.trim().split(/\s+/)[0] ?? "" });
    case "code_block":
      return createElement(CodeBlock, { key, code: token.content, lang: "" });
    case "html_block":
    case "html_inline":
      // html:false 已把原文转义；这里仍然只作为可见文本呈现，绝不产出元素。
      return createElement("span", { className: "markdown-escaped-html", key }, token.content);
    case "image":
      return renderImage(node, key);
    default:
      break;
  }

  if (token.type === "inline") return renderList(kids);
  if (token.type === "link_open") return renderLink(node, key);
  if (!token.tag || !token.type.endsWith("_open")) return null;

  const tag = token.tag;
  if (tag === "li") {
    const task = taskOf(node);
    if (task?.paragraph) {
      const rest = task.marker!.content.slice(TASK_MARKER_RE.exec(task.marker!.content)![0].length);
      return createElement(
        "li",
        { className: "task-list-item", key },
        createElement("input", { className: "task-list-item-checkbox", type: "checkbox", checked: task.checked, disabled: true }),
        createElement("p", null, rest, ...renderList(inlineChildren(task.paragraph).slice(1))),
        ...renderList(node.children.filter((child) => child !== task.paragraph)),
      );
    }
  }

  const attrs: Record<string, unknown> = {};
  if (tag === "ol") {
    // markdown-it 只在起始编号不是 1 时才写 start 属性；
    // 把缺失属性当成 0 会让浏览器从 0 开始编号。
    const raw = token.attrGet("start");
    const start = raw === null || raw === undefined ? Number.NaN : Number(raw);
    if (Number.isFinite(start) && start !== 1) attrs.start = start;
  }
  if (tag === "blockquote") attrs.className = "markdown-quote";
  const body = renderList(node.children);
  const element = createElement(tag, { ...attrs, key }, body);
  if (tag !== "table") return element;
  return createElement("div", { className: "markdown-table-viewport", key }, createElement("table", attrs, body));
}

function renderList(nodes: readonly TreeNode[]): ReactNode[] {
  const rendered: ReactNode[] = [];
  nodes.forEach((node, index) => {
    const element = renderNode(node, index);
    if (element !== null && element !== undefined) rendered.push(element);
  });
  return rendered;
}

function renderText(text: string): ReactNode[] {
  return renderList(buildTokenTree(md.parse(normalizeLineBreaks(text), {})));
}

const CACHE_LIMIT = 200;
const cache = new Map<string, ReactNode[]>();

function cachedRender(text: string): ReactNode[] {
  const hit = cache.get(text);
  if (hit) {
    // Map 保持插入顺序，命中后移到队尾即得到 LRU。
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const nodes = renderText(text);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(text, nodes);
  return nodes;
}

/** 只有确实带 Markdown 结构的正文才显示「原文」切换，纯文本气泡保持简洁。 */
export function hasMarkdownStructure(text: string): boolean {
  if (!text) return false;
  return /```|^\s{0,3}#{1,6}\s|^\s*[-*+]\s+\S|^\s*\d+\.\s+\S|^\s*>\s|^\s*\[[ xX]\]\s|\|.{1,}\||\[[^\]\n]+\]\([^)\n]+\)|`[^`\n]+`|\*\*[\s\S]+?\*\*|\*[^*\n]+\*|\b_{1,2}/.test(
    normalizeLineBreaks(text),
  );
}

/**
 * 去掉脚手架后的可见正文。判断是否需要 Markdown 预览必须用它：
 * 否则「整段都是 invoke 块」这类消息会被当成纯文本，把内部标签原样显示出来。
 */
export function visibleMessageText(text: string): string {
  return stripAssistantScaffolding(text);
}

export default function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }) {
  const visible = useMemo(() => stripAssistantScaffolding(text, { streaming }), [text, streaming]);

  if (!visible.trim()) return createElement("span", { className: "markdown-empty" }, "…");
  if (isBlockArtText(visible)) {
    return createElement("div", { className: "chat-text" }, createElement(CodeBlock, { code: visible, lang: "block-art" }));
  }
  if (visible.length > MARKDOWN_CHAR_LIMIT) {
    return createElement(
      "div",
      { className: "chat-text markdown-plain-text-fallback" },
      `${visible.slice(0, MARKDOWN_CHAR_LIMIT)}…（内容过长，已停止渲染）`,
    );
  }
  if (visible.length > MARKDOWN_PARSE_LIMIT) {
    return createElement("div", { className: "chat-text markdown-plain-text-fallback" }, visible);
  }
  return createElement("div", { className: "chat-text" }, cachedRender(visible));
}
