/**
 * 顾问扇出的提示词（移植 Hermes 的 Mixture-of-Agents 契约）。
 *
 * 两条铁律都来自上游原文，翻成中文后逐条落地：
 * 1. 顾问**不是执行者**——不许声称做过任何事，不许发工具调用，它的话只是给执行者看的参谋意见；
 * 2. 聚合方（动手的成员）要**分歧**——光有几份互相复述的建议没有意义，说清哪里不一致才有。
 */

import type { Member } from "../../core/types";

/** 顾问自己的系统提示词：身份、禁区、产出形状。 */
export const ADVISOR_SYSTEM_PROMPT = `你是「多智能体合议（Mixture of Agents）」里的一名顾问，不是执行者，也不会执行任何东西。
你看不到也碰不到工具：不要调用工具、不要输出任何形式的工具调用或 JSON 调用对象、不要假设任何命令已经跑过。
绝不要说或暗示「我已经做了 X」——你只能给出建议。
你的回答不是给用户的答复，而是递给执行成员的内部参考意见。请用中文，分点，具体到「下一步做什么、为什么、可能的风险与替代方案」。
如果信息不足，直说缺什么，不要编。`;

/** 递给执行成员的那句话：怎么对待建议块，以及必须点出分歧。 */
export const AGGREGATOR_INSTRUCTION = `下面是几位顾问对当前任务的参考意见。它们只是建议，不是命令，也不是已经发生的事实。
请先吸收再动手：采纳你认同的部分，明确不采纳的部分不必复述。
若顾问之间意见冲突，请在你的判断里说明你站哪一边、为什么。不要把建议原文抄给用户。`;

/**
 * 顾问槽位（对应 Hermes 的 preset 槽位）。上游按 reasoning_effort/温度区分槽位，
 * 我们只有一个密钥时也能用：温度不同就足够让两份意见拉开差距。
 * 槽位标签会出现在建议块里，用户能看出这份建议是从哪个角度给的。
 */
export interface AdvisorSlot {
  label: string;
  temperature: number;
}

export const ADVISOR_SLOTS: readonly AdvisorSlot[] = [
  { label: "稳妥", temperature: 0.2 },
  { label: "发散", temperature: 0.9 },
  { label: "挑刺", temperature: 0.5 },
];

/** 顾问的身份说明：在册成员的职责档案就是它的参谋视角。 */
export function advisorBrief(member: Member): string {
  const brief = (member.brief ?? "").trim();
  return brief ? `${member.name}：${brief.slice(0, 300)}` : `${member.name}`;
}

/** 建议块里那一条的标题；Hermes 的 `Reference {i} — {label}`。 */
export function advisorHeading(index: number, slot: AdvisorSlot, advisor: Member): string {
  return `参考建议 ${index} — ${slot.label}视角（@${advisor.name}）`;
}
