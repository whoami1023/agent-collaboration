/**
 * 工具输出与外部文本里的密钥掩码。
 *
 * 移植自 Hermes `agent/redact.py` 的两条核心判断：
 * 1) 掩码必须**不可复用**。他们出过事故：`sk-prod…7890` 这种「首尾保留」的掩码看起来像
 *    截断的真密钥，被智能体当成可用值写回配置，把密钥本身毁掉了。所以这里只保留
 *    家族前缀与原长度，绝不保留尾部字符。
 * 2) 误报是一等问题。`Secretary:`、`tokenizer:`、`KEYBOARD=` 都曾被当成密钥赋值。
 *    所以每条规则前面有一层廉价子串门控（顺带保证线性时间，避免二次回溯），
 *    命中后还要过占位符/程序化取值的排除。
 */

/** 只保留前缀与长度：`«已脱敏：疑似 OpenAI/DeepSeek 密钥（原 51 位）»`。 */
function sentinel(family: string, length: number): string {
  return `«已脱敏：疑似${family}（原 ${length} 位）»`;
}

interface SecretRule {
  id: string;
  family: string;
  /** 廉价子串门控：任一出现才跑正则。空数组表示不门控。 */
  prefixes: string[];
  re: RegExp;
  /** 命中值里要掩掉的部分在哪个捕获组（默认整段）。 */
  group?: number;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: "anthropic-key",
    family: "Anthropic 密钥",
    prefixes: ["sk-ant-"],
    re: /sk-ant-[A-Za-z0-9_\-]{16,}/g,
  },
  {
    id: "openai-key",
    family: "OpenAI/DeepSeek 系密钥",
    prefixes: ["sk-"],
    re: /\bsk-[A-Za-z0-9_\-]{16,}/g,
  },
  {
    id: "stripe-live",
    family: "Stripe live 密钥",
    prefixes: ["sk_live_", "pk_live_"],
    re: /\b[sp]k_live_[A-Za-z0-9]{12,}/g,
  },
  {
    id: "github-token",
    family: "GitHub 令牌",
    prefixes: ["ghp_", "gho_", "ghs_", "github_pat_"],
    re: /\b(?:gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  {
    id: "slack-token",
    family: "Slack 令牌",
    prefixes: ["xox"],
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: "gitlab-token",
    family: "GitLab 个人令牌",
    prefixes: ["glpat-"],
    re: /\bglpat-[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: "aws-access-key",
    family: "AWS 访问密钥 ID",
    prefixes: ["AKIA", "ASIA"],
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "google-api-key",
    family: "Google API 密钥",
    prefixes: ["AIza"],
    re: /\bAIza[0-9A-Za-z_\-]{30,}\b/g,
  },
  {
    id: "jwt",
    family: "JWT",
    prefixes: ["eyJ"],
    re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
  },
  {
    id: "private-key-block",
    family: "PEM 私钥",
    prefixes: ["-----begin"],
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
  },
  {
    id: "bearer-header",
    family: "Bearer 凭据",
    prefixes: ["bearer "],
    re: /\bBearer\s+[A-Za-z0-9._~+/=\-]{20,}/gi,
    group: 0,
  },
  {
    id: "url-credentials",
    family: "URL 内嵌账号密码",
    prefixes: ["://"],
    re: /\b([a-z][a-z0-9+.-]*):\/\/([^/\s:@"']{1,64}):([^/\s@"]{3,})@/gi,
    group: 3,
  },
  {
    id: "assignment",
    family: "密钥赋值",
    prefixes: [":", "="],
    re: /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token|password|passwd|pwd|token|secret)\b(\s*[:=]\s*)["']?([A-Za-z0-9._~+/=\-]{16,})["']?/gi,
    group: 3,
  },
];

/** 看起来就是占位符/示例，不是真凭据。 */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (/^[<{[]/.test(v) || /[>\]}]$/.test(v)) return true;
  if (/^\*+$/.test(v) || /^x{8,}$/i.test(v) || /^0{8,}$/.test(v)) return true;
  if (/\$\{[^}]+\}|%[a-z_]+%/i.test(v)) return true;
  return /(your|example|sample|placeholder|dummy|changeme|insert|replace|<|\.\.\.|…)/i.test(v);
}

/** 程序化取值语句（os.getenv("X") / process.env.X / $env:X）里的名字不是密钥本体。 */
function isProgrammaticLookup(source: string, index: number): boolean {
  const before = source.slice(Math.max(0, index - 40), index);
  return /(?:getenv|environ|process\.env|env\[|Env:|System\.getenv)\s*[(".[]?$/i.test(before);
}

/** 词边界：`SECRETKEY`、`tokenizer`、`KEYBOARD` 不该触发 `secret`/`key` 赋值规则。 */
function isWordStart(source: string, index: number): boolean {
  const prev = index > 0 ? source[index - 1] : "";
  return prev === "" || !/[A-Za-z0-9]/.test(prev);
}

export interface RedactResult {
  text: string;
  /** 掩掉的条目数，用于给模型留一句「本结果里已掩掉 N 处疑似密钥」。 */
  replaced: number;
  families: string[];
}

export function redactSecrets(input: string): RedactResult {
  if (!input || input.length < 12) return { text: input, replaced: 0, families: [] };
  const lower = input.toLowerCase();
  let text = input;
  let replaced = 0;
  const families: string[] = [];
  for (const rule of SECRET_RULES) {
    if (rule.prefixes.length > 0 && !rule.prefixes.some((prefix) => lower.includes(prefix))) {
      continue;
    }
    rule.re.lastIndex = 0;
    const ranges: { start: number; end: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = rule.re.exec(input)) !== null) {
      const group = rule.group ?? 0;
      const value = match[group] ?? match[0];
      if (!value) {
        if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
        continue;
      }
      const start = match.index + (match[0].indexOf(value) < 0 ? 0 : match[0].indexOf(value));
      if (isPlaceholder(value) || isProgrammaticLookup(input, start) || !isWordStart(input, match.index)) {
        if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
        continue;
      }
      ranges.push({ start, end: start + value.length });
      if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
    if (ranges.length === 0) continue;
    for (const range of [...ranges].reverse()) {
      const original = text.slice(range.start, range.end);
      text = `${text.slice(0, range.start)}${sentinel(rule.family, original.length)}${text.slice(range.end)}`;
      replaced += 1;
      if (!families.includes(rule.family)) families.push(rule.family);
    }
  }
  return { text, replaced, families };
}

/**
 * 给人看的命令行脱敏：不可见字符与格式字符显式化，让人在批准前看得见将要执行的是什么。
 * 移植自 Hermes `sanitize_command_for_display`。
 */
const INVISIBLE_CODEPOINTS: Record<string, string> = {
  "200b": "零宽空格",
  "200c": "零宽不连字",
  "200d": "零宽连字",
  "202a": "LRE",
  "202b": "RLE",
  "202c": "PDF",
  "202d": "LRO",
  "202e": "RLO",
  "2066": "LRI",
  "2067": "RLI",
  "2068": "FSI",
  "2069": "PDI",
  feff: "BOM",
  "200e": "LRM",
  "200f": "RLM",
  "00a0": "不换行空格",
};

export function invisibleCharNames(text: string): string[] {
  const found: string[] = [];
  for (const char of text) {
    const key = char.codePointAt(0)!.toString(16);
    const label = INVISIBLE_CODEPOINTS[key];
    if (label && !found.includes(label)) found.push(label);
  }
  return found;
}

export function sanitizeForDisplay(text: string): string {
  let out = "";
  for (const char of text) {
    const key = char.codePointAt(0)!.toString(16);
    const label = INVISIBLE_CODEPOINTS[key];
    out += label ? `⟨${label}⟩` : char;
  }
  return out;
}
