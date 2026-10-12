import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { writeTextAtomic } from "./fs-util.js";
import type { GcClass } from "./gc.js";

/**
 * Project-relative directory of "Ask agent" captures (SPEC §10, ADR 0011):
 * frame captures `f_<frame>.png` and pick details `e_<frame>_<n>.json`.
 * Regenerable, gitignored with the rest of `.frameshell/`.
 */
export const CONTEXT_DIR = ".frameshell/context";

/** Captures older than this are swept by `gc` and on open: a reference is read soon after it is typed. */
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const CONTEXT_ENTRY = /^(?:f_\d+\.png|e_\d+_\d+\.json)$/;

/** What an entry of {@link CONTEXT_DIR} is, for `gc`: a capture (its own key), or null (kept). */
export function classifyContext(name: string, isDirectory: boolean): GcClass {
  return !isDirectory && CONTEXT_ENTRY.test(name) ? { kind: "context", key: name } : null;
}

/**
 * Write details file `name` (`e_<frame>_<n>.json`, checked by the method's
 * params) into {@link CONTEXT_DIR} of `root`, atomically. Throws
 * `OutsideProject` when the folder resolves outside the project (a symlinked
 * `.frameshell`). Resolves with the project-relative path.
 */
export async function writeContext(root: string, name: string, content: string): Promise<{ path: string }> {
  const dir = join(root, ...CONTEXT_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  const inside = relative(await realpath(root), await realpath(dir));
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new RpcError(ErrorCode.OutsideProject, `${CONTEXT_DIR} resolves outside the project`, { path: dir });
  }
  await writeTextAtomic(join(dir, name), content);
  return { path: `${CONTEXT_DIR}/${name}` };
}
