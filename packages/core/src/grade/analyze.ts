import { join } from "node:path";
import { ErrorCode, type GradeAnalyzeResultShape, type MediaProbe, RpcError } from "@frameshell/protocol";
import { type AdapterClip, type MediaClip, type Timeline, logFootageHint, logFootageWarning } from "@frameshell/schema";
import type { ClipRenderer } from "../clips/renderer.js";
import { pool } from "../export/service.js";
import { runTool } from "../media/ffmpeg.js";
import { type FrameLevels, meanLevels, parseSignalstats, round } from "./levels.js";
import { correctionFlags, suggestGrade } from "./suggest.js";

// `grade.analyze` (ADR 0031): levels of a clip's source frames by ffmpeg `signalstats` and a suggestion from them. Reads only.
// A generated clip's source is its cached draft render (ADR 0031): the picture before its own grade, as a media file is.

/** Width the frames are measured at, px: area-averaged, so the figures do not depend on the source's size. */
const MEASURE_WIDTH = 480;
/** Frames decoded at once. */
const PARALLEL = 4;
/** Distance kept from a clip's last frame when the measure lands on its end, source seconds. */
const END_GUARD_S = 0.001;
/** Source frame rate assumed when the probe has none. */
const FALLBACK_FPS = 30;

/** Most clip ids a nested-timeline refusal lists; the rest are counted. */
const LISTED_INSIDE = 8;

/** A clip on a video track of a nested timeline file, as {@link GradeAnalyzerOptions.nestedClips} lists it. */
export interface NestedClipRef {
  /** Clip id inside the nested timeline file. */
  id: string;
  /** `media`, `shot`, `timeline` or the type of a generated clip. */
  type: string;
  /** Id of the track holding the clip, when known. */
  track?: string | undefined;
}

/** What {@link GradeAnalyzer} needs from the daemon. */
export interface GradeAnalyzerOptions {
  /** Absolute path of the managed ffmpeg. */
  ffmpeg(root: string): Promise<string>;
  /** Probe of a project file. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** The clip render cache: a generated clip is measured from its draft render, made (queued, cached) when missing. */
  clips: Pick<ClipRenderer, "ensure">;
  /**
   * Clips on the video tracks of the nested timeline file `source` (project-relative), for the refusal of a nested
   * clip to name where to look. Default, or an empty answer, a file that is missing or invalid, or a throw: the
   * refusal without ids.
   */
  nestedClips?(root: string, source: string): Promise<readonly NestedClipRef[]>;
}

/** What to measure of one clip. */
export interface GradeAnalyzeRequest {
  /** Timeline id, echoed. */
  timeline: string;
  /** Project frame rate: a range never takes more frames than it holds. */
  fps: number;
  clip: string;
  /** One frame, timeline seconds; excludes `from` and `to`. */
  at?: number | undefined;
  from?: number | undefined;
  to?: number | undefined;
  /** Frames over a range. */
  samples: number;
}

const invalid = (reason: string, message: string, field: string, valid?: { from: number; to: number }, extra?: Record<string, unknown>) =>
  new RpcError(ErrorCode.InvalidOperation, `grade.analyze: ${message}`, { op: "grade.analyze", reason, field, ...(valid ? { valid } : {}), ...extra });

/** The `signalstats` text of one frame of `file` at source second `at`, read after area-averaging to {@link MEASURE_WIDTH}. */
async function statsAt(ffmpeg: string, file: string, at: number | null, signal: AbortSignal | undefined): Promise<string> {
  // Video levels and Rec.709 whatever the source, so a full-range file and an RGB photo read like the picture the grade sees.
  const chain = `scale=${MEASURE_WIDTH}:-2:flags=area:out_range=tv:out_color_matrix=bt709,format=yuv444p,signalstats,metadata=mode=print:file=-`;
  return runTool(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-nostdin", ...(at === null ? [] : ["-ss", String(at)]), "-i", file, "-map", "0:v:0", "-an", "-frames:v", "1", "-vf", chain, "-f", "null", "-"],
    signal ? { signal } : {},
  );
}

/** Measures the pictures of media clips and suggests a correction; never writes. */
export class GradeAnalyzer {
  readonly #options: GradeAnalyzerOptions;

  constructor(options: GradeAnalyzerOptions) {
    this.#options = options;
  }

  /** Ids of the media and generated clips of nested timeline file `source` (the ones this can measure); none when it cannot be read. */
  async #analyzableInside(root: string, source: string | undefined): Promise<string[]> {
    if (!source || !this.#options.nestedClips) return [];
    try {
      const clips = await this.#options.nestedClips(root, source);
      return clips.filter((inner) => inner.type !== "timeline" && inner.type !== "shot").map((inner) => inner.id);
    } catch {
      // The refusal stands without ids: an unreadable nested file must not replace it.
      return [];
    }
  }

  /** Levels and suggestion for clip `request.clip` of `timeline` (top level, on a video track). Throws `ClipNotFound` or `InvalidOperation`. */
  async analyze(root: string, timeline: Timeline, request: GradeAnalyzeRequest, signal?: AbortSignal): Promise<GradeAnalyzeResultShape> {
    const clip = timeline.tracks.flatMap((track) => (track.kind === "video" ? track.clips : [])).find((candidate) => candidate.id === request.clip);
    if (!clip) {
      throw new RpcError(ErrorCode.ClipNotFound, `grade.analyze: no clip "${request.clip}" on a video track of timeline ${timeline.id}. List clip ids with "frameshell timeline show".`, { clip: request.clip });
    }
    if (clip.type === "timeline") {
      const inside = await this.#analyzableInside(root, clip.source);
      const listed = inside.slice(0, LISTED_INSIDE).join(", ") + (inside.length > LISTED_INSIDE ? ` and ${inside.length - LISTED_INSIDE} more` : "");
      throw invalid(
        "nested",
        `clip ${clip.id} is a nested timeline: it has no single picture to measure. ` +
          (inside.length > 0 ? `Analyze one of them: ${listed} (in ${clip.source})` : `Analyze a clip inside it (${clip.source})`) +
          ", or see its colour with `grade.compare`.",
        "clip",
        undefined,
        inside.length > 0 ? { inside } : undefined,
      );
    }
    if (clip.type === "shot") throw invalid("not-gradable", `clip ${clip.id} is a multicam shot: it takes no grade, so there is nothing to measure for one.`, "clip");
    const generated = clip.type === "media" ? undefined : (clip as AdapterClip);
    const media = generated ? undefined : (clip as MediaClip);
    const probe = media ? await this.#options.probe(root, media.asset) : undefined;
    if (media && !probe?.video) throw invalid("no-picture", `${media.asset} has no picture.`, "clip");
    const still = probe?.video?.still ?? false;
    const speed = media?.speed ?? 1;
    const start = clip.start;
    const end = media ? start + (media.out - media.in) / speed : start + generated!.duration;
    const valid = { from: round(start, 3), to: round(end, 3) };
    if (request.at !== undefined && (request.from !== undefined || request.to !== undefined)) {
      throw invalid("at-and-range", "`at` measures one frame, `from` and `to` a range: give one.", "at");
    }
    // `valid` is rounded to 3 decimals, so a value read from it (or from `timeline show`) may sit a hair outside the clip: half a frame is let through and clamped.
    const slack = 0.5 / request.fps;
    let times: number[];
    let mode: "frame" | "range" = "frame";
    let [from, to] = [start, end];
    if (request.at !== undefined) {
      if (request.at < start - slack || request.at > end + slack) throw invalid("outside-clip", `\`at\` ${request.at} is outside clip ${clip.id}, which plays from ${valid.from} to ${valid.to} s of the timeline.`, "at", valid);
      // Half a frame before the end is the middle of the last frame: a seek to its very end finds none.
      const at = Math.max(start, Math.min(end - slack, request.at));
      [times, from, to] = [[at], at, at];
    } else if (still) {
      times = [start];
      to = start;
    } else {
      from = request.from ?? start;
      to = request.to ?? end;
      const outside = from < start - slack || to > end + slack;
      [from, to] = [Math.max(start, from), Math.min(end, to)];
      if (outside || to <= from) {
        throw invalid("outside-clip", `the range ${request.from ?? start} to ${request.to ?? end} s is not inside clip ${clip.id}, which plays from ${valid.from} to ${valid.to} s of the timeline.`, "from", valid);
      }
      // A range never takes more frames than it holds.
      const frames = Math.max(1, Math.min(request.samples, Math.floor((to - from) * request.fps)));
      times = Array.from({ length: frames }, (_, i) => from + ((i + 0.5) * (to - from)) / frames);
      mode = "range";
    }
    const warnings: string[] = [];
    let file: string;
    let label: string;
    let first: number;
    let lastSeek: number;
    if (media) {
      first = media.in;
      // A seek lands on the first frame at or after it: the last seek is the start of the clip's last source frame, since one into its tail finds none.
      lastSeek = media.out - 1 / (probe!.video!.fps || FALLBACK_FPS) - END_GUARD_S;
      file = join(root, ...media.asset.split("/"));
      label = media.asset;
    } else {
      // The draft render of this clip alone: the other generated clips are not this call's business, and the key does not depend on them.
      const rendered = await this.#options.clips.ensure(root, onlyGenerated(timeline, clip.id), { tier: "draft", onWarning: (note) => void warnings.push(note) });
      const render = rendered.get(clip.id);
      if (!render) throw invalid("no-render", `clip ${clip.id} has no render to measure.`, "clip");
      for (const note of render.warnings ?? []) if (!warnings.includes(note)) warnings.push(note);
      if (render.hasAlpha) {
        throw invalid(
          "has-alpha",
          `the render of ${clip.type} clip ${clip.id} has transparency, so its levels would count the empty parts as black. Judge its colour with \`grade.compare\` (or \`frame\`) instead.`,
          "clip",
        );
      }
      first = generated!.in ?? 0;
      lastSeek = Math.min(first + generated!.duration, render.duration ?? Number.POSITIVE_INFINITY) - 1 / request.fps - END_GUARD_S;
      file = render.path;
      label = render.file;
    }
    const sourceAt = (time: number): number => Math.max(first, Math.min(lastSeek, first + (time - start) * speed));

    const ffmpeg = await this.#options.ffmpeg(root);
    const measured: (FrameLevels | null)[] = new Array<FrameLevels | null>(times.length).fill(null);
    let firstFailure = "";
    await pool(times, PARALLEL, async (time, index) => {
      signal?.throwIfAborted();
      try {
        measured[index] = parseSignalstats(await statsAt(ffmpeg, file, still ? null : sourceAt(time), signal));
      } catch (error) {
        // One undecodable frame is left out; a cancelled call is not a failed frame.
        signal?.throwIfAborted();
        firstFailure ||= error instanceof Error ? error.message.split("\n")[0]! : String(error);
      }
    });
    const taken = times.flatMap((time, index) => (measured[index] ? [{ time, levels: measured[index]! }] : []));
    if (taken.length === 0) throw invalid("no-frame", `ffmpeg read no picture from ${label} for the frames asked${firstFailure ? `: ${firstFailure}` : ""}.`, "clip");
    if (taken.length < times.length) warnings.push(`${times.length - taken.length} of ${times.length} frames could not be read and are left out.`);

    const levels = meanLevels(taken.map((entry) => entry.levels));
    const { correction, reasons } = suggestGrade(levels, clip.grade);
    const hint = media ? logFootageHint(media.asset, probe!.video!) : null;
    if (media && hint) warnings.push(logFootageWarning(media.asset, hint));
    if (clip.grade && Object.keys(clip.grade).length > 0) {
      warnings.push(`${clip.id} already has a grade. The levels are of its ${media ? "source" : "render"}, and the suggestion replaces the clip's correction numbers (a correction field it does not need is set back to neutral; a LUT stays); read it against \`current\`.`);
    }
    return {
      timeline: request.timeline,
      clip: clip.id,
      asset: media?.asset ?? null,
      kind: media ? "media" : "generated",
      mode,
      from: round(from, 3),
      to: round(to, 3),
      frames: taken.length,
      samples: taken.map((entry) => ({ at: round(entry.time, 3), luma: round(entry.levels.lumaMean, 3) })),
      levels: {
        luma: { min: round(levels.lumaMin, 3), low: round(levels.lumaLow, 3), mean: round(levels.lumaMean, 3), high: round(levels.lumaHigh, 3), max: round(levels.lumaMax, 3) },
        saturation: round(levels.saturation, 3),
        warmth: round(levels.warmth, 3),
        tint: round(levels.tint, 3),
      },
      current: clip.grade ?? null,
      suggestion: correction,
      reasons,
      flags: correctionFlags(correction),
      warnings,
    };
  }
}

/** `timeline` with every generated clip but `id` taken off its video tracks: a render of one clip asks the cache for that clip only. Tempo, markers and the other tracks (what a clip's timing reads) stay. */
function onlyGenerated(timeline: Timeline, id: string): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.kind === "video" ? { ...track, clips: track.clips.filter((clip) => clip.type === "media" || clip.type === "timeline" || clip.id === id) } : track,
    ),
  };
}
