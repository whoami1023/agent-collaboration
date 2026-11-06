/**
 * 每个工具的结果该怎么处理：套不套外部内容边界、要不要掩码、要不要标注指令改写。
 *
 * 用表而不是在每个工具里写 if：新增工具默认按内部结果处理（什么都不做），
 * 只有明确登记为外部来源的工具才会被包边界。这样"忘了登记"只会少一层提醒，
 * 不会把智能体自己的错误消息当成外部数据糊上一段免责声明。
 */
import { guardExternalContent } from "./envelope";
import { redactSecrets } from "./redact";

export interface ToolContentPolicy {
  /** 设定后：结果按外部内容套边界，标签就是这个来源名。 */
  source?: string;
  /** 结果里出现疑似密钥时掩码（命令输出与脚本打印最常见）。 */
  redact: boolean;
}

const POLICIES: Record<string, ToolContentPolicy> = {
  web_fetch: { source: "web_fetch", redact: true },
  web_search: { source: "web_search", redact: true },
  // 上传的文件同样是外部内容：里面完全可以藏一段"忽略先前指令"。
  file_read: { source: "file_read", redact: true },
  run_command: { source: "run_command", redact: true },
  run_skill_script: { source: "run_skill_script", redact: true },
  // 技能正文是**要照着做的说明**，不能套"不是指令"的边界；但脚本输出与附带文件要脱敏。
  read_skill_file: { redact: true },
  use_skill: { redact: true },
  // 记忆与群聊记录是房内的内容，只做掩码。
  memory_get: { redact: true },
  memory_search: { redact: true },
  room_history: { redact: true },
};

const DEFAULT_POLICY: ToolContentPolicy = { redact: false };

/** 这些前缀是我们自己工具发的话，不是外部数据，不套边界。 */
const INTERNAL_NOTICE_PREFIXES = [
  "错误：",
  "工具执行失败",
  "更新失败",
  "写入失败",
  "读取失败",
  "登记失败",
  "启动失败",
  "没有找到",
];

export function policyFor(toolName: string): ToolContentPolicy {
  return POLICIES[toolName] ?? DEFAULT_POLICY;
}

export function isInternalToolNotice(text: string): boolean {
  const head = text.trimStart().slice(0, 12);
  return INTERNAL_NOTICE_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * 工具结果的统一出口。在 agent 循环里调用，所以任何工具（含以后新增的）
 * 都只有一条路径能把内容送进模型上下文。
 */
export function applyToolResultPolicy(toolName: string, raw: string): string {
  const policy = policyFor(toolName);
  const redacted = policy.redact ? redactSecrets(raw) : { text: raw, replaced: 0, families: [] };
  let out = redacted.text;
  if (redacted.replaced > 0) {
    out = `${out}\n\n（提示：本结果里已掩掉 ${redacted.replaced} 处疑似密钥（${redacted.families.join(
      "、",
    )}）。原始值仍在文件里，需要引用时让用户自己查看，不要试图还原。）`;
  }
  if (!policy.source || isInternalToolNotice(out)) return out;
  return guardExternalContent(policy.source, out);
}
