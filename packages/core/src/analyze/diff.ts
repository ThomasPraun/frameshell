import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ANALYZE_DIFF_LABELS,
  ANALYSIS_DIR,
  type AnalyzeDiffFilm,
  type AnalyzeDiffResultShape,
  type AnalyzeDiffSample,
  type AnalyzeSheet,
  ErrorCode,
  RpcError,
} from "@frameshell/protocol";
import { runTool } from "../media/ffmpeg.js";
import { Frames } from "../review/images.js";
import { sheetLayout, splitImages, tileHeight } from "../review/plan.js";
import { type FilmSource, fileSource } from "../review/source.js";
import { type SheetTile, writeSheet } from "../review/sheet.js";
import { readActivity } from "./activity.js";
import {
  DEFAULT_MAX_LAG_S,
  activityGrid,
  alignFilms,
  energyOf,
  energyWindows,
  matchedStretch,
  parseSsim,
  pickSnapshots,
  windowStep,
} from "./align.js";
import { MAX_PICTURE_S } from "./picture.js";
import { frameAt, frameStart } from "./shots.js";

// `analyze.diff` (#471): our film against a reference. Lined up by activity-curve alignment, then compared at matched times by
// SSIM (ffmpeg's `ssim`), with the energy of each and a side-by-side sheet. A distance to read, not a pass or fail. After
// HyperFrames' `measure` diff and energy (Apache-2.0), ported per #478; the sheet is `review`'s (`review/sheet.ts`).

/** Default seconds between SSIM readings. */
export const DEFAULT_DIFF_EVERY_S = 0.5;
/** Fewest seconds between SSIM readings the caller may ask for. */
export const MIN_DIFF_EVERY_S = 0.1;
/** Most SSIM readings: a long matched stretch is read less often than asked. */
export const MAX_DIFF_SAMPLES = 600;
/** Default pairs of frames on the side-by-side sheet. */
export const DEFAULT_SNAPSHOTS = 8;
/** Most pairs of frames on the sheet. */
export const MAX_SNAPSHOTS = 24;
/** Widest picture, px, the two films are scaled to for SSIM. */
const SSIM_MAX_WIDTH = 480;
/** SSIM under which a reading counts as clearly different. */
export const DIFF_BELOW = 0.5;
/** Seconds the lowest readings picked for the sheet must be apart. */
const SNAPSHOT_APART_S = 1;
/** Relative difference of the two films' shapes (width over height) above which the reference is said to be stretched. */
const ASPECT_TOLERANCE = 0.05;
/** Name of the manifest `analyze.diff` writes in its folder: its result. */
export const DIFF_MANIFEST = "diff.json";

/** What one `analyze.diff` run is asked for. */
export interface AnalyzeDiffRequest {
  /** Absolute path of our film (an export, or any video). */
  file: string;
  /** Absolute path of the reference video. */
  reference: string;
  /** Name of the comparison folder; default `<film>-vs-<reference>`. */
  name: string;
  /** Seconds to add to a time of our film to find the same moment of the reference; default: found by activity alignment. */
  lag?: number | undefined;
  /** Most seconds the alignment looks for either way; default {@link DEFAULT_MAX_LAG_S}. */
  maxLag?: number | undefined;
  /** Seconds between SSIM readings; default {@link DEFAULT_DIFF_EVERY_S}. */
  every?: number | undefined;
  /** Pairs of frames on the sheet; default {@link DEFAULT_SNAPSHOTS}. */
  snapshots?: number | undefined;
}

/** What a run reports while it works. */
export interface AnalyzeDiffHooks {
  signal?: AbortSignal | undefined;
  stage?: ((message: string) => void) | undefined;
  progress?: ((fraction: number) => void) | undefined;
}

/** What {@link runDiff} needs: the tools of the project. */
export interface AnalyzeDiffTools {
  root: string;
  ffmpeg: string;
  ffprobe: string;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

function filmFacts(file: string, source: FilmSource): AnalyzeDiffFilm {
  return { file, fps: source.fps, width: source.width, height: source.height, frames: source.frames, duration: frameStart(source.frames, source.fps) };
}

/** Size both films are scaled to for SSIM: our film's shape, at most {@link SSIM_MAX_WIDTH} wide, even. */
export function diffSize(width: number, height: number): { width: number; height: number } {
  const wide = 2 * Math.round(Math.min(width, SSIM_MAX_WIDTH) / 2);
  return { width: Math.max(2, wide), height: tileHeight(Math.max(2, wide), width / height) };
}

/**
 * SSIM of the two films from `from` seconds of ours and `from + lag` of the reference, for `duration` seconds, one reading
 * every `every` seconds, both scaled to `size`. ffmpeg's `ssim` filter writes its per-frame stats to a file in `scratch`.
 */
async function ssimReadings(tools: AnalyzeDiffTools, request: { film: string; reference: string; from: number; lag: number; duration: number; every: number; size: { width: number; height: number } }, scratch: string, signal: AbortSignal | undefined): Promise<AnalyzeDiffSample[]> {
  const { film, reference, from, lag, duration, every, size } = request;
  const view = `fps=${(1 / every).toFixed(6)},scale=${size.width}:${size.height}:flags=area,setsar=1`;
  await mkdir(scratch, { recursive: true });
  // The stats file is relative to `cwd`: a Windows drive letter in a filter option needs escaping.
  await runTool(
    tools.ffmpeg,
    [
      ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
      ...["-ss", from.toFixed(3), "-t", duration.toFixed(3), "-i", film],
      ...["-ss", (from + lag).toFixed(3), "-t", duration.toFixed(3), "-i", reference],
      ...["-filter_complex", `[0:v]${view}[a];[1:v]${view}[b];[a][b]ssim=stats_file=ssim.log`],
      ...["-an", "-f", "null", "-"],
    ],
    { cwd: scratch, ...(signal ? { signal } : {}) },
  );
  return parseSsim(await readFile(join(scratch, "ssim.log"), "utf8"), from, every, lag);
}

/** Compare `request.file` with `request.reference`; see the `analyze.diff` method. */
export async function runDiff(tools: AnalyzeDiffTools, request: AnalyzeDiffRequest, hooks: AnalyzeDiffHooks = {}): Promise<AnalyzeDiffResultShape> {
  const { signal } = hooks;
  const stage = (message: string, from: number) => {
    hooks.stage?.(message);
    hooks.progress?.(from);
  };
  const [filmSource, referenceSource] = [await fileSource(tools.ffmpeg, tools.ffprobe, request.file, "analyze.diff"), await fileSource(tools.ffmpeg, tools.ffprobe, request.reference, "analyze.diff")];
  const film = filmFacts(request.file, filmSource);
  const reference = filmFacts(request.reference, referenceSource);
  const warnings: string[] = [];
  const maxLag = request.maxLag ?? DEFAULT_MAX_LAG_S;
  if (Math.abs(filmSource.width / filmSource.height / (referenceSource.width / referenceSource.height) - 1) > ASPECT_TOLERANCE) {
    warnings.push(`shape: the film is ${film.width}x${film.height} and the reference ${reference.width}x${reference.height}; the reference is stretched to the film's shape for SSIM and the sheet, so a low SSIM may be the shape, not the picture.`);
  }

  stage(`Measuring the motion of ${basename(request.file)}`, 0);
  const filmRead = await readActivity(tools.ffmpeg, request.file, filmSource, signal, (fraction) => hooks.progress?.(0.2 * fraction));
  stage(`Measuring the motion of ${basename(request.reference)}`, 0.2);
  const referenceRead = await readActivity(tools.ffmpeg, request.reference, referenceSource, signal, (fraction) => hooks.progress?.(0.2 + 0.2 * fraction));
  if (filmRead.truncated || referenceRead.truncated) warnings.push(`motion and SSIM: measured on the first ${MAX_PICTURE_S / 60} minutes.`);
  const filmActivity = { activity: filmRead.activity, fps: film.fps };
  const referenceActivity = { activity: referenceRead.activity, fps: reference.fps };

  const alignment = alignFilms(activityGrid(filmRead.activity, film.fps), activityGrid(referenceRead.activity, reference.fps), maxLag, request.lag);
  if (alignment.source === "none") warnings.push("alignment: the activity of the two films does not match at any lag (or one of them holds still); they are compared at the same times. Give a lag if you know it.");
  const measuredDuration = (read: { activity: ArrayLike<number> }, fps: number) => frameStart(read.activity.length, fps);
  const stretch = matchedStretch(measuredDuration(filmRead, film.fps), measuredDuration(referenceRead, reference.fps), alignment.lag);
  const duration = stretch.to - stretch.from;
  if (duration < 0.5) throw new RpcError(ErrorCode.InvalidOperation, `analyze.diff: the two films share no stretch at a lag of ${alignment.lag} s (the film lasts ${film.duration} s, the reference ${reference.duration} s).`, { op: "analyze.diff", field: "lag" });
  if (duration < 2) warnings.push(`alignment: only ${round(duration, 2)} s of the films match at this lag.`);

  const step = windowStep(duration);
  const energy = {
    step,
    film: energyOf(filmRead.activity, film.fps, stretch.from, stretch.to),
    reference: energyOf(referenceRead.activity, reference.fps, stretch.from + alignment.lag, stretch.to + alignment.lag),
    ratio: null as number | null,
    windows: energyWindows(filmActivity, referenceActivity, alignment.lag, stretch.from, stretch.to, step),
  };
  energy.ratio = energy.reference.mean > 0 ? round(energy.film.mean / energy.reference.mean, 2) : null;

  stage("Comparing the pictures (SSIM)", 0.4);
  const every = round(Math.max(request.every ?? DEFAULT_DIFF_EVERY_S, MIN_DIFF_EVERY_S, duration / MAX_DIFF_SAMPLES), 3);
  const size = diffSize(film.width, film.height);
  const scratch = join(tools.root, ".frameshell", "cache", "analyze", randomBytes(6).toString("hex"));
  const dir = join(tools.root, ...ANALYSIS_DIR.split("/"), request.name);
  let samples: AnalyzeDiffSample[];
  let sheets: AnalyzeSheet[];
  try {
    samples = await ssimReadings(tools, { film: request.file, reference: request.reference, from: stretch.from, lag: alignment.lag, duration, every, size }, join(scratch, "ssim"), signal);
    if (samples.length === 0) throw new RpcError(ErrorCode.InvalidOperation, `analyze.diff: ffmpeg compared no frames of ${request.file} and ${request.reference}.`, { op: "analyze.diff" });
    stage("Writing the side-by-side sheet", 0.8);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    sheets = await pairSheets({ ffmpeg: tools.ffmpeg, film: filmSource, reference: referenceSource, lag: alignment.lag, samples: pickSnapshots(samples, request.snapshots ?? DEFAULT_SNAPSHOTS, SNAPSHOT_APART_S), dir, scratch, signal });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const lowest = samples.reduce((low, sample) => (sample.ssim < low.ssim ? sample : low), samples[0]!);
  const result: AnalyzeDiffResultShape = {
    name: request.name,
    dir,
    film,
    reference,
    alignment: { ...alignment, maxLag },
    energy,
    diff: {
      every,
      size,
      samples,
      mean: round(samples.reduce((sum, sample) => sum + sample.ssim, 0) / samples.length, 3),
      min: lowest.ssim,
      minAt: lowest.at,
      below: round(samples.filter((sample) => sample.ssim < DIFF_BELOW).length / samples.length, 3),
    },
    sheets,
    warnings,
    labels: { ...ANALYZE_DIFF_LABELS },
  };
  await writeFile(join(dir, DIFF_MANIFEST), `${JSON.stringify(result, null, 2)}\n`);
  hooks.progress?.(1);
  return result;
}

/** What {@link pairSheets} tiles. */
interface PairSheets {
  ffmpeg: string;
  film: FilmSource;
  reference: FilmSource;
  lag: number;
  /** The readings to show, in time order. */
  samples: readonly AnalyzeDiffSample[];
  dir: string;
  scratch: string;
  signal: AbortSignal | undefined;
}

/** Our frame and the reference's at each sample, side by side (ours left), tiled as `review` tiles its sheets. */
async function pairSheets(options: PairSheets): Promise<AnalyzeSheet[]> {
  const { ffmpeg, film, reference, samples, dir, signal } = options;
  const aspect = film.width / film.height;
  const wide = aspect >= 1;
  const layout = { columns: wide ? 4 : 6, perImage: wide ? 24 : 18, tileWidth: wide ? sheetLayout("safe", aspect).tileWidth : 200 };
  const tile = { width: layout.tileWidth, height: tileHeight(layout.tileWidth, aspect) };
  const filmFrames = new Frames(film, join(options.scratch, "film"));
  const referenceFrames = new Frames(reference, join(options.scratch, "reference"));
  const pairs = samples.map((sample) => ({
    sample,
    filmFrame: Math.min(film.frames - 1, frameAt(sample.at, film.fps)),
    referenceFrame: Math.max(0, Math.min(reference.frames - 1, frameAt(sample.referenceAt, reference.fps))),
  }));
  await filmFrames.ensure(pairs.map((pair) => pair.filmFrame), signal);
  await referenceFrames.ensure(pairs.map((pair) => pair.referenceFrame), signal);
  const parts = splitImages(pairs, layout.perImage / 2);
  const sheets: AnalyzeSheet[] = [];
  for (const [i, part] of parts.entries()) {
    const path = join(dir, parts.length === 1 ? "diff.png" : `diff-${i + 1}.png`);
    const tiles: SheetTile[] = part.flatMap(({ sample, filmFrame, referenceFrame }) => [
      { path: filmFrames.path(filmFrame), label: `film ${sample.at.toFixed(2)} ssim ${sample.ssim.toFixed(2)}` },
      { path: referenceFrames.path(referenceFrame), label: `ref ${sample.referenceAt.toFixed(2)}` },
    ]);
    const size = await writeSheet(ffmpeg, tiles, { out: path, columns: layout.columns, tile, scratch: join(options.scratch, `sheet-${i}`), ...(signal ? { signal } : {}) });
    sheets.push({
      kind: "diff",
      path,
      width: size.width,
      height: size.height,
      columns: size.columns,
      rows: size.rows,
      tile,
      tiles: tiles.map((entry, t) => ({
        at: t % 2 === 0 ? part[t / 2]!.sample.at : part[(t - 1) / 2]!.sample.referenceAt,
        frame: t % 2 === 0 ? part[t / 2]!.filmFrame : part[(t - 1) / 2]!.referenceFrame,
        tag: "grid" as const,
        label: entry.label,
        row: Math.floor(t / size.columns),
        column: t % size.columns,
      })),
    });
  }
  return sheets;
}
