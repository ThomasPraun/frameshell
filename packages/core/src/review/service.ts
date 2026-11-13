import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ErrorCode,
  REVIEW_KEEP,
  REVIEW_SHEETS,
  type ReviewDelivery,
  type ReviewLoudness,
  type ReviewMetrics,
  type ReviewOutput,
  type ReviewPeak,
  type ReviewResult,
  type ReviewSafeZone,
  type ReviewSeam,
  type ReviewSheet,
  type ReviewSheetKind,
  type ReviewSync,
  RpcError,
  type TimelineViewName,
} from "@frameshell/protocol";
import { type FormatEntry, type PlatformId, type ResolvedSubtitleTrack, SAFE_ZONES, type ExportPreset, type Timeline } from "@frameshell/schema";
import { PHONE_BAND_FILTER, measureLoudness } from "../analyze/loudness.js";
import { generatedClips } from "../clips/renderer.js";
import type { GeneratedSource } from "../export/compiler.js";
import { captionFontMetrics } from "../export/font-metrics.js";
import type { ExportService, LoadedTimeline } from "../export/service.js";
import { probeMedia } from "../media/ffmpeg.js";
import type { ScannedAsset } from "../people/face-clusters.js";
import type { TimelineService } from "../timeline/service.js";
import {
  type Critical,
  type FramePick,
  MAX_SAFE_TILES,
  contactPicks,
  frameRange,
  frameTime,
  motionPeaks,
  phonePicks,
  seamPicks,
  sheetLayout,
  stripPicks,
  STRIPS,
  timelineCritical,
} from "./plan.js";
import { Frames, type SheetImagesOptions, writeSheetImages } from "./images.js";
import { deliveryChecks } from "./delivery.js";
import { pictureMoves, seamJump, seamVerdict } from "./loop.js";
import { reviewMetrics, visualEvents } from "./metrics.js";
import { fileOnsets, takeOnsets } from "./onsets.js";
import { type BoxSpan, faceBoxes, graphicBoxes } from "./placement.js";
import { boxCrossings, cueCrossings, filmInsets, safeFlags, sameOrientation, subjectsAt } from "./safe.js";
import { type FilmSource, type MotionSeries, fileSource, timelineSource } from "./source.js";
import { syncMetrics } from "./sync.js";

/** Options for {@link ReviewService}. */
export interface ReviewServiceOptions {
  timelines: Pick<TimelineService, "viewTimeline" | "show">;
  exports: Pick<ExportService, "frame" | "resolvedSubtitles" | "resolvedTimeline" | "planRender" | "presets">;
  /** Renders of the generated clips of a flattened timeline by clip id, at `size` when given (`ClipRenderer.ensure`); absent: graphics are not placed against safe zones. */
  generated?(root: string, timeline: Timeline, size?: { width: number; height: number }): Promise<ReadonlyMap<string, GeneratedSource>>;
  /** The cached face scans of the project's videos (`people scan`); absent: faces are not placed against safe zones. */
  faceScans?(root: string): Promise<readonly ScannedAsset[]>;
  /** Platforms the project's style guide names (`style.json`); empty when there is none. */
  platforms(root: string): Promise<readonly PlatformId[]>;
  /** Absolute ffmpeg and ffprobe for the project rooted at `root`. */
  ffmpeg(root: string): Promise<string>;
  ffprobe(root: string): Promise<string>;
}

/** What one `review` run is asked for; see the `review` method. */
export interface ReviewRequest {
  timeline: string;
  /** Absolute path of an exported video; absent: the timeline. */
  file?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  /** Sheets and `metrics` to write; absent: the default sheets and the metrics. */
  sheets?: readonly ReviewOutput[] | undefined;
  /** Platform whose safe zones the `safe` sheet draws. */
  platform?: PlatformId | undefined;
  every?: number | undefined;
  projectFormat?: string | undefined;
  /** Which version of the timeline to look at. */
  view: TimelineViewName;
  /** The project's format list as `view` shows it, when a proposal changes it (ADR 0036); absent: the file's. */
  formats?: readonly FormatEntry[] | undefined;
  /** With `file`: the export preset the file was made with; the file is then checked against the export plan of `timeline` (in `projectFormat`) with it. */
  preset?: string | undefined;
  /** The film is meant to repeat: a seam that holds a frame or jumps is a craft warning. */
  loop?: boolean | undefined;
}

/** Where review runs are written, project-relative: regenerable, gitignored with the rest of `.frameshell/`. */
export const REVIEW_DIR = [".frameshell", "review"] as const;

/**
 * `review` (#457): contact sheet, phone sheet, fast-motion strips, loop seam and `metrics.json` of a timeline or an
 * exported file, written to `.frameshell/review/<n>/`. Frames come from the `frame` method (timeline) or ffmpeg (file); sampling
 * is in `plan.ts` and tiling in `sheet.ts`, which #471 `analyze` shares.
 */
export class ReviewService {
  readonly #options: ReviewServiceOptions;

  constructor(options: ReviewServiceOptions) {
    this.#options = options;
  }

  /** Write the sheets of `request` for the project at `root`; see the `review` method. */
  async run(root: string, request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
    const scratch = join(root, ".frameshell", "cache", "review", randomBytes(6).toString("hex"));
    await mkdir(scratch, { recursive: true });
    try {
      const ffmpeg = await this.#options.ffmpeg(root);
      const { source, critical, subtitles, viewed, loaded, warnings } = await this.#open(root, request, ffmpeg, scratch);
      const range = frameRange(source.frames, source.fps, request.from, request.to);
      if (!range) {
        const last = frameTime(source.frames - 1, source.fps);
        throw new RpcError(ErrorCode.InvalidOperation, `review: the range ${request.from ?? 0} to ${request.to ?? "the end"} s holds no frame (frames start from 0 to ${last} s).`, {
          op: "review",
          reason: "out of range",
          field: "from",
          valid: { min: 0, max: last },
        });
      }
      const safePlatforms = await this.#safePlatforms(root, request, source, warnings);
      const kinds = REVIEW_SHEETS.filter((kind) => (kind === "safe" ? safePlatforms.length > 0 : request.sheets === undefined || request.sheets.includes(kind)));
      const { run, dir } = await this.#nextRun(root);
      const frames = new Frames(source, join(scratch, "frames"));
      const aspect = source.width / source.height;
      const sheets: ReviewSheet[] = [];
      const peaks: ReviewPeak[] = [];
      let measured: MotionSeries | undefined;
      /** The motion of the range, measured once for the `motion` sheet and the metrics. */
      const motion = async () => (measured ??= await source.motion(range, join(scratch, "motion"), signal));
      const safeZones: ReviewSafeZone[] = [];

      /** Write the images of `kind` for `picks`, named `<stem>.png` or, for several, `<stem>-<i>.png`. */
      const write = async (
        kind: ReviewSheetKind,
        picks: readonly FramePick[],
        stem: string,
        numbered = false,
        extra: Pick<SheetImagesOptions, "shade" | "flags"> = {},
      ): Promise<string[]> => {
        const images = await writeSheetImages({
          ffmpeg,
          fps: source.fps,
          aspect,
          frames,
          layout: sheetLayout(kind, aspect),
          picks,
          dir,
          stem,
          numbered,
          scratch,
          signal,
          ...extra,
        });
        sheets.push(...images.map((image) => ({ kind, ...image })));
        return images.map((image) => image.path);
      };

      for (const kind of kinds) {
        signal?.throwIfAborted();
        if (kind === "contact") await write("contact", contactPicks(source.fps, range, critical, request.every), "contact");
        else if (kind === "safe") {
          const frame = { width: source.width, height: source.height };
          const picks = contactPicks(source.fps, range, critical, request.every, MAX_SAFE_TILES);
          // Every track of a project takes the one caption face of its style.
          const metrics = subtitles[0] ? await captionFontMetrics(root, subtitles[0].style.font) : null;
          const boxes = loaded ? await this.#boxes(root, request, loaded, source, join(scratch, "boxes"), warnings, signal) : [];
          for (const platform of safePlatforms) {
            const zone = SAFE_ZONES[platform];
            const insets = filmInsets(zone, frame);
            const crossing = [...(metrics ? cueCrossings(subtitles, insets, frame, metrics) : []), ...boxCrossings(boxes, insets, frame, source.fps)].filter(
              (cue) => cue.end > range.first && cue.start < range.end,
            );
            const paths = await write("safe", picks, `safe-${platform}`, false, {
              shade: { top: insets.top / frame.height, bottom: insets.bottom / frame.height, left: insets.left / frame.width, right: insets.right / frame.width },
              flags: (pick) => subjectsAt(crossing, pick.frame),
            });
            safeZones.push({ platform, measured: zone.measured, source: zone.source, insets, sheets: paths, flags: safeFlags(crossing, source.fps) });
          }
        } else if (kind === "phone") await write("phone", phonePicks(source.fps, range), "phone");
        else if (kind === "seam") {
          const picks = seamPicks(range);
          if (picks) await write("seam", picks, "seam");
          else warnings.push("seam: the range is a single frame, so there is no seam to look at.");
        } else {
          const series = await motion();
          const found = motionPeaks(series.times, series.energy);
          if (found.length === 0) warnings.push("motion: nothing in the picture changes between frames, so there are no fast moments to show.");
          for (const [i, peak] of found.entries()) {
            const strip = i < STRIPS ? (await write("motion", stripPicks(source.fps, range, peak.at), `motion-${i + 1}`))[0]! : null;
            peaks.push({ ...peak, strip });
          }
        }
      }

      let metrics: ReviewMetrics | null = null;
      if (request.sheets === undefined || request.sheets.includes("metrics")) {
        signal?.throwIfAborted();
        const series = await motion();
        const seconds = { from: frameTime(range.first, source.fps), to: frameTime(range.end, source.fps) };
        const loudness = await this.#loudness(request, source, ffmpeg, warnings, signal);
        const sync = await this.#sync(root, request, source, loaded, series, critical, seconds, ffmpeg, scratch, warnings, signal);
        const seam = await this.#seam(source, range, frames, series, ffmpeg, warnings, signal);
        const delivery = request.file && request.preset ? await this.#delivery(root, request, ffmpeg, loudness, warnings, signal) : null;
        metrics = reviewMetrics({
          fps: source.fps,
          range: seconds,
          series,
          tracks: subtitles,
          loudness,
          hasSound: source.audio ?? null,
          sync,
          seam,
          loop: request.loop === true,
          delivery,
          safe: safeZones.map(({ platform, flags }) => ({ platform, flags })),
        });
        await writeFile(join(dir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
      }

      const result: ReviewResult = {
        view: viewed.view,
        proposal: viewed.proposal,
        source: request.file ? "file" : "timeline",
        timeline: request.file ? null : request.timeline,
        file: request.file ?? null,
        run,
        dir,
        range: { from: frameTime(range.first, source.fps), to: frameTime(range.end, source.fps) },
        fps: source.fps,
        width: source.width,
        height: source.height,
        sheets,
        peaks,
        safeZones,
        metrics,
        warnings,
      };
      const { view: _view, proposal: _proposal, metrics: _metrics, ...manifest } = result;
      await writeFile(join(dir, "review.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await this.#prune(root);
      return result;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }


  /**
   * Boxes of the film's pixels that graphics (generated clips with an alpha render) and faces (footage with a cached `people scan`)
   * hold, for the safe-zone check. Says in `warnings` what could not be measured; never fails the run.
   */
  async #boxes(root: string, request: ReviewRequest, loaded: LoadedTimeline, source: FilmSource, work: string, warnings: string[], signal?: AbortSignal): Promise<BoxSpan[]> {
    const { exports, generated, faceScans } = this.#options;
    const film = { width: source.width, height: source.height };
    let flat: Awaited<ReturnType<ExportService["resolvedTimeline"]>>;
    try {
      flat = await exports.resolvedTimeline(root, loaded, request.projectFormat);
    } catch (error) {
      warnings.push(`safe: graphics and faces are not placed (${(error as Error).message.split("\n")[0]}).`);
      return [];
    }
    const found: BoxSpan[] = [];
    if (faceScans) {
      try {
        found.push(...faceBoxes(flat.timeline, await faceScans(root), film, flat.project, flat.layout));
      } catch (error) {
        warnings.push(`safe: faces are not placed (${(error as Error).message.split("\n")[0]}).`);
      }
    }
    if (generated && generatedClips(flat.timeline).length > 0) {
      try {
        const otherSize = film.width !== flat.project.width || film.height !== flat.project.height;
        const renders = await generated(root, flat.timeline, otherSize ? film : undefined);
        const graphics = await graphicBoxes({ ffmpeg: await this.#options.ffmpeg(root), timeline: flat.timeline, renders, film, project: flat.project, work, signal });
        found.push(...graphics.boxes);
        if (graphics.opaque.length > 0) warnings.push(`safe: ${graphics.opaque.join(", ")} ${graphics.opaque.length === 1 ? "has a render" : "have renders"} with no alpha, so the box of what they draw is not known (it fills the frame).`);
      } catch (error) {
        signal?.throwIfAborted();
        warnings.push(`safe: graphics are not placed (${(error as Error).message.split("\n")[0]}).`);
      }
    }
    return found;
  }

  /**
   * Sounds against picture events: the generated takes on a timeline's audio tracks, or the hits found in a file's sound,
   * against the visual events of the picture and the cuts. Null when there is no sound to place.
   */
  async #sync(
    root: string,
    request: ReviewRequest,
    source: FilmSource,
    loaded: LoadedTimeline | null,
    series: MotionSeries,
    critical: readonly Critical[],
    range: { from: number; to: number },
    ffmpeg: string,
    scratch: string,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<ReviewSync | null> {
    try {
      let sounds;
      if (request.file) {
        if (!source.audio) return null;
        sounds = await fileOnsets(ffmpeg, request.file, join(scratch, "onsets"));
      } else if (loaded) {
        sounds = await takeOnsets(root, (await this.#options.exports.resolvedTimeline(root, loaded, request.projectFormat)).timeline);
      } else return null;
      const spacing = series.times.length > 1 ? (series.times.at(-1)! - series.times[0]!) / (series.times.length - 1) : 0;
      return syncMetrics({
        source: request.file ? "file" : "takes",
        sounds,
        events: visualEvents(series),
        cuts: critical.filter((cut) => cut.tag === "cut").map((cut) => cut.at),
        range,
        spacing,
      });
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`sync: the sounds could not be placed against the picture (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
  }

  /** How far the last frame of the range is from the first; null for a range of one frame. */
  async #seam(source: FilmSource, range: { first: number; end: number }, frames: Frames, series: MotionSeries, ffmpeg: string, warnings: string[], signal?: AbortSignal): Promise<ReviewSeam | null> {
    if (range.end - range.first < 2) return null;
    const last = range.end - 1;
    try {
      await frames.ensure([range.first, last], signal);
      const jump = await seamJump(ffmpeg, frames.path(range.first), frames.path(last), source);
      return { first: frameTime(range.first, source.fps), last: frameTime(last, source.fps), jump: Math.round(jump * 100) / 100, verdict: seamVerdict(jump, pictureMoves(series.energy)) };
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`seam: the first and last frame could not be compared (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
  }

  /**
   * `request.file` against the export plan of the timeline with `request.preset` (in `projectFormat`): size, frame rate, length,
   * codecs and loudness. Null, with a warning, when the plan cannot be made or the file cannot be read.
   */
  async #delivery(root: string, request: ReviewRequest, ffmpeg: string, loudness: ReviewLoudness | null, warnings: string[], signal?: AbortSignal): Promise<ReviewDelivery | null> {
    const { exports } = this.#options;
    try {
      const planned = await exports.planRender(root, { timeline: request.timeline, preset: request.preset, ...(request.projectFormat ? { formats: [request.projectFormat] } : {}) });
      const found = (await exports.presets(root)).find((candidate) => candidate.id === planned.result.preset);
      if (!found) return null;
      const { plugin: _plugin, ...rest } = found;
      const preset = rest as ExportPreset;
      const file = request.file!;
      const [probe, info] = await Promise.all([probeMedia(await this.#options.ffprobe(root), file, signal), stat(file)]);
      return { timeline: request.timeline, preset: preset.id, format: planned.result.format, bytes: info.size, checks: deliveryChecks(planned.result, preset, probe, loudness) };
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`delivery: the file cannot be checked against the export plan (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
  }

  /** The loudness of an exported file's sound, whole and in the phone band; null for a timeline, or for a file with no sound (`warnings` says so). */
  async #loudness(request: ReviewRequest, source: FilmSource, ffmpeg: string, warnings: string[], signal?: AbortSignal): Promise<ReviewLoudness | null> {
    // A timeline's sound is mixed only by `render`, and the number that counts is the file's after the encode.
    if (!request.file) return null;
    if (!source.audio) {
      warnings.push("loudness: the file has no sound.");
      return null;
    }
    try {
      const [whole, band] = await Promise.all([measureLoudness(ffmpeg, request.file, signal), measureLoudness(ffmpeg, request.file, signal, PHONE_BAND_FILTER)]);
      if (whole === null) {
        warnings.push("loudness: ffmpeg reported no reading for the sound.");
        return null;
      }
      return { integrated: whole.integrated, range: whole.range, truePeak: whole.truePeak, phoneBand: band?.integrated ?? null };
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`loudness: ffmpeg could not measure the sound (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
  }

  /** The source of the frames and what is worth a frame in it. */
  async #open(
    root: string,
    request: ReviewRequest,
    ffmpeg: string,
    scratch: string,
  ): Promise<{ source: FilmSource; critical: Critical[]; subtitles: ResolvedSubtitleTrack[]; viewed: Pick<ReviewResult, "view" | "proposal">; loaded: LoadedTimeline | null; warnings: string[] }> {
    const warnings: string[] = [];
    if (request.file) {
      const source = await fileSource(ffmpeg, await this.#options.ffprobe(root), request.file);
      return { source, critical: [], subtitles: [], viewed: { view: "current", proposal: null }, loaded: null, warnings };
    }
    const { timelines, exports } = this.#options;
    const loaded = { ...(await timelines.viewTimeline(root, request.timeline, request.view)), ...(request.formats ? { formats: request.formats } : {}) };
    const shown = await timelines.show(root, request.timeline, request.view);
    if (shown.duration === null) {
      throw new RpcError(ErrorCode.InvalidOperation, `review: timeline ${request.timeline} has a clip whose end is unknown (${shown.problems[0]?.message ?? "nested timeline problem"}); fix it first.`, {
        op: "review",
        reason: "unknown duration",
      });
    }
    const frames = Math.round(shown.duration * loaded.fps);
    if (frames < 1) throw new RpcError(ErrorCode.InvalidOperation, `review: timeline ${request.timeline} is empty.`, { op: "review", reason: "empty" });
    const subtitles = await exports.resolvedSubtitles(root, loaded, request.projectFormat).catch((error: unknown) => {
      warnings.push(`contact: subtitle cues are not marked (${(error as Error).message.split("\n")[0]}).`);
      return [];
    });
    const cues = subtitles.flatMap((track) => track.cues.map((cue) => cue.start / loaded.fps));
    const source = await timelineSource(
      ffmpeg,
      loaded.fps,
      frames,
      async (at, out) => {
        const { width, height } = await exports.frame(root, { timeline: request.timeline, at, out, projectFormat: request.projectFormat }, loaded);
        return { width, height };
      },
      scratch,
    );
    return { source, critical: timelineCritical(shown, cues), subtitles, viewed: { view: loaded.view, proposal: loaded.proposal }, loaded, warnings };
  }

  /**
   * Platforms the `safe` sheet is written for: the one asked for; else, when `safe` is among the sheets asked for or
   * the film is vertical and no sheets were named, the style guide's platforms whose zones suit the film's orientation.
   * Says in `warnings` why a sheet asked for is not written.
   */
  async #safePlatforms(root: string, request: ReviewRequest, film: { width: number; height: number }, warnings: string[]): Promise<PlatformId[]> {
    const asked = request.sheets?.includes("safe") === true;
    if (request.platform) {
      if (request.sheets && !asked) {
        warnings.push(`safe: \`platform\` ${request.platform} is ignored because \`safe\` is not among the sheets asked for.`);
        return [];
      }
      if (!sameOrientation(SAFE_ZONES[request.platform], film)) {
        warnings.push(`safe: ${request.platform} is a ${SAFE_ZONES[request.platform].height > SAFE_ZONES[request.platform].width ? "vertical" : "horizontal"} platform and the film is not, so its zones are scaled to the film's proportions.`);
      }
      return [request.platform];
    }
    if (!asked && !(request.sheets === undefined && film.height > film.width)) return [];
    const named = await this.#options.platforms(root).catch((error: unknown) => {
      if (asked) warnings.push(`safe: the style guide cannot be read (${(error as Error).message.split("\n")[0]}).`);
      return [] as PlatformId[];
    });
    const usable = named.filter((id) => sameOrientation(SAFE_ZONES[id], film));
    if (usable.length === 0 && asked) warnings.push("safe: no platform to draw: pass `platform` (instagram-reels, tiktok, youtube-shorts, youtube) or name platforms in the style guide.");
    return usable;
  }

  /** Create the next numbered folder under `.frameshell/review/`. */
  async #nextRun(root: string): Promise<{ run: number; dir: string }> {
    const base = join(root, ...REVIEW_DIR);
    await mkdir(base, { recursive: true });
    // A concurrent run may take the number first: mkdir without `recursive` fails on it, then take the next.
    for (let run = Math.max(0, ...(await numbered(base))) + 1; ; run++) {
      const dir = join(base, String(run));
      try {
        await mkdir(dir);
        return { run, dir };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  /** Delete the numbered folders but the newest {@link REVIEW_KEEP}. */
  async #prune(root: string): Promise<void> {
    const base = join(root, ...REVIEW_DIR);
    const old = (await numbered(base)).sort((a, b) => b - a).slice(REVIEW_KEEP);
    for (const run of old) await rm(join(base, String(run)), { recursive: true, force: true });
  }
}

/** The run numbers under `base`. */
async function numbered(base: string): Promise<number[]> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name));
}
