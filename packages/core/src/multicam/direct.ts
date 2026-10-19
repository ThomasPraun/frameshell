import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCode, type JournalEntry, RpcError } from "@frameshell/protocol";
import {
  type AnyClip,
  DIRECTOR_FILE,
  type DirectorRules,
  type DirectorTemplateId,
  type MulticamGroup,
  type ProgramTrack,
  SHOT_LOW_CONFIDENCE,
  type ShotClip,
  isShotClip,
  parseDirectorFile,
  resolveDirectorRules,
} from "@frameshell/schema";

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
 * cut out of them since, as long as they still carry no director `confidence`.
 * A `shot.set` by anyone else hands the shot back to the director.
 * `entries` is the timeline's journal, oldest first.
 */
export function humanShots(entries: readonly JournalEntry[], track: ProgramTrack): string[] {
  // Clips each entry created, as they were right after it: the next entry's inverse holds a
  // clip's state before that entry; a clip no later entry touched is as `track` has it now.
  const now = new Map<string, AnyClip | null>(track.clips.map((clip) => [clip.id, clip]));
  const created: { id: string; clip: AnyClip | null | undefined }[][] = Array.from({ length: entries.length }, () => []);
  for (let i = entries.length - 1; i >= 0; i--) {
    const changes = entries[i]!.inverse.args.clips ?? [];
    for (const change of changes) if (change.clip === null) created[i]!.push({ id: change.id, clip: now.get(change.id) });
    for (const change of changes) now.set(change.id, change.clip);
  }
  const human = new Set<string>();
  entries.forEach((entry, i) => {
    const clip = entry.args["clip"];
    if (entry.op === "shot.set" && typeof clip === "string") {
      if (entry.author === "ui") human.add(clip);
      else human.delete(clip);
      return;
    }
    // A created clip is a piece of a human shot when its group time lies inside that shot's
    // group time before the operation; a shot the operation only moved passes nothing on.
    const sources = (entry.inverse.args.clips ?? []).flatMap((change) => (human.has(change.id) && change.clip && isShotClip(change.clip) ? [change.clip] : []));
    if (sources.length === 0) return;
    for (const { id, clip: piece } of created[i]!) {
      if (!piece || !isShotClip(piece) || piece.confidence !== undefined) continue;
      if (sources.some((source) => piece.in >= source.in - TIME_EPSILON && piece.out <= source.out + TIME_EPSILON)) human.add(id);
    }
  });
  return track.clips.filter((shot) => human.has(shot.id) && shot.confidence === undefined).map((shot) => shot.id);
}

/** Tolerance for comparing times rounded to 3 decimals. */
const TIME_EPSILON = 0.0005;

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
