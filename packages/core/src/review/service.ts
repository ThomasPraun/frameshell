import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ErrorCode,
  REVIEW_KEEP,
  REVIEW_PICKED_SHEETS,
  type ReviewBehind,
  type ReviewBehindSample,
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
  type ReviewSound,
  type ReviewSpeed,
  type ReviewSync,
  RpcError,
  type TimelineViewName,
} from "@frameshell/protocol";
import {
  type AdapterClip,
  type FormatEntry,
  type PlatformId,
  clipLength,
  letterboxPicture,
  type RequirementsFile,
  type ResolvedSubtitleTrack,
  SAFE_ZONES,
  type ExportPreset,
  type Size,
  type StyleSource,
  type Timeline,
  showsPicture,
} from "@frameshell/schema";
import { PHONE_BAND_FILTER, measureLoudness } from "../analyze/loudness.js";
import { MAX_PICTURE_S } from "../analyze/picture.js";
import { sceneScores } from "../analyze/scene.js";
import { DEFAULT_CUT_THRESHOLD, detectCuts } from "../analyze/shots.js";
import { generatedClips } from "../clips/renderer.js";
import type { GeneratedSource } from "../export/compiler.js";
import { captionFontMetrics } from "../export/font-metrics.js";
import { type ExportService, type LoadedTimeline, readTranscriptFile } from "../export/service.js";
import { BINARY_ERRORS } from "../media/duck.js";
import type { EnergyProfile } from "../media/energy.js";
import { probeMedia } from "../media/ffmpeg.js";
import type { ScannedAsset } from "../people/face-clusters.js";
import { soundsOn } from "../sound/place.js";
import type { TimelineService } from "../timeline/service.js";
import type { TempoResult } from "../timeline/tempo.js";
import { unusableGrid } from "../timeline/time-ref.js";
import { encodeRgbPng } from "../segment/png.js";
import {
  type BeatGrid,
  type CropRect,
  type Critical,
  type CutPick,
  DEFAULT_CROP_SIZE,
  type FramePick,
  type FrameRange,
  MAX_SAFE_TILES,
  beatPicks,
  contactPicks,
  cropRect,
  cutPicks,
  frameIndex,
  frameRange,
  frameTime,
  motionPeaks,
  onionPicks,
  phonePicks,
  popPicks,
  seamPicks,
  sheetLayout,
  stripPicks,
  STRIPS,
  tileLabel,
  timelineCritical,
  timelineSampleStep,
} from "./plan.js";
import { speedChart } from "./chart.js";
import { Frames, type KitSheetOptions, type SheetImagesOptions, writeOnionSheet, writePopSheet, writeSheetImages } from "./images.js";
import { writeSheet } from "./sheet.js";
import { type HeroSample, peakSpeed, spansOf, speedOf } from "./speed.js";
import { BEHIND_WIDTH, SPEED_ALPHA_WIDTH } from "./thresholds.js";
import { deliveryChecks } from "./delivery.js";
import { seamOf, seamVerdict } from "./loop.js";
import { reviewMetrics, visualEvents } from "./metrics.js";
import { fileBandEnvelope, fileClicks, fileEnvelope, fileOnsets, takeOnsets } from "./onsets.js";
import { fileSound, heardClips, timelineSound } from "./sound.js";
import { type BoxSpan, type ClipPicture, alphaHero, alphaMask, clipHero, clipPointInFilm, clipRectInFilm, faceBoxes, graphicBoxes, matteFrame } from "./placement.js";
import { behindEntry, boxesMeet, coveredShare, matteFrameAt, sampleFrames, subjectSpans, within } from "./behind.js";
import { type ClipSpan, type FramePlacement, judgeRequirements } from "./requirements.js";
import { readRequirementsFile } from "./requirements-file.js";
import { boxCrossings, cueCrossings, filmInsets, safeFlags, sameOrientation, subjectsAt, withinPicture } from "./safe.js";
import { type FilmSource, type MotionSeries, fileSource, timelineSource } from "./source.js";
import { syncMetrics } from "./sync.js";

/** A timeline flattened for a format, as `ExportService.resolvedTimeline` gives it. */
type Flat = Awaited<ReturnType<ExportService["resolvedTimeline"]>>;

/**
 * The clips of the flattened timeline's video and audio tracks that sit inside a nested clip (id `<nested clip id>/<inner id>`),
 * as spans on the timeline's clock; `known` are the top-level ids, which stay as the timeline lists them.
 * Shots of program tracks inside a nested clip are left out.
 */
function nestedClipSpans(flat: Timeline, fps: number, known: ReadonlySet<string>): ClipSpan[] {
  const found: ClipSpan[] = [];
  const seen = new Set<string>();
  for (const track of flat.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    for (const clip of track.clips) {
      // A `behind` plate is copied onto a subject track under its own id: one span per id.
      if (!clip.id.includes("/") || known.has(clip.id) || seen.has(clip.id)) continue;
      seen.add(clip.id);
      const length = clipLength(clip, { fps });
      found.push({ id: clip.id, start: clip.start, end: Number.isFinite(length) ? clip.start + length : null });
    }
  }
  return found;
}

/** A clip of a video track of the flattened timeline, as `ReviewService.#videoClip` finds it. */
interface VideoClip {
  clip: ClipPicture["clip"];
  placed: ClipPicture;
  /** Timeline seconds it starts and ends. */
  start: number;
  end: number;
  resolved: Flat;
}

/** What `ReviewService.#boxes` placed: graphics and faces, generated clips with no alpha, and whether the timeline was laid out at all. */
interface Placed {
  boxes: BoxSpan[];
  opaque: string[];
  laidOut: boolean;
}

/** A finished subject matte: absolute path, size, frame rate and frame count (`<key>.json`). */
export interface ReadyMatte {
  path: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** Options for {@link ReviewService}. */
export interface ReviewServiceOptions {
  timelines: Pick<TimelineService, "viewTimeline" | "show">;
  exports: Pick<ExportService, "frame" | "resolvedSubtitles" | "resolvedTimeline" | "planRender" | "presets">;
  /** Renders of the generated clips of a flattened timeline by clip id, at `size` when given (`ClipRenderer.ensure`); absent: graphics are not placed against safe zones. */
  generated?(root: string, timeline: Timeline, size?: { width: number; height: number }): Promise<ReadonlyMap<string, GeneratedSource>>;
  /** The cached face scans of the project's videos (`people scan`); absent: faces are not placed against safe zones. */
  faceScans?(root: string): Promise<readonly ScannedAsset[]>;
  /** The 10 ms envelope of a project asset (`EnergyStore.profile`); absent: a timeline's sound is not reviewed. */
  soundProfile?(root: string, asset: string): Promise<EnergyProfile>;
  /** Platforms the project's style guide names (`style.json`); empty when there is none. */
  platforms(root: string): Promise<readonly PlatformId[]>;
  /** dB the project's style guide sets music under the voice (`style.json` `sound.musicUnderVoice`, or the default); absent: the default. */
  musicUnderVoice?(root: string): Promise<{ value: number; source: StyleSource }>;
  /** The tempo grid of a timeline up to `horizon` seconds (`tempoGrid`); absent: the `beats` sheet is not written. */
  grid?(root: string, timeline: { timeline: Timeline; fps: number }, horizon: number): Promise<TempoResult>;
  /** Size of the picture of a project asset, null when it has none (`MediaService.probe`); absent: taken as the film's. */
  pictureSize?(root: string, asset: string): Promise<Size | null>;
  /**
   * The finished proxy-size subject matte of a project asset (ADR 0032), read only: review never starts a matte job.
   * `missing` says why there is none. Absent: words behind the person are not measured.
   */
  readyMatte?(root: string, asset: string): Promise<ReadyMatte | { missing: string }>;
  /** Absolute ffmpeg and ffprobe for the project rooted at `root`. */
  ffmpeg(root: string): Promise<string>;
  ffprobe(root: string): Promise<string>;
}

/** The point `cropAt` crops every tile around; see the `review` method. */
export interface CropAt {
  /** Fractions of the film's frame, or of the picture of `clip`. */
  x: number;
  y: number;
  /** Width of the crop as a share of the frame's width; default {@link DEFAULT_CROP_SIZE}. */
  size?: number | undefined;
  clip?: string | undefined;
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
  /** The project's requirements as `view` shows them, when a proposal changes them (ADR 0036); absent: the file's. */
  requirements?: RequirementsFile | null | undefined;
  /** Why the proposal's requirements hold no valid file (`requirements` is then null): said in `warnings`. */
  requirementsError?: string | undefined;
  /** Crop every tile but the `safe` sheet's around this point. */
  cropAt?: CropAt | undefined;
  /** Seconds of a pop: the `pop` sheet shows the frame before and the frame at it, and their difference. */
  pop?: number | undefined;
  /** Clip id whose frames the `onion` sheet blends. */
  onion?: string | undefined;
  /** Clip id whose hero point the `speed` sheet charts. */
  speed?: string | undefined;
}

/** Where review runs are written, project-relative: regenerable, gitignored with the rest of `.frameshell/`. */
export const REVIEW_DIR = [".frameshell", "review"] as const;

/**
 * `review`: contact sheet, phone sheet, fast-motion strips, loop seam, cut strips, the per-clip kit (pop pair,
 * onion skin, speed graph) and `metrics.json` of a timeline or an
 * exported file, written to `.frameshell/review/<n>/`. Frames come from the `frame` method (timeline) or ffmpeg (file); sampling
 * is in `plan.ts` and tiling in `sheet.ts`, which `analyze` shares.
 */
export class ReviewService {
  readonly #options: ReviewServiceOptions;

  constructor(options: ReviewServiceOptions) {
    this.#options = options;
  }

  /** Write the sheets of `request` for the project at `root`; see the `review` method. */
  async run(root: string, request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
    if (request.file && request.cropAt?.clip !== undefined) {
      throw new RpcError(ErrorCode.InvalidOperation, "review: `cropAt.clip` follows a clip of the timeline, and a file has no clips: drop `clip` (the point is then in the frame) or review the timeline.", {
        op: "review",
        field: "cropAt.clip",
        reason: "file",
      });
    }
    for (const field of ["onion", "speed"] as const) {
      if (request.file && request[field] !== undefined) {
        throw new RpcError(ErrorCode.InvalidOperation, `review: \`${field}\` names a clip of the timeline, and a file has no clips: review the timeline.`, { op: "review", field, reason: "file" });
      }
    }
    const scratch = join(root, ".frameshell", "cache", "review", randomBytes(6).toString("hex"));
    await mkdir(scratch, { recursive: true });
    try {
      const ffmpeg = await this.#options.ffmpeg(root);
      const { source, critical, subtitles, viewed, loaded, clips, warnings } = await this.#open(root, request, ffmpeg, scratch);
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
      const pop = request.pop === undefined ? null : popPicks(source.frames, frameIndex(request.pop, source.fps));
      if (request.pop !== undefined && !pop) {
        const last = frameTime(source.frames - 1, source.fps);
        throw new RpcError(ErrorCode.InvalidOperation, `review: \`pop\` ${request.pop} s is ${request.pop < 1 / source.fps ? "the first frame, which has no frame before it" : "past the film's last frame"} (a pop is looked at from ${frameTime(1, source.fps)} to ${last} s).`, {
          op: "review",
          field: "pop",
          reason: "out of range",
          valid: { min: frameTime(1, source.fps), max: last },
        });
      }
      // With only the per-clip kit asked for, the run is a debugging look: no default sheets.
      const kitOnly = request.sheets === undefined && (request.pop !== undefined || request.onion !== undefined || request.speed !== undefined);
      const safePlatforms = kitOnly && !request.platform ? [] : await this.#safePlatforms(root, request, source, warnings);
      // `beats` and `cuts` are written only when named: a tempo most films do not set, a strip per cut that floods a long film.
      const asked = (kind: (typeof REVIEW_PICKED_SHEETS)[number]) =>
        kind === "beats" || kind === "cuts" ? request.sheets?.includes(kind) === true : !kitOnly && (request.sheets === undefined || request.sheets.includes(kind));
      const kinds = REVIEW_PICKED_SHEETS.filter((kind) => (kind === "safe" ? safePlatforms.length > 0 : asked(kind)));
      const frames = new Frames(source, join(scratch, "frames"));
      const aspect = source.width / source.height;
      const sheets: ReviewSheet[] = [];
      const peaks: ReviewPeak[] = [];
      let measured: MotionSeries | undefined;
      /** The motion of the range, measured once for the `motion` sheet and the metrics. */
      const motion = async (): Promise<MotionSeries> => {
        if (measured) return measured;
        measured = await source.motion(range, join(scratch, "motion"), signal);
        if (measured.truncated) warnings.push(`motion and rhythm: measured on the first ${MAX_PICTURE_S / 60} minutes of the file.`);
        return measured;
      };
      const safeZones: ReviewSafeZone[] = [];
      /** The timeline flattened for the format, resolved once for the safe-zone boxes and the sync. */
      let flattened: Promise<Flat> | undefined;
      const flat = (): Promise<Flat> => (flattened ??= this.#options.exports.resolvedTimeline(root, loaded!, request.projectFormat));
      const frame = { width: source.width, height: source.height };
      /** The picture the timeline's letterbox bars leave in this format (ADR 0043); null without bars. */
      const picture = async () => letterboxPicture(frame, await flat().then((resolved) => resolved.timeline.letterbox?.aspect, () => undefined));
      let placing: Promise<Placed> | undefined;
      /** Graphics and faces of the timeline, placed once for the safe zones and `staysInFrame`. */
      const placed = (topic: string): Promise<Placed> => (placing ??= this.#boxes(root, flat, source, join(scratch, "boxes"), warnings, topic, signal));
      const crop = request.cropAt ? await this.#cropper(root, request, request.cropAt, frame, loaded ? flat : null, loaded ? picture : null) : undefined;
      if (crop && kinds.includes("safe")) warnings.push("safe: the safe-zone sheet shows whole frames, not the `cropAt` crop: its zones lie on the frame's edges.");
      const onion = request.onion === undefined ? null : await this.#clipFrames(root, request, "onion", request.onion, frame, flat, range);
      const speedClip = request.speed === undefined ? null : await this.#clipFrames(root, request, "speed", request.speed, frame, flat, range);
      let cutting: Promise<number[]> | undefined;
      /** Frames where a shot starts, found once for the `cuts` sheet and the metrics. */
      const cutFrames = (): Promise<number[]> => (cutting ??= this.#cuts(request, source, critical, ffmpeg, warnings, signal));
      // After `cropAt` is checked, so a refused clip leaves no empty run folder.
      const { run, dir } = await this.#nextRun(root);

      /** Write the images of `kind` for `picks`, named `<stem>.png` or, for several, `<stem>-<i>.png`. */
      const write = async (
        kind: ReviewSheetKind,
        picks: readonly FramePick[],
        stem: string,
        numbered = false,
        extra: Pick<SheetImagesOptions, "shade" | "flags" | "label"> = {},
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
          ...(crop && kind !== "safe" ? { crop } : {}),
          ...extra,
        });
        sheets.push(...images.map((image) => ({ kind, ...image })));
        return images.map((image) => image.path);
      };

      for (const kind of kinds) {
        signal?.throwIfAborted();
        if (kind === "contact") await write("contact", contactPicks(source.fps, range, critical, request.every), "contact");
        else if (kind === "safe") {
          const picks = contactPicks(source.fps, range, critical, request.every, MAX_SAFE_TILES);
          // Every track of a project takes the one caption face of its style.
          const metrics = subtitles[0] ? await captionFontMetrics(root, subtitles[0].style.font) : null;
          // The bars of the timeline's letterbox in this format (ADR 0043) cover graphics and faces; captions are drawn over them.
          const bars = loaded ? await picture() : null;
          const boxes = withinPicture(loaded ? (await placed("safe")).boxes : [], bars);
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
            safeZones.push({ platform, measured: zone.measured, source: zone.source, insets, ...(bars ? { picture: bars } : {}), sheets: paths, flags: safeFlags(crossing, source.fps) });
          }
        } else if (kind === "phone") await write("phone", phonePicks(source.fps, range), "phone");
        else if (kind === "seam") {
          const picks = seamPicks(range);
          if (picks) await write("seam", picks, "seam");
          else warnings.push("seam: the range is a single frame, so there is no seam to look at.");
        } else if (kind === "cuts") {
          const found = cutPicks(source.fps, range, await cutFrames());
          if (found.picks.length === 0) warnings.push("cuts: no cut falls inside the range reviewed, so there is no seam strip to show.");
          else {
            if (found.dropped > 0) warnings.push(`cuts: ${found.cuts} cuts in the range; the sheet shows ${found.cuts - found.dropped} of them spread evenly and leaves ${found.dropped} out (narrow the range to see them).`);
            await write("cuts", found.picks, "cuts", false, { label: (pick, at) => tileLabel(at, pick.tag, (pick as CutPick).name) });
          }
        } else if (kind === "beats") {
          const grid = loaded ? await this.#beatGrid(root, loaded, source, warnings) : null;
          if (!loaded) warnings.push("beats: a file has no tempo grid: review the timeline for the beats sheet.");
          const picks = grid ? beatPicks(source.fps, range, grid) : [];
          if (grid && picks.length === 0) warnings.push("beats: no beat of the tempo grid falls in the range reviewed.");
          if (picks.length > 0) {
            const names = new Map(picks.map((pick) => [pick.frame, pick.name] as const));
            await write("beats", picks, "beats", false, { label: (pick, at) => tileLabel(at, pick.tag, names.get(pick.frame)) });
          }
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

      const kit: KitSheetOptions = { ffmpeg, fps: source.fps, aspect, frames, layout: sheetLayout("pop", aspect), dir, scratch, signal, ...(crop ? { crop } : {}) };
      if (pop) {
        signal?.throwIfAborted();
        sheets.push({ kind: "pop", ...(await writePopSheet({ ...kit, picks: pop })) });
      }
      if (onion) {
        signal?.throwIfAborted();
        const picks = onionPicks(onion.frames);
        const label = tileLabel(frameTime(picks[0]!.frame, source.fps), "onion", `onion ${request.onion} ${picks.length} frames to ${frameTime(picks.at(-1)!.frame, source.fps).toFixed(2)}`);
        sheets.push({ kind: "onion", ...(await writeOnionSheet({ ...kit, layout: sheetLayout("onion", aspect), picks, label })) });
      }
      const speed: ReviewSpeed[] = [];
      if (speedClip) {
        signal?.throwIfAborted();
        const found = await this.#speed(root, request.speed!, speedClip, source, { ffmpeg, dir, scratch, warnings, signal });
        speed.push(found.speed);
        if (found.sheet) sheets.push(found.sheet);
      }

      let metrics: ReviewMetrics | null = null;
      const wantsMetrics = request.sheets === undefined ? !kitOnly || request.speed !== undefined : request.sheets.includes("metrics");
      if (request.speed !== undefined && !wantsMetrics) warnings.push("speed: its linear moves and dead stops are listed in `metrics.speed`: add `metrics` to the sheets to get them.");
      if (wantsMetrics) {
        signal?.throwIfAborted();
        const series = await motion();
        const seconds = { from: frameTime(range.first, source.fps), to: frameTime(range.end, source.fps) };
        const loudness = await this.#loudness(request, source, ffmpeg, warnings, signal);
        let decoded: Promise<Float32Array> | undefined;
        /** The 10 ms envelope of a file's sound, decoded once for the sync and the sound review list. */
        const envelope = (file: string) => (decoded ??= fileEnvelope(ffmpeg, file, join(scratch, "sound")));
        const cuts = await cutFrames();
        const sync = await this.#sync(root, request, source, loaded ? flat : null, series, cuts, critical, seconds, envelope, warnings, signal);
        const sound = await this.#sound(root, request, source, loaded ? flat : null, seconds, ffmpeg, envelope, scratch, warnings, signal);
        const seam = await this.#seam(source, range, frames, ffmpeg, warnings, signal);
        const delivery = request.file && request.preset ? await this.#delivery(root, request, ffmpeg, loudness, warnings, signal) : null;
        const behind = loaded ? await this.#behind(root, loaded, flat, source, seconds, ffmpeg, join(scratch, "behind"), warnings, signal) : null;
        metrics = reviewMetrics({
          fps: source.fps,
          range: seconds,
          source: request.file ? "file" : "timeline",
          series,
          cuts,
          tracks: subtitles,
          loudness,
          hasSound: source.audio ?? null,
          sync,
          seam,
          loop: request.loop === true,
          delivery,
          sound,
          safe: safeZones.map(({ platform, flags }) => ({ platform, flags })),
          ...(speedClip ? { speed } : {}),
          ...(behind ? { behind } : {}),
        });
        if (request.requirementsError !== undefined) warnings.push(`requirements: the proposal's requirements are invalid (${request.requirementsError.split("\n")[0]}), so the film is judged without them.`);
        const requirements = request.requirements !== undefined ? request.requirements : await readRequirementsFile(root);
        if (requirements) {
          const inFrame = loaded !== null && requirements.clips.some((clip) => clip.staysInFrame !== undefined);
          // Clips inside nested timelines are named `<nested clip id>/<inner id>`: read from the flattened timeline, and only when the file asks about clips (a check or a clip waiver).
          let judgedClips = clips;
          if (clips !== null && (requirements.clips.length > 0 || requirements.waivers.some((waiver) => waiver.clip !== undefined))) {
            const resolved = await flat().catch((error: unknown) => {
              warnings.push(`requirements: the flattened timeline cannot be read (${(error as Error).message.split("\n")[0]}), so clips inside nested timelines cannot be judged.`);
              return null;
            });
            if (resolved) judgedClips = [...clips, ...nestedClipSpans(resolved.timeline, source.fps, new Set(clips.map((clip) => clip.id)))];
          }
          let placement: FramePlacement | null = null;
          if (inFrame) {
            const found = await placed("staysInFrame");
            if (found.laidOut) {
              const unplaced = new Map(found.opaque.map((id) => [id, "its render has no alpha plane, so it fills the frame and what it draws has no box"] as const));
              const bars = await picture();
              placement = { format: (await flat()).format, picture: bars ?? { left: 0, top: 0, ...frame }, boxes: found.boxes, unplaced };
            }
          }
          const judged = judgeRequirements({
            requirements,
            metrics,
            series,
            filmSeconds: source.frames / source.fps,
            range: seconds,
            fps: source.fps,
            timeline: loaded?.timeline ?? null,
            clips: judgedClips,
            tracks: loaded ? subtitles : null,
            placement,
          });
          metrics = judged.metrics;
          warnings.push(...judged.notes);
        }
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
   * The tempo grid of the timeline reviewed, the one `tempo.show` lists, for the `beats` sheet; null, with a `warnings`
   * line saying why, when there is none to use (no tempo, beats not measured or broken, a LOW-confidence grid).
   */
  async #beatGrid(root: string, loaded: LoadedTimeline, source: FilmSource, warnings: string[]): Promise<BeatGrid | null> {
    if (!this.#options.grid) {
      warnings.push("beats: this daemon has no tempo grid to read.");
      return null;
    }
    let found: TempoResult;
    try {
      found = await this.#options.grid(root, loaded, source.frames / source.fps + 1);
    } catch (error) {
      warnings.push(`beats: the tempo grid cannot be read (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
    const refusal = unusableGrid(found);
    if (refusal || !found.grid) {
      warnings.push(`beats: no beats sheet: ${refusal?.message ?? "the timeline has no tempo."}${refusal?.hint ? ` ${refusal.hint}` : ""}`);
      return null;
    }
    return found.grid;
  }

  /**
   * The crop of each tile for `cropAt`: one rectangle for a point of the frame, or, with `clip`, the point of the clip's
   * picture where the clip's placement (keys) and the format's cover crop put it at that frame, clamped to the clip's span.
   * The crop stays inside the picture letterbox bars leave. Throws InvalidOperation when `clip` is no picture clip.
   */
  async #cropper(
    root: string,
    request: ReviewRequest,
    at: CropAt,
    frame: Size,
    flat: (() => Promise<Flat>) | null,
    picture: (() => Promise<ReturnType<typeof letterboxPicture>>) | null,
  ): Promise<(pick: FramePick, seconds: number) => CropRect> {
    const size = at.size ?? DEFAULT_CROP_SIZE;
    const bars = picture ? await picture() : null;
    if (at.clip === undefined) {
      const fixed = cropRect(frame, { x: at.x * frame.width, y: at.y * frame.height }, size, bars);
      return () => fixed;
    }
    const { clip, placed, start, end, resolved } = await this.#videoClip(root, request, "cropAt.clip", at.clip, frame, flat!);
    const last = Math.max(start, end - 0.5 / resolved.fps);
    return (_pick, seconds) => {
      // The middle of the frame, where the capture takes it.
      const shown = Math.min(Math.max(seconds + 0.5 / resolved.fps, clip.start), last);
      const point = clipPointInFilm(placed, shown, at, frame, resolved.project, resolved.layout);
      return cropRect(frame, point, size, bars);
    };
  }

  /**
   * The clip `id` of a video track of the flattened timeline, with the size of its own picture. Throws InvalidOperation,
   * naming `field`, when there is no such clip or it has no picture.
   */
  async #videoClip(root: string, request: ReviewRequest, field: string, id: string, frame: Size, flat: () => Promise<Flat>): Promise<VideoClip> {
    const resolved = await flat();
    const base = resolved.timeline.tracks.find(showsPicture);
    const track = resolved.timeline.tracks.find((candidate) => candidate.kind === "video" && candidate.clips.some((clip) => clip.id === id));
    const clip = track?.kind === "video" ? track.clips.find((candidate) => candidate.id === id) : undefined;
    if (!track || !clip) {
      throw new RpcError(ErrorCode.InvalidOperation, `review: \`${field}\` ${id} is not a clip of a video track of timeline ${request.timeline} (\`timeline.show\` lists the clip ids).`, {
        op: "review",
        field,
        reason: "not found",
      });
    }
    const generated = !("asset" in clip);
    let source: Size | null = frame;
    if ("asset" in clip && this.#options.pictureSize) source = await this.#options.pictureSize(root, clip.asset);
    if (!source) {
      throw new RpcError(ErrorCode.InvalidOperation, `review: \`${field}\` ${id} plays ${"asset" in clip ? clip.asset : "a clip"}, which has no picture to follow.`, {
        op: "review",
        field,
        reason: "no picture",
      });
    }
    const length = "asset" in clip ? (clip.out - clip.in) / (clip.speed ?? 1) : (clip.duration ?? 0);
    return { clip, placed: { clip, source, generated, base: base?.id === track.id }, start: clip.start, end: clip.start + length, resolved };
  }

  /** The clip `id` of {@link #videoClip} and the frames of the range it plays in; InvalidOperation when it plays in none. */
  async #clipFrames(root: string, request: ReviewRequest, field: "onion" | "speed", id: string, frame: Size, flat: () => Promise<Flat>, range: FrameRange): Promise<VideoClip & { frames: FrameRange }> {
    const found = await this.#videoClip(root, request, field, id, frame, flat);
    const fps = found.resolved.fps;
    const frames = { first: Math.max(range.first, frameIndex(found.start, fps)), end: Math.min(range.end, Math.ceil(found.end * fps - 1e-6)) };
    if (frames.first >= frames.end) {
      throw new RpcError(ErrorCode.InvalidOperation, `review: \`${field}\` ${id} plays from ${found.start} to ${Math.round(found.end * 1000) / 1000} s, outside the range reviewed.`, {
        op: "review",
        field,
        reason: "out of range",
      });
    }
    return { ...found, frames };
  }

  /**
   * The speed graph of a clip's hero point over `found.frames`: a media clip's picture as its keys place it, every frame;
   * a generated clip's alpha (centre and area), at up to 90 frames. Writes the chart as the `speed` sheet. A generated clip
   * with no render, no alpha, a render that fails or alpha on fewer than two frames is skipped with the reason, in the
   * entry and in `warnings`.
   */
  async #speed(
    root: string,
    id: string,
    found: VideoClip & { frames: FrameRange },
    source: FilmSource,
    out: { ffmpeg: string; dir: string; scratch: string; warnings: string[]; signal?: AbortSignal | undefined },
  ): Promise<{ speed: ReviewSpeed; sheet: ReviewSheet | null }> {
    const { resolved, placed, frames } = found;
    const fps = source.fps;
    const film = { width: source.width, height: source.height };
    const count = frames.end - frames.first;
    const entry = { clip: id, label: "ESTIMATED" as const, hero: placed.generated ? ("alpha" as const) : ("placement" as const), from: frameTime(frames.first, fps), to: frameTime(frames.end, fps), frames: count };
    const skip = (reason: string) => {
      out.warnings.push(`speed: ${id} is not measured: ${reason}.`);
      return { speed: { ...entry, samples: 0, peak: 0, spans: [], sheet: null, skipped: reason }, sheet: null };
    };
    let samples: HeroSample[];
    if (placed.generated) {
      const otherSize = film.width !== resolved.project.width || film.height !== resolved.project.height;
      try {
        const renders = this.#options.generated ? await this.#options.generated(root, resolved.timeline, otherSize ? film : undefined) : null;
        const render = renders?.get(id);
        if (!render) return skip("its clip has no render to read");
        if (!render.hasAlpha) return skip("its render has no alpha plane, so what it draws has no centre to follow");
        const step = timelineSampleStep(count);
        samples = await alphaHero(
          { ffmpeg: out.ffmpeg, clip: found.clip as AdapterClip, render, film, project: resolved.project, work: join(out.scratch, "speed"), signal: out.signal },
          { first: frames.first, count: Math.ceil(count / step), step },
          fps,
          SPEED_ALPHA_WIDTH,
        );
      } catch (error) {
        // As the safe-zone boxes do: a render or alpha read that fails is a reason in the result, never a failed run.
        out.signal?.throwIfAborted();
        return skip(`its render could not be read (${(error as Error).message.split("\n")[0]})`);
      }
      if (samples.length < 2) return skip("its alpha shows on fewer than two of the frames read, so there is no move to measure");
    } else {
      samples = [];
      for (let frame = frames.first; frame < frames.end; frame++) samples.push({ frame, ...clipHero(placed, (frame + 0.5) / fps, film, resolved.project, resolved.layout) });
    }
    const intervals = speedOf(samples);
    const spans = spansOf(intervals);
    const peak = peakSpeed(intervals);
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const layout = sheetLayout("speed", film.width / film.height);
    const tile = { width: layout.tileWidth, height: Math.round(layout.tileWidth * 0.28) };
    const work = join(out.scratch, "speed-chart");
    await mkdir(work, { recursive: true });
    const chart = speedChart(intervals, spans, { first: samples[0]?.frame ?? frames.first, end: samples.at(-1)?.frame ?? frames.end }, tile.width, tile.height);
    await writeFile(join(work, "chart.png"), encodeRgbPng(chart.pixels, chart.width, chart.height));
    const counted = (kind: string) => spans.filter((span) => span.kind === kind).length;
    const label = tileLabel(entry.from, "speed", `speed ${id} peak ${round(peak)} px/frame, ${counted("linear")} linear, ${counted("stop")} stop`);
    const path = join(out.dir, "speed.png");
    const size = await writeSheet(out.ffmpeg, [{ path: join(work, "chart.png"), label }], { out: path, columns: 1, tile, scratch: join(work, "sheet"), ...(out.signal ? { signal: out.signal } : {}) });
    const sheet: ReviewSheet = { kind: "speed", path, ...size, tile, tiles: [{ at: entry.from, frame: frames.first, tag: "speed", label, row: 0, column: 0 }] };
    return {
      speed: {
        ...entry,
        samples: samples.length,
        peak: round(peak),
        spans: spans.map((span) => ({ from: frameTime(span.from, fps), to: frameTime(Math.min(frames.end, span.to + 1), fps), kind: span.kind, speed: round(span.speed) })),
        sheet: path,
      },
      sheet,
    };
  }

  /**
   * Boxes of the film's pixels that graphics (generated clips with an alpha render) and faces (footage with a cached `people scan`)
   * hold, for the safe-zone check and `staysInFrame`. Says in `warnings`, under `topic`, what could not be measured; never fails
   * the run. `opaque`: generated clips whose render has no alpha; `laidOut` false when the timeline could not be laid out.
   */
  async #boxes(root: string, flat: () => Promise<Flat>, source: FilmSource, work: string, warnings: string[], topic: string, signal?: AbortSignal): Promise<Placed> {
    const { generated, faceScans } = this.#options;
    const film = { width: source.width, height: source.height };
    let resolved: Flat;
    try {
      resolved = await flat();
    } catch (error) {
      warnings.push(`${topic}: graphics and faces are not placed (${(error as Error).message.split("\n")[0]}).`);
      return { boxes: [], opaque: [], laidOut: false };
    }
    const found: BoxSpan[] = [];
    let opaque: string[] = [];
    if (faceScans) {
      try {
        found.push(...faceBoxes(resolved.timeline, await faceScans(root), film, resolved.project, resolved.layout));
      } catch (error) {
        warnings.push(`${topic}: faces are not placed (${(error as Error).message.split("\n")[0]}).`);
      }
    }
    if (generated && generatedClips(resolved.timeline).length > 0) {
      try {
        const otherSize = film.width !== resolved.project.width || film.height !== resolved.project.height;
        const renders = await generated(root, resolved.timeline, otherSize ? film : undefined);
        const graphics = await graphicBoxes({ ffmpeg: await this.#options.ffmpeg(root), timeline: resolved.timeline, renders, film, project: resolved.project, work, signal });
        found.push(...graphics.boxes);
        opaque = graphics.opaque;
        if (graphics.opaque.length > 0) warnings.push(`${topic}: ${graphics.opaque.join(", ")} ${graphics.opaque.length === 1 ? "has a render" : "have renders"} with no alpha, so the box of what they draw is not known (it fills the frame).`);
      } catch (error) {
        signal?.throwIfAborted();
        warnings.push(`${topic}: graphics are not placed (${(error as Error).message.split("\n")[0]}).`);
      }
    }
    return { boxes: found, opaque, laidOut: true };
  }

  /**
   * Each clip on a track `behind` a plate in the timeline reviewed (ADR 0032): for a generated clip with alpha, the
   * share of it the person's matte covers and whether it meets a face of the plate clip, at the first, middle and last
   * frame of its time under the person (`behind.ts`), inside `range` (timeline seconds): a clip that plays outside it
   * is not listed, one that straddles an end is sampled in the part that is in. A clip that cannot be measured is an
   * `unplaced` entry and a warning, never a failed review. Root tracks only, as the timeline file names them. Null when
   * no shown track is behind one.
   */
  async #behind(
    root: string,
    loaded: LoadedTimeline,
    flat: () => Promise<Flat>,
    source: FilmSource,
    range: { from: number; to: number },
    ffmpeg: string,
    work: string,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<ReviewBehind[] | null> {
    const plates = new Map(loaded.timeline.tracks.flatMap((track) => (track.kind === "video" && track.behind !== undefined && track.hidden !== true ? [[track.id, track.behind] as const] : [])));
    if (plates.size === 0) return null;
    let resolved: Flat;
    try {
      resolved = await flat();
    } catch (error) {
      warnings.push(`behind: words behind the person are not measured (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
    const film = { width: source.width, height: source.height };
    const { project, layout, fps } = resolved;
    const tracks = resolved.timeline.tracks.filter((track) => track.kind === "video" && plates.has(track.id));
    let renders: ReadonlyMap<string, GeneratedSource> = new Map();
    if (this.#options.generated && tracks.some((track) => track.kind === "video" && track.clips.some((clip) => clip.type !== "media" && clip.type !== "timeline"))) {
      try {
        const otherSize = film.width !== project.width || film.height !== project.height;
        renders = await this.#options.generated(root, resolved.timeline, otherSize ? film : undefined);
      } catch (error) {
        signal?.throwIfAborted();
        warnings.push(`behind: the renders of the words cannot be read (${(error as Error).message.split("\n")[0]}).`);
      }
    }
    const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
      let known = cache.get(key);
      if (!known) cache.set(key, (known = read()));
      return known;
    };
    const mattes = new Map<string, Promise<ReadyMatte | { missing: string }>>();
    const matteOf = (asset: string) => once(mattes, asset, () => this.#options.readyMatte?.(root, asset) ?? Promise.resolve({ missing: "this daemon reads no mattes" }));
    const sizes = new Map<string, Promise<Size | null>>();
    const sizeOf = (asset: string) => once(sizes, asset, () => this.#options.pictureSize?.(root, asset) ?? Promise.resolve(film));
    let scans: readonly ScannedAsset[] = [];
    if (this.#options.faceScans) {
      try {
        scans = await this.#options.faceScans(root);
      } catch (error) {
        warnings.push(`behind: faces are not checked (${(error as Error).message.split("\n")[0]}).`);
      }
    }
    const faces = faceBoxes(resolved.timeline, scans, film, project, layout);
    const scanned = new Set(scans.map((entry) => entry.asset));
    const base = resolved.timeline.tracks.find(showsPicture)?.id;
    const noScan = new Set<string>();
    const round = (value: number) => Math.round(value * 1000) / 1000;

    const found: ReviewBehind[] = [];
    for (const track of tracks) {
      if (track.kind !== "video") continue;
      const plate = plates.get(track.id)!;
      for (const listed of track.clips) {
        signal?.throwIfAborted();
        if (listed.start + clipLength(listed, { fps }) <= range.from || listed.start >= range.to) continue;
        const word = { clip: listed.id, track: track.id, plate };
        const unplaced = (message: string) => found.push({ ...word, from: null, to: null, samples: [], verdict: "unplaced", message });
        if (listed.type === "media" || listed.type === "timeline") {
          unplaced(`clip ${listed.id} is not a generated clip: only what a generated clip's render draws (its alpha) is measured behind the person.`);
          continue;
        }
        const clip = listed as AdapterClip;
        const render = renders.get(clip.id);
        if (!render) {
          unplaced(`clip ${clip.id} has no render yet, so what it draws is not known.`);
          continue;
        }
        if (!render.hasAlpha) {
          unplaced(`clip ${clip.id} has a render with no alpha plane: it fills the frame, so there is no word shape to measure.`);
          continue;
        }
        const spans = within(subjectSpans(resolved.timeline, plate), Math.max(clip.start, range.from), Math.min(clip.start + clip.duration, range.to));
        const frames = sampleFrames(spans, fps);
        if (frames.length === 0) {
          unplaced(`the person is never drawn over clip ${clip.id}: no media clip of plate track ${plate} plays under it, or a shown track between them covers the person then.`);
          continue;
        }
        const samples: ReviewBehindSample[] = [];
        let missing: string | null = null;
        try {
          for (const frame of frames) {
            const at = frame / fps;
            const subject = (spans.find((span) => at >= span.from - 1e-6 && at < span.to) ?? spans.find((span) => at < span.to) ?? spans.at(-1)!).clip;
            const [matte, size] = await Promise.all([matteOf(subject.asset), sizeOf(subject.asset)]);
            if (!size || "missing" in matte) {
              missing = `the person over clip ${clip.id} would come from ${subject.asset}, ${"missing" in matte ? matte.missing : "which has no picture"}.`;
              break;
            }
            const shown = (frame + 0.5) / fps;
            const [alpha, person] = await Promise.all([
              alphaMask({ ffmpeg, render, fps, work: join(work, `${clip.id}-${frame}`), signal }, (clip.in ?? 0) + at - clip.start, BEHIND_WIDTH),
              matteFrame(ffmpeg, matte, Math.min(matte.frames - 1, matteFrameAt(subject, frame, fps))),
            ]);
            const coverage =
              alpha && person
                ? coveredShare(
                    alpha,
                    clipRectInFilm({ clip, source: render, generated: true, base: false }, shown, film, project, layout),
                    person,
                    clipRectInFilm({ clip: subject, source: size, generated: false, base: base === plate }, shown, film, project, layout),
                  )
                : null;
            let face: boolean | null = null;
            if (scanned.has(subject.asset)) {
              face = coverage !== null && faces.some((box) => box.track === plate && box.clip === subject.id && box.from <= at + 1e-6 && at < box.to && boxesMeet(box.box, coverage.box));
            } else noScan.add(subject.asset);
            samples.push({ at: round(at), plateClip: subject.id, covered: coverage ? round(coverage.share) : null, face });
          }
        } catch (error) {
          signal?.throwIfAborted();
          const message = `clip ${clip.id} is not measured (${(error as Error).message.split("\n")[0]})`;
          warnings.push(`behind: ${message}.`);
          unplaced(`${message}.`);
          continue;
        }
        if (missing !== null) unplaced(missing);
        else found.push(behindEntry(word, spans[0]!.from, spans.at(-1)!.to, samples));
      }
    }
    if (noScan.size > 0) {
      warnings.push(`behind: ${[...noScan].join(", ")} ${noScan.size === 1 ? "has" : "have"} no cached face scan, so no word over it was checked against a face (\`frameshell people scan\` first).`);
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
    flat: (() => Promise<Flat>) | null,
    series: MotionSeries,
    cuts: readonly number[],
    critical: readonly Critical[],
    range: { from: number; to: number },
    envelope: (file: string) => Promise<Float32Array>,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<ReviewSync | null> {
    try {
      let sounds;
      if (request.file) {
        if (!source.audio) return null;
        sounds = fileOnsets(await envelope(request.file));
      } else if (flat) {
        sounds = await takeOnsets(root, (await flat()).timeline);
      } else return null;
      const spacing = series.times.length > 1 ? (series.times.at(-1)! - series.times[0]!) / (series.times.length - 1) : 0;
      return syncMetrics({
        source: request.file ? "file" : "takes",
        sounds,
        // A timeline's cuts are `exact` already; a file's scene cuts are visual events like any big change.
        events: visualEvents(series, source.fps, request.file ? cuts : []),
        exact: critical.filter((item) => item.tag === "cut" || item.tag === "marker").map((item) => item.at),
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

  /**
   * Frames where a shot starts, for the shot-length CV and the big changes: a file's cuts found the way `analyze` finds
   * them (ffmpeg scene scores at its default threshold), a timeline's clip starts and ends.
   */
  async #cuts(request: ReviewRequest, source: FilmSource, critical: readonly Critical[], ffmpeg: string, warnings: string[], signal?: AbortSignal): Promise<number[]> {
    if (!request.file) return critical.filter((item) => item.tag === "cut").map((item) => frameIndex(item.at, source.fps));
    try {
      return detectCuts(await sceneScores(ffmpeg, request.file, source.fps, signal), DEFAULT_CUT_THRESHOLD).map((cut) => cut.frame);
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`rhythm: ffmpeg could not find the shots (${(error as Error).message.split("\n")[0]}), so the film counts as one shot.`);
      return [];
    }
  }

  /**
   * The sound review list. A file: its decoded mix (ending, clicks, harshness). A timeline: each heard clip from its asset's
   * envelope, by role (voice over bed and over music, repeated effects, cut-off tails, cut-in starts, the music on the last
   * frame). Null when there is no sound, or
   * with a warning when it cannot be read.
   */
  async #sound(
    root: string,
    request: ReviewRequest,
    source: FilmSource,
    flat: (() => Promise<Flat>) | null,
    range: { from: number; to: number },
    ffmpeg: string,
    envelope: (file: string) => Promise<Float32Array>,
    scratch: string,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<ReviewSound | null> {
    const filmEnd = source.frames / source.fps;
    try {
      if (request.file) {
        if (!source.audio) return null;
        const [decoded, clicks, band] = await Promise.all([
          envelope(request.file),
          fileClicks(ffmpeg, request.file, join(scratch, "clicks"), signal),
          fileBandEnvelope(ffmpeg, request.file, join(scratch, "band"), signal),
        ]);
        return fileSound({ envelope: decoded, clicks, band, range, filmEnd });
      }
      const { soundProfile, musicUnderVoice } = this.#options;
      if (!flat || !soundProfile) return null;
      const { timeline, fps } = await flat();
      const assets = new Set(timeline.tracks.flatMap((track) => (track.kind === "subtitles" ? [] : track.clips.flatMap((clip) => ("asset" in clip ? [clip.asset] : [])))));
      const transcribed = new Set<string>();
      for (const asset of assets) {
        if ((await readTranscriptFile(root, asset).catch(() => null)) !== null) transcribed.add(asset);
      }
      const kinds = new Map((await soundsOn(root, timeline)).map((item) => [item.file, item.kind] as const));
      const clips = heardClips(timeline, fps, { transcribed, kinds }).filter((clip) => clip.end > range.from && clip.start < range.to);
      const profiles = new Map<string, EnergyProfile>();
      const unread = new Set<string>();
      for (const asset of new Set(clips.map((clip) => clip.asset))) {
        signal?.throwIfAborted();
        try {
          profiles.set(asset, await soundProfile(root, asset));
        } catch (error) {
          // No ffmpeg hears nothing: the outer catch drops the whole list with a warning instead of reviewing it as silence.
          if (error instanceof RpcError && BINARY_ERRORS.includes(error.code)) throw error;
          // A clip of a video track is only heard as a voice; a still there has no sound to miss.
          if (clips.some((clip) => clip.asset === asset && timeline.tracks.find((track) => track.id === clip.track)?.kind !== "video")) unread.add(asset);
        }
      }
      if (unread.size > 0) warnings.push(`sound: ${[...unread].join(", ")} cannot be decoded, so ${unread.size === 1 ? "it is" : "they are"} not heard in the sound review.`);
      const style = musicUnderVoice
        ? await musicUnderVoice(root).catch((error: unknown) => {
            warnings.push(`sound: the style guide cannot be read, so music under the voice is judged by the default (${(error as Error).message.split("\n")[0]}).`);
            return undefined;
          })
        : undefined;
      return timelineSound({ clips, profiles, range, filmEnd, musicUnderVoice: style });
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`sound: the sound could not be reviewed (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
  }

  /** How far the last frame of the range is from the first; null for a range of one frame. */
  async #seam(source: FilmSource, range: { first: number; end: number }, frames: Frames, ffmpeg: string, warnings: string[], signal?: AbortSignal): Promise<ReviewSeam | null> {
    if (range.end - range.first < 2) return null;
    const last = range.end - 1;
    try {
      const second = Math.min(range.first + 1, last);
      const middle = Math.floor((range.first + range.end) / 2);
      await frames.ensure([...new Set([range.first, second, middle, last])], signal);
      const { jump, duplicate } = await seamOf(ffmpeg, { first: frames.path(range.first), second: frames.path(second), middle: frames.path(middle), last: frames.path(last) }, source);
      return { first: frameTime(range.first, source.fps), last: frameTime(last, source.fps), jump: Math.round(jump * 100) / 100, verdict: seamVerdict(jump, duplicate) };
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`seam: the first and last frame could not be compared (${(error as Error).message.split("\n")[0]}).`);
      return null;
    }
  }

  /**
   * `request.file` against the export plan of the timeline with `request.preset` (in `projectFormat`): size, frame rate, length,
   * codecs and loudness. The plan is the preset's own: a file rendered with `--quality draft` differs in frame rate by design. Null, with a warning, when the plan cannot be made or the file cannot be read.
   */
  async #delivery(root: string, request: ReviewRequest, ffmpeg: string, loudness: ReviewLoudness | null, warnings: string[], signal?: AbortSignal): Promise<ReviewDelivery | null> {
    const { exports } = this.#options;
    try {
      // The plan of the version `view` shows, like the rest of the run; made without `--quality`, as the preset says.
      const viewed = await this.#options.timelines.viewTimeline(root, request.timeline, request.view);
      const planned = await exports.planRender(root, { timeline: request.timeline, preset: request.preset, ...(request.projectFormat ? { formats: [request.projectFormat] } : {}) }, viewed);
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
  ): Promise<{ source: FilmSource; critical: Critical[]; subtitles: ResolvedSubtitleTrack[]; viewed: Pick<ReviewResult, "view" | "proposal">; loaded: LoadedTimeline | null; clips: ClipSpan[] | null; warnings: string[] }> {
    const warnings: string[] = [];
    if (request.file) {
      const source = await fileSource(ffmpeg, await this.#options.ffprobe(root), request.file);
      return { source, critical: [], subtitles: [], viewed: { view: "current", proposal: null }, loaded: null, clips: null, warnings };
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
        const shot = await exports.frame(root, { timeline: request.timeline, at, out, projectFormat: request.projectFormat }, loaded);
        // Every frame of a film shows the same clips: say each warning once.
        for (const warning of shot.warnings) if (!warnings.includes(warning)) warnings.push(warning);
        return { width: shot.width, height: shot.height };
      },
      scratch,
    );
    const clips = shown.tracks.flatMap((track) => (track.clips as ClipSpan[]).map(({ id, start, end }) => ({ id, start, end })));
    return { source, critical: timelineCritical(shown, cues), subtitles, viewed: { view: loaded.view, proposal: loaded.proposal }, loaded, clips, warnings };
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
