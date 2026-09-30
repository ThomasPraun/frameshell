import { ErrorCode, RpcError } from "@frameshell/protocol";
import {
  type ExportPreset,
  type MediaClip,
  type Placement,
  type ResolvedSubtitleTrack,
  SUBTITLE_FONT,
  type Size,
  type Timeline,
  type Transcript,
  isIdentityPlacement,
  layerRect,
  placementOf,
  subtitleTracks,
} from "@frameshell/schema";
import { fpsRational } from "../media/recipe.js";
import { FrameGrid } from "../timeline/grid.js";
import { assSubtitles } from "./ass.js";

/**
 * Export compiler (SPEC §3.5): timeline → render plan → ffmpeg argument
 * arrays. Pure: no I/O, no clock, no randomness, so plans are golden-tested.
 * Every step runs with the work directory as cwd; plan file names are
 * relative to it, sources and outputs are absolute.
 */

/** What the compiler needs to know about one asset. */
export interface ExportSource {
  /** Absolute path of the original asset (never the proxy: export uses full quality). */
  path: string;
  /** First video stream (`width`x`height` as probed); null for audio-only files. */
  video: { codec: string; still: boolean; width: number; height: number } | null;
  /** True when the file has an audio stream. */
  audio: boolean;
}

/** Inputs of {@link compileRender}. */
export interface RenderInput {
  timeline: Timeline;
  /** Project fps: the timeline frame grid. */
  fps: number;
  preset: ExportPreset;
  /** Integrated loudness target in LUFS. */
  loudness: number;
  /** Every asset the timeline's media clips name, keyed by project-relative path. */
  sources: ReadonlyMap<string, ExportSource>;
  /** Project resolution (`frameshell.json`): clip transform offsets are in its pixels. */
  resolution: Size;
  /**
   * Transcripts of the assets subtitle tracks follow, keyed by asset path.
   * An asset without one shows no subtitles (and a warning when it has sound).
   */
  transcripts?: ReadonlyMap<string, Transcript>;
  /** Target video segment length in seconds. Default {@link DEFAULT_SEGMENT_SECONDS}. */
  segmentSeconds?: number;
}

/** One video segment: encoded on its own, joined by the concat demuxer. */
export interface RenderSegment {
  /** Output file, relative to the work directory. */
  file: string;
  /** Timeline seconds covered: [from, to). */
  from: number;
  to: number;
  /** Output frames the segment holds. */
  frames: number;
  args: string[];
}

/** One item of an audio track, in output samples. */
export type AudioItem =
  | { kind: "clip"; clip: string; input: number; from: number; to: number; speed: number; gainDb: number; samples: number }
  | { kind: "silence"; samples: number };

/** Timeline compiled for export. JSON-serializable. */
export interface RenderPlan {
  timeline: string;
  preset: string;
  /** Output frame rate as an ffmpeg rational, e.g. `30/1`. */
  fps: string;
  width: number;
  height: number;
  /** Output video frames. */
  frames: number;
  /** Timeline seconds rendered. */
  duration: number;
  /** Integrated loudness target, LUFS. */
  loudness: number;
  /** Output container, also the ffmpeg muxer name. */
  container: ExportPreset["container"];
  /** Things the timeline holds that this export does not render. */
  warnings: string[];
  /** Files to write into the work directory before any step runs. */
  files: Record<string, string>;
  /**
   * Font files (`SUBTITLE_FONT.file`) to copy into `fonts/` of the work
   * directory before any step runs: burned subtitles read them. Empty when
   * nothing is burned.
   */
  fonts: string[];
  segments: RenderSegment[];
  audio: {
    sampleRate: number;
    /** Output samples; equals the video length exactly. */
    samples: number;
    /** Absolute paths of the audio inputs; items refer to them by index. */
    inputs: string[];
    /** One sequence per audible track, each exactly `samples` long. Empty = silent export. */
    tracks: AudioItem[][];
    /** Encoder args of the final audio stream. */
    codec: string[];
  };
}

/** Pass-1 `loudnorm` statistics (its JSON `stats_file`). */
export interface LoudnessMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** One ffmpeg invocation: write `files` into the work directory, then run `args` there. */
export interface FfmpegStep {
  args: string[];
  files: Record<string, string>;
}

/** Inputs of {@link compileFrame}. */
export interface FrameInput {
  timeline: Timeline;
  fps: number;
  sources: ReadonlyMap<string, ExportSource>;
  /** See {@link RenderInput.resolution}. */
  resolution: Size;
  /** See {@link RenderInput.transcripts}. */
  transcripts?: ReadonlyMap<string, Transcript>;
  width: number;
  height: number;
  /** Timeline seconds; the frame showing at that time is captured. */
  at: number;
  /** PNG to write (absolute, or relative to the work directory). */
  output: string;
}

/** Single-frame plan (MCP `frame_capture`, `frameshell frame`). */
export interface FramePlan {
  /** Timeline frame captured. */
  frame: number;
  /** Its start time in timeline seconds, 3 decimals. */
  at: number;
  /** Clip on the base video track showing then; null for a gap (black frame). */
  clip: string | null;
  /** Files to write into the work directory (the args' cwd) first. */
  files: Record<string, string>;
  /** Fonts to copy into its `fonts/`; see {@link RenderPlan.fonts}. */
  fonts: string[];
  args: string[];
}

/** Video segment length: long enough to amortize encoder start, short enough to spread over cores. */
export const DEFAULT_SEGMENT_SECONDS = 10;
/** Edge fade at every audio cut; same length as the preview's (SPEC §3.4). */
export const EDGE_FADE_SECONDS = 0.002;
/** Decode this much source before a clip's first frame, so the nearest frame is always available. */
const SEEK_PREROLL_SECONDS = 1;
/** Extra source seconds read past a sped-up clip's out point; see `audioGraph`. */
const ATEMPO_TAIL_SECONDS = 0.1;
/** `loudnorm` loudness range target: wide, so linear (single gain) normalization applies to normal speech. */
const LOUDNORM_LRA = 20;
/** `loudnorm` true peak ceiling, dBTP. */
const LOUDNORM_TP = -1;
/** Pass-1 statistics file, relative to the work directory. */
export const LOUDNESS_STATS_FILE = "loudness.json";
/** Lossless audio mix, relative to the work directory. */
export const MIX_FILE = "mix.wv";
/** Concat demuxer list, relative to the work directory. */
const CONCAT_LIST = "segments.txt";
/** Burned subtitles, relative to the work directory. */
export const SUBTITLES_FILE = "subtitles.ass";
/** Directory libass loads fonts from, relative to the work directory. */
export const FONTS_DIR = "fonts";

/** Quiet, overwrite, machine-readable progress on stdout (`runTool` parses it). */
const BASE = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];

/** A media clip placed on the timeline frame grid. */
interface Placed {
  clip: MediaClip;
  source: ExportSource;
  /** Timeline frames [start, end). */
  start: number;
  end: number;
  /** Source frame (project fps) of the first frame; may be fractional only through speed. */
  in: number;
  speed: number;
  placement: Placement;
}

/** What export v1 renders of a timeline. */
interface Layout {
  frames: number;
  /** Every clip of the base (first) video track, sorted. */
  base: Placed[];
  /** Untransformed clips of the base track: they fill the frame, black elsewhere. */
  video: Placed[];
  /**
   * Layers composited over the base, bottom first (SPEC §5.3: track order is
   * stacking order): transformed clips of the base track, then every upper
   * video track. Only clips with a picture that is not fully transparent.
   */
  overlays: Placed[][];
  /** Clips carrying sound, one list per track (base video track first). */
  audio: Placed[][];
  /** Subtitle tracks with at least one cue, in track order. */
  subtitles: ResolvedSubtitleTrack[];
  warnings: string[];
}

/** Output of a video graph. */
interface GraphTarget {
  fps: number;
  width: number;
  height: number;
  pixFmt: string;
  /** Project resolution, for transform offsets. */
  project: Size;
}

/**
 * Compile `timeline` into a render plan. Nested timelines must already be
 * flattened (`flattenTimeline`). Throws `ExportUnsupported` when the
 * timeline is empty or holds what export cannot render yet (adapter clips,
 * nested timelines left unresolved).
 */
export function compileRender(input: RenderInput): RenderPlan {
  const { timeline, fps, preset } = input;
  const layout = layoutTimeline(timeline, fps, input.sources, input.transcripts);
  const outFps = preset.video.fps ?? fps;
  const rate = fpsRational(outFps);
  const { width, height } = preset.video;
  const segmentFrames = Math.max(1, Math.round((input.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS) * fps));
  const edges = layout.video.flatMap((placed) => [placed.start, placed.end]);
  const target = { fps, width, height, pixFmt: "yuv420p", project: input.resolution };
  const bounds = segmentBounds(layout.frames, edges, segmentFrames);
  const ext = preset.container;
  const files: Record<string, string> = {};
  if (layout.subtitles.length > 0) files[SUBTITLES_FILE] = assSubtitles(layout.subtitles, { width, height }, fps);
  const segments: RenderSegment[] = bounds.map(([from, to], index) => {
    const name = `seg-${String(index + 1).padStart(4, "0")}`;
    const outFrames = Math.round((to / fps) * outFps) - Math.round((from / fps) * outFps);
    const graph = videoGraph(layout, from, to, target);
    const tail = `${burnSubtitles(layout, from, to, fps)}${outFps === fps ? "" : `,fps=${rate}`}`;
    files[`${name}.filter`] = `${[...graph.lines.slice(0, -1), `${graph.lines.at(-1)}${tail}[v]`].join(";\n")}\n`;
    return {
      file: `${name}.${ext}`,
      from: seconds(from, fps),
      to: seconds(to, fps),
      frames: outFrames,
      args: [
        ...BASE,
        ...graph.inputs,
        ...["-/filter_complex", `${name}.filter`, "-map", "[v]", "-an", "-frames:v", String(outFrames), "-r", rate],
        ...videoCodecArgs(preset),
        ...["-map_metadata", "-1", "-f", preset.container, `${name}.${ext}`],
      ],
    };
  });
  files[CONCAT_LIST] = segments.map((segment) => `file '${segment.file}'\n`).join("");

  const sampleRate = preset.audio.sampleRate ?? 48_000;
  const audio = { ...audioPlan(layout, fps, sampleRate), codec: audioCodecArgs(preset, sampleRate) };
  return {
    timeline: timeline.id,
    preset: preset.id,
    fps: rate,
    width,
    height,
    frames: segments.reduce((sum, segment) => sum + segment.frames, 0),
    duration: seconds(layout.frames, fps),
    loudness: input.loudness,
    container: preset.container,
    warnings: layout.warnings,
    files,
    fonts: layout.subtitles.length > 0 ? [SUBTITLE_FONT.file] : [],
    segments,
    audio,
  };
}

/**
 * Audio mix (SPEC §3.5 step 4): the whole mix in one continuous pass, written
 * losslessly (WavPack float) to {@link MIX_FILE}. Loudness is measured and
 * applied on that file, not inside this graph: `loudnorm` fed by a large
 * graph ends early (ffmpeg 9 dropped the last seconds in testing). Null when
 * the export is silent.
 */
export function mixStep(plan: RenderPlan): FfmpegStep | null {
  if (plan.audio.tracks.length === 0) return null;
  const { inputs, lines } = audioGraph(plan.audio);
  return {
    files: { "mix.filter": `${lines.join(";\n")}\n` },
    args: [...BASE, ...inputs, "-/filter_complex", "mix.filter", "-map", "[mix]", "-c:a", "wavpack", "-f", "wv", MIX_FILE],
  };
}

/**
 * Loudness pass 1: `loudnorm` in analysis mode over {@link MIX_FILE}, writing
 * {@link LOUDNESS_STATS_FILE}. Runs after {@link mixStep}; null when silent.
 */
export function loudnessAnalysis(plan: RenderPlan): FfmpegStep | null {
  if (plan.audio.tracks.length === 0) return null;
  const loudnorm = `loudnorm=I=${plan.loudness}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}:print_format=json:stats_file=${LOUDNESS_STATS_FILE}`;
  return { files: {}, args: [...BASE, "-i", MIX_FILE, "-af", loudnorm, "-f", "null", "-"] };
}

/**
 * Final step: joined video segments (stream copy) plus {@link MIX_FILE}
 * normalized with `measured` (`loudnorm` pass 2, linear when the measurement
 * allows; skipped when null), written to `output`. A silent export gets a
 * silent track of the exact length.
 */
export function muxStep(plan: RenderPlan, measured: LoudnessMeasurement | null, output: string): FfmpegStep {
  const { sampleRate: rate, samples } = plan.audio;
  const silent = plan.audio.tracks.length === 0;
  const normalize = measured
    ? `loudnorm=I=${plan.loudness}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}` +
      `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
      `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true,`
    : "";
  // loudnorm works at 192 kHz: resample back, then cut to the exact length.
  const audio = silent
    ? `anullsrc=r=${rate}:cl=stereo,atrim=end_sample=${samples}[a]`
    : `[1:a:0]${normalize}aresample=${rate},atrim=end_sample=${samples}[a]`;
  return {
    files: {},
    args: [
      ...BASE,
      ...["-f", "concat", "-safe", "0", "-i", CONCAT_LIST],
      ...(silent ? [] : ["-i", MIX_FILE]),
      ...["-filter_complex", audio, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy"],
      ...plan.audio.codec,
      ...["-map_metadata", "-1", "-f", plan.container],
      ...(plan.container === "webm" ? [] : ["-movflags", "+faststart"]),
      output,
    ],
  };
}

/**
 * Compile the capture of the one composited frame showing at `at` (every
 * video layer), scaled and letterboxed to `width`x`height`, as PNG. Throws
 * `ExportUnsupported` like {@link compileRender} and `InvalidOperation`
 * when `at` is outside the timeline.
 */
export function compileFrame(input: FrameInput): FramePlan {
  const { fps, width, height } = input;
  const layout = layoutTimeline(input.timeline, fps, input.sources, input.transcripts);
  const frame = Math.floor((input.at + 0.0005) * fps);
  if (frame < 0 || frame >= layout.frames) {
    const last = seconds(layout.frames - 1, fps);
    throw new RpcError(
      ErrorCode.InvalidOperation,
      `at ${input.at} s is outside timeline ${input.timeline.id} (frames start from 0 to ${last} s).`,
      { op: "frame", reason: "out of range", field: "at", valid: { min: 0, max: last } },
    );
  }
  const graph = videoGraph(layout, frame, frame + 1, { fps, width, height, pixFmt: "rgb24", project: input.resolution });
  const clip = layout.base.find((placed) => placed.start <= frame && frame < placed.end);
  const burn = burnSubtitles(layout, frame, frame + 1, fps);
  return {
    frame,
    at: seconds(frame, fps),
    clip: clip?.clip.id ?? null,
    files: burn ? { [SUBTITLES_FILE]: assSubtitles(layout.subtitles, { width, height }, fps) } : {},
    fonts: burn ? [SUBTITLE_FONT.file] : [],
    args: [
      ...BASE,
      ...graph.inputs,
      ...["-filter_complex", `${graph.lines.join(";")}${burn}[v]`, "-map", "[v]", "-frames:v", "1"],
      ...["-c:v", "png", "-f", "image2", "-update", "1", input.output],
    ],
  };
}

/** Parse the pass-1 stats file; null when the mix is silent (nothing to normalize). */
export function parseLoudnessStats(text: string): LoudnessMeasurement | null {
  const stats = JSON.parse(text) as Record<string, unknown>;
  const pick = (key: keyof LoudnessMeasurement) => {
    const value = stats[key];
    if (typeof value !== "string") throw new Error(`loudnorm stats lack ${key}: ${text}`);
    return value;
  };
  const measured = {
    input_i: pick("input_i"),
    input_tp: pick("input_tp"),
    input_lra: pick("input_lra"),
    input_thresh: pick("input_thresh"),
    target_offset: pick("target_offset"),
  };
  // Silence measures -inf (or the -70 LUFS gate): a gain would be meaningless.
  const integrated = Number(measured.input_i);
  return Number.isFinite(integrated) && integrated > -70 ? measured : null;
}

/** Place the timeline's media clips on the frame grid, resolve subtitle cues, and reject what export cannot render. */
function layoutTimeline(
  timeline: Timeline,
  fps: number,
  sources: ReadonlyMap<string, ExportSource>,
  transcripts: ReadonlyMap<string, Transcript> = new Map(),
): Layout {
  const grid = new FrameGrid(fps);
  const warnings: string[] = [];
  const video: Placed[][] = [];
  const audio: Placed[][] = [];
  let frames = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const placed: Placed[] = [];
    for (const clip of track.clips) {
      if (clip.type === "timeline" && "source" in clip) {
        throw unsupported(
          timeline.id,
          `Clip ${clip.id} on track ${track.id} nests ${clip.source}, which cannot be read (missing, invalid, or nesting itself). ` +
            `Fix or restore ${clip.source}, or remove the clip to export: \`frameshell clip remove ${clip.id}\`.`,
          { track: track.id, clip: clip.id },
        );
      }
      if (clip.type !== "media" || !("asset" in clip)) {
        throw unsupported(
          timeline.id,
          `Clip ${clip.id} on track ${track.id} is a \`${clip.type}\` clip; exports render only media clips so far. ` +
            `Remove it to export: \`frameshell clip remove ${clip.id}\`.`,
          { track: track.id, clip: clip.id },
        );
      }
      const source = sources.get(clip.asset);
      if (!source) throw new Error(`no export source for ${clip.asset}`);
      const speed = clip.speed ?? 1;
      const start = grid.frame(clip.start);
      const end = Math.max(start + 1, grid.frame(clip.start + (clip.out - clip.in) / speed));
      placed.push({ clip, source, start, end, in: Math.round(clip.in * fps), speed, placement: placementOf(clip.transform) });
      frames = Math.max(frames, end);
    }
    placed.sort((a, b) => a.start - b.start);
    // The engine never overlaps clips, but a hand-edited file may: the later clip wins from its start.
    for (let i = 1; i < placed.length; i++) {
      const before = placed[i - 1]!;
      if (before.end > placed[i]!.start) before.end = Math.max(before.start, placed[i]!.start);
    }
    placed.splice(0, placed.length, ...placed.filter((p) => p.end > p.start));
    if (track.kind === "video") video.push(placed);
    audio.push(placed.filter(({ clip, source }) => source.audio && clip.audio?.muted !== true));
  }
  if (frames === 0) {
    throw unsupported(timeline.id, `Timeline ${timeline.id} has no clips; add some first: \`frameshell clip add <track> <asset>\`.`, {});
  }
  const subtitles = subtitleTracks(timeline, (asset) => transcripts.get(asset) ?? null, fps);
  for (const track of subtitles) {
    if (track.unknownPreset !== null) {
      warnings.push(`Subtitle track ${track.track} names unknown style preset "${track.unknownPreset}"; it was rendered as ${track.style.preset}.`);
    }
    // Only assets with sound have words to show.
    const silent = track.missing.filter((asset) => sources.get(asset)?.audio === true);
    if (silent.length > 0) {
      warnings.push(
        `Subtitle track ${track.track} shows no words for ${silent.join(", ")}: no transcript. Run \`frameshell transcribe <asset>\` first.`,
      );
    }
  }
  const [base = [], ...upper] = video;
  const visible = (placed: Placed) => placed.source.video !== null && placed.placement.opacity > 0;
  const overlays = [base.filter((p) => !isIdentityPlacement(p.placement)), ...upper]
    .map((layer) => layer.filter(visible))
    .filter((layer) => layer.length > 0);
  return {
    frames,
    base,
    video: base.filter((p) => isIdentityPlacement(p.placement)),
    overlays,
    audio: audio.filter((track) => track.length > 0),
    subtitles: subtitles.filter((track) => track.cues.length > 0),
    warnings,
  };
}

/**
 * Filter chain appended to a graph rendering timeline frames [from, to)
 * that burns the subtitle cues showing there; empty when none does. The
 * graph's timestamps start at 0: they are moved to timeline time for the
 * `ass` filter, then back.
 */
function burnSubtitles(layout: Layout, from: number, to: number, fps: number): string {
  const showing = layout.subtitles.some((track) => track.cues.some((cue) => cue.start < to && cue.end > from));
  if (!showing) return "";
  const shift = from === 0 ? "" : `setpts=PTS+${num(from / fps)}/TB,`;
  const back = from === 0 ? "" : ",setpts=PTS-STARTPTS";
  return `,${shift}ass=filename=${SUBTITLES_FILE}:fontsdir=${FONTS_DIR}${back}`;
}

function unsupported(timeline: string, message: string, data: { track?: string; clip?: string }): RpcError {
  return new RpcError(ErrorCode.ExportUnsupported, message, { timeline, ...data });
}

/**
 * Split [0, frames) into segments of about `target` frames. A segment ends
 * on a clip edge when one falls in its second half, else mid-clip (video
 * segments are independent encodes, so any frame is a clean boundary).
 */
function segmentBounds(frames: number, edges: number[], target: number): [number, number][] {
  const sorted = [...new Set(edges)].sort((a, b) => a - b);
  const bounds: [number, number][] = [];
  for (let from = 0; from < frames; ) {
    let to = Math.min(frames, from + target);
    if (to < frames) {
      const edge = sorted.filter((e) => e > from + target / 2 && e <= to).at(-1);
      if (edge !== undefined) to = edge;
    }
    bounds.push([from, to]);
    from = to;
  }
  return bounds;
}

/**
 * Filter graph rendering timeline frames [from, to): the base track's
 * untransformed clips (fitted, black between them), then every overlay layer
 * bottom first. One input per clip piece, seeked near its first frame; see
 * {@link pieceChain}. An overlay piece is scaled to its `layerRect` (the
 * preview places layers with the same function), given its opacity as
 * alpha, padded with transparent frames up to its first frame so it lines up
 * with the base frame by frame, and overlaid until it ends. The last line
 * has no output label.
 */
function videoGraph(layout: Layout, from: number, to: number, out: GraphTarget): { inputs: string[]; lines: string[] } {
  const { fps, width, height, pixFmt } = out;
  const rate = fpsRational(fps);
  const fit =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=${pixFmt}`;
  const inputs: string[] = [];
  const lines: string[] = [];
  const labels: string[] = [];
  const black = (frames: number) => {
    const label = `p${labels.length}`;
    lines.push(`color=c=black:s=${width}x${height}:r=${rate},trim=end_frame=${frames},setsar=1,format=${pixFmt}[${label}]`);
    labels.push(label);
  };
  let cursor = from;
  for (const placed of layout.video) {
    const start = Math.max(placed.start, from);
    const end = Math.min(placed.end, to);
    if (end <= start) continue;
    if (start > cursor) black(start - cursor);
    cursor = end;
    if (!placed.source.video) {
      black(end - start);
      continue;
    }
    const label = `p${labels.length}`;
    lines.push(`${pieceChain(placed, start, end, fps, inputs)},${fit}[${label}]`);
    labels.push(label);
  }
  if (to > cursor) black(to - cursor);
  const joined = labels.length === 1 ? `[${labels[0]}]null` : `${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=1:a=0`;

  const pieces = layout.overlays.flatMap((layer) =>
    layer.flatMap((placed) => {
      const start = Math.max(placed.start, from);
      const end = Math.min(placed.end, to);
      return end > start ? [{ placed, start, end }] : [];
    }),
  );
  if (pieces.length === 0) {
    lines.push(joined);
    return { inputs, lines };
  }
  lines.push(`${joined}[base]`);
  let below = "base";
  pieces.forEach(({ placed, start, end }, n) => {
    const rect = layerRect(placed.source.video!, { width, height }, out.project, placed.placement);
    const { opacity } = placed.placement;
    const chain = [
      pieceChain(placed, start, end, fps, inputs),
      `scale=${rect.width}:${rect.height},setsar=1,format=rgba`,
      ...(opacity < 1 ? [`colorchannelmixer=aa=${num(opacity)}`] : []),
      ...(start > from ? [`tpad=start=${start - from}:color=black@0`] : []),
    ];
    lines.push(`${chain.join(",")}[o${n}]`);
    const overlay = `[${below}][o${n}]overlay=x=${rect.left}:y=${rect.top}:eof_action=pass:format=auto`;
    below = `b${n}`;
    lines.push(n === pieces.length - 1 ? `${overlay},format=${pixFmt}` : `${overlay}[${below}]`);
  });
  return { inputs, lines };
}

/**
 * Start of the filter chain yielding exactly frames [start, end) of
 * `placed`, timestamps from 0 at the output rate; its input args are
 * appended to `inputs`. The piece's timestamps are shifted so its first
 * frame is at 0 and divided by the speed; `fps` then picks the source frame
 * nearest to every output frame (the proxy clock: frame n = source n / fps,
 * SPEC §6.3) and `trim` keeps exactly the piece's frames.
 */
function pieceChain(placed: Placed, start: number, end: number, fps: number, inputs: string[]): string {
  const rate = fpsRational(fps);
  const frames = end - start;
  const video = placed.source.video!;
  const index = inputs.filter((arg) => arg === "-i").length;
  let shift: number;
  if (video.still) {
    inputs.push("-loop", "1", "-framerate", rate, "-t", num(frames / fps + SEEK_PREROLL_SECONDS), "-i", placed.source.path);
    shift = 0;
  } else {
    // Source frame (project fps) shown at the piece's first frame.
    const first = placed.in + (start - placed.start) * placed.speed;
    const seekFrame = Math.max(0, Math.floor(first - SEEK_PREROLL_SECONDS * fps));
    shift = (first - seekFrame) / fps;
    const length = shift + (frames * placed.speed) / fps + SEEK_PREROLL_SECONDS;
    // ADR 0002: the native vp9 decoder drops alpha; libvpx keeps it.
    const decoder = video.codec === "vp9" ? ["-c:v", "libvpx-vp9"] : [];
    inputs.push(...decoder, "-ss", num(seekFrame / fps), "-t", num(length), "-i", placed.source.path);
  }
  const speed = placed.speed === 1 ? "" : `/${num(placed.speed)}`;
  return `[${index}:v:0]setpts=(PTS-${num(shift)}/TB)${speed},fps=${rate}:start_time=0,trim=end_frame=${frames},setpts=PTS-STARTPTS`;
}

/**
 * Audio items per track in output samples. Boundaries are rounded from
 * frame times once, so every track sums to exactly the video length.
 */
function audioPlan(layout: Layout, fps: number, sampleRate: number): Omit<RenderPlan["audio"], "codec"> {
  const at = (frame: number) => Math.round((frame / fps) * sampleRate);
  const samples = at(layout.frames);
  const inputs: string[] = [];
  const tracks = layout.audio.map((track) => {
    const items: AudioItem[] = [];
    let cursor = 0;
    for (const placed of track) {
      const start = at(placed.start);
      const end = at(placed.end);
      if (start > cursor) items.push({ kind: "silence", samples: start - cursor });
      let input = inputs.indexOf(placed.source.path);
      if (input === -1) input = inputs.push(placed.source.path) - 1;
      const from = Math.round((placed.in / fps) * sampleRate);
      const sourceSamples = Math.round(((placed.end - placed.start) / fps) * placed.speed * sampleRate);
      items.push({
        kind: "clip",
        clip: placed.clip.id,
        input,
        from,
        to: from + sourceSamples,
        speed: placed.speed,
        gainDb: placed.clip.audio?.gain ?? 0,
        samples: end - start,
      });
      cursor = end;
    }
    if (samples > cursor) items.push({ kind: "silence", samples: samples - cursor });
    return items;
  });
  return { sampleRate, samples, inputs, tracks };
}

/**
 * One continuous audio graph (SPEC §3.5 step 4) ending in `[mix]`: every
 * input decoded once on the source clock (same filter as the PCM sidecar),
 * split per clip, `atrim` to the clip's source samples, `atempo` for speed,
 * padded or cut to its exact timeline length, a short fade at both edges so
 * no cut clicks, tracks concatenated and mixed.
 */
function audioGraph(audio: RenderPlan["audio"]): { inputs: string[]; lines: string[] } {
  const { sampleRate: rate } = audio;
  const format = `aformat=sample_fmts=fltp:sample_rates=${rate}:channel_layouts=stereo`;
  const uses = audio.inputs.map(() => 0);
  for (const item of audio.tracks.flat()) if (item.kind === "clip") uses[item.input]!++;
  const lines = audio.inputs.map((_, input) => {
    const outs = Array.from({ length: uses[input]! }, (_, n) => `[i${input}c${n}]`).join("");
    return `[${input}:a:0]aresample=${rate}:async=1:first_pts=0,${format},asplit=${uses[input]}${outs}`;
  });
  const taken = audio.inputs.map(() => 0);
  const trackLabels = audio.tracks.map((items, t) => {
    const labels = items.map((item, n) => {
      const label = `t${t}i${n}`;
      if (item.kind === "silence") {
        lines.push(`anullsrc=r=${rate}:cl=stereo,atrim=end_sample=${item.samples},${format}[${label}]`);
        return label;
      }
      const fade = Math.max(1, Math.min(Math.round(EDGE_FADE_SECONDS * rate), Math.floor(item.samples / 2)));
      // atempo returns up to a few ms less than asked: feed it more source, cut the output to length.
      const tail = item.speed === 1 ? 0 : Math.round(ATEMPO_TAIL_SECONDS * rate * item.speed);
      const chain = [
        `atrim=start_sample=${item.from}:end_sample=${item.to + tail}`,
        "asetpts=PTS-STARTPTS",
        ...tempo(item.speed),
        ...(item.gainDb === 0 ? [] : [`volume=${num(item.gainDb)}dB`]),
        `apad=whole_len=${item.samples}`,
        `atrim=end_sample=${item.samples}`,
        `afade=t=in:ss=0:ns=${fade}`,
        `afade=t=out:ss=${item.samples - fade}:ns=${fade}`,
      ];
      lines.push(`[i${item.input}c${taken[item.input]!++}]${chain.join(",")}[${label}]`);
      return label;
    });
    const track = `t${t}`;
    lines.push(`${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=0:a=1[${track}]`);
    return track;
  });
  if (trackLabels.length === 0) {
    lines.push(`anullsrc=r=${rate}:cl=stereo,atrim=end_sample=${audio.samples},${format}[mix]`);
  } else if (trackLabels.length === 1) {
    lines.push(`[${trackLabels[0]}]anull[mix]`);
  } else {
    lines.push(`${trackLabels.map((l) => `[${l}]`).join("")}amix=inputs=${trackLabels.length}:duration=longest:normalize=0[mix]`);
  }
  const inputs = audio.inputs.flatMap((path) => ["-vn", "-i", path]);
  return { inputs, lines };
}

/** `atempo` chain for `speed`; each stage accepts 0.5 to 100. */
function tempo(speed: number): string[] {
  if (speed === 1) return [];
  const stages: string[] = [];
  let rest = speed;
  while (rest < 0.5) {
    stages.push("atempo=0.5");
    rest /= 0.5;
  }
  while (rest > 100) {
    stages.push("atempo=100");
    rest /= 100;
  }
  stages.push(`atempo=${num(rest)}`);
  return stages;
}

function videoCodecArgs(preset: ExportPreset): string[] {
  const { codec, crf, bitrateKbps } = preset.video;
  const rate =
    crf !== undefined
      ? ["-crf", String(crf), ...(bitrateKbps ? ["-maxrate", `${bitrateKbps}k`, "-bufsize", `${bitrateKbps * 2}k`] : [])]
      : bitrateKbps
        ? ["-b:v", `${bitrateKbps}k`]
        : [];
  switch (codec) {
    case "h264":
      return ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-pix_fmt", "yuv420p", ...rate];
    case "h265":
      return ["-c:v", "libx265", "-preset", "medium", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", ...rate];
    case "vp9":
      // Constant quality in libvpx needs -b:v 0 unless a bitrate is set.
      return ["-c:v", "libvpx-vp9", "-row-mt", "1", "-pix_fmt", "yuv420p", ...(bitrateKbps ? [] : ["-b:v", "0"]), ...rate];
    case "prores":
      return ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"];
  }
}

function audioCodecArgs(preset: ExportPreset, rate: number): string[] {
  const { codec, bitrateKbps } = preset.audio;
  const bitrate = bitrateKbps ? ["-b:a", `${bitrateKbps}k`] : [];
  switch (codec) {
    case "aac":
      return ["-c:a", "aac", ...bitrate, "-ar", String(rate)];
    case "opus":
      return ["-c:a", "libopus", ...bitrate, "-ar", String(rate)];
    case "pcm":
      return ["-c:a", "pcm_s16le", "-ar", String(rate)];
  }
}

/** Frame start in stored seconds (3 decimals). */
function seconds(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000) / 1000;
}

/** Stable decimal text for args: at most 6 decimals, no trailing zeros. */
function num(value: number): string {
  return String(Number(value.toFixed(6)));
}
