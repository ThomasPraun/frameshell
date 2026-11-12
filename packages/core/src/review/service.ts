import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ErrorCode,
  REVIEW_KEEP,
  REVIEW_SHEETS,
  type ReviewPeak,
  type ReviewResult,
  type ReviewSafeZone,
  type ReviewSheet,
  type ReviewSheetKind,
  RpcError,
  type TimelineViewName,
} from "@frameshell/protocol";
import { type PlatformId, type ResolvedSubtitleTrack, SAFE_ZONES } from "@frameshell/schema";
import { bundledFontMetrics } from "../export/font-metrics.js";
import type { ExportService } from "../export/service.js";
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
import { crossingAt, cueCrossings, filmInsets, safeFlags, sameOrientation } from "./safe.js";
import { type FilmSource, fileSource, timelineSource } from "./source.js";

/** Options for {@link ReviewService}. */
export interface ReviewServiceOptions {
  timelines: Pick<TimelineService, "viewTimeline" | "show">;
  exports: Pick<ExportService, "frame" | "resolvedSubtitles">;
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
  sheets?: readonly ReviewSheetKind[] | undefined;
  /** Platform whose safe zones the `safe` sheet draws. */
  platform?: PlatformId | undefined;
  every?: number | undefined;
  projectFormat?: string | undefined;
  /** Which version of the timeline to look at. */
  view: TimelineViewName;
}

/** Where review runs are written, project-relative: regenerable, gitignored with the rest of `.frameshell/`. */
export const REVIEW_DIR = [".frameshell", "review"] as const;

/**
 * `review` (#457): contact sheet, phone sheet, fast-motion strips and loop seam of a timeline or an exported file,
 * written to `.frameshell/review/<n>/`. Frames come from the `frame` method (timeline) or ffmpeg (file); sampling
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
      const { source, critical, subtitles, viewed, warnings } = await this.#open(root, request, ffmpeg, scratch);
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
          const metrics = subtitles.length > 0 ? await bundledFontMetrics() : null;
          for (const platform of safePlatforms) {
            const zone = SAFE_ZONES[platform];
            const insets = filmInsets(zone, frame);
            const crossing = metrics ? cueCrossings(subtitles, insets, frame, metrics).filter((cue) => cue.end > range.first && cue.start < range.end) : [];
            const paths = await write("safe", picks, `safe-${platform}`, false, {
              shade: { top: insets.top / frame.height, bottom: insets.bottom / frame.height, left: insets.left / frame.width, right: insets.right / frame.width },
              flags: (pick) => (crossingAt(crossing, pick.frame) ? ["subtitle"] : []),
            });
            safeZones.push({ platform, measured: zone.measured, source: zone.source, insets, sheets: paths, flags: safeFlags(crossing, source.fps) });
          }
        } else if (kind === "phone") await write("phone", phonePicks(source.fps, range), "phone");
        else if (kind === "seam") {
          const picks = seamPicks(range);
          if (picks) await write("seam", picks, "seam");
          else warnings.push("seam: the range is a single frame, so there is no seam to look at.");
        } else {
          const series = await source.motion(range, join(scratch, "motion"), signal);
          const found = motionPeaks(series.times, series.energy);
          if (found.length === 0) warnings.push("motion: nothing in the picture changes between frames, so there are no fast moments to show.");
          for (const [i, peak] of found.entries()) {
            const strip = i < STRIPS ? (await write("motion", stripPicks(source.fps, range, peak.at), `motion-${i + 1}`))[0]! : null;
            peaks.push({ ...peak, strip });
          }
        }
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
        warnings,
      };
      const { view: _view, proposal: _proposal, ...manifest } = result;
      await writeFile(join(dir, "review.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await this.#prune(root);
      return result;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** The source of the frames and what is worth a frame in it. */
  async #open(
    root: string,
    request: ReviewRequest,
    ffmpeg: string,
    scratch: string,
  ): Promise<{ source: FilmSource; critical: Critical[]; subtitles: ResolvedSubtitleTrack[]; viewed: Pick<ReviewResult, "view" | "proposal">; warnings: string[] }> {
    const warnings: string[] = [];
    if (request.file) {
      const source = await fileSource(ffmpeg, await this.#options.ffprobe(root), request.file);
      return { source, critical: [], subtitles: [], viewed: { view: "current", proposal: null }, warnings };
    }
    const { timelines, exports } = this.#options;
    const loaded = await timelines.viewTimeline(root, request.timeline, request.view);
    const shown = await timelines.show(root, request.timeline, request.view);
    if (shown.duration === null) {
      throw new RpcError(ErrorCode.InvalidOperation, `review: timeline ${request.timeline} has a clip whose end is unknown (${shown.problems[0]?.message ?? "nested timeline problem"}); fix it first.`, {
        op: "review",
        reason: "unknown duration",
      });
    }
    const frames = Math.round(shown.duration * loaded.fps);
    if (frames < 1) throw new RpcError(ErrorCode.InvalidOperation, `review: timeline ${request.timeline} is empty.`, { op: "review", reason: "empty" });
    const subtitles = await exports.resolvedSubtitles(root, loaded).catch((error: unknown) => {
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
    return { source, critical: timelineCritical(shown, cues), subtitles, viewed: { view: loaded.view, proposal: loaded.proposal }, warnings };
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
      warnings.push(`safe: the style guide cannot be read (${(error as Error).message.split("\n")[0]}).`);
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
