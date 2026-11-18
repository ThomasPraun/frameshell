import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { CLIP_REQUIREMENT_FIELDS, REQUIREMENTS_FILE, REQUIREMENTS_SCHEMA_URL, REQUIREMENT_PATHS, type RequirementsFile, SCHEMA_VERSION, clipRequirements, parseRequirementsFile } from "@frameshell/schema";
import type { ConfigDocument } from "../config/journal.js";
import { type ConfigState, PLAIN_RULES } from "../config/patch.js";
import { readJsonIfExists, writeTextAtomic } from "../fs-util.js";
import { readRequirementsFile } from "./requirements-file.js";

/**
 * The `requirements` config document (ADR 0036, #457): `requirements.json` as keyed state. Keys, after
 * {@link REQUIREMENTS_KEY}: each of `REQUIREMENT_PATHS` (`film.maxSeconds`, `captions.minSize`, `fail`...),
 * `clip:<id>.<field>` per assertion of a clip, `waiver:<check>` and `waiver:<check>:<clip>` with the reason.
 * Entries the file repeats for one clip or waiver read as one key (later fields of a clip win, the first waiver's
 * reason wins, as `review` reads them); a write of that key leaves one entry. A state with no key is no file.
 */

/** Key prefix of the `requirements` document. */
export const REQUIREMENTS_KEY = "requirements:";

type Raw = Record<string, unknown>;
type Entry = Record<string, unknown>;

/** Key of assertion `field` of clip `clip`, without the prefix. */
export function clipRequirementKey(clip: string, field: string): string {
  return `clip:${clip}.${field}`;
}

/** Key of the waiver of `check` (on `clip`), without the prefix. */
export function waiverKey(check: string, clip?: string): string {
  return clip === undefined ? `waiver:${check}` : `waiver:${check}:${clip}`;
}

/** Keyed state of a requirements file (null: no file). */
export function requirementsState(file: RequirementsFile | null): ConfigState {
  const state: Record<string, unknown> = {};
  if (!file) return state;
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) state[REQUIREMENTS_KEY + key] = value;
  };
  for (const path of REQUIREMENT_PATHS) {
    if (path === "fail") put(path, file.fail.length > 0 ? file.fail : undefined);
    else if (path === "captions.minSize") put(path, file.captions?.minSize);
    else put(path, file.film[path.slice("film.".length) as keyof RequirementsFile["film"]]);
  }
  for (const entry of clipRequirements(file.clips)) {
    for (const field of CLIP_REQUIREMENT_FIELDS) put(clipRequirementKey(entry.clip, field), entry[field]);
  }
  for (const waiver of file.waivers) {
    const key = REQUIREMENTS_KEY + waiverKey(waiver.check, waiver.clip);
    if (!(key in state)) state[key] = waiver.reason;
  }
  return state;
}

/** What one key of the document names in the file. */
type Target =
  | { kind: "film"; field: string }
  | { kind: "captions" }
  | { kind: "fail" }
  | { kind: "clip"; clip: string; field: string }
  | { kind: "waiver"; check: string; clip: string | undefined };

function targetOf(key: string): Target | null {
  const path = key.slice(REQUIREMENTS_KEY.length);
  if (path === "fail") return { kind: "fail" };
  if (path === "captions.minSize") return { kind: "captions" };
  if (path.startsWith("film.")) return { kind: "film", field: path.slice("film.".length) };
  const clip = /^clip:(.+)\.([^.]+)$/.exec(path);
  if (clip) return { kind: "clip", clip: clip[1]!, field: clip[2]! };
  const waiver = /^waiver:([^:]+)(?::(.+))?$/.exec(path);
  if (waiver) return { kind: "waiver", check: waiver[1]!, clip: waiver[2] };
  return null;
}

/** `list` as `next[name]`; the key removed when the list is empty. */
function setList(next: Raw, name: string, list: Entry[]): void {
  if (list.length === 0) delete next[name];
  else next[name] = list;
}

/** Write `value` (null: none) at `target` into the file object `next`. */
function writeTarget(next: Raw, target: Target, value: unknown): void {
  const gone = value === null || value === undefined;
  switch (target.kind) {
    case "film": {
      const film = { ...((next["film"] as Raw | undefined) ?? {}) };
      if (gone) delete film[target.field];
      else film[target.field] = structuredClone(value);
      if (Object.keys(film).length === 0) delete next["film"];
      else next["film"] = film;
      return;
    }
    case "captions":
      if (gone) delete next["captions"];
      else next["captions"] = { ...((next["captions"] as Raw | undefined) ?? {}), minSize: value };
      return;
    case "fail":
      if (gone) delete next["fail"];
      else next["fail"] = structuredClone(value);
      return;
    case "clip": {
      const entries = ((next["clips"] as Entry[] | undefined) ?? []).map((entry) => ({ ...entry }));
      const mine = entries.filter((entry) => entry["clip"] === target.clip);
      // One entry keeps the value; the clip's other entries lose the field, so the file reads back as the state.
      for (const entry of mine) delete entry[target.field];
      if (!gone) {
        if (mine[0]) mine[0][target.field] = structuredClone(value);
        else entries.push({ clip: target.clip, [target.field]: structuredClone(value) });
      }
      setList(
        next,
        "clips",
        entries.filter((entry) => Object.keys(entry).some((field) => field !== "clip")),
      );
      return;
    }
    case "waiver": {
      const entries = (next["waivers"] as Entry[] | undefined) ?? [];
      const same = (entry: Entry) => entry["check"] === target.check && entry["clip"] === target.clip;
      const first = entries.findIndex(same);
      const kept = entries.filter((entry, index) => !same(entry) || (!gone && index === first)).map((entry) => (same(entry) ? { ...entry, reason: value } : entry));
      if (!gone && first === -1) kept.push({ check: target.check, ...(target.clip === undefined ? {} : { clip: target.clip }), reason: value });
      setList(next, "waivers", kept);
      return;
    }
  }
}

/**
 * `state` as the file to write over `raw` (the parsed JSON on disk; null when none): only the keys that differ are
 * written, so the order, `$schema` and the rest stay. Null when `state` is empty.
 */
export function requirementsWritten(raw: Raw | null, state: ConfigState): Raw | null {
  if (Object.keys(state).length === 0) return null;
  const next: Raw = raw ? structuredClone(raw) : { $schema: REQUIREMENTS_SCHEMA_URL, schemaVersion: SCHEMA_VERSION };
  const parsed = raw ? parseRequirementsFile(raw) : null;
  const current = requirementsState(parsed?.ok ? parsed.value : null);
  const keys = [...new Set([...Object.keys(current), ...Object.keys(state)])].sort();
  for (const key of keys) {
    if (PLAIN_RULES.same(current[key], state[key])) continue;
    const target = targetOf(key);
    if (target) writeTarget(next, target, state[key] ?? null);
  }
  return next;
}

/**
 * `state` as a valid file normalizes it (defaults filled in); InvalidOperation reason `value` naming the schema's
 * complaint when no valid `requirements.json` holds it. `op` names the method in the error.
 */
export function checkedRequirementsState(state: ConfigState, op: string): ConfigState {
  const written = requirementsWritten(null, state);
  if (written === null) return state;
  const parsed = parseRequirementsFile(written);
  if (!parsed.ok) {
    throw new RpcError(ErrorCode.InvalidOperation, `Invalid requirement:\n${parsed.error}\nSee the requirements.json JSON Schema for every field and its unit.`, {
      op,
      reason: "value",
      details: parsed.error,
    });
  }
  return requirementsState(parsed.value);
}

/**
 * The requirements file keyed `state` stands for (a proposal's version): `file` null when it is empty, or, with the
 * schema's complaint in `error`, when no valid file holds it.
 */
export function requirementsFromState(state: ConfigState): { file: RequirementsFile | null; error?: string } {
  const written = requirementsWritten(null, state);
  if (!written) return { file: null };
  const parsed = parseRequirementsFile(written);
  return parsed.ok ? { file: parsed.value } : { file: null, error: parsed.error };
}

/** The `requirements` document for the config journal: reads `requirements.json`, writes only the keys that changed. */
export function requirementsConfigDocument(): ConfigDocument {
  return {
    rules: PLAIN_RULES,
    read: async (root) => requirementsState(await readRequirementsFile(root)),
    write: async (root, state) => {
      const path = join(root, REQUIREMENTS_FILE);
      const next = requirementsWritten(((await readJsonIfExists(path)) as Raw | undefined) ?? null, state);
      if (next === null) {
        await rm(path, { force: true });
        return;
      }
      const parsed = parseRequirementsFile(next);
      if (!parsed.ok) throw new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${parsed.error}`, { path, details: parsed.error });
      await writeTextAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}
