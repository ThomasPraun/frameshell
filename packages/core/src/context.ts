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
