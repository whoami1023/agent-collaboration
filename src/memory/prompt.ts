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
  const hasMemoryRetract = params.availableTools.has("memory_retract");
  const hasMaintenance = params.availableTools.has("maintenance_scan");
  if (!hasMemorySearch && !hasMemoryGet && !hasMemoryAppend && !hasMemoryRetract && !hasMaintenance) {
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
        "写事实顺手给出处（source：群聊 #seq、文件路径、链接或用户原话）和生效日期 asOf；有明确失效条件的写 validUntil。",
        "与旧事实冲突时不要重复新增：用 memory_append 写更正条目并传 supersedes=旧条目 entryId，旧条目会自动退出检索。",
      ]
    : [];
  const retractGuidance = hasMemoryRetract
    ? [
        "事实不再成立又没有被新事实取代时，用 memory_retract 按 entryId 撤回；撤回保留正文供审计，不要直接删文件内容。",
      ]
    : [];
  const outcomeGuidance =
    "检索结果带 warning 或 disabled=true 时，如实向用户说明记忆检索是部分可用/不可用；命中带 stale=true 表示已过有效期，采用前先核实或向用户说明。";
  const provenanceGuidance =
    "命中里的 provenance/asOf/validUntil 是这条事实的出处与时效；转述结论时一并交代出处，别把过期事实当现状。";
  const citationGuidance = "引用记忆时给出 Source: <path>#L<start>-L<end>，方便用户核对。";
  const maintenanceGuidance = hasMaintenance
    ? [
        "",
        "## 维护巡检",
        "用户要求整理/检查记忆、做定期维护，或怀疑记忆过时、任务卡停滞时，用 maintenance_scan 汇总：撤回/过期/被取代的记忆条目、反复注入却从未被交付引用的召回、以及停滞或缺依赖/负责人/核验回执的任务卡。",
        "巡检只报告、不自动改。看完报告再决定：过时事实用 memory_append 更正或 memory_retract 撤回，问题任务卡用 task_update 改派或关闭；不要凭报告批量删除记忆。",
        "某条记忆反复被主动召回却从未被引用，通常是触发词过宽或事实已过时——先看正文，再决定改 trigger 还是撤回。",
        "召回账本过大时才用 compact=true 压缩（默认保留最近 2000 条）；压缩不可恢复，先征得用户同意。",
      ]
    : [];
  return [
    "## 记忆检索",
    guidance,
    ...sessionGuidance,
    ...writeGuidance,
    ...retractGuidance,
    outcomeGuidance,
    provenanceGuidance,
    citationGuidance,
    ...maintenanceGuidance,
    "",
  ];
}
