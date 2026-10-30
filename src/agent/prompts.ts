import type { Member, RoomMessage } from "../core/types";
import type { SkillSummary } from "../skills/library";
import { buildMemoryPromptSection } from "../memory/prompt";
import { buildSubagentStandingInstructions } from "./spawn/system-prompt";

function clock(ts: number): string {
  const date = new Date(ts);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function formatRoomWindow(messages: RoomMessage[]): string {
  return messages
    .map((message) => {
      const who =
        message.senderKind === "user"
          ? `${message.senderName}（用户）`
          : message.senderKind === "system"
            ? "系统"
            : `@${message.senderName}`;
      const meta = [`#${message.seq}`, who, clock(message.ts)];
      if (message.taskId) meta.push(`任务 ${message.taskId}`);
      if (message.kind === "announce") meta.push("报告");
      return `${meta.join(" · ")}\n${message.text}`;
    })
    .join("\n\n");
}

export function formatRoster(member: Member, members: Member[], taskTitles: Map<string, string>): string {
  return members
    .map((candidate) => {
      const role = candidate.role === "main" ? "主智能体" : "成员";
      const self = candidate.id === member.id ? "，你" : "";
      const status = candidate.status === "running" ? "运行中" : candidate.status === "error" ? "异常" : "空闲";
      const task = taskTitles.get(candidate.id);
      return `- @${candidate.name}（${role}${self}，${status}${task ? `，任务：${task}` : ""}）`;
    })
    .join("\n");
}

export interface PromptContext {
  roomName: string;
  member: Member;
  members: Member[];
  parentName: string | null;
  taskTitles: Map<string, string>;
  limits: { maxChildrenPerAgent: number; maxSpawnDepth: number; maxConcurrent: number };
  skills: SkillSummary[];
  /** 本轮实际注册的工具名；记忆指引只描述可用工具（对应 OpenClaw availableTools）。 */
  availableTools?: Set<string>;
}

function formatSkills(skills: SkillSummary[]): string {
  if (skills.length === 0) return "- （暂无可用技能）";
  return skills
    .map((skill) => `- ${skill.name}（${skill.scope === "shared" ? "共享" : "个人"}）：${skill.description}`)
    .join("\n");
}

export function buildSystemPrompt(context: PromptContext): string {
  const base = context.member.role === "main" ? mainPrompt(context) : subPrompt(context);
  // 对应 OpenClaw memory-core 的 promptSection：拼在系统提示尾部，仅描述实际注册的工具。
  const memorySection = context.availableTools
    ? buildMemoryPromptSection({ availableTools: context.availableTools }).join("\n")
    : "";
  return memorySection ? `${base}\n\n${memorySection.trimEnd()}` : base;
}

function mainPrompt(context: PromptContext): string {
  const { member, roomName, members, taskTitles, limits } = context;
  return `你是群聊「${roomName}」里的主智能体 @${member.name}，对用户负责并统筹整组成员。

群成员：
${formatRoster(member, members, taskTitles)}

可用技能（任务与描述匹配时，先调用 use_skill 读取完整说明，再按其中步骤执行）：
${formatSkills(context.skills)}

判断与分工
- 快问快答、你已知或一步能查的，直接自己回答，不要分派。
- 需要多人协作时，只能 @ 群成员里已有的人，或用 task_create 建任务卡并指定负责人。
- 你不能创建成员：需要新成员时，请让用户在左侧「新建成员」里填写名字与职责创建，不要假装已经创建或已派发。
- 每个成员的活应互相独立；不要让成员互相联系，所有协调经过你。
- 成员的报告会自动出现在群里并唤醒你：先核对证据，再给用户一个综合结论；发现冲突先解决再汇报。

节奏
- 分派后不要轮询、不要反复催问，等它的报告。
- 一次回复只做一件事：要么分派，要么综合汇报；不要刷屏。
- 用 task_create 建任务卡，进展用 task_update 更新，结果用 task_attach_artifact 登记。

约束：总并发 ${limits.maxConcurrent}；成员创建由用户操作，你只做任务分派与汇总。`;
}

function subPrompt(context: PromptContext): string {
  const { member, roomName, members, parentName, taskTitles } = context;
  const brief = member.brief?.trim();
  const roleSection = brief ? `\n\n你的角色（创建时用户写下的职责描述）：\n${brief}` : "";
  const base = `你是群聊「${roomName}」里的成员 @${member.name}，由 ${parentName ? `@${parentName}` : "主智能体"} 创建，只对分配给你的任务负责。${roleSection}

群成员：
${formatRoster(member, members, taskTitles)}

可用技能（任务与描述匹配时，先调用 use_skill 读取完整说明，再按其中步骤执行）：
${formatSkills(context.skills)}

纪律
- 你只在被 @${member.name} 或收到分配任务时行动；其他人的闲聊不回应。
- 一次只发一条完整结论，不刷屏，不发「收到」这类空话。
- 汇报必须包含：结论、证据（路径/链接/关键输出）、未解决项与不确定点。不要只给承诺。
- 你没有创建成员的能力：不要尝试新建或下派子成员，只做分给你的任务。
- 不要 @ 其他同级成员互相派活；跨线协调必须经过创建你的那一级。
- 用 task_update 更新任务卡状态，用 task_attach_artifact 登记产出。`;
  const standing = buildSubagentStandingInstructions({ spawnMode: "session" });
  return `${base}\n${standing}`;
}

export function buildInstruction(member: Member, trigger: RoomMessage): string {
  if (trigger.senderKind === "user") {
    return `用户刚在群里发了一条消息（#${trigger.seq}）。请阅读上面的群聊记录，回应用户；需要分工时只能 @ 已有成员或建任务卡，不能创建新成员。`;
  }
  if (trigger.kind === "announce") {
    return `成员 @${trigger.senderName} 交回了结果（#${trigger.seq}）。请核对其中的证据，然后给用户一个综合结论；不要只说「收到」。`;
  }
  return `消息 #${trigger.seq} @ 了你。请处理其中对你的要求${member.role === "sub" ? "，只做分内的事" : ""}。`;
}
