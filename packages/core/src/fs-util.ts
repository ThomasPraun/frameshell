import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
