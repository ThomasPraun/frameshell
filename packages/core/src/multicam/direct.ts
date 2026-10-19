import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCode, type JournalEntry, RpcError } from "@frameshell/protocol";
import {
  DIRECTOR_FILE,
  type DirectorRules,
  type DirectorTemplateId,
  type MulticamGroup,
  type ProgramTrack,
  SHOT_LOW_CONFIDENCE,
  type ShotClip,
  parseDirectorFile,
  resolveDirectorRules,
} from "@frameshell/schema";
import { touchedIds } from "../history/revert.js";

/** Rules `multicam.direct` runs with, and where they came from. */
export interface LoadedRules {
  /** Template the rules started from. */
  template: DirectorTemplateId;
  /** The template with the rules file on top. */
  rules: DirectorRules;
  /** Project-relative, `/`-separated; null when no file was read. */
  rulesFile: string | null;
}

/**
 * Rules of template `template` with the rules file on top: `file` (absolute
 * or relative to `cwd`, inside the project), else `director.json` at the
 * project root when it exists. Throws InvalidOperation (a named file is
 * missing), OutsideProject or InvalidProjectFile (not JSON, or not the schema).
 */
export async function loadDirectorRules(root: string, cwd: string, file: string | undefined, template: DirectorTemplateId | undefined): Promise<LoadedRules> {
  const path = file === undefined ? join(root, DIRECTOR_FILE) : resolve(cwd, file);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RpcError(ErrorCode.OutsideProject, `multicam.direct: rules file ${file} is not inside the project ${root}.`, { path: file });
  }
  const shown = rel.split(sep).join("/");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (file === undefined) return { ...resolveDirectorRules(null, template), rulesFile: null };
    throw new RpcError(ErrorCode.InvalidOperation, `multicam.direct: no rules file ${shown}. Write it, or leave \`rules\` out to use ${DIRECTOR_FILE} or the template.`, {
      op: "multicam.direct",
      reason: "rules file missing",
      field: "rules",
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalidRules(shown, `not JSON: ${(error as Error).message}`);
  }
  const parsed = parseDirectorFile(value);
  if (!parsed.ok) throw invalidRules(shown, parsed.error);
  return { ...resolveDirectorRules(parsed.value, template), rulesFile: shown };
}

function invalidRules(path: string, details: string): RpcError {
  return new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}\nFix the file (see the director.json JSON Schema) and retry.`, { path, details });
}

/**
 * Shots of `track` a person chose (ADR 0016: re-directing keeps them): shots
 * whose layout or angles the app set (`shot.set` by author `ui`), plus pieces
 * split off them since, as long as they still carry no director `confidence`.
 * `entries` is the timeline's journal, oldest first.
 */
export function humanShots(entries: readonly JournalEntry[], track: ProgramTrack): string[] {
  const human = new Set<string>();
  for (const entry of entries) {
    const touched = touchedIds(entry.inverse.args);
    if (entry.op === "shot.set" && entry.author === "ui" && typeof entry.args["clip"] === "string") human.add(entry.args["clip"]);
    else if (touched.some((id) => human.has(id))) {
      // Clips the operation created are the ones its inverse deletes.
      for (const change of entry.inverse.args.clips ?? []) if (change.clip === null) human.add(change.id);
    }
  }
  return track.clips.filter((shot) => human.has(shot.id) && shot.confidence === undefined).map((shot) => shot.id);
}

/** Angle ids in `rules.weights` that `group` does not have, for a warning. */
export function unknownWeights(rules: DirectorRules, group: MulticamGroup): string[] {
  return Object.keys(rules.weights).filter((id) => !group.angles.some((angle) => angle.id === id));
}

/** The `ids` among `track`'s shots whose confidence is below {@link SHOT_LOW_CONFIDENCE}, by start, placed on the timeline. */
export function lowShots(track: ProgramTrack, ids: ReadonlySet<string>): (Pick<ShotClip, "shot" | "angles" | "start"> & { clip: string; end: number; confidence: number; reason: string })[] {
  return track.clips
    .filter((shot) => ids.has(shot.id) && shot.confidence !== undefined && shot.confidence < SHOT_LOW_CONFIDENCE)
    .map((shot) => ({
      clip: shot.id,
      start: shot.start,
      end: Math.round((shot.start + shot.out - shot.in) * 1000) / 1000,
      shot: shot.shot,
      angles: shot.angles,
      confidence: shot.confidence!,
      reason: shot.reason ?? "",
    }));
}
