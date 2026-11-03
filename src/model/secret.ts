// API-key handling ported from OpenClaw's secret layer (`src/secrets/*`,
// `src/config/redact-sentinel.ts`, `src/config/redact-snapshot.ts`),
// MIT License — Copyright (c) 2026 OpenClaw Foundation.
// 我们支持字面量、`${ENV}` / `$ENV` / `env:NAME` / `file:PATH`；
// OpenClaw 的 `exec:` 来源会执行配置里的命令，在多人 Web 服务上属于提权面，故不移植。

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** UI 侧看到的占位符：写回时代表「保持不变」，绝不当成真实密钥。 */
export const REDACTED_SENTINEL = "__REDACTED__";

const KNOWN_MASKS = new Set([
  REDACTED_SENTINEL,
  "REDACTED",
  "redacted",
  "***",
  "[redacted]",
  "[REDACTED]",
  "<redacted>",
  "********",
]);

/** 是否为掩码快照里的占位符（允许 `__REDACTED__:deepseek` 这类带后缀形式）。 */
export function looksMasked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (KNOWN_MASKS.has(trimmed)) return true;
  return [...KNOWN_MASKS].some((mask) => trimmed === mask || trimmed.startsWith(`${mask}:`));
}

/** 对外展示用：只保留来源说明与末 4 位，不回传明文。 */
export function secretPreview(value: string | undefined): { hasSecret: boolean; hint?: string; source: SecretSource } {
  if (!value) return { hasSecret: false, source: "none" };
  const parsed = classifySecretInput(value);
  if (parsed.source === "literal") {
    const tail = value.slice(-4);
    return { hasSecret: true, hint: `自定义密钥（…${tail}）`, source: "literal" };
  }
  return { hasSecret: true, hint: `${parsed.source}：${parsed.reference}`, source: parsed.source };
}

export type SecretSource = "literal" | "env" | "file" | "none";

export interface SecretClassification {
  source: SecretSource;
  /** 环境变量名或文件路径；字面量时为空串。 */
  reference: string;
}

/** 判断密钥写法的来源，不落盘解析。 */
export function classifySecretInput(value: string): SecretClassification {
  const trimmed = value.trim();
  const envBrace = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (envBrace?.[1]) return { source: "env", reference: envBrace[1] };
  const envBare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (envBare?.[1]) return { source: "env", reference: envBare[1] };
  if (trimmed.startsWith("env:")) {
    return { source: "env", reference: trimmed.slice(4).trim() };
  }
  if (trimmed.startsWith("file:")) {
    return { source: "file", reference: trimmed.slice(5).trim() };
  }
  return { source: "literal", reference: "" };
}

/** provider 的密钥环境变量回退顺序（对应 OpenClaw provider-env-vars 表）。 */
export function providerEnvVarCandidates(providerId: string): string[] {
  const upper = providerId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const candidates = [
    `${upper}_API_KEY`,
    `${upper}_APIKEY`,
    `${upper}_KEY`,
    `API_KEY_${upper}`,
  ];
  if (/^(openai|azure|azure_openai|azureopenai|oneapi|easyllm)$/i.test(providerId)) {
    candidates.push("OPENAI_API_KEY");
  }
  if (/^deepseek/i.test(providerId)) candidates.push("DEEPSEEK_API_KEY");
  if (/^anthropic|claude/i.test(providerId)) candidates.push("ANTHROPIC_API_KEY");
  if (/^gemini|google/i.test(providerId)) candidates.push("GEMINI_API_KEY");
  candidates.push("MODELS_API_KEY");
  return [...new Set(candidates)];
}

export interface ResolvedSecret {
  apiKey?: string;
  /** 解析成功时说明密钥来源，便于状态面板展示。 */
  via?: string;
  error?: string;
}

/**
 * 把配置里的密钥写法解析成真实值：字面量直接用；`${ENV}`/`env:` 查环境；`file:` 读文件。
 * 未配置时按 provider id 回退到常见环境变量名。
 */
export function resolveApiKey(
  input: string | undefined,
  providerId: string,
  deps: { env?: NodeJS.ProcessEnv; dataDir?: string } = {},
): ResolvedSecret {
  const env = deps.env ?? process.env;
  if (input && !looksMasked(input)) {
    const classified = classifySecretInput(input);
    switch (classified.source) {
      case "env": {
        const value = env[classified.reference]?.trim();
        if (!value) return { error: `环境变量 ${classified.reference} 未设置` };
        return { apiKey: value, via: `env:${classified.reference}` };
      }
      case "file": {
        const path = isAbsolute(classified.reference)
          ? classified.reference
          : resolve(deps.dataDir ?? process.cwd(), classified.reference);
        try {
          const value = readFileSync(path, "utf8").trim();
          if (!value) return { error: `密钥文件为空：${classified.reference}` };
          return { apiKey: value, via: `file:${classified.reference}` };
        } catch {
          return { error: `无法读取密钥文件：${classified.reference}` };
        }
      }
      default:
        return { apiKey: input, via: "literal" };
    }
  }
  for (const name of providerEnvVarCandidates(providerId)) {
    const value = env[name]?.trim();
    if (value) return { apiKey: value, via: `env:${name}` };
  }
  return {};
}

/**
 * 补丁回写：只有显式提供且不是掩码占位符的密钥才覆盖原值，
 * 占位符与空串都表示「保持现状」——修掉旧实现里「未填即删除」的问题。
 */
export function preserveSecretOnPatch(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined || incoming === null) return existing;
  if (typeof incoming !== "string") throw new Error("apiKey 必须是字符串或环境变量引用");
  const trimmed = incoming.trim();
  if (!trimmed || looksMasked(trimmed)) return existing;
  return trimmed;
}
