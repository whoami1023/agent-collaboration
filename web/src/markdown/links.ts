/*!
 * Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
 * MIT License, Copyright (c) OpenClaw contributors.
 * Source: ui/src/components/markdown-parser.ts (`disallowed-link-scheme`, link target rules)
 * and ui/src/components/markdown.ts (decorateMarkdownAnchor: URL.parse re-check, rel/target).
 * Adaptation: we render markdown-it tokens into React elements (no innerHTML), so the
 * DOMPurify pass is replaced by this scheme allowlist at the point where href/src is emitted.
 */

/** OpenClaw 的消息模式只放行 http/https/mailto；其余 scheme 一律降级为纯文本标签。 */
const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ALLOWED_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const TRUSTED_INLINE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

export type SafeLink =
  | { kind: "link"; href: string; external: boolean }
  | { kind: "label"; text: string };

function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

export function safeLink(raw: string, label: string): SafeLink {
  const url = parseUrl(raw);
  // 解析失败的相对链接照旧放行：我们只服务同源页面，没有可跳转的相对路径目标。
  if (!url) return { kind: "link", href: raw, external: false };
  if (!ALLOWED_LINK_PROTOCOLS.has(url.protocol)) {
    return { kind: "label", text: label || raw };
  }
  return { kind: "link", href: url.href, external: true };
}

export type InlineImage = { kind: "inline"; src: string } | { kind: "external"; href: string };

/** 远程图片不自动加载（隐私/内网考虑），只有 base64 位图才内联，和 OpenClaw 的 remoteImages=false 一致。 */
export function safeImage(raw: string): InlineImage | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (url.protocol === "data:" || url.protocol === "data") {
    return TRUSTED_INLINE_IMAGE.test(url.href) ? { kind: "inline", src: url.href } : null;
  }
  return ALLOWED_IMAGE_PROTOCOLS.has(url.protocol) ? { kind: "external", href: url.href } : null;
}
