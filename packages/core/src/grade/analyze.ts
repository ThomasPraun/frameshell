import { join } from "node:path";
import { ErrorCode, type GradeAnalyzeResultShape, type MediaProbe, RpcError } from "@frameshell/protocol";
import { type MediaClip, type Timeline, logFootageHint, logFootageWarning } from "@frameshell/schema";
import { pool } from "../export/service.js";
import { runTool } from "../media/ffmpeg.js";
import { type FrameLevels, meanLevels, parseSignalstats, round } from "./levels.js";
import { correctionFlags, suggestGrade } from "./suggest.js";

// `grade.analyze` (#384, ADR 0031): levels of a clip's source frames by ffmpeg `signalstats` and a suggestion from them. Reads only.

/** Width the frames are measured at, px: area-averaged, so the figures do not depend on the source's size. */
const MEASURE_WIDTH = 480;
/** Frames decoded at once. */
const PARALLEL = 4;
/** Distance kept from a clip's last frame when the measure lands on its end, source seconds. */
const END_GUARD_S = 0.001;

/** What {@link GradeAnalyzer} needs from the daemon. */
export interface GradeAnalyzerOptions {
  /** Absolute path of the managed ffmpeg. */
  ffmpeg(root: string): Promise<string>;
  /** Probe of a project file. */
  probe(root: string, asset: string): Promise<MediaProbe>;
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

const invalid = (reason: string, message: string, field: string, valid?: { from: number; to: number }) =>
  new RpcError(ErrorCode.InvalidOperation, `grade.analyze: ${message}`, { op: "grade.analyze", reason, field, ...(valid ? { valid } : {}) });

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

  /** Levels and suggestion for clip `request.clip` of `timeline` (top level, on a video track). Throws `ClipNotFound` or `InvalidOperation`. */
  async analyze(root: string, timeline: Timeline, request: GradeAnalyzeRequest, signal?: AbortSignal): Promise<GradeAnalyzeResultShape> {
    const clip = timeline.tracks.flatMap((track) => (track.kind === "video" ? track.clips : [])).find((candidate) => candidate.id === request.clip);
    if (!clip) {
      throw new RpcError(ErrorCode.ClipNotFound, `grade.analyze: no clip "${request.clip}" on a video track of timeline ${timeline.id}. List clip ids with "frameshell timeline show".`, { clip: request.clip });
    }
    if (clip.type !== "media") throw invalid("not-media", `clip ${clip.id} is not a media clip: only footage and photos have a source picture to measure.`, "clip");
    const media = clip as MediaClip;
    const probe = await this.#options.probe(root, media.asset);
    if (!probe.video) throw invalid("no-picture", `${media.asset} has no picture.`, "clip");
    const still = probe.video.still;
    const speed = media.speed ?? 1;
    const start = media.start;
    const end = start + (media.out - media.in) / speed;
    const valid = { from: round(start, 3), to: round(end, 3) };
    if (request.at !== undefined && (request.from !== undefined || request.to !== undefined)) {
      throw invalid("at-and-range", "`at` measures one frame, `from` and `to` a range: give one.", "at");
    }
    let times: number[];
    let mode: "frame" | "range" = "frame";
    let [from, to] = [start, end];
    if (request.at !== undefined) {
      if (request.at < start || request.at >= end) throw invalid("outside-clip", `\`at\` ${request.at} is outside clip ${clip.id}, which plays from ${valid.from} to ${valid.to} s of the timeline.`, "at", valid);
      [times, from, to] = [[request.at], request.at, request.at];
    } else if (still) {
      times = [start];
      to = start;
    } else {
      from = request.from ?? start;
      to = request.to ?? end;
      if (from < start || to > end || to <= from) {
        throw invalid("outside-clip", `the range ${from} to ${to} s is not inside clip ${clip.id}, which plays from ${valid.from} to ${valid.to} s of the timeline.`, "from", valid);
      }
      // A range never takes more frames than it holds.
      const frames = Math.max(1, Math.min(request.samples, Math.floor((to - from) * request.fps)));
      times = Array.from({ length: frames }, (_, i) => from + ((i + 0.5) * (to - from)) / frames);
      mode = "range";
    }
    const sourceAt = (time: number): number => Math.min(media.out - END_GUARD_S, media.in + (time - start) * speed);

    const ffmpeg = await this.#options.ffmpeg(root);
    const file = join(root, ...media.asset.split("/"));
    const measured: (FrameLevels | null)[] = new Array<FrameLevels | null>(times.length).fill(null);
    await pool(times, PARALLEL, async (time, index) => {
      signal?.throwIfAborted();
      measured[index] = parseSignalstats(await statsAt(ffmpeg, file, still ? null : sourceAt(time), signal));
    });
    const warnings: string[] = [];
    const taken = times.flatMap((time, index) => (measured[index] ? [{ time, levels: measured[index]! }] : []));
    if (taken.length === 0) throw invalid("no-frame", `ffmpeg read no picture from ${media.asset} for the frames asked.`, "clip");
    if (taken.length < times.length) warnings.push(`${times.length - taken.length} of ${times.length} frames could not be read and are left out.`);

    const levels = meanLevels(taken.map((entry) => entry.levels));
    const { correction, reasons } = suggestGrade(levels);
    const hint = logFootageHint(media.asset, probe.video);
    if (hint) warnings.push(logFootageWarning(media.asset, hint));
    if (media.grade && Object.keys(media.grade).length > 0) {
      warnings.push(`${clip.id} already has a grade. The levels are of its source, and the suggestion replaces the clip's correction numbers (a LUT stays); read them against \`current\`.`);
    }
    return {
      timeline: request.timeline,
      clip: clip.id,
      asset: media.asset,
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
      current: media.grade ?? null,
      suggestion: correction,
      reasons,
      flags: correctionFlags(correction),
      warnings,
    };
  }
}
