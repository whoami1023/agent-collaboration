import type { Member, RunScopeKind, TaskStatus } from "../core/types";
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
import { buildShellTools } from "./shell-tools";
import { buildCronTools } from "./cron-tools";
import { applyRunScope } from "./run-scope";
import { verifyAcceptance, type EvidenceLedger } from "./evidence";
import type { CronService } from "../cron/service";
import type { SkillUsageRecorder } from "../skills/curation/types";

export interface ToolDeps {
  bus: RoomBus;
  board: Workboard;
  skills: SkillLibrary;
  userId: string;
  memory?: MemorySearchManager;
  files?: WorkspaceFiles;
  /** 联网工具注入点：单测可替换 fetch/DNS，生产环境留空走真实网络。 */
  web?: WebToolOptions;
  /** 定时任务服务：工作区加载后才有；未接上时智能体看不到 cron 工具。 */
  getCron?: () => CronService | undefined;
  /**
   * 本轮运行姿态（由触发消息带上）。设定后只注册白名单里的工具，
   * 并把文件写入限制在姿态规定的前缀内——见 run-scope.ts。
   */
  runScope?: RunScopeKind;
  /**
   * 本轮证据台账：写文件、跑命令、登记成果时在这里记账，
   * 交付闸门用它核验 task_update → done（见 evidence.ts）。
   */
  evidence?: EvidenceLedger;
  /**
   * 技能使用记账（策展的输入）：命中一次技能就加一次数，同步返回、异步落盘。
   * 没接上时什么都不做——群聊永远不该因为账本写不进去而停下来。
   */
  skillUsage?: SkillUsageRecorder;
}

const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "blocked", "done", "failed"];

/** 验收条款上限：够写三四条可核对的事实，又不至于让卡片变成第二份需求文档。 */
const MAX_ACCEPTANCE_CHARS = 300;

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
      // 展开正文算一次真实使用：策展的闲置与归档判断只看这个计数，光在提示词里列出来不算被用过。
      deps.skillUsage?.(skill.id, "use");
      const files = skill.files ?? [];
      const filesSection =
        files.length > 0
          ? `\n\n附带文件（用 read_skill_file 读取正文，脚本用 run_skill_script 执行，参数 skill=${skill.name}）：\n${files
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
      // 读附带文件只算「动过手」（viewCount），不计入 useCount：闲置判断看的是整份技能有没有被展开。
      deps.skillUsage?.(skill.id, "view");
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
      description:
        "创建任务卡。依赖未完成时，卡片不能进入进行中或已完成。交付型任务把「做到什么程度算做完」写进 acceptance（每条一个可独立核对的客体），之后标记完成时闸门会核验真实证据。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务标题" },
          detail: { type: "string", description: "任务细节" },
          owner: { type: "string", description: "可选：负责人成员名（不带 @）" },
          deps: { type: "array", items: { type: "string" }, description: "可选：依赖的任务 id" },
          acceptance: {
            type: "string",
            description:
              "可选：验收条款。一行一个可独立核对的事实，如「files/reports/x.docx 存在且包含第 3 章」「跑过 python check.py 且退出码 0」。最多 300 字",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const title = readString(args, "title");
      if (!title) return "错误：title 不能为空";
      const acceptance = readString(args, "acceptance");
      if (acceptance && acceptance.length > MAX_ACCEPTANCE_CHARS) {
        return `错误：acceptance 最多 ${MAX_ACCEPTANCE_CHARS} 字；只保留能被逐条核对的验收客体，其余写进 detail`;
      }
      const ownerName = readString(args, "owner");
      const owner = ownerName ? deps.bus.findMemberByName(ownerName) : undefined;
      const task = deps.board.create({
        title,
        ...(readString(args, "detail") ? { detail: readString(args, "detail") } : {}),
        ...(acceptance ? { acceptance } : {}),
        createdBy: member.id,
        ownerId: owner?.id ?? null,
        ...(readStringArray(args, "deps") ? { deps: readStringArray(args, "deps") } : {}),
      });
      return `已创建任务 ${task.id}：${task.title}（状态 ${task.status}${owner ? `，负责人 @${owner.name}` : ""}）${
        task.acceptance
          ? `\n验收条款已登记，标记完成时闸门会核验证据：\n${task.acceptance}`
          : ""
      }`;
    },
  });

  tools.push({
    schema: {
      name: "task_update",
      description:
        "更新任务卡：状态、负责人或细节。卡片写了验收条款时，标 done 必须同时传 verify_kind 与 verify_handle（本轮真实产出过的文件路径 / 跑过的命令 / 已登记成果名），闸门会回读核验；核验不过就保持 doing。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "任务 id" },
          status: { type: "string", enum: TASK_STATUSES, description: "新状态" },
          owner: { type: "string", description: "可选：新负责人成员名（不带 @）" },
          detail: { type: "string", description: "可选：补充说明" },
          acceptance: {
            type: "string",
            description: `可选：补写或修订验收条款（最多 ${MAX_ACCEPTANCE_CHARS} 字）`,
          },
          verify_kind: {
            type: "string",
            enum: ["file", "command", "artifact"],
            description: "标 done 时的证据类型：写出的文件、跑过的命令，或登记过的成果",
          },
          verify_handle: {
            type: "string",
            description:
              "证据标识：文件用相对路径（如 reports/a.md，不带 files/ 前缀），命令用原样那一条，成果用登记时的名称",
          },
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
      const acceptance = readString(args, "acceptance");
      if (acceptance && acceptance.length > MAX_ACCEPTANCE_CHARS) {
        return `错误：acceptance 最多 ${MAX_ACCEPTANCE_CHARS} 字`;
      }
      const ownerName = readString(args, "owner");
      const owner = ownerName ? deps.bus.findMemberByName(ownerName) : undefined;
      if (ownerName && !owner) return `错误：找不到成员 ${ownerName}`;
      const task = deps.board.get(taskId);
      if (!task) return `更新失败：任务不存在：${taskId}`;
      const verifyKind = readString(args, "verify_kind");
      const verifyHandle = readString(args, "verify_handle");
      const willBeDone = status === "done";
      if (willBeDone && (task.acceptance || acceptance) && deps.evidence) {
        const verdict = await verifyAcceptance({
          task: { ...task, ...(acceptance ? { acceptance } : {}) },
          ledger: deps.evidence,
          ...(verifyKind ? { verifyKind } : {}),
          ...(verifyHandle ? { verifyHandle } : {}),
          fileExists: async (relPath) => {
            if (!deps.files) return false;
            try {
              await deps.files.read(relPath, { maxBytes: 1 });
              return true;
            } catch {
              return false;
            }
          },
          artifactExists: async (name) => {
            const current = deps.board.get(taskId);
            return (
              current?.artifacts.some((item) => item.name === name) ??
              task.artifacts.some((item) => item.name === name)
            );
          },
        });
        if (!verdict.ok) return verdict.reason;
        const updated = deps.board.update(taskId, {
          ...(acceptance ? { acceptance } : {}),
          status: "done",
          ...(owner ? { ownerId: owner.id } : {}),
          ...(readString(args, "detail") ? { detail: readString(args, "detail") } : {}),
          evidence: deps.evidence.mergeInto(task.evidence),
          ...(verdict.verifiedBy
            ? {
                completion: {
                  verifiedBy: verdict.verifiedBy,
                  at: Date.now(),
                  ...(verdict.detail ? { detail: verdict.detail } : {}),
                },
              }
            : {}),
        });
        return `任务 ${updated.id} 已核验通过并标记完成：证据 ${verdict.verifiedBy?.kind} ${
          verdict.verifiedBy?.handle
        }${owner ? `，负责人 @${owner.name}` : ""}`;
      }
      try {
        const updated = deps.board.update(taskId, {
          ...(status ? { status: status as TaskStatus } : {}),
          ...(owner ? { ownerId: owner.id } : {}),
          ...(acceptance ? { acceptance } : {}),
          ...(readString(args, "detail") ? { detail: readString(args, "detail") } : {}),
          // 进展更新顺手把本轮台账留在卡上：成员被「继续」唤醒时装回证据，闸门才认续跑。
          ...(deps.evidence ? { evidence: deps.evidence.mergeInto(task.evidence) } : {}),
        });
        return `任务 ${updated.id} 已更新：状态 ${updated.status}${owner ? `，负责人 @${owner.name}` : ""}`;
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
      const relPath = readString(args, "path");
      if (relPath && deps.files) {
        // 指向工作区文件的成果必须真的在：登记一个不存在的路径等于伪造证据。
        try {
          await deps.files.read(relPath.replace(/^files\//, ""), { maxBytes: 1 });
        } catch (err) {
          return `登记失败：files/${relPath.replace(/^files\//, "")} 读不到（${
            err instanceof Error ? err.message : String(err)
          }）。请先产出该文件，或把成果名与摘要写清楚、不带路径。`;
        }
      }
      try {
        const task = deps.board.attachArtifact(taskId, {
          name,
          ...(relPath ? { path: relPath } : {}),
          ...(readString(args, "summary") ? { summary: readString(args, "summary") } : {}),
          addedBy: member.id,
        });
        deps.evidence?.record("artifact", name, relPath ? `files/${relPath.replace(/^files\//, "")}` : "摘要登记");
        if (relPath && deps.files) {
          deps.evidence?.record("file", relPath.replace(/^files\//, ""), `成果「${name}」`);
        }
        return `已登记成果到 ${task.id}，当前共 ${task.artifacts.length} 项`;
      } catch (err) {
        return `登记失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  tools.push({
    schema: {
      name: "task_list",
      description:
        "列出当前房间的任务卡（id、状态、负责人、产出）。「回读确认」就用它：成员说任务已更新、产出已登记时，先看这里的状态和成果，不要凭它的说法向用户宣布完成。",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: TASK_STATUSES, description: "可选：只看某个状态" },
          owner: { type: "string", description: "可选：只看某个成员（成员名，不带 @）" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    execute: async (args) => {
      const status = readString(args, "status");
      if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
        return `错误：status 只能是 ${TASK_STATUSES.join(" / ")}`;
      }
      const ownerName = readString(args, "owner");
      const owner = ownerName ? deps.bus.findMemberByName(ownerName) : undefined;
      if (ownerName && !owner) return `错误：找不到成员 ${ownerName}`;
      let tasks = deps.board.list();
      if (status) tasks = tasks.filter((task) => task.status === status);
      if (owner) tasks = tasks.filter((task) => task.ownerId === owner.id);
      if (tasks.length === 0) return "（没有符合条件的任务卡）";
      const shown = tasks.slice(0, 40);
      const lines = shown.map((task) => {
        const ownerLabel = task.ownerId ? deps.bus.getMember(task.ownerId)?.name ?? task.ownerId : "未指派";
        const artifacts =
          task.artifacts.length > 0
            ? `，成果 ${task.artifacts.length} 项：${task.artifacts
                .slice(-3)
                .map((item) => item.path ?? item.name)
                .join("、")}`
            : "，成果 0 项";
        return `- ${task.id}｜${task.title}｜${task.status}｜@${ownerLabel}${artifacts}${
          task.completion
            ? `｜已核验：${task.completion.verifiedBy.kind} ${task.completion.verifiedBy.handle}`
            : task.acceptance
              ? "｜有验收条款（done 需证据）"
              : ""
        }`;
      });
      const head = `任务卡 ${tasks.length} 张${shown.length < tasks.length ? `（只显示前 ${shown.length} 张）` : ""}：`;
      return [head, ...lines].join("\n");
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
  if (deps.files) {
    tools.push(...buildFileTools(deps.files, deps.evidence));
    // 命令执行：run_command 在工作区跑命令，run_skill_script 展开并执行技能附带脚本。
    tools.push(
      ...buildShellTools({
        files: deps.files,
        skills: deps.skills,
        userId: deps.userId,
        member,
        ...(deps.evidence ? { evidence: deps.evidence } : {}),
        ...(deps.skillUsage ? { skillUsage: deps.skillUsage } : {}),
      }),
    );
  }

  // 联网检索与正文抓取：内置共享技能 web-search / web-fetch / web-browse 的执行底座。
  tools.push(...buildWebTools(deps.web));

  // 定时任务：调度器由工作区注入，未接上时这个工具压根不出现在清单里。
  const cron = deps.getCron?.();
  if (cron) {
    tools.push(...buildCronTools({ cron, bus: deps.bus, member, ownerId: deps.userId }));
  }

  return applyRunScope(tools, deps.runScope);
}
