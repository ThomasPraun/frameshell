import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, type GradeCompareResultShape, type GradeLook, RpcError } from "@frameshell/protocol";
import { type AdapterClip, GRADE_LIMITS, type Grade, type MediaClip, type Timeline, type TimelineClip, findLook, gradeOf, lookNames } from "@frameshell/schema";
import { readLut } from "../export/grade.js";
import { type ExportService, type LoadedTimeline, pool } from "../export/service.js";
import { captureParallelism } from "../review/source.js";
import { type SheetTile, writeSheet } from "../review/sheet.js";
import { FrameGrid } from "../timeline/grid.js";
import { NestedTimelineError, clipEnd, nestedClipError } from "../timeline/timing.js";
import { round } from "./levels.js";
import { correctionFlags } from "./suggest.js";

// `grade.compare` (ADR 0031): one frame of a clip under several grades, each rendered by the `frame` export path
// on a copy of the loaded timeline whose clip carries that grade, tiled into one labelled sheet. Never edits the timeline.
// Footage, photos, generated clips and nested timelines take a grade; the frame path draws each as it exports.

/** Where compare sheets go by default, project-relative: regenerable, gitignored with the rest of `.frameshell/`. */
export const GRADE_COMPARE_DIR = [".frameshell", "grade"] as const;

/** What {@link GradeComparer} needs from the daemon. */
export interface GradeComparerOptions {
  exports: Pick<ExportService, "frame">;
  /** Absolute path of the managed ffmpeg. */
  ffmpeg(root: string): Promise<string>;
  /** Length in seconds of the nested timeline file `source` (project-relative), for a nested clip that sets no `duration`. */
  nestedDuration(root: string, timeline: string, fps: number): (source: string) => Promise<number>;
}

/** One `grade.compare` call, params validated. */
export interface GradeCompareRequest {
  clip: string;
  looks: readonly GradeLook[];
  /** Timeline seconds inside the clip; default its middle frame. */
  at?: number | undefined;
  /** Absolute PNG path; default under {@link GRADE_COMPARE_DIR}. */
  out?: string | undefined;
  tileWidth: number;
  projectFormat?: string | undefined;
}

type Tile = GradeCompareResultShape["tiles"][number];

const CORRECTION_FIELDS = ["exposure", "temperature", "tint", "contrast", "saturation"] as const;

/** Renders grade candidates of one frame side by side; writes the sheet only. */
export class GradeComparer {
  readonly #options: GradeComparerOptions;

  constructor(options: GradeComparerOptions) {
    this.#options = options;
  }

  /** The sheet of `request` for clip `request.clip` of `loaded` (top level, on a video track; media, generated or nested). Throws `ClipNotFound`, `InvalidOperation` or `InvalidParams`. */
  async compare(root: string, loaded: LoadedTimeline, request: GradeCompareRequest): Promise<GradeCompareResultShape> {
    const { timeline, fps } = loaded;
    const found = timeline.tracks.flatMap((track) => (track.kind === "video" ? track.clips.map((clip) => ({ track, clip })) : [])).find((entry) => entry.clip.id === request.clip);
    if (!found) {
      throw new RpcError(ErrorCode.ClipNotFound, `grade.compare: no clip "${request.clip}" on a video track of timeline ${timeline.id}. List clip ids with "frameshell timeline show".`, { clip: request.clip });
    }
    const { track, clip } = found;
    if (clip.type === "shot") throw invalid("not-gradable", `clip ${clip.id} is a multicam shot: only media, generated and nested timeline clips take a grade.`, "clip");
    // A nested clip with no `duration` plays the rest of its timeline, which only the nested file knows.
    const end = await clipEnd(clip as GradableClip, new FrameGrid(fps), this.#options.nestedDuration(root, timeline.id, fps)).catch((error: unknown) => {
      if (error instanceof NestedTimelineError) throw nestedClipError(error, { timeline: timeline.id, track: track.id, clip, op: "grade.compare" });
      throw error;
    });
    const frame = compareFrame(clip.id, clip.start, end, fps, request.at, "grade.compare");

    const warnings: string[] = [];
    if (track.hidden) warnings.push(`Track ${track.id} is hidden: the frame does not show clip ${clip.id}, so every tile looks the same.`);
    const looks = resolveLooks(request.looks);
    await checkLuts(root, looks);
    const current = clip.grade && gradeOf(clip) ? clip.grade : null;
    const tiles: Tile[] = [{ label: "", kind: "neutral", grade: null, flags: "--clear-grade" }];
    if (current) tiles.push({ label: "", kind: "current", grade: current, flags: "" });
    const names: string[] = ["neutral", ...(current ? ["current"] : [])];
    for (const [i, { name, ...grade }] of looks.entries()) {
      const label = name ?? `look ${i + 1}`;
      if (!gradeOf({ type: clip.type, grade })) warnings.push(`Look "${label}" changes nothing: its tile is the neutral picture.`);
      tiles.push({ label: "", kind: "look", grade, flags: lookFlags(grade, current) });
      names.push(label);
    }
    for (const [i, tile] of tiles.entries()) tile.label = `${i + 1} ${names[i]}`;

    const out = request.out ?? join(root, ...GRADE_COMPARE_DIR, `compare-${clip.id}-${frame}.png`);
    const scratch = join(root, ".frameshell", "cache", "grade-compare", randomBytes(6).toString("hex"));
    try {
      const paths = tiles.map((_, i) => join(scratch, `tile-${i}.png`));
      const render = async (i: number) => {
        const shot = await this.#options.exports.frame(
          root,
          { timeline: timeline.id, at: frame / fps, out: paths[i]!, projectFormat: request.projectFormat },
          { ...loaded, timeline: withGrade(timeline, clip.id, tiles[i]!.grade) },
        );
        // What a generated clip's render says (a draft standing in for a final, a setting the adapter changed): once.
        for (const warning of shot.warnings) if (!warnings.includes(warning)) warnings.push(warning);
        return shot;
      };
      // The first frame alone: it makes the generated renders and mattes the others then find cached.
      const first = await render(0);
      await pool(tiles.slice(1), captureParallelism(), async (_, i) => void (await render(i + 1)));
      const tile = { width: request.tileWidth, height: evenHeight(request.tileWidth, first.width, first.height) };
      const size = await writeSheet(await this.#options.ffmpeg(root), tiles.map((entry, i) => ({ path: paths[i]!, label: entry.label }) satisfies SheetTile), {
        out,
        columns: columnsFor(tiles.length),
        tile,
        scratch: join(scratch, "sheet"),
      });
      return {
        timeline: timeline.id,
        clip: clip.id,
        asset: "asset" in clip ? clip.asset : null,
        kind: clip.type === "media" ? "media" : clip.type === "timeline" ? "timeline" : "generated",
        frame,
        at: round(frame / fps, 3),
        path: out,
        width: size.width,
        height: size.height,
        columns: size.columns,
        rows: size.rows,
        tiles,
        warnings,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

const invalid = (reason: string, message: string, field: string, valid?: { from: number; to: number }, op = "grade.compare") =>
  new RpcError(ErrorCode.InvalidOperation, `${op}: ${message}`, { op, reason, field, ...(valid ? { valid } : {}) });

/** A clip that takes a grade: footage or a photo, a generated clip, a nested timeline. */
type GradableClip = MediaClip | TimelineClip | AdapterClip;

/**
 * Timeline frame of the clip `id` playing from `start` to `end` (seconds) that `at` asks for, else its middle one: the
 * frame the compare methods (`op`) render. Throws `InvalidOperation` when `at` is outside the clip.
 */
export function compareFrame(id: string, start: number, end: number, fps: number, at: number | undefined, op: string): number {
  const first = Math.ceil(start * fps - 1e-6);
  const last = Math.max(first, Math.ceil(end * fps - 1e-6) - 1);
  if (at === undefined) return Math.floor((first + last + 1) / 2);
  const slack = 0.5 / fps;
  if (at < start - slack || at > end + slack) {
    const valid = { from: round(start, 3), to: round(end, 3) };
    throw invalid("outside-clip", `\`at\` ${at} is outside clip ${id}, which plays from ${valid.from} to ${valid.to} s of the timeline.`, "at", valid, op);
  }
  return Math.max(first, Math.min(last, Math.floor(at * fps + 1e-6)));
}

/** A look of the request with its built-in `look` filled in: a name and a whole grade. */
export type ResolvedLook = Grade & { name?: string | undefined };

/**
 * `looks` with each `look: "<name>"` replaced by the built-in look's numbers, the fields the request gives written
 * over them (the tile is named after the built-in look unless the look has a `name`). Throws `InvalidParams` naming the
 * valid looks for a name that is not one, before any frame is rendered.
 */
export function resolveLooks(looks: readonly GradeLook[]): ResolvedLook[] {
  return looks.map(({ look, ...own }, i) => {
    if (look === undefined) return own;
    const builtIn = findLook(look);
    if (!builtIn) {
      const valid = lookNames.join(", ");
      throw new RpcError(ErrorCode.InvalidParams, `grade.compare: look ${i + 1} asks for the built-in look "${look}", which does not exist. Built-in looks: ${valid}.`, {
        issues: [{ path: ["looks", i, "look"], message: `unknown look "${look}"; one of ${valid}` }],
      });
    }
    return { name: builtIn.name, ...builtIn.grade, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)) };
  });
}

/** Refuse a look whose LUT cannot be read before any frame is rendered, naming the look. */
async function checkLuts(root: string, looks: readonly ResolvedLook[]): Promise<void> {
  const checked = new Set<string>();
  for (const [i, look] of looks.entries()) {
    if (look.lut === undefined || checked.has(look.lut)) continue;
    checked.add(look.lut);
    try {
      await readLut(root, look.lut);
    } catch (error) {
      throw new RpcError(ErrorCode.InvalidParams, `grade.compare: look "${look.name ?? `look ${i + 1}`}" uses LUT ${look.lut}, which cannot be used: ${(error as Error).message}`, {
        issues: [{ path: ["looks", i, "lut"], message: (error as Error).message }],
      });
    }
  }
}

/** `timeline` with clip `id`'s grade replaced by `grade` (removed for null; any clip but a multicam shot); the rest shared, never mutated. */
export function withGrade(timeline: Timeline, id: string, grade: Grade | null): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.kind !== "video" || !track.clips.some((clip) => clip.id === id)
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => {
              if (clip.id !== id || clip.type === "shot") return clip;
              const { grade: _old, ...rest } = clip as GradableClip;
              return (grade ? { ...rest, grade } : rest) as typeof clip;
            }),
          },
    ),
  };
}

/**
 * `clip set` flags that turn the clip's `current` grade into `look`: the look's fields, and the neutral value of each
 * field `current` sets and the look leaves out (`clip set` merges field by field). Empty when nothing changes.
 */
export function lookFlags(look: Grade, current: Grade | null): string {
  const correction = Object.fromEntries(
    CORRECTION_FIELDS.flatMap((field) => {
      const value = look[field] ?? (current?.[field] !== undefined ? GRADE_LIMITS[field].default : undefined);
      return value === undefined || value === current?.[field] ? [] : [[field, value]];
    }),
  );
  const flags = [correctionFlags(correction)];
  const lut = look.lut ?? (current?.lut !== undefined ? null : undefined);
  if (lut !== undefined && lut !== current?.lut) flags.push(`--grade-lut ${lut === null ? "none" : shellWord(lut)}`);
  const mix = look.lutMix ?? (current?.lutMix !== undefined ? GRADE_LIMITS.lutMix.default : undefined);
  if (mix !== undefined && mix !== current?.lutMix) flags.push(`--grade-lut-mix ${mix}`);
  return flags.filter((flag) => flag !== "").join(" ");
}

/** `text` as one shell word: as is when plain, else in double quotes. */
function shellWord(text: string): string {
  return /^[\w./-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Tiles per row: one row up to 4, else about square. */
export function columnsFor(tiles: number): number {
  return tiles <= 4 ? tiles : Math.ceil(Math.sqrt(tiles));
}

/** Height of a `width` px tile of a `frameWidth` x `frameHeight` frame, even (ffmpeg's `tile` and most encoders want it). */
export function evenHeight(width: number, frameWidth: number, frameHeight: number): number {
  return Math.max(2, 2 * Math.round((width * frameHeight) / frameWidth / 2));
}
