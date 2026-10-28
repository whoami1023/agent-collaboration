import type { ContextMode, Limits, Member, TaskStatus } from "../core/types";
import type { RoomBus } from "../room/bus";
import type { Workboard } from "../workboard/board";
import type { SkillLibrary } from "../skills/library";
import type { MemorySearchManager } from "../memory/manager";
import { buildMemoryTools } from "../memory/tools";
import type { ToolImpl } from "./loop";
import { formatRoomWindow } from "./prompts";
import {
  isSpawnDepthAllowed,
  spawnDepthRejectError,
  LEAF_SPAWN_REJECT_ERROR,
} from "./spawn/child-admission";

export interface SpawnInput {
  name: string;
  task: string;
  systemPrompt?: string;
  contextMode?: ContextMode;
  providerId?: string;
}

export interface ToolDeps {
  bus: RoomBus;
  board: Workboard;
  limits: Limits;
  skills: SkillLibrary;
  userId: string;
  spawn(input: SpawnInput): Promise<string>;
  memory?: MemorySearchManager;
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

  // Ported capability gate：spawn_member 始终注册但受双重护栏——
  // controlScope（leaf 直接拒绝）与嵌套深度；与 OpenClaw「声明与准入分离」一致。
  tools.push({
      schema: {
        name: "spawn_member",
        description:
          "创建一个子成员并把任务派给它。会生成任务卡并自动 @ 该成员；不要再用回复重复 @。只在任务多步、耗时且可独立完成时使用。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "成员名（2-12 个字），之后用 @名字 引用" },
            task: {
              type: "string",
              description: "任务简报，必须包含：目标、交付物、写入范围、验收方式",
            },
            system_prompt: { type: "string", description: "可选：该成员长期遵循的额外要求" },
            context_mode: {
              type: "string",
              enum: ["isolated", "fork"],
              description: "isolated=只看最近群聊窗口（默认）；fork=带更完整历史",
            },
            provider_id: { type: "string", description: "可选：指定模型 provider id" },
          },
          required: ["name", "task"],
          additionalProperties: false,
        },
      },
      execute: async (args) => {
        if (member.controlScope !== "children") return LEAF_SPAWN_REJECT_ERROR;
        if (!isSpawnDepthAllowed(member.depth, deps.limits.maxSpawnDepth)) {
          return `错误：${spawnDepthRejectError(member.depth, deps.limits.maxSpawnDepth)}`;
        }
        const name = readString(args, "name");
        const task = readString(args, "task");
        if (!name) return "错误：name 不能为空";
        if (!task) return "错误：task 不能为空，请给出任务简报";
        const contextMode = args["context_mode"] === "fork" ? "fork" : "isolated";
        const systemPrompt = readString(args, "system_prompt");
        const providerId = readString(args, "provider_id");
        return deps.spawn({
          name,
          task,
          contextMode,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(providerId ? { providerId } : {}),
        });
      },
  });

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
        const available = deps.skills.listForAgent(deps.userId).map((item) => item.name);
        return `错误：没有可用的技能 ${raw}${
          available.length > 0 ? `。可用技能：${available.join("、")}` : ""
        }`;
      }
      return `技能 ${skill.name}（${skill.scope === "shared" ? "共享" : "个人"}）\n描述：${skill.description}\n\n${skill.instructions}`;
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
    tools.push(...buildMemoryTools(deps.memory));
  }

  return tools;
}
