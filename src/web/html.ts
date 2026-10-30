/**
 * 正文抽取：思路参考 OpenClaw agents/tools/web-fetch-utils（MIT）——
 * 先剔除脚本/样式/隐藏结构，再把块级标签映射成换行与标题/列表，最后解码实体；
 * 这里用受控的正则实现，保证输出有界、可审计，不引入完整 HTML 解析器。
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  times: "×",
  divide: "÷",
  deg: "°",
  laquo: "«",
  raquo: "»",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function readHtmlAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(attrs);
  if (!match) return undefined;
  return decodeEntities((match[1] ?? match[2] ?? match[3] ?? "").trim());
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function cleanInline(value: string): string {
  return decodeEntities(stripTags(value)).replace(/\s+/g, " ").trim();
}

function resolveLink(raw: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function extractTitle(html: string): string | undefined {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const fromTitle = title ? cleanInline(title) : "";
  if (fromTitle) return fromTitle;
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const fromHeading = heading ? cleanInline(heading) : "";
  return fromHeading || undefined;
}

const PRE_PLACEHOLDER = "\u0000PRE";

export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let source = html;
  source = source.replace(/<!--[\s\S]*?-->/g, "");
  source = source.replace(
    /<(script|style|noscript|template|svg|iframe|object|embed|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  source = source.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");

  const preBlocks: string[] = [];
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const text = decodeEntities(stripTags(inner)).replace(/\u00a0/g, " ").replace(/^\n+|\n+$/g, "");
    preBlocks.push(`\`\`\`\n${text}\n\`\`\``);
    return `\n${PRE_PLACEHOLDER}${preBlocks.length - 1}\n`;
  });

  source = source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) => {
    const text = cleanInline(inner);
    const href = resolveLink(readHtmlAttribute(attrs, "href"), baseUrl);
    if (!href) return text;
    if (!text) return href;
    if (text === href) return href;
    return `[${text}](${href})`;
  });

  source = source.replace(/<img\b([^>]*?)\/?>/gi, (_match, attrs: string) => {
    const alt = readHtmlAttribute(attrs, "alt") ?? "";
    const src = resolveLink(readHtmlAttribute(attrs, "src"), baseUrl);
    if (!src) return alt ? alt : "";
    return alt ? `![${alt}](${src})` : `![](${src})`;
  });

  source = source.replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n\n${"#".repeat(Number(level))} `);
  source = source.replace(/<\/h[1-6]>/gi, "\n\n");
  source = source.replace(/<li\b[^>]*>/gi, "\n- ");
  source = source.replace(/<br\s*\/?>/gi, "\n");
  source = source.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
  source = source.replace(/<\/t[dh]>/gi, " | ");
  source = source.replace(
    /<\/(p|div|section|article|header|footer|main|aside|nav|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|figure|figcaption|form|fieldset|details|summary|address|pre)>/gi,
    "\n\n",
  );
  source = source.replace(/<(p|div|section|article|blockquote|figure|figcaption)\b[^>]*>/gi, "\n\n");
  source = source.replace(
    /<\/?(?:span|strong|b|em|i|u|s|small|big|mark|sub|sup|font|abbr|time|code|kbd|samp|var|label|input|button|select|option|textarea)\b[^>]*>/gi,
    "",
  );
  source = source.replace(/<[^>]+>/g, "");
  source = decodeEntities(source);
  source = source.replace(/\r\n?/g, "\n");
  source = source
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n");
  source = source.replace(/\n{3,}/g, "\n\n");

  // 代码块在空白归一化之后再还原，避免把缩进和空行吃掉。
  source = source.replace(new RegExp(`${PRE_PLACEHOLDER}(\\d+)`, "g"), (_match, index: string) => {
    return preBlocks[Number(index)] ?? "";
  });
  return source.trim();
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripHtmlNoise(value: string): string {
  return htmlToText(value);
}
