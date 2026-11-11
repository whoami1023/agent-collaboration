import type { LlmEvent, LlmProvider, LlmRequest } from "./types";

export interface MockTurn {
  /** 推理模型的思考过程：只作为事件下发，不进入正文与上下文。 */
  reasoning?: string;
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** 覆盖 done 事件的 stopReason：测截断续写时给 length / max_tokens。 */
  finishReason?: string;
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
  readonly id: string;
  private callCounter = 0;

  constructor(private readonly handler: MockHandler, id = "mock") {
    this.id = id;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    if (request.signal?.aborted) throw abortError();
    const turn = await this.handler(request);
    this.callCounter += 1;
    const reasoning = turn.reasoning ?? "";
    for (let index = 0; index < reasoning.length; index += 6) {
      if (request.signal?.aborted) throw abortError();
      yield { type: "reasoning", delta: reasoning.slice(index, index + 6) };
      await sleep(1);
    }
    const text = turn.text ?? "";
    for (let index = 0; index < text.length; index += 6) {
      if (request.signal?.aborted) throw abortError();
      yield { type: "text", delta: text.slice(index, index + 6) };
      await sleep(1);
    }
    const promptChars = request.messages.reduce((total, message) => total + message.content.length, 0);
    yield {
      type: "usage",
      usage: {
        input: Math.ceil(promptChars / 4),
        output: Math.ceil(text.length / 4),
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    if (turn.toolCalls?.length) {
      const calls = turn.toolCalls.map((call, index) => ({
        id: `call_${this.callCounter}_${index}`,
        name: call.name,
        args: call.args,
      }));
      yield { type: "tool-calls", calls };
      yield { type: "done", stopReason: turn.finishReason ?? "tool_calls" };
      return;
    }
    yield { type: "done", stopReason: turn.finishReason ?? "stop" };
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

const DEMO_DOC = `# 多智能体协同框架调度方式对比

## 一、三类调度方式

| 方式 | 控制流 | 可观测性 | 适用场景 | 主要成本 |
| --- | --- | --- | --- | --- |
| 中心编排（orchestrator） | 主智能体分派、成员回报 | 每次唤醒与交付都有记录，消息可回放 | 需要稳定交付物的任务 | 编排逻辑需要维护 |
| 对等会话 | 成员之间自由 @ | 记录都堆在群聊里，没有明确的收口点 | 开放式讨论、头脑风暴 | 容易发散、难判定完成 |
| 事件总线 | 事件驱动，谁订阅谁响应 | 事件全量可查，链路追踪较绕 | 高并发、弹性要求高的场景 | 调试与回溯成本最高 |

## 二、选型建议

以「消息可回放 + 每次唤醒有记录」为验收标准衡量，中心编排 + 共享房间事件最稳：
分派路径唯一，状态收敛清楚，交付物能挂回任务卡。对等会话适合讨论不适合交付；
纯事件总线弹性最好，但排查一次跨成员的问题需要重建整条事件链。

## 三、局限与存疑

样本只覆盖 3 个框架，缺少长任务（>30 分钟）的压测数据；
以上结论基于公开实现与文档，未做同等规模的基准测试。
`;

export function demoHandler(): MockHandler {
  return (request) => {
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";
    const isMain = system.includes("里的主智能体");
    const userText = lastUserText(request);
    const steps = assistantSteps(request);

    // 持续审计的模型调用：演示模型也返回严格 JSON，方便本地看完整链路。
    if (system.includes("独立的任务审计员")) {
      const hasFiles =
        userText.includes("=== 文件：") &&
        !userText.includes("（未提供正文）") &&
        !userText.includes("（无成果文件）");
      return {
        text: JSON.stringify({
          criteria: [
            hasFiles
              ? {
                  criterion: "任务成果已经落盘",
                  verdict: "pass",
                  evidence: "成果文件摘录里给出了文件正文",
                  fix_hint: "",
                }
              : {
                  criterion: "任务成果已经落盘",
                  verdict: "fail",
                  evidence: "证据里没有成果文件",
                  fix_hint: "先把成果写入文件工作区，再在群里说明证据",
                },
          ],
        }),
      };
    }

    if (isMain) {
      if (userText.includes("交回了结果")) {
        return { text: "已收到成员报告，核对证据后给用户综合结论。" };
      }
      if (steps === 0) {
        return {
          reasoning:
            "先拆解任务：确认要对比的框架范围与验收口径，建卡并把资料工作交给成员，最后汇总证据。",
          toolCalls: [
            {
              name: "task_create",
              args: {
                title: "调研多智能体协同框架",
                detail:
                  "调研 2026 年多智能体协同框架的主流调度方式（中心编排 / 对等会话 / 事件总线），输出对比表与选型建议。",
                acceptance: "files/多智能体调度方式对比.md 存在，且含三类调度方式的对比与选型建议",
              },
            },
          ],
        };
      }
      if (steps === 1) {
        const taskId = findTaskId(request);
        if (taskId) {
          return { toolCalls: [{ name: "task_update", args: { task_id: taskId, status: "doing" } }] };
        }
      }
      if (steps === 2) {
        return {
          toolCalls: [
            {
              name: "file_write",
              args: {
                path: "多智能体调度方式对比.md",
                content: DEMO_DOC,
              },
            },
          ],
        };
      }
      if (steps === 3) {
        const taskId = findTaskId(request);
        if (taskId) {
          return {
            toolCalls: [
              {
                name: "task_attach_artifact",
                args: {
                  task_id: taskId,
                  name: "多智能体调度方式对比.md",
                  path: "多智能体调度方式对比.md",
                  summary: "中心编排 / 对等会话 / 事件总线 三类调度方式的对比与选型建议",
                },
              },
              {
                name: "task_update",
                args: {
                  task_id: taskId,
                  status: "done",
                  verify_kind: "file",
                  verify_handle: "多智能体调度方式对比.md",
                },
              },
            ],
          };
        }
      }
      return {
        reasoning:
          "对照任务卡的验收标准检查交付物：确认文件已落盘、证据完整，再把结论归纳成三段。",
        text:
          "**结论**：三种调度方式里，中心编排（orchestrator）+ 共享房间事件最稳；对等会话适合开放式讨论但不适合交付；纯事件总线弹性最好，调试成本最高。\n\n**证据**：对比了中心编排、对等会话、事件总线三类实现，均以「消息可回放 + 每次唤醒有记录」为验收标准。\n\n**未解决**：样本只覆盖 3 个框架，缺少长任务（>30 分钟）的压测数据。",
      };
    }

    return { text: "收到，我按任务简报执行。" };
  };
}
