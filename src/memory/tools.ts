/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * - extensions/memory-core/src/memory-tool-contract.ts（MEMORY_SEARCH/MEMORY_GET 工具契约：
 *   schema、corpus 枚举、prepareArguments 别名归一化 min_score/max_results/limit、
 *   maxResults > max_results > limit 的优先级、GET_READ_OUTCOME_GUIDANCE 口径）
 * - extensions/memory-core/src/tools.ts（执行参数读取与 jsonResult 输出形态：
 *   { results, citations, ... } / memory_get 的 status=ok|not_found|error）
 * - src/agents/tools/common.ts（readStringParam / readPositiveIntegerParam /
 *   readStrictNumberParam 的严格校验语义：0 与非整数拒绝、空白可选值视为缺失）
 * 适配：
 * - wiki 语料不存在：corpus=wiki/all 中 wiki 部分按 not-registered 处理（信息性，不算顶层 warning）。
 * - memory_append 是本项目的写回通道（OpenClaw 由文件写工具 + memory flush 承担），
 *   条目格式与 annotations.ts 的策展注释解析完全对应。
 * - 工具返回值沿用 OpenClaw 的 JSON 文本形态（我们的 ToolImpl 只接受 string）。
 */

import type { ToolImpl } from "../agent/loop";
import type { MemorySearchManager, MemorySearchResult } from "./manager";

class ToolInputError extends Error {}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean },
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (options?.required) {
    throw new ToolInputError(`${key} is required.`);
  }
  return undefined;
}

// 对应 readStrictNumberParam：只接受 number 或严格可解析的字符串；空白字符串=缺失，其余非法值报错。
function readStrictFiniteNumber(params: Record<string, unknown>, key: string): number | undefined {
  const raw = params[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
    throw new ToolInputError(`${key} must be a finite number`);
  }
  if (raw != null) {
    throw new ToolInputError(`${key} must be a finite number`);
  }
  return undefined;
}

function readPositiveIntegerParam(params: Record<string, unknown>, key: string): number | undefined {
  const message = `${key} must be a positive integer`;
  const value = readStrictFiniteNumber(params, key);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToolInputError(message);
  }
  return value;
}

function readFiniteNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  return readStrictFiniteNumber(params, key);
}

function readCorpusParam<T extends string>(
  params: Record<string, unknown>,
  allowed: readonly T[],
): T | undefined {
  const raw = readStringParam(params, "corpus");
  if (raw === undefined) return undefined;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ToolInputError(`corpus must be one of: ${allowed.join(", ")}`);
}

// 对应 MEMORY_SEARCH_TOOL_CONTRACT.prepareArguments：别名归一化，
// 优先级 maxResults > max_results > limit（即使值非法也保持该顺序交给校验拒绝）。
function prepareSearchArguments(args: Record<string, unknown>): Record<string, unknown> {
  const aliases = [
    ["min_score", "minScore"],
    ["max_results", "maxResults"],
    ["limit", "maxResults"],
  ] as const;
  if (!aliases.some(([alias]) => Object.hasOwn(args, alias))) {
    return args;
  }
  const normalized = { ...args };
  for (const [alias, key] of aliases) {
    if (Object.hasOwn(normalized, alias) && !Object.hasOwn(normalized, key)) {
      normalized[key] = normalized[alias];
    }
    delete normalized[alias];
  }
  return normalized;
}

function presentSearchResult(result: MemorySearchResult): Record<string, unknown> {
  return {
    path: result.path,
    startLine: result.startLine,
    endLine: result.endLine,
    score: Number(result.score.toFixed(4)),
    snippet: result.snippet,
    source: result.source,
    ...(result.importance !== undefined ? { importance: result.importance } : {}),
    ...(result.triggers ? { triggers: result.triggers } : {}),
    ...(result.projectKey ? { projectKey: result.projectKey } : {}),
  };
}

export interface MemoryToolOptions {
  /** 检索时透传的项目键（对应 OpenClaw activeProjectKeys）。 */
  activeProjectKeys?: readonly string[];
  /** 子成员 ID：检索/读取/追加都限定到这个成员自己的记忆文件。 */
  agentId?: string;
}

export function buildMemoryTools(
  manager: MemorySearchManager,
  options: MemoryToolOptions = {},
): ToolImpl[] {
  const settings = manager.getSettings();
  const tools: ToolImpl[] = [];

  tools.push({
    schema: {
      name: "memory_search",
      description:
        "检索长期记忆（共享 MEMORY.md、USER.md、memory/**.md；子成员另含自己的记忆文件）与已索引的群聊转录。答案依赖当前回合没有的既往工作、决定、日期、人物、偏好或待办时使用；上下文已够时不要重复检索。corpus=sessions 命中是转录摘录，行号是 seq。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词" },
          maxResults: { type: "integer", minimum: 1, description: `默认 ${settings.query.maxResults}` },
          minScore: { type: "number", description: `默认 ${settings.query.minScore}` },
          corpus: {
            type: "string",
            enum: ["memory", "all", "sessions"],
            description: "memory=仅记忆文件（默认）；sessions=仅群聊转录；all=两者",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    execute: async (rawArgs) => {
      try {
        const params = prepareSearchArguments(rawArgs);
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readPositiveIntegerParam(params, "maxResults");
        const minScore = readFiniteNumberParam(params, "minScore");
        const corpus = readCorpusParam(params, ["memory", "all", "sessions"] as const);
        const sources =
          corpus === "sessions" ? (["sessions"] as const) : corpus === "all" ? (["memory", "sessions"] as const) : (["memory"] as const);
        const results = await manager.search(query ?? "", {
          ...(maxResults !== undefined ? { maxResults } : {}),
          ...(minScore !== undefined ? { minScore } : {}),
          sources: [...sources],
          ...(options.activeProjectKeys ? { activeProjectKeys: options.activeProjectKeys } : {}),
          ...(options.agentId ? { agentId: options.agentId } : {}),
        });
        return JSON.stringify({
          results: results.map(presentSearchResult),
          citations: "on",
          ...(corpus === "all"
            ? { corpusOutcomes: { memory: "ok", wiki: "not-registered", sessions: "ok" } }
            : {}),
        });
      } catch (error) {
        if (error instanceof ToolInputError) throw error;
        return JSON.stringify({
          disabled: true,
          warning: "记忆检索暂时不可用",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  tools.push({
    schema: {
      name: "memory_get",
      description:
        "按路径精确读取记忆文件片段（安全摘录）。只支持 MEMORY.md、USER.md、memory/**.md；子成员还可读自己 agents/<成员ID>/ 下的 MEMORY.md 与 USER.md。群聊转录命中不支持此工具，用 room_history 扩上下文。status=ok 表示已读到请求的摘录；status=not_found 表示路径不在允许范围；status=error 表示读取失败，不代表记忆被禁用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作区相对路径，如 MEMORY.md 或 memory/decisions.md" },
          from: { type: "integer", minimum: 1, description: "起始行（1 基）" },
          lines: { type: "integer", minimum: 1, description: "读取行数，默认有界摘录" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    execute: async (rawArgs) => {
      const params = rawArgs;
      const relPath = readStringParam(params, "path", { required: true });
      const from = readPositiveIntegerParam(params, "from");
      const lines = readPositiveIntegerParam(params, "lines");
      readCorpusParam(params, ["memory", "all"] as const);
      try {
        const file = await manager.readFile(relPath ?? "", {
          ...(from !== undefined ? { from } : {}),
          ...(lines !== undefined ? { lines } : {}),
          ...(options.agentId ? { agentId: options.agentId } : {}),
        });
        return JSON.stringify({
          status: "ok",
          path: relPath,
          ...file,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notFound = /不存在|not found/i.test(message);
        return JSON.stringify({
          status: notFound ? "not_found" : "error",
          error: message,
        });
      }
    },
  });

  tools.push({
    schema: {
      name: "memory_append",
      description:
        "把一条值得长期保留的事实追加到 MEMORY.md 策展条目区（子成员追加到自己的 MEMORY.md）。一条只写一个事实（用户偏好、项目决定、日期/人物、可复用做法），别塞过程性废话。写入格式：- 正文 <!-- trigger: 触发短语, 另一个说法 --> <!-- importance: 1-10 -->。",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "单条事实正文，不带 '- ' 前缀" },
          triggers: {
            type: "array",
            items: { type: "string" },
            description: "以后提问可能用到的触发词/短语（用于自动召回）",
          },
          importance: { type: "integer", minimum: 1, maximum: 10, description: "重要度 1-10" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    execute: async (rawArgs) => {
      const text = readStringParam(rawArgs, "text", { required: true });
      const triggersRaw = rawArgs.triggers;
      const triggers = Array.isArray(triggersRaw)
        ? triggersRaw.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
        : undefined;
      const importance = readPositiveIntegerParam(rawArgs, "importance");
      if (importance !== undefined && importance > 10) {
        throw new ToolInputError("importance must be between 1 and 10");
      }
      const written = await manager.appendEntry(
        text ?? "",
        {
          ...(triggers?.length ? { triggers } : {}),
          ...(importance !== undefined ? { importance } : {}),
        },
        options.agentId ? { agentId: options.agentId } : undefined,
      );
      return JSON.stringify({ status: "ok", path: written });
    },
  });

  return tools;
}
