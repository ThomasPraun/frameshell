import { appendFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

/** True when `path` exists (file or directory). */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parsed JSON of `path`, or `undefined` when the file is missing. Throws on invalid JSON. */
export async function readJsonIfExists(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text);
}

/** Temp + rename so readers never see a half-written file (SPEC §6.1). Creates the parent directory. Text or bytes. */
export async function writeTextAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  // Drop a stale temp (or a planted symlink) and create exclusively so the write never follows a link.
  await rm(temp, { force: true });
  await writeFile(temp, content, { flag: "wx" });
  await rename(temp, path);
}

/** {@link writeTextAtomic} of pretty-printed JSON with a trailing newline. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * One spelling per existing path, to compare paths clients spell differently:
 * symlinks resolved, and on Windows 8.3 short names (`RUNNER~1`) expanded
 * (the promise `realpath` is the native one; `fs.realpathSync` would keep them).
 * `path` itself when it cannot be resolved.
 */
export async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/**
 * {@link canonicalPath}, synchronously: same native realpath, so both agree on every key.
 * Blocks on disk: only for a result that must be ready in the same tick, and memoize it.
 */
export function canonicalPathSync(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Append `value` as one JSON line, creating the file and its directory. A
 * crash may leave a partial last line; ours starts on a fresh one so only
 * that line is lost. Callers serialize appends per file.
 */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const prefix = await endsWithoutNewline(path);
  await appendFile(path, `${prefix ? "\n" : ""}${JSON.stringify(value)}\n`);
}

/**
 * Parsed JSON lines of `path`, in file order; empty when the file is missing.
 * Blank lines and lines that are not JSON (a write cut short, a hand edit) are skipped.
 */
export async function readJsonLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return values;
}

async function endsWithoutNewline(path: string): Promise<boolean> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await file.close();
  }
}
