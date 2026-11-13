// 执行前审批闸门：识别高风险工具调用，需要时生成审批卡并挂起本轮运行。
//
// 与 ask_user 共用同一套挂起/恢复链路（QuestionStore + ToolSuspension），
// 但审批调用本身不写工具结果：回答后从运行日志重放该调用，再按允许/拒绝执行。

import {
  APPROVAL_OPTIONS,
  approvalRuleFor,
  classifyApprovalAction,
  decideApproval,
  type ApprovalAction,
  type ApprovalGrant,
  type ApprovalSettings,
} from "../core/approvals";
import type { Settings } from "../core/settings";
import type { RoomBus } from "./bus";
import type { QuestionStore } from "./questions";
import type { ToolCall } from "../provider/types";
import type { ToolImpl } from "../agent/loop";
import type { ToolSuspension } from "../agent/loop";

export type ApprovalGateResult =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "suspend"; suspension: ToolSuspension };

export interface ApprovalGateDeps {
  roomId: string;
  bus: RoomBus;
  questions: QuestionStore;
  getSettings(): Settings;
  setSettings(next: Settings): Promise<void>;
  now?(): number;
}

function messageOf(action: ApprovalAction): string {
  return [
    "【需要你批准】",
    `${action.label}：${action.preview.replace(/\s+/g, " ").slice(0, 600)}`,
    "请在卡片里选择允许或拒绝；拒绝后智能体会换一种做法。",
  ].join("\n");
}

function questionText(action: ApprovalAction): string {
  const preview = action.preview.replace(/\s+/g, " ").slice(0, 380);
  return `${action.label}：${preview}${action.preview.length > 380 ? "…" : ""}\n批准这次操作吗？`;
}

export class ApprovalGate {
  private readonly deps: ApprovalGateDeps;
  /** 本轮 + 调用 → 审批问题；进程重启后可从问题记录里恢复。 */
  private readonly pending = new Map<string, string>();
  private readonly grants: ApprovalGrant[] = [];

  constructor(deps: ApprovalGateDeps) {
    this.deps = deps;
  }

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private key(runId: string, callId: string): string {
    return `${runId}\u0000${callId}`;
  }

  private findQuestion(runId: string, callId: string) {
    return this.deps.questions
      .list()
      .find(
        (item) =>
          item.approval?.runId === runId &&
          item.approval?.callId === callId &&
          (item.status === "open" || item.status === "answered" || item.status === "canceled"),
      );
  }

  private actionOf(call: ToolCall): ApprovalAction | null {
    return classifyApprovalAction(call.name, call.args);
  }

  /** 该调用是否正通过审批卡挂起（续跑时用来重放未执行的调用）。 */
  canResume(runId: string, call: ToolCall): boolean {
    return this.findQuestion(runId, call.id) !== undefined;
  }

  async check(input: {
    runId: string;
    memberId: string;
    memberName: string;
    call: ToolCall;
    tool?: ToolImpl;
  }): Promise<ApprovalGateResult> {
    const action = this.actionOf(input.call);
    if (!action) return { action: "allow" };
    if (!input.tool) return { action: "allow" };

    const question = this.findQuestion(input.runId, input.call.id);
    if (question && question.status === "open") {
      return {
        action: "suspend",
        suspension: {
          kind: "awaiting_user",
          questionId: question.id,
          messageId: question.messageId,
        },
      };
    }
    if (question && question.status === "answered") {
      return this.resolveAnswer(question);
    }
    if (question && question.status === "canceled") {
      this.pending.delete(this.key(input.runId, input.call.id));
      return { action: "deny", reason: "审批已取消，本次操作未执行。" };
    }

    const behavior = decideApproval(this.deps.getSettings().approvals, action, this.grants);
    if (behavior === "allow") return { action: "allow" };
    if (behavior === "deny") {
      return {
        action: "deny",
        reason: `当前审批设置拒绝了${action.label}，本次操作未执行。不要重试，请向用户说明。`,
      };
    }

    // 需要审批：先落一条问题消息，再挂起；不写工具结果，续跑时重放这次调用。
    const message = this.deps.bus.append({
      senderId: input.memberId,
      senderName: input.memberName,
      senderKind: "member",
      kind: "question",
      text: messageOf(action),
      mentions: [],
      depthTurn: 0,
      runId: input.runId,
    });
    const item = this.deps.questions.ask({
      messageId: message.id,
      askerId: input.memberId,
      askerName: input.memberName,
      title: `审批：${action.label}`,
      questions: [
        {
          id: "decision",
          question: questionText(action),
          options: APPROVAL_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
        },
      ],
      urgency: "routine",
      unblocks: "批准后会继续执行这次操作；拒绝后智能体会换一种做法。",
      approval: {
        category: action.category,
        tool: action.tool,
        scope: action.scope,
        label: action.label,
        preview: action.preview,
        runId: input.runId,
        callId: input.call.id,
        memberId: input.memberId,
      },
    });
    this.pending.set(this.key(input.runId, input.call.id), item.id);
    return {
      action: "suspend",
      suspension: { kind: "awaiting_user", questionId: item.id, messageId: message.id },
    };
  }

  /** 回答已经落库：记录本会话/始终允许，再返回允许或拒绝。 */
  private async resolveAnswer(question: ReturnType<QuestionStore["get"]>): Promise<ApprovalGateResult> {
    if (!question || !question.approval) return { action: "deny", reason: "审批记录缺失，本次操作未执行。" };
    const answer = question.answers["decision"];
    const option = answer?.optionId;
    const payload = question.approval;
    this.pending.delete(this.key(payload.runId, payload.callId));
    if (option === "deny") {
      return { action: "deny", reason: "用户拒绝了本次操作，未执行。不要重试，请换一种做法或向用户说明。" };
    }
    if (option !== "allow_once" && option !== "allow_conversation" && option !== "allow_always") {
      return { action: "deny", reason: "审批没有明确允许，本次操作未执行。" };
    }
    if (option === "allow_conversation") {
      const grant: ApprovalGrant = {
        tool: payload.tool,
        category: payload.category,
        scope: payload.scope,
      };
      if (!this.grants.some((item) => item.tool === grant.tool && item.category === grant.category && item.scope === grant.scope)) {
        this.grants.push(grant);
      }
    }
    if (option === "allow_always") {
      const current = this.deps.getSettings();
      const exists = current.approvals.rules.some(
        (rule) =>
          rule.tool === payload.tool &&
          rule.category === payload.category &&
          (rule.scope === "" || rule.scope === payload.scope),
      );
      if (!exists) {
        const action: ApprovalAction = {
          category: payload.category,
          tool: payload.tool,
          scope: payload.scope,
          label: payload.label,
          preview: payload.preview,
        };
        const next: Settings = {
          ...current,
          approvals: {
            categories: { ...current.approvals.categories },
            rules: [...current.approvals.rules, approvalRuleFor(action, this.now)],
          },
        };
        await this.deps.setSettings(next).catch(() => undefined);
      }
    }
    return { action: "allow" };
  }

  /** 设置面板保存后清掉已不再匹配的本会话授权（始终允许由设置本身决定）。 */
  syncGrants(settings: ApprovalSettings): void {
    for (let index = this.grants.length - 1; index >= 0; index -= 1) {
      if (settings.categories[this.grants[index]!.category] === "deny") this.grants.splice(index, 1);
    }
  }
}
