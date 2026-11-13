import { open, readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// O_EXCL makes seeding atomic: an existing file (user-edited content) is never touched,
// and two workspaces loading concurrently cannot both write it.
export async function writeFileIfMissing(file: string, text: string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

// 同一毫秒内对同一目标文件的两次写入若共用临时文件，两个句柄会互相截断/覆盖，
// 落盘后可能变成「完整 JSON + 残尾」。用进程内递增序号保证临时文件唯一。
let atomicWriteSeq = 0;

// Windows: rename onto a busy target raises EPERM/EBUSY. Retry with backoff and
// never unlink the previous file first — a missing file between delete and rename
// lets concurrent readers seed fresh state.
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  atomicWriteSeq += 1;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${atomicWriteSeq}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
      await sleep(40 * 2 ** attempt);
    }
  }
  throw new Error(`写入失败（目标文件被占用）：${file}`);
}
