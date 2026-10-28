import type { LlmEvent, LlmProvider, LlmRequest } from "./types";

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export type MockHandler = (request: LlmRequest) => MockTurn | Promise<MockTurn>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

export class MockProvider implements LlmProvider {
  readonly id = "mock";
  private callCounter = 0;

  constructor(private readonly handler: MockHandler) {}

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    if (request.signal?.aborted) throw abortError();
    const turn = await this.handler(request);
    this.callCounter += 1;
    const text = turn.text ?? "";
    for (let index = 0; index < text.length; index += 6) {
      if (request.signal?.aborted) throw abortError();
      yield { type: "text", delta: text.slice(index, index + 6) };
      await sleep(1);
    }
    if (turn.toolCalls?.length) {
      const calls = turn.toolCalls.map((call, index) => ({
        id: `call_${this.callCounter}_${index}`,
        name: call.name,
        args: call.args,
      }));
      yield { type: "tool-calls", calls };
      yield { type: "done", stopReason: "tool_calls" };
      return;
    }
    yield { type: "done", stopReason: "stop" };
  }
}

function assistantSteps(request: LlmRequest): number {
  return request.messages.filter((m) => m.role === "assistant").length;
}

function lastUserText(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role === "user") return message.content;
  }
  return "";
}

function findTaskId(request: LlmRequest): string | undefined {
  for (const message of request.messages) {
    const match = /任务\s+(task_[A-Za-z0-9]+)/.exec(message.content);
    if (match) return match[1];
  }
  return undefined;
}

export function demoHandler(): MockHandler {
  return (request) => {
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";
    const isMain = system.includes("里的主智能体");
    const userText = lastUserText(request);
    const steps = assistantSteps(request);

    if (isMain) {
      if (userText.includes("交回了结果")) {
        return {
          text:
            "研究员已交回报告。\n\n**综合结论**：小团队协同优先用「中心编排 + 事件总线」——主智能体拆解任务、@ 派发，成员把自己的结论写回同一个房间，父级被动唤醒后汇总。优点是可审计、可中断；对等会话适合成员之间需要长期谈判的场景，但难以防环。\n\n**证据**：研究员报告已归档在任务卡成果区。\n\n**未解决**：跨房间的成员复用还没做。",
        };
      }
      if (steps === 0) {
        return {
          toolCalls: [
            {
              name: "spawn_member",
              args: {
                name: "研究员",
                task:
                  "调研 2026 年多智能体协同框架的主流调度方式（中心编排 / 对等会话 / 事件总线），输出对比表与选型建议。",
                context_mode: "isolated",
              },
            },
          ],
        };
      }
      if (steps === 1) {
        return { text: "已派给研究员，等它的调研报告回来我再汇总。" };
      }
      return { text: "收到。" };
    }

    if (userText.includes("调研 2026 年多智能体协同框架")) {
      const taskId = findTaskId(request);
      if (taskId && steps === 0) {
        return { toolCalls: [{ name: "task_update", args: { task_id: taskId, status: "doing" } }] };
      }
      if (taskId && steps === 1) {
        return {
          toolCalls: [
            {
              name: "task_attach_artifact",
              args: {
                task_id: taskId,
                name: "多智能体调度方式对比.md",
                summary: "中心编排 / 对等会话 / 事件总线 三类调度方式的对比与选型建议",
              },
            },
            { name: "task_update", args: { task_id: taskId, status: "done" } },
          ],
        };
      }
      return {
        text:
          "**结论**：三种调度方式里，中心编排（orchestrator）+ 共享房间事件最稳；对等会话适合开放式讨论但不适合交付；纯事件总线弹性最好，调试成本最高。\n\n**证据**：对比了中心编排、对等会话、事件总线三类实现，均以「消息可回放 + 每次唤醒有记录」为验收标准。\n\n**未解决**：样本只覆盖 3 个框架，缺少长任务（>30 分钟）的压测数据。",
      };
    }
    return { text: "收到，我按任务简报执行。" };
  };
}
