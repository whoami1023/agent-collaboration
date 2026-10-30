import type { Member, TaskStatus } from "../core/types";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { SkillLibrary } from "../skills/library";
import { selectSkillsForMember, isSkillSelected } from "../skills/selection";
import { formatSkillFileSize } from "../skills/skill-files";
import type { MemorySearchManager } from "../memory/manager";
import { buildMemoryTools } from "../memory/tools";
import type { WorkspaceFiles } from "../files/workspace-files";
import type { ToolImpl } from "./loop";
import { formatRoomWindow } from "./prompts";
import { buildWebTools, type WebToolOptions } from "../web/tools";
import { buildFileTools } from "./file-tools";

export interface ToolDeps {
  bus: RoomBus;
  board: Workboard;
  skills: SkillLibrary;
  userId: string;
  memory?: MemorySearchManager;
  files?: WorkspaceFiles;
  /** 联网工具注入点：单测可替换 fetch/DNS，生产环境留空走真实网络。 */
  web?: WebToolOptions;
}

const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "done", "failed"];

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length > 0 ? items.map((item) => item.trim()) : undefined;
}

export function buildTools(member: Member, deps: ToolDeps): ToolImpl[] {
  const tools: ToolImpl[] = [];
  // 成员级技能白名单（智能体文件 → 技能）：提示词只列勾选项，工具也要拦。
  const enabledSkills = () =>
    selectSkillsForMember(deps.skills.listForAgent(deps.userId), member.skillNames);
  const denialFor = (skillName: string): string => {
    const available = enabledSkills().map((item) => item.name);
    return `错误：技能 ${skillName} 未对 @${member.name} 启用${
      available.length > 0
        ? `。可用技能：${available.join("、")}`
        : "，该智能体当前没有启用任何技能（可在右侧「智能体文件 → 技能」中勾选）"
    }`;
  };

  // 成员只能由用户在左侧「新建成员」创建；运行中的智能体不再拥有创建子成员的通道。
  tools.push({
    schema: {
      name: "use_skill",
      description:
        "读取一个可用技能的完整说明。当任务与某个技能的描述匹配时，先调用本工具，再严格按返回的步骤执行。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称，见 system prompt 中的可用技能列表" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const raw = readString(args, "name");
      if (!raw) return "错误：name 不能为空";
      const skill = deps.skills.readForAgent(deps.userId, raw);
      if (!skill) {
        const available = enabledSkills().map((item) => item.name);
        return `错误：没有可用的技能 ${raw}${
          available.length > 0 ? `。可用技能：${available.join("、")}` : ""
        }`;
      }
      if (!isSkillSelected(member.skillNames, skill.name)) return denialFor(skill.name);
      const files = skill.files ?? [];
      const filesSection =
        files.length > 0
          ? `\n\n附带文件（用 read_skill_file 读取正文，参数 skill=${skill.name}）：\n${files
              .map((file) => `- ${file.path}（${formatSkillFileSize(file.size)}）`)
              .join("\n")}`
          : "";
      return `技能 ${skill.name}（${skill.scope === "shared" ? "共享" : "个人"}）\n描述：${
        skill.description
      }\n\n${skill.instructions}${filesSection}`;
    },
  });

  tools.push({
    schema: {
      name: "read_skill_file",
      description:
        "读取技能目录里的附带文件（脚本、参考资料、模板等）。use_skill 返回的附带文件清单中路径才能读；二进制文件只返回大小。",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "技能名称" },
          path: { type: "string", description: "附带文件相对路径，如 scripts/build.js" },
        },
        required: ["skill", "path"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const skillName = readString(args, "skill");
      const path = readString(args, "path");
      if (!skillName) return "错误：skill 不能为空";
      if (!path) return "错误：path 不能为空";
      const skill = deps.skills.readForAgent(deps.userId, skillName);
      if (!skill) return `错误：没有可用的技能 ${skillName}`;
      if (!isSkillSelected(member.skillNames, skill.name)) return denialFor(skill.name);
      const hit = deps.skills.readSkillFile(deps.userId, skillName, path);
      if (!hit) {
        const list = (skill.files ?? []).map((file) => file.path);
        return list.length > 0
          ? `错误：技能 ${skillName} 里没有文件 ${path}。可选路径：${list.join("、")}`
          : `错误：技能 ${skillName} 没有附带文件`;
      }
      if (hit.file.encoding === "base64") {
        return `文件 ${hit.file.path} 是二进制内容（${formatSkillFileSize(
          hit.file.size,
        )}），作战室内无法直接查看正文。`;
      }
      return `技能 ${skillName} 的文件 ${hit.file.path}：\n\n${hit.file.content}`;
    },
  });

  tools.push({
    schema: {
      name: "task_create",
      description: "创建任务卡。依赖未完成时，卡片不能进入进行中或已完成。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          detail: { type: "string", description: "任务细节" },
          owner: { type: "string", description: "可选：负责人成员名（不带 @）" },
          deps: { type: "array", items: { type: "string" }, description: "可选：依赖的任务 id" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const title = readString(args, "title");
      if (!title) return "错误：title 不能为空";
      const ownerName = readString(args, "owner");
      const owner = ownerName ? deps.bus.findMemberByName(ownerName) : undefined;
      const task = deps.board.create({
        title,
        ...(readString(args, "detail") ? { detail: readString(args, "detail") } : {}),
        createdBy: member.id,
        ownerId: owner?.id ?? null,
        ...(readStringArray(args, "deps") ? { deps: readStringArray(args, "deps") } : {}),
      });
      return `已创建任务 ${task.id}：${task.title}（状态 ${task.status}${owner ? `，负责人 @${owner.name}` : ""}）`;
    },
  });

  tools.push({
    schema: {
      name: "task_update",
      description: "更新任务卡：状态、负责人或细节。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "任务 id" },
          status: { type: "string", enum: TASK_STATUSES, description: "新状态" },
          owner: { type: "string", description: "可选：新负责人成员名（不带 @）" },
          detail: { type: "string", description: "可选：补充说明" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const taskId = readString(args, "task_id");
      if (!taskId) return "错误：task_id 不能为空";
      const status = readString(args, "status");
      if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
        return `错误：status 只能是 ${TASK_STATUSES.join(" / ")}`;
      }
      const ownerName = readString(args, "owner");
      const owner = ownerName ? deps.bus.findMemberByName(ownerName) : undefined;
      if (ownerName && !owner) return `错误：找不到成员 ${ownerName}`;
      try {
        const task = deps.board.update(taskId, {
          ...(status ? { status: status as TaskStatus } : {}),
          ...(owner ? { ownerId: owner.id } : {}),
          ...(readString(args, "detail") ? { detail: readString(args, "detail") } : {}),
        });
        return `任务 ${task.id} 已更新：状态 ${task.status}${owner ? `，负责人 @${owner.name}` : ""}`;
      } catch (err) {
        return `更新失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  tools.push({
    schema: {
      name: "task_attach_artifact",
      description: "把产出登记到任务卡的成果区（文件名、路径或摘要）。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "任务 id" },
          name: { type: "string", description: "成果名称" },
          path: { type: "string", description: "可选：文件路径或链接" },
          summary: { type: "string", description: "可选：一句话说明" },
        },
        required: ["task_id", "name"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const taskId = readString(args, "task_id");
      const name = readString(args, "name");
      if (!taskId || !name) return "错误：task_id 和 name 都必须提供";
      try {
        const task = deps.board.attachArtifact(taskId, {
          name,
          ...(readString(args, "path") ? { path: readString(args, "path") } : {}),
          ...(readString(args, "summary") ? { summary: readString(args, "summary") } : {}),
          addedBy: member.id,
        });
        return `已登记成果到 ${task.id}，当前共 ${task.artifacts.length} 项`;
      } catch (err) {
        return `登记失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  tools.push({
    schema: {
      name: "room_history",
      description: "读取群聊最近的消息记录（当需要更早的上下文时使用）。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "读取条数，默认 30，最多 100" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const raw = args["limit"];
      const limit = typeof raw === "number" && Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.round(raw))) : 30;
      const messages = deps.bus.listMessages(limit);
      return formatRoomWindow(messages) || "（群里还没有消息）";
    },
  });

  // P5：记忆三件套（memory_search / memory_get / memory_append），
  // 对应 OpenClaw memory-core 插件按 agent 注册工具通道的形态。
  if (deps.memory) {
    tools.push(...buildMemoryTools(deps.memory, member.role === "sub" ? { agentId: member.id } : {}));
  }

  // 文件工作区：用户上传与智能体产出共用 files/ 目录，对应 OpenClaw 的 read/write/ls 文件工具。
  if (deps.files) tools.push(...buildFileTools(deps.files));

  // 联网检索与正文抓取：内置共享技能 web-search / web-fetch / web-browse 的执行底座。
  tools.push(...buildWebTools(deps.web));

  return tools;
}
