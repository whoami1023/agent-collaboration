// 学习层的落盘账本：待确认的记忆提案 + 复盘流水，落在各账号工作区的 learning.json。
// 读写口径与 ModelUsageStore 一致（懒加载 + 写链 + 延迟落盘），删号随工作区目录一起清掉。

import { readJson, writeJsonAtomic } from "../../store/persist";
import { LEARNING_RULES, type MemoryProposal, type ProposalStatus, type ReviewLog } from "./types";

interface LearningData {
  proposals: MemoryProposal[];
  log: ReviewLog[];
}

const EMPTY: LearningData = { proposals: [], log: [] };

function isProposal(value: unknown): value is MemoryProposal {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.content === "string" &&
    (record.status === "pending" || record.status === "applied" || record.status === "dismissed")
  );
}

function isLog(value: unknown): value is ReviewLog {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.at === "number" && typeof record.outcome === "string";
}

/** UTC 自然日键：每日复盘上限按它统计。 */
export function dayKeyOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class LearningStore {
  private data: LearningData = { proposals: [], log: [] };
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= (async () => {
      try {
        const parsed = await readJson<Partial<LearningData> | null>(this.file, null);
        const proposals = parsed && Array.isArray(parsed.proposals) ? parsed.proposals : [];
        const log = parsed && Array.isArray(parsed.log) ? parsed.log : [];
        this.data = { proposals: proposals.filter(isProposal), log: log.filter(isLog) };
      } catch (err) {
        this.onError(`学习账本读取失败：${err instanceof Error ? err.message : String(err)}`);
        this.data = structuredClone(EMPTY);
      }
      this.loaded = true;
    })();
    await this.loadPromise;
  }

  async listProposals(filter: { status?: ProposalStatus } = {}): Promise<MemoryProposal[]> {
    await this.ensureLoaded();
    const all = filter.status
      ? this.data.proposals.filter((proposal) => proposal.status === filter.status)
      : this.data.proposals;
    return [...all].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getProposal(id: string): Promise<MemoryProposal | undefined> {
    await this.ensureLoaded();
    return this.data.proposals.find((proposal) => proposal.id === id);
  }

  async addProposals(proposals: readonly MemoryProposal[]): Promise<void> {
    if (proposals.length === 0) return;
    await this.ensureLoaded();
    this.data.proposals = [...proposals, ...this.data.proposals].slice(0, LEARNING_RULES.maxProposals);
    this.schedulePersist();
  }

  async patchProposal(id: string, patch: Partial<MemoryProposal>): Promise<MemoryProposal | undefined> {
    await this.ensureLoaded();
    const current = this.data.proposals.find((proposal) => proposal.id === id);
    if (!current) return undefined;
    Object.assign(current, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return current;
  }

  async addLog(entry: ReviewLog): Promise<void> {
    await this.ensureLoaded();
    this.data.log = [entry, ...this.data.log].slice(0, LEARNING_RULES.maxLogEntries);
    this.schedulePersist();
  }

  async listLog(limit = 50): Promise<ReviewLog[]> {
    await this.ensureLoaded();
    return this.data.log.slice(0, Math.max(1, Math.min(LEARNING_RULES.maxLogEntries, limit)));
  }

  /** 今天（UTC）已经复盘过几次：用于每日成本上限。 */
  async reviewsToday(at = Date.now()): Promise<number> {
    await this.ensureLoaded();
    const day = dayKeyOf(at);
    return this.data.log.filter((entry) => dayKeyOf(entry.at) === day).length;
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(() =>
      writeJsonAtomic(this.file, this.data).catch((err: unknown) =>
        this.onError(`学习账本写入失败：${err instanceof Error ? err.message : String(err)}`),
      ),
    );
  }

  /** 工作区关闭前把挂起的写入落完。 */
  async flush(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}
