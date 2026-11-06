/**
 * 房间分流（移植 Hermes 的 `ROUTING_MODES = everyone|lead|auto`）。
 *
 * 这个文件只放**纯判定**：谁能被挑、该不该挑、挑出来的文本怎么算数。
 * 真正发起那次小模型调用的是 Orchestrator——它才知道群现在停没停、这条消息还新不新。
 *
 * 三条规则都刻意保持便宜：分流只看最近几条、每行截断、输出封顶；挑不出来就回落到主智能体，
 * 因此任何一次分流失败都不会让用户的话没人接。
 */

import type { Member, RoomMessage, RoomRoutingMode } from "../core/types";
import type { LlmMessage } from "../provider/types";

export const ROUTING_LIMITS = {
  /** 分流只看最近 5 条消息：判断「这该谁接」不需要全文，喂多了只是贵。 */
  recentMessages: 5,
  /** 每条截 600 字符，成员职责截 300 字符。 */
  messageChars: 600,
  briefChars: 300,
  /** 一条消息最多挑 6 个人——再多就不叫分流，叫广播。 */
  maxPicks: 6,
  /** 少于 2 个候选成员时不分流：没有可选的人，这一次调用纯属浪费。 */
  minCandidates: 2,
  /** 每条成员发言最多再拉 2 个「被点名但还没开口」的同伴进下一轮。 */
  maxPeerPull: 2,
  /** 分流的输出与时间上限：它必须比正文便宜一个数量级。 */
  maxTokens: 200,
  timeoutMs: 20_000,
} as const;

/**
 * 分流的契约。刻意写成「只回一个 JSON 对象」：解析失败就等于没挑出来，
 * 回落路径是确定性的，不依赖模型配合。
 */
export const ROUTER_SYSTEM_PROMPT = `你在一个「用户 + 若干 AI 助手」的群聊里做分流。
判断用户刚发的这条消息该由哪些成员接手：只挑职责或专业领域与这条消息直接有关的成员，无关的不要挑。
只有当这条消息明显是整个群的消息（打招呼、向所有人提问、每个成员都要出一份力）时，才选所有人。
不要仅仅为了让某个成员附和或复述别人的话而选它。
成员的名字只能照抄下面花名册里的写法。
只回复一个 JSON 对象，不要有任何其它文字，例如：
{"members": ["名字1", "名字2"]}
或
{"members": "everyone"}`;

/** 切换取人方式时播报给用户的一句话：说清从现在起规则怎么变，而不是只报一个名字。 */
export const ROUTING_SWITCH_NOTICES: Record<RoomRoutingMode, string> = {
  lead: "没点名的消息交给主智能体，由它拆解与 @ 分派；显式 @ 照旧直接找到那个人。",
  everyone:
    "没点名的消息会同时唤醒在场的成员（最多 6 人），与自己无关的成员回一个 pass 就保持沉默；主智能体仍在场兜底。",
  auto: "没点名的消息先由一次不带工具的小调用从花名册里挑人（最多 6 人），挑不出来或调用失败就交回主智能体。",
};

/** 按房间取人方式筛出可被挑中的成员：已取消的、自己都不算。 */
export function routingCandidates(message: RoomMessage, members: Member[]): Member[] {
  return members.filter(
    (member) =>
      member.status !== "cancelled" &&
      member.id !== message.senderId &&
      // 计划轮（以及以后任何只读姿态）里，智能体发的消息不能把成员拉进来干活。
      !(message.runScope && message.senderKind !== "user"),
  );
}

/**
 * 该不该花这一次分流调用（对应 Hermes 的确定性旁路顺序，命中一条就按 lead 处理）：
 * 用户已经 @ 过人就不用挑；定时/系统/成员消息没有「该谁接」这个问题；计划轮不该派活。
 */
export function routingNeeded(
  message: RoomMessage,
  routing: RoomRoutingMode,
  candidates: readonly Member[],
): boolean {
  if (routing !== "auto") return false;
  if (message.senderKind !== "user") return false;
  if (message.mentions.length > 0) return false;
  if (message.runScope) return false;
  if (message.text.trim().length === 0) return false;
  return candidates.length >= ROUTING_LIMITS.minCandidates;
}

/**
 * 轮转顺序（移植 Hermes 的 `shift = round % n`）：同一个名单每轮从不同的人开始，
 * 并发槽位按这个顺序发放，总让同一个人先开口的情况就不会出现。
 */
export function rotateBy<T>(items: readonly T[], salt: number): T[] {
  if (items.length === 0) return [];
  const shift = Math.abs(Math.trunc(salt)) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/** everyone：这条消息在场的人都算被点名，不相关的人用 pass 表态（见 isPassText）。 */
export function everyonePicks(candidates: readonly Member[], salt: number): string[] {
  return rotateBy(candidates, salt)
    .slice(0, ROUTING_LIMITS.maxPicks)
    .map((member) => member.id);
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 分流的输入：花名册 + 最近几条，每条截断。不带工具、不带系统提示词之外的任何东西。 */
export function buildRouterMessages(input: {
  message: RoomMessage;
  candidates: readonly Member[];
  recent: readonly RoomMessage[];
}): LlmMessage[] {
  const roster = input.candidates.map((member) => {
    const brief = clip(member.brief ?? "", ROUTING_LIMITS.briefChars);
    const skills = member.skillNames?.length ? `；技能：${member.skillNames.join("、")}` : "";
    return `- ${member.name}${member.role === "main" ? "（主智能体）" : ""}${brief ? `：${brief}` : ""}${skills}`;
  });
  const recent = input.recent
    .filter((message) => message.id !== input.message.id)
    .slice(-ROUTING_LIMITS.recentMessages)
    .map(
      (message) =>
        `${message.senderKind === "user" ? "用户" : `成员 ${message.senderName}`}：` +
        clip(message.text, ROUTING_LIMITS.messageChars),
    );
  const user = [
    "群成员花名册：",
    ...roster,
    "",
    ...(recent.length > 0 ? ["最近的消息：", ...recent, ""] : []),
    `用户刚发的消息：${clip(input.message.text, ROUTING_LIMITS.messageChars)}`,
    "",
    "该由哪些成员接手？只回复那个 JSON 对象。",
  ].join("\n");
  return [
    { role: "system", content: ROUTER_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

function matchCandidate(handle: string, candidates: readonly Member[]): Member | undefined {
  const wanted = normalizeHandle(handle).toLowerCase();
  if (!wanted) return undefined;
  return candidates.find((member) => member.name.toLowerCase() === wanted);
}

/**
 * 严格解析分流答复：顶层必须是只含 `members` 一个键的对象，值是 `"everyone"` 或字符串数组。
 * 任何不合规（多键、数组、夹带解释文字、名字全都不认识）都返回 undefined，由调用方回落。
 * `//` 与 ```json 包裹这类无害包装先剥掉。
 */
export function parseRouterPicks(
  text: string,
  candidates: readonly Member[],
): string[] | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("members" in record)) return undefined;
  const value = record.members;
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "everyone"
      ? everyonePicks(candidates, 0)
      : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (normalizeHandle(item).toLowerCase() === "everyone") return everyonePicks(candidates, 0);
    const member = matchCandidate(item, candidates);
    if (!member || ids.includes(member.id)) continue;
    ids.push(member.id);
    if (ids.length >= ROUTING_LIMITS.maxPicks) break;
  }
  return ids.length > 0 ? ids : undefined;
}

/**
 * 文本里点了名字、却没 @ 到的成员（移植 Hermes 的 `_unaddressed_member_mentions`）：
 * 讨论里顺嘴提的那位往往正是该接话的人。名字少于两字的成员不参与匹配，免得把常用词当人名。
 */
export function citedPeerIds(
  text: string,
  candidates: readonly Member[],
  already: ReadonlySet<string>,
): string[] {
  const lower = text.toLowerCase();
  const picked: string[] = [];
  for (const member of candidates) {
    const name = member.name.trim();
    if (name.length < 2 || already.has(member.id)) continue;
    if (lower.includes(name.toLowerCase())) picked.push(member.id);
    if (picked.length >= ROUTING_LIMITS.maxPeerPull) break;
  }
  return picked;
}

/**
 * pass（移植 Hermes 的 `is_pass_text`）：成员用这一个词表示「这轮我沉默，群里不发我这条」。
 * 被点名的成员不适用——那是派下来的活，不是可以自己躲开的广播。
 * 括号与句点允许中英文两种写法：模型回「（pass）」和回「pass」是同一个意思。
 */
const PASS_RE = /^[([{（【]?\s*pass\s*[)\]}）】]?[.。!！]*$/i;

export function isPassText(text: string): boolean {
  return PASS_RE.test(text.trim());
}
