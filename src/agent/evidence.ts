/**
 * 本轮证据台账：交付闸门的核验依据。
 *
 * 移植自 Hermes 的 verification_evidence 思路——闸门只认「运行期真实发生过的事」，
 * 不认模型自述。台账由工具在成功返回的那一刻写入（文件落盘、命令退出码 0、成果登记），
 * 模型无法用一条消息伪造它；`task_update → done` 只能引用台账里查得通的条目。
 *
 * 每条记录都带一个「续跑句柄」（handle）：成员被「继续」唤醒、重新注册运行时，
 * 用 seed() 把上一段进展的指纹放回本轮，闸门才不会把续跑当成零证据。
 */
import type { TaskCard, TaskEvidenceKind, TaskEvidenceRecord } from "../core/types";
import type { WorkspaceFileListing } from "../files/workspace-files";

export type EvidenceKind = TaskEvidenceKind;
export type EvidenceRecord = TaskEvidenceRecord;

/** 留在卡片上的证据上限：再多也只是噪音，闸门只需要近期事实。 */
export const MAX_TASK_EVIDENCE = 40;

/** 命令指纹：压缩空白后取前 200 字符，避免同一条长脚本因为换行差异核不上。 */
export function commandHandle(command: string): string {
  return command.trim().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * 按证据类型规范化句柄。写入与查询走同一个函数，模型把命令里的空格敲多一个、
 * 或者把路径写成 files/ 开头，都不该被当成「这条证据不存在」而误拒。
 */
function normalizeHandle(kind: EvidenceKind, handle: string): string {
  if (kind === "command") return commandHandle(handle);
  if (kind === "file") return handle.trim().replace(/^files\//, "");
  return handle.trim();
}

export class EvidenceLedger {
  private readonly records: EvidenceRecord[] = [];

  constructor(private readonly maxRecords = 200) {}
  /**
   * 载入上一段进展的指纹（成员被「继续」唤醒、重新注册运行时）：
   * 把本房间里仍未完成的任务卡上留下的证据重新装回本轮，闸门才不会把续跑当成零证据。
   */
  seed(tasks: TaskCard[]): void {
    for (const task of tasks) {
      if (task.status === "done" || task.status === "failed") continue;
      for (const record of task.evidence ?? []) {
        if (!record || typeof record.handle !== "string" || !record.handle) continue;
        if (!isEvidenceKind(record.kind)) continue;
        this.push({ ...record });
      }
    }
  }

  /** 卡片上存量的证据（去重后合并进本轮台账），供 task 工具回写时使用。 */
  mergeInto(records: TaskEvidenceRecord[] | undefined): TaskEvidenceRecord[] {
    const merged = [...(records ?? [])];
    for (const record of this.records) {
      if (merged.some((item) => item.kind === record.kind && item.handle === record.handle)) continue;
      merged.push({ ...record });
    }
    return merged.slice(-MAX_TASK_EVIDENCE);
  }

  snapshot(): EvidenceRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  record(kind: EvidenceKind, handle: string, detail: string): void {
    const normalized = normalizeHandle(kind, handle);
    if (!normalized) return;
    this.push({ kind, handle: normalized, detail: detail.trim(), at: Date.now() });
  }

  find(kind: EvidenceKind, handle: string): EvidenceRecord | undefined {
    const normalized = normalizeHandle(kind, handle);
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record && record.kind === kind && record.handle === normalized) return record;
    }
    return undefined;
  }

  list(kind?: EvidenceKind): EvidenceRecord[] {
    return this.records
      .filter((record) => !kind || record.kind === kind)
      .map((record) => ({ ...record }));
  }

  private push(record: EvidenceRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.shift();
  }
}

function isEvidenceKind(value: unknown): value is TaskEvidenceKind {
  return value === "file" || value === "command" || value === "artifact";
}

export interface AcceptanceGateInput {
  task: TaskCard;
  ledger: EvidenceLedger;
  /** 这次 task_update 想引用的证据；闸门只在本轮查得到它时才放行 done。 */
  verifyKind?: string;
  verifyHandle?: string;
  /** 文件是否真的在工作区里（台账只记「写成功过」，回读确认要靠它）。 */
  fileExists: (relPath: string) => Promise<boolean>;
  /** 依赖本任务的成果是否由更具体的事实支撑（如成果名对应的文件仍在）。 */
  artifactExists?: (name: string) => Promise<boolean>;
}

export type AcceptanceGateVerdict =
  | {
      ok: true;
      /** 引用了台账里哪条事实；没有验收条款的任务为空。 */
      verifiedBy?: { kind: EvidenceKind; handle: string };
      detail?: string;
    }
  | {
      ok: false;
      /** 写给模型看的说明：列出验收条款、缺什么、台账里有什么。 */
      reason: string;
    };

/** 一次扫描得到的文件指纹表：路径 → 「修改时间:字节数」。扫描失败按空表处理。 */
export function stampFiles(listing: WorkspaceFileListing | undefined): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const file of listing?.files ?? []) {
    if (file.kind !== "file") continue;
    stamps.set(file.path, `${Math.round(file.updatedAt)}:${file.sizeBytes}`);
  }
  return stamps;
}

/** 隐藏目录（.skill-runtime 展开的技能文件每次都会重写）不算成果变化。 */
function isIgnoredPath(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment.startsWith("."));
}

export const MAX_CHANGED_FILE_RECORDS = 24;

/**
 * 命令/脚本跑完后，把指纹变了的文件登记为证据：脚本产出的 docx、xlsx 同样是可核验事实，
 * 不该因为「不是 file_write 写的」就过不了闸门。
 */
export function recordFileChanges(
  ledger: EvidenceLedger,
  before: Map<string, string>,
  listing: WorkspaceFileListing | undefined,
  note: string,
): string[] {
  const changed: string[] = [];
  for (const file of listing?.files ?? []) {
    if (file.kind !== "file" || isIgnoredPath(file.path)) continue;
    if (before.get(file.path) === `${Math.round(file.updatedAt)}:${file.sizeBytes}`) continue;
    changed.push(file.path);
  }
  for (const path of changed.slice(0, MAX_CHANGED_FILE_RECORDS)) {
    ledger.record("file", path, note);
  }
  return changed;
}

const KIND_LABELS: Record<EvidenceKind, string> = {
  file: "文件（file）",
  command: "命令（command）",
  artifact: "成果（artifact）",
};

function ledgerHint(ledger: EvidenceLedger): string {
  const all = ledger.list();
  if (all.length === 0) return "本轮台账是空的：还没有写成功过文件、跑成功过命令或登记过成果。";
  const lines = all
    .slice(-8)
    .map((record) => `  - ${KIND_LABELS[record.kind]}：${record.handle}`);
  return `本轮已登记的可核验事实（最近 ${lines.length} 条）：\n${lines.join("\n")}`;
}

/**
 * 验收闸门：任务卡写了验收条款时，`done` 必须引用一条本轮查得通的证据。
 * 没有验收条款的任务不受影响（大量任务是过程性的，不该被闸门卡住）。
 */
export async function verifyAcceptance(input: AcceptanceGateInput): Promise<AcceptanceGateVerdict> {
  const acceptance = input.task.acceptance?.trim();
  if (!acceptance) return { ok: true };

  const kind = input.verifyKind?.trim();
  const handle = input.verifyHandle?.trim();
  const missing =
    `任务「${input.task.title}」写了验收条款，标记完成前必须给出一条可核验的证据：\n` +
    `  验收条款：${acceptance}\n` +
    `  请传 verify_kind（file / command / artifact）与 verify_handle（真实文件路径、跑过的命令、或已登记成果名），` +
    `闸门会核对它在本轮是否真的发生过。\n` +
    `  证据不成立就保持 status=doing，如实说明还差什么；不要用自述冒充核验。\n\n` +
    `${ledgerHint(input.ledger)}`;

  if (!kind || !handle) return { ok: false, reason: missing };
  if (kind !== "file" && kind !== "command" && kind !== "artifact") {
    return {
      ok: false,
      reason: `verify_kind 只能是 file / command / artifact，收到的是「${kind}」。\n\n${ledgerHint(input.ledger)}`,
    };
  }

  const record = input.ledger.find(kind, handle);
  if (!record) {
    return {
      ok: false,
      reason:
        `本轮台账里查不到 ${KIND_LABELS[kind]}「${handle}」——也就是说这一轮没有真的产出它。` +
        `先去产出来自它的证据（写文件、跑命令、登记成果），再来标记完成。\n\n${ledgerHint(input.ledger)}`,
    };
  }

  if (kind === "file" && !(await input.fileExists(record.handle))) {
    return {
      ok: false,
      reason:
        `台账记过 files/${record.handle}，但回读时文件已经不在了——「调用成功不等于任务成功」。` +
        `请重新写出该文件（或把验收证据指向真正存在的那份）。\n\n${ledgerHint(input.ledger)}`,
    };
  }
  if (kind === "artifact" && input.artifactExists && !(await input.artifactExists(record.handle))) {
    return {
      ok: false,
      reason: `成果「${record.handle}」登记过，但现在已经查不到对应的产出。\n\n${ledgerHint(input.ledger)}`,
    };
  }

  return {
    ok: true,
    verifiedBy: { kind, handle: record.handle },
    detail: record.detail || undefined,
  };
}
