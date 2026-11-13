/**
 * 结构化提问：把「智能体在等人回答」变成一条持久、可追踪、可回灌的决策行。
 *
 * 机制参考 OpenRig 的 human questions（Apache-2.0）：1–4 个问题、每问 2–4 个选项、最多一个推荐项；
 * 逐题记录选择或文本，全部问题都有答案才算完成。与聊天文本的区别：答案有归属、有状态、答完会回到提问者。
 */
import { newId } from "../core/ids";

export type QuestionStatus = "open" | "answered" | "canceled";
export type QuestionUrgency = "routine" | "urgent" | "critical";

export const QUESTION_URGENCIES: readonly QuestionUrgency[] = ["routine", "urgent", "critical"];
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_QUESTION_CHARS = 500;
export const MAX_OPTION_LABEL_CHARS = 75;
export const MAX_ANSWER_TEXT_CHARS = 2_000;
export const MAX_QUESTION_ITEMS = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface QuestionOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface QuestionField {
  id: string;
  question: string;
  options: QuestionOption[];
}

export interface QuestionAnswer {
  /** 选了哪个选项；自由回答时没有。 */
  optionId?: string;
  /** 自由文本回答。 */
  text?: string;
  answeredAt: number;
  by: string;
}

export interface QuestionTransition {
  at: number;
  from: QuestionStatus | null;
  to: QuestionStatus;
  by: string;
  note?: string;
}

/** 审批卡附带的动作信息：批准后由运行时据此执行被挂起的工具调用。 */
export interface ApprovalPayload {
  category: "command" | "delete" | "write";
  tool: string;
  scope: string;
  label: string;
  preview: string;
  runId: string;
  callId: string;
  memberId: string;
}

export interface QuestionItem {
  id: string;
  roomId: string;
  /** 提问消息的 id：界面按它把卡片挂在对应气泡下。 */
  messageId: string;
  createdAt: number;
  updatedAt: number;
  askerId: string;
  askerName: string;
  title: string;
  questions: QuestionField[];
  answers: Record<string, QuestionAnswer>;
  status: QuestionStatus;
  urgency: QuestionUrgency;
  /** 有它表示这是一张动作审批卡，不是普通提问。 */
  approval?: ApprovalPayload;
  /** 答完能解锁什么：给用户判断优先级的上下文。 */
  unblocks?: string;
  answeredAt?: number;
  answeredBy?: string;
  transitions: QuestionTransition[];
}

export type ParseQuestions =
  | { ok: true; questions: QuestionField[] }
  | { ok: false; error: string };

/** 作者提交的问题组：数量、id、题干、选项与推荐项都按上限校验，只保留认识的字段。 */
export function parseQuestionFields(value: unknown): ParseQuestions {
  if (!Array.isArray(value)) return { ok: false, error: "questions 必须是数组" };
  if (value.length < 1 || value.length > MAX_QUESTIONS) {
    return { ok: false, error: `一次提问 ${1}–${MAX_QUESTIONS} 个问题（收到 ${value.length} 个）` };
  }
  const questionIds = new Set<string>();
  const questions: QuestionField[] = [];
  for (const [questionIndex, raw] of value.entries()) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const where = `第 ${questionIndex + 1} 个问题`;
    if (typeof entry["id"] !== "string" || !ID_RE.test(entry["id"])) {
      return { ok: false, error: `${where}：id 需为 1–40 位字母、数字、- 或 _` };
    }
    if (questionIds.has(entry["id"])) {
      return { ok: false, error: `${where}：id "${entry["id"]}" 重复` };
    }
    questionIds.add(entry["id"]);
    if (typeof entry["question"] !== "string" || !entry["question"].trim()) {
      return { ok: false, error: `${where}：question 不能为空` };
    }
    const questionText = entry["question"].trim();
    if (questionText.length > MAX_QUESTION_CHARS) {
      return { ok: false, error: `${where}：题干不能超过 ${MAX_QUESTION_CHARS} 字` };
    }
    if (!Array.isArray(entry["options"]) || entry["options"].length < MIN_OPTIONS || entry["options"].length > MAX_OPTIONS) {
      return { ok: false, error: `${where}：给 ${MIN_OPTIONS}–${MAX_OPTIONS} 个选项` };
    }
    const optionIds = new Set<string>();
    const options: QuestionOption[] = [];
    let recommended = 0;
    for (const [optionIndex, rawOption] of (entry["options"] as unknown[]).entries()) {
      const option = (rawOption ?? {}) as Record<string, unknown>;
      const optionWhere = `${where} 选项 ${optionIndex + 1}`;
      if (typeof option["id"] !== "string" || !ID_RE.test(option["id"])) {
        return { ok: false, error: `${optionWhere}：id 不合法` };
      }
      if (optionIds.has(option["id"])) {
        return { ok: false, error: `${optionWhere}：id "${option["id"]}" 重复` };
      }
      optionIds.add(option["id"]);
      if (typeof option["label"] !== "string" || !option["label"].trim()) {
        return { ok: false, error: `${optionWhere}：label 不能为空` };
      }
      const label = option["label"].trim();
      if (label.length > MAX_OPTION_LABEL_CHARS) {
        return { ok: false, error: `${optionWhere}：选项不能超过 ${MAX_OPTION_LABEL_CHARS} 字` };
      }
      if (option["recommended"] !== undefined && typeof option["recommended"] !== "boolean") {
        return { ok: false, error: `${optionWhere}：recommended 只能是 true/false` };
      }
      const isRecommended = option["recommended"] === true;
      if (isRecommended) recommended += 1;
      options.push(isRecommended ? { id: option["id"], label, recommended: true } : { id: option["id"], label });
    }
    if (recommended > 1) return { ok: false, error: `${where}：最多标一个推荐项` };
    questions.push({ id: entry["id"], question: questionText, options });
  }
  return { ok: true, questions };
}

export type RecordAnswerResult =
  | { status: "recorded"; item: QuestionItem; complete: boolean }
  | { status: "not-applicable"; reason: string };

export interface QuestionStoreOptions {
  now?: () => number;
  onChange?: (item: QuestionItem) => void;
  maxItems?: number;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isField(value: unknown): value is QuestionField {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw["id"] === "string" && typeof raw["question"] === "string" && Array.isArray(raw["options"]);
}

function hydrateApproval(value: unknown): ApprovalPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw["category"] !== "command" && raw["category"] !== "delete" && raw["category"] !== "write") ||
    typeof raw["tool"] !== "string" ||
    typeof raw["scope"] !== "string" ||
    typeof raw["label"] !== "string" ||
    typeof raw["preview"] !== "string" ||
    typeof raw["runId"] !== "string" ||
    typeof raw["callId"] !== "string" ||
    typeof raw["memberId"] !== "string"
  ) {
    return undefined;
  }
  return {
    category: raw["category"],
    tool: raw["tool"],
    scope: raw["scope"],
    label: raw["label"],
    preview: raw["preview"],
    runId: raw["runId"],
    callId: raw["callId"],
    memberId: raw["memberId"],
  };
}

export class QuestionStore {
  private items: QuestionItem[] = [];
  private readonly now: () => number;
  private readonly onChange: (item: QuestionItem) => void;
  private readonly maxItems: number;

  constructor(
    readonly roomId: string,
    options: QuestionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.onChange = options.onChange ?? (() => undefined);
    this.maxItems = options.maxItems ?? MAX_QUESTION_ITEMS;
  }

  hydrate(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const restored: QuestionItem[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const rawItem = entry as Record<string, unknown>;
      if (typeof rawItem["id"] !== "string" || typeof rawItem["messageId"] !== "string") continue;
      const parsed = parseQuestionFields(rawItem["questions"]);
      if (!parsed.ok) continue;
      const status = rawItem["status"];
      if (status !== "open" && status !== "answered" && status !== "canceled") continue;
      const createdAt = typeof rawItem["createdAt"] === "number" ? rawItem["createdAt"] : 0;
      const answersRaw = rawItem["answers"];
      const answers: Record<string, QuestionAnswer> = {};
      if (answersRaw && typeof answersRaw === "object") {
        for (const [fieldId, value] of Object.entries(answersRaw as Record<string, unknown>)) {
          if (!value || typeof value !== "object") continue;
          const answer = value as Record<string, unknown>;
          if (typeof answer["answeredAt"] !== "number" || typeof answer["by"] !== "string") continue;
          answers[fieldId] = {
            ...(typeof answer["optionId"] === "string" ? { optionId: answer["optionId"] } : {}),
            ...(typeof answer["text"] === "string" ? { text: answer["text"] } : {}),
            answeredAt: answer["answeredAt"],
            by: answer["by"],
          };
        }
      }
      const approval = hydrateApproval(rawItem["approval"]);
      restored.push({
        id: rawItem["id"],
        roomId: typeof rawItem["roomId"] === "string" ? rawItem["roomId"] : this.roomId,
        messageId: rawItem["messageId"],
        createdAt,
        updatedAt: typeof rawItem["updatedAt"] === "number" ? rawItem["updatedAt"] : createdAt,
        askerId: typeof rawItem["askerId"] === "string" ? rawItem["askerId"] : "unknown",
        askerName: typeof rawItem["askerName"] === "string" ? rawItem["askerName"] : "未知",
        title: typeof rawItem["title"] === "string" ? rawItem["title"] : parsed.questions[0]!.question,
        questions: parsed.questions,
        answers,
        status,
        urgency:
          rawItem["urgency"] === "urgent" || rawItem["urgency"] === "critical"
            ? rawItem["urgency"]
            : "routine",
        ...(approval ? { approval } : {}),
        ...(typeof rawItem["unblocks"] === "string" ? { unblocks: rawItem["unblocks"] } : {}),
        ...(typeof rawItem["answeredAt"] === "number" ? { answeredAt: rawItem["answeredAt"] } : {}),
        ...(typeof rawItem["answeredBy"] === "string" ? { answeredBy: rawItem["answeredBy"] } : {}),
        transitions: this.normalizeTransitions(rawItem["transitions"], status, createdAt),
      });
    }
    this.items = restored;
    this.trim();
  }

  /** 智能体发起提问：校验在调用方完成，这里只负责落一条 open 行并通知界面。 */
  ask(input: {
    messageId: string;
    askerId: string;
    askerName: string;
    title?: string;
    questions: QuestionField[];
    urgency?: QuestionUrgency;
    unblocks?: string;
    approval?: ApprovalPayload;
  }): QuestionItem {
    const at = this.now();
    const item: QuestionItem = {
      id: newId("ask"),
      roomId: this.roomId,
      messageId: input.messageId,
      createdAt: at,
      updatedAt: at,
      askerId: input.askerId,
      askerName: input.askerName,
      title: (input.title?.trim() || input.questions[0]!.question).slice(0, MAX_QUESTION_CHARS),
      questions: input.questions,
      answers: {},
      status: "open",
      urgency: input.urgency ?? "routine",
      ...(input.approval ? { approval: input.approval } : {}),
      ...(input.unblocks?.trim() ? { unblocks: input.unblocks.trim().slice(0, MAX_QUESTION_CHARS) } : {}),
      transitions: [{ at, from: null, to: "open", by: input.askerId, note: "发起提问" }],
    };
    this.items.push(item);
    this.trim();
    this.onChange(item);
    return item;
  }

  /**
   * 回答一个字段：选项必须存在，或给出非空文本；重复回答在完成前允许改写。
   * 全部字段都有答案时结算为 answered，本轮之后不再接受新答案。
   */
  answer(
    id: string,
    fieldId: string,
    payload: { optionId?: string; text?: string },
    by: string,
  ): RecordAnswerResult {
    const item = this.get(id);
    if (!item) return { status: "not-applicable", reason: "问题不存在" };
    if (item.status !== "open") return { status: "not-applicable", reason: "问题已经结束" };
    const field = item.questions.find((question) => question.id === fieldId);
    if (!field) return { status: "not-applicable", reason: "没有这个问题字段" };
    const optionId = payload.optionId?.trim();
    const text = payload.text?.trim();
    if (optionId) {
      if (!field.options.some((option) => option.id === optionId)) {
        return { status: "not-applicable", reason: "选项不存在" };
      }
    } else if (!text) {
      return { status: "not-applicable", reason: "必须选择选项或填写回答" };
    } else if (text.length > MAX_ANSWER_TEXT_CHARS) {
      return { status: "not-applicable", reason: `回答不能超过 ${MAX_ANSWER_TEXT_CHARS} 字` };
    }
    const at = this.now();
    item.answers[fieldId] = {
      ...(optionId ? { optionId } : {}),
      ...(!optionId && text ? { text: clip(text, MAX_ANSWER_TEXT_CHARS) } : {}),
      answeredAt: at,
      by,
    };
    item.updatedAt = at;
    const complete = item.questions.every((question) => item.answers[question.id] !== undefined);
    if (complete) {
      item.status = "answered";
      item.answeredAt = at;
      item.answeredBy = by;
      item.transitions.push({ at, from: "open", to: "answered", by, note: "全部问题已回答" });
    }
    this.onChange(item);
    return { status: "recorded", item, complete };
  }

  cancel(id: string, by: string, note: string): QuestionItem | null {
    const item = this.get(id);
    if (!item || item.status !== "open") return null;
    const at = this.now();
    item.status = "canceled";
    item.updatedAt = at;
    item.transitions.push({ at, from: "open", to: "canceled", by, note });
    this.onChange(item);
    return item;
  }

  cancelOpen(by: string, note: string): number {
    let canceled = 0;
    for (const item of this.items) {
      if (item.status === "open" && this.cancel(item.id, by, note)) canceled += 1;
    }
    return canceled;
  }

  get(id: string): QuestionItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  byMessage(messageId: string): QuestionItem | undefined {
    return this.items.find((item) => item.messageId === messageId);
  }

  open(): QuestionItem[] {
    return this.items.filter((item) => item.status === "open").sort((a, b) => a.createdAt - b.createdAt);
  }

  list(): QuestionItem[] {
    return [...this.items];
  }

  snapshot(): QuestionItem[] {
    return JSON.parse(JSON.stringify(this.items)) as QuestionItem[];
  }

  private trim(): void {
    const open = this.items.filter((item) => item.status === "open");
    const closed = this.items
      .filter((item) => item.status !== "open")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-this.maxItems);
    this.items = [...closed, ...open].sort((a, b) => a.createdAt - b.createdAt);
  }

  private normalizeTransitions(
    value: unknown,
    status: QuestionStatus,
    fallbackAt: number,
  ): QuestionTransition[] {
    if (!Array.isArray(value)) {
      return [{ at: fallbackAt, from: null, to: status, by: "system" }];
    }
    const transitions: QuestionTransition[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as Record<string, unknown>;
      const to = raw["to"];
      if (to !== "open" && to !== "answered" && to !== "canceled") continue;
      if (typeof raw["at"] !== "number") continue;
      const from =
        raw["from"] === "open" || raw["from"] === "answered" || raw["from"] === "canceled"
          ? raw["from"]
          : null;
      transitions.push({
        at: raw["at"],
        from,
        to,
        by: typeof raw["by"] === "string" ? raw["by"] : "system",
        ...(typeof raw["note"] === "string" ? { note: raw["note"] } : {}),
      });
    }
    return transitions;
  }
}

/** 选项 id → 可读文本；自由回答原样返回。 */
export function answerLabel(item: QuestionItem, field: QuestionField): string | undefined {
  const answer = item.answers[field.id];
  if (!answer) return undefined;
  if (answer.optionId) {
    return field.options.find((option) => option.id === answer.optionId)?.label ?? answer.optionId;
  }
  return answer.text;
}

/** 回答问题用的系统消息正文：给不支持卡片的客户端也能看懂的纯文本。 */
export function formatQuestionMessage(item: QuestionItem): string {
  const lines = [`【需要你回答】${item.title}`];
  if (item.unblocks) lines.push(`回答后可以继续：${item.unblocks}`);
  item.questions.forEach((field, index) => {
    lines.push(`${index + 1}. ${field.question}`);
    for (const option of field.options) {
      lines.push(`   - ${option.label}${option.recommended ? "（推荐）" : ""}`);
    }
  });
  lines.push("请在问题卡片里选择选项，或写下你的回答。");
  return lines.join("\n");
}

/** 回答完成后回灌给提问者的消息正文。 */
export function formatAnswerMessage(item: QuestionItem): string {
  const lines = [`【结构化回答】对「${item.title}」的回答：`];
  item.questions.forEach((field, index) => {
    lines.push(`${index + 1}. ${field.question} → ${answerLabel(item, field) ?? "（未回答）"}`);
  });
  return lines.join("\n");
}
