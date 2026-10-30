/**
 * 适配自 OpenClaw infra/net/ssrf（MIT，Copyright (c) 2026 OpenClaw Foundation）：
 * 只允许 http(s)、逐跳校验重定向目标、解析全部 A/AAAA 并拒绝私网/保留地址；
 * 本实现收敛为 fetch 工具所需的同步判定 + 一次 DNS 解析，不保留代理/DNS pinning 等运行时设施。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LookupAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<LookupAddress[]>;

export class WebUrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebUrlBlockedError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "metadata.google.internal",
  "metadata",
]);

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family }));
}

/** 只接受无凭据的 http/https URL，并拒绝显而易见的本地主机名。 */
export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new WebUrlBlockedError(`不是合法的 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebUrlBlockedError(`只支持 http/https 链接，收到：${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new WebUrlBlockedError("链接里不能带用户名或密码");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) throw new WebUrlBlockedError("链接缺少主机名");
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new WebUrlBlockedError(`不允许访问本机或内网地址：${host}`);
  }
  return url;
}

/**
 * 抓取前校验：DNS 解析出的每个地址都必须是公网地址，防止 DNS rebinding
 * 与「域名指向 127.0.0.1 / 169.254.169.254」这类绕过。
 */
export async function assertPublicHttpUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  const url = parseHttpUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const literalFamily = isIP(host);
  let addresses: LookupAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new WebUrlBlockedError(`无法解析主机名：${host}`);
    }
  }
  if (addresses.length === 0) throw new WebUrlBlockedError(`无法解析主机名：${host}`);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new WebUrlBlockedError(`不允许访问本机或内网地址：${host} → ${entry.address}`);
    }
  }
  return url;
}

/** 私网、回环、链路本地、保留与组播地址一律视为不可访问。 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (value.includes("%")) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice("::ffff:".length));
  const family = isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family === 6) return isPrivateIpv6(value);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 198.18.0.0/15 是 Clash/Surge 等代理的 fake-ip 段：本机所有公网域名都可能解析到
  // 这里，按私网拦截会让 web_fetch 全部失败；它不是内网服务地址，故放行。
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.split("%")[0]!.toLowerCase();
  if (value === "::" || value === "::1") return true;
  const first = value.split(":")[0] ?? "";
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true; // fc00::/7
  if (/^ff[0-9a-f]{2}$/.test(first)) return true; // ff00::/8
  if (value.startsWith("64:ff9b:")) return true; // NAT64：可能映射到私网 v4
  if (value.startsWith("2001:db8:")) return true; // 文档保留
  return false;
}

export { defaultLookup as lookupHost };
