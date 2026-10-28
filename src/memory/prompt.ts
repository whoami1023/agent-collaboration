/**
 * 移植自 OpenClaw（MIT License, Copyright (c) 2026 OpenClaw Foundation）：
 * extensions/memory-core/src/memory-tool-contract.ts 的 buildMemoryPromptSection——
 * 结构（## Memory Recall / 检索指引 / 会话命中处理 / 结果口径 / 引用口径）逐项对应，
 * 文案按本项目中文提示风格改写；sessions_search/sessions_history 工具不存在，
 * 对应指引收敛为 room_history 与「会话命中只是摘录」。
 */

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
}): string[] {
  const hasMemorySearch = params.availableTools.has("memory_search");
  const hasMemoryGet = params.availableTools.has("memory_get");
  const hasMemoryAppend = params.availableTools.has("memory_append");
  if (!hasMemorySearch && !hasMemoryGet && !hasMemoryAppend) {
    return [];
  }

  const guidance = hasMemorySearch
    ? `当答案依赖当前回合里没有的既往工作、决定、日期、人物、偏好或待办时，先调用 memory_search（不带 corpus）检索已配置的记忆源${
        hasMemoryGet ? "；命中的记忆文件结果用 memory_get 只取需要的行" : ""
      }。已有的上下文足够回答时不要重复检索。检索后仍没把握，就明说你查过。`
    : "当答案依赖既往工作、决定、日期、人物、偏好或待办，且指向具体记忆文件时，用 memory_get 只取需要的行；读完仍没把握，就明说你查过。";

  const sessionGuidance = hasMemorySearch
    ? [
        "corpus=sessions 的命中是群聊转录摘录，不是可读的记忆文件路径；需要更多上下文用 room_history。",
        "会话命中的行号是转录 seq，不是历史偏移；不要把它当文件行号读。",
      ]
    : [];
  const writeGuidance = hasMemoryAppend
    ? [
        "值得长期保留的结论（用户偏好、项目决定、日期/人物、可复用做法）用 memory_append 写成一条策展条目；一条只写一个事实，别塞过程性废话。",
        "条目格式：- 事实正文 <!-- trigger: 触发短语, 另一个说法 --> <!-- importance: 1-10 -->；trigger 用你以后提问时可能用的词。",
      ]
    : [];
  const outcomeGuidance =
    "检索结果带 warning、disabled=true 或 stale=true 时，如实向用户说明记忆检索是部分可用/不可用/过期。";
  const citationGuidance = "引用记忆时给出 Source: <path>#L<start>-L<end>，方便用户核对。";
  return ["## 记忆检索", guidance, ...sessionGuidance, ...writeGuidance, outcomeGuidance, citationGuidance, ""];
}
