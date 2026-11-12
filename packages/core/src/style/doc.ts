import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { SCHEMA_VERSION, STYLE_FILE, STYLE_PATHS, STYLE_SCHEMA_URL, type StyleFile, parseStyleFile } from "@frameshell/schema";
import type { ConfigDocument } from "../config/journal.js";
import { type ConfigState, PLAIN_RULES } from "../config/patch.js";
import { readJsonIfExists, writeTextAtomic } from "../fs-util.js";
import { readStyleFile } from "./read.js";

/**
 * The `style` config document (ADR 0036 decision 6): `style.json` as keyed state, key `style:<path>` per value
 * of {@link STYLE_PATHS} plus `style:from`. A value null or absent in the file has no key: both resolve alike.
 * A state with no key is no file, so reverting the change that created `style.json` removes it.
 */

/** Key prefix of the `style` document. */
export const STYLE_KEY = "style:";

/** Every path a key can hold, in the order a new file lists them. */
const KEY_PATHS: readonly string[] = ["from", ...STYLE_PATHS];

/** Dotted path of a `style:` key. */
export function stylePathOf(key: string): string {
  return key.slice(STYLE_KEY.length);
}

/** Keyed state of a style file (null: no file). */
export function styleState(file: StyleFile | null): ConfigState {
  const state: Record<string, unknown> = {};
  if (!file) return state;
  for (const path of KEY_PATHS) {
    const value = valueAt(file, path);
    if (value !== undefined && value !== null) state[STYLE_KEY + path] = value;
  }
  return state;
}

/**
 * `state` as the file to write over `raw` (the parsed JSON on disk; null when none): only the values that differ
 * are set or removed, so key order, `$schema` and explicit nulls of the rest stay. Null when `state` is empty.
 */
export function styleWritten(raw: Record<string, unknown> | null, state: ConfigState): Record<string, unknown> | null {
  if (Object.keys(state).length === 0) return null;
  const next: Record<string, unknown> = raw ? structuredClone(raw) : { $schema: STYLE_SCHEMA_URL, schemaVersion: SCHEMA_VERSION };
  const parsed = raw ? parseStyleFile(raw) : null;
  const current = styleState(parsed?.ok ? parsed.value : null);
  for (const path of KEY_PATHS) {
    const key = STYLE_KEY + path;
    if (PLAIN_RULES.same(current[key], state[key])) continue;
    if (state[key] === undefined || state[key] === null) removeAt(next, path);
    else setAt(next, path, structuredClone(state[key]));
  }
  return next;
}

/**
 * `state` as a valid file normalizes it (trimmed text); InvalidOperation reason `value` naming the schema's
 * complaint when no valid `style.json` holds it. `op` names the method in the error.
 */
export function checkedStyleState(state: ConfigState, op: string): ConfigState {
  const written = styleWritten(null, state);
  if (written === null) return state;
  const parsed = parseStyleFile(written);
  if (!parsed.ok) {
    throw new RpcError(ErrorCode.InvalidOperation, `Invalid style value:\n${parsed.error}\nRead \`frameshell style show\` for every path and its unit.`, {
      op,
      reason: "value",
      details: parsed.error,
    });
  }
  return styleState(parsed.value);
}

/** The `style` document for the config journal: reads `style.json`, writes only the values that changed. */
export function styleConfigDocument(): ConfigDocument {
  return {
    rules: PLAIN_RULES,
    read: async (root) => styleState(await readStyleFile(root)),
    write: async (root, state) => {
      const path = join(root, STYLE_FILE);
      const next = styleWritten(((await readJsonIfExists(path)) as Record<string, unknown> | undefined) ?? null, state);
      if (next === null) {
        await rm(path, { force: true });
        return;
      }
      const parsed = parseStyleFile(next);
      if (!parsed.ok) throw new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${parsed.error}`, { path, details: parsed.error });
      await writeTextAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

function valueAt(node: unknown, path: string): unknown {
  let at = node;
  for (const part of path.split(".")) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

function setAt(node: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let at = node;
  for (const part of parts.slice(0, -1)) {
    const child = at[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  at[parts.at(-1)!] = value;
}

/** Remove the value at `path` and every object that removal leaves empty. */
function removeAt(node: Record<string, unknown>, path: string): void {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) {
    delete node[head!];
    return;
  }
  const child = node[head!];
  if (typeof child !== "object" || child === null || Array.isArray(child)) return;
  removeAt(child as Record<string, unknown>, rest.join("."));
  if (Object.keys(child).length === 0) delete node[head!];
}
