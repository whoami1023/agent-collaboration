/**
 * 会话归档：把一次作战室的内容（群聊记录、任务卡、files/ 文件工作区）整体存成一份可恢复的快照。
 *
 * 目录结构（每用户工作区下）：
 *   archives/<归档ID>/manifest.json  —— 摘要，列表只读它
 *   archives/<归档ID>/session.json   —— { seq, messages, tasks }
 *   archives/<归档ID>/files/         —— 归档时文件工作区里的成果（真实移动，不复制）
 *
 * 恢复是「交换」而不是「覆盖」：先把当前内容归档成一份新快照，再把这些内容放回作战室，
 * 因此任何一次恢复都不会丢数据，且归档可以反复恢复。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  RoomMessage,
  SessionArchiveDetail,
  SessionArchiveFileEntry,
  SessionArchiveSummary,
  TaskCard,
} from "../core/types";
import { newId } from "../core/ids";
import { readJson, writeJsonAtomic } from "../store/persist";

/** run_skill_script 展开脚本用的临时目录：属于运行时缓存，不进归档。 */
const SKILL_RUNTIME_DIR = ".skill-runtime";
const MAX_ARCHIVED_FILES = 2000;
const MAX_WALK_DEPTH = 12;
const ARCHIVE_ID_RE = /^arch_[0-9a-f]{12}$/;

export interface CaptureInput {
  roomName: string;
  seq: number;
  messages: RoomMessage[];
  tasks: TaskCard[];
  /** false 时只存群聊与任务卡，文件工作区留在原地（/new 开新会话用）；缺省为 true。 */
  includeFiles?: boolean;
}

export interface RestoreResult {
  archive: SessionArchiveDetail;
  restoredFiles: string[];
  conflicts: string[];
}

interface Manifest extends SessionArchiveSummary {
  seq: number;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.lstat(absPath);
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}

/** 重命名优先（同盘不占额外空间）；跨盘或 Windows 占用时回退到复制+删除。 */
async function moveInto(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (!isErrno(err, "EPERM") && !isErrno(err, "EXDEV") && !isErrno(err, "EACCES")) throw err;
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

export class SessionArchives {
  private readonly root: string;
  private readonly filesRoot: string;

  constructor(workspaceDir: string) {
    this.root = path.join(workspaceDir, "archives");
    this.filesRoot = path.join(workspaceDir, "files");
  }

  private dirFor(id: string): string {
    if (!ARCHIVE_ID_RE.test(id)) throw new Error(`归档 ID 不合法：${id}`);
    return path.join(this.root, id);
  }

  async list(): Promise<SessionArchiveSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
    const summaries: SessionArchiveSummary[] = [];
    for (const entry of entries) {
      if (!ARCHIVE_ID_RE.test(entry)) continue;
      const manifest = await readJson<Manifest | null>(path.join(this.root, entry, "manifest.json"), null);
      if (!manifest) continue;
      summaries.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        roomName: manifest.roomName,
        messageCount: manifest.messageCount,
        taskCount: manifest.taskCount,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
      });
    }
    return summaries.sort((left, right) => right.createdAt - left.createdAt);
  }

  async read(id: string): Promise<SessionArchiveDetail> {
    const dir = this.dirFor(id);
    const manifest = await readJson<Manifest | null>(path.join(dir, "manifest.json"), null);
    if (!manifest) throw new Error("归档不存在");
    const session = await readJson<{ seq?: number; messages?: RoomMessage[]; tasks?: TaskCard[] }>(
      path.join(dir, "session.json"),
      {},
    );
    return {
      ...manifest,
      seq: session.seq ?? 0,
      messages: session.messages ?? [],
      tasks: session.tasks ?? [],
      files: await this.listFiles(path.join(dir, "files")),
    };
  }

  /** 采集当前作战室内容成一份归档；三样都是空的就返回 null（不留下空归档）。 */
  async capture(input: CaptureInput): Promise<SessionArchiveSummary | null> {
    const withFiles = input.includeFiles !== false;
    const topLevel = withFiles ? await this.liveTopLevel() : [];
    const files = withFiles ? await this.listFiles(this.filesRoot) : [];
    if (input.messages.length === 0 && input.tasks.length === 0 && files.length === 0) {
      return null;
    }
    const id = newId("arch");
    const dir = this.dirFor(id);
    const createdAt = Date.now();
    const summary: SessionArchiveSummary = {
      id,
      createdAt,
      roomName: input.roomName,
      messageCount: input.messages.length,
      taskCount: input.tasks.length,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    };
    // 先落清单与会话，再移动文件：中途失败时已移动的文件都在归档里，未移动的仍留在工作区，不会两头丢。
    await writeJsonAtomic(path.join(dir, "session.json"), {
      seq: input.seq,
      messages: input.messages,
      tasks: input.tasks,
    });
    await writeJsonAtomic(path.join(dir, "manifest.json"), { ...summary, seq: input.seq });
    for (const entry of topLevel) {
      await moveInto(path.join(this.filesRoot, entry), path.join(dir, "files", entry));
    }
    return summary;
  }

  /** 把归档放回作战室：文件移回 files/（已存在同路径则跳过并记为冲突），会话内容随返回值交回调用方。 */
  async restore(id: string): Promise<RestoreResult> {
    const archive = await this.read(id);
    const dir = this.dirFor(id);
    const archivedRoot = path.join(dir, "files");
    const topLevel = await this.topLevelOf(archivedRoot);
    const restoredFiles: string[] = [];
    const conflicts: string[] = [];
    for (const entry of topLevel) {
      const target = path.join(this.filesRoot, entry);
      if (await exists(target)) {
        conflicts.push(entry);
        continue;
      }
      await fs.mkdir(this.filesRoot, { recursive: true });
      await moveInto(path.join(archivedRoot, entry), target);
      restoredFiles.push(entry);
    }
    // 文件是移走的，不是复制：归档清单与摘要都要按剩余内容改写，列表才不会报出已经不存在的文件数。
    const remaining = restoredFiles.length > 0 ? await this.listFiles(archivedRoot) : archive.files;
    const next: SessionArchiveDetail = {
      ...archive,
      files: remaining,
      fileCount: remaining.length,
      totalBytes: remaining.reduce((total, file) => total + file.sizeBytes, 0),
    };
    if (restoredFiles.length > 0) {
      await writeJsonAtomic(path.join(dir, "manifest.json"), { ...summaryOf(next), seq: archive.seq });
    }
    return { archive: next, restoredFiles, conflicts };
  }

  async remove(id: string): Promise<SessionArchiveSummary> {
    const dir = this.dirFor(id);
    const summary = await this.read(id);
    await fs.rm(dir, { recursive: true, force: true });
    return summary;
  }

  private async liveTopLevel(): Promise<string[]> {
    const entries = await this.topLevelOf(this.filesRoot);
    return entries.filter((entry) => entry !== SKILL_RUNTIME_DIR);
  }

  private async topLevelOf(absDir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      return entries
        .filter((entry) => !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
  }

  /** 归档面板要列出的文件清单：目录不单独成项，只收文件（受数量与深度上限保护）。 */
  private async listFiles(absRoot: string): Promise<SessionArchiveFileEntry[]> {
    const collected: SessionArchiveFileEntry[] = [];

    const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
      if (collected.length >= MAX_ARCHIVED_FILES || depth > MAX_WALK_DEPTH) return;
      const entries = await this.topLevelOf(absDir);
      for (const name of entries) {
        // 顶层的技能脚本缓存既不进归档，也不该计入摘要，否则清单会报出根本不存在的文件。
        if (!relDir && name === SKILL_RUNTIME_DIR) continue;
        if (collected.length >= MAX_ARCHIVED_FILES) return;
        const rel = relDir ? `${relDir}/${name}` : name;
        const abs = path.join(absDir, name);
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) await walk(abs, rel, depth + 1);
        else if (stat.isFile()) collected.push({ path: rel, sizeBytes: stat.size, updatedAt: stat.mtimeMs });
      }
    };

    await walk(absRoot, "", 0);
    return collected.sort((left, right) => left.path.localeCompare(right.path));
  }
}

/** SSE 与接口只回摘要：完整消息/任务正文留在 read() 里按需取。 */
export function summaryOf(archive: SessionArchiveDetail): SessionArchiveSummary {
  const { seq: _seq, messages: _messages, tasks: _tasks, files: _files, ...summary } = archive;
  return summary;
}
