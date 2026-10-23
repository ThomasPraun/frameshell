import { DEFAULT_FRAME_QUALITY, ErrorCode, type FrameFormat, RpcError } from "@frameshell/protocol";
import {
  type AdapterClip,
  type Clip,
  type ClipEdges,
  type ClipTrack,
  type CropPath,
  type ExportPreset,
  type LayerRect,
  type MediaClip,
  type MulticamGroup,
  type Placement,
  type ShotClip,
  type ResolvedSubtitleTrack,
  SUBTITLE_FONT,
  type Size,
  type Timeline,
  type Transcript,
  edgeTransitions,
  fixedPlacement,
  hasPictureKeys,
  hostFades,
  isKeyed,
  isIdentityPlacement,
  isProgramSound,
  layerRect,
  nestingOf,
  placementOf,
  programGroup,
  programSound,
  shotLayers,
  soundSamples,
  staticGain,
  subtitleTracks,
} from "@frameshell/schema";
import { fpsRational } from "../media/recipe.js";
import { FrameGrid } from "../timeline/grid.js";
import { GAIN_FRAME_SAMPLES, type Ramp, fadeFilters, gainExpression, gainVolume, keyedOpacity, num, placementExpressions } from "./animation.js";
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
  /** Seconds of material (probed); absent when unknown, then a clip has no handle after its `out` (ADR 0018). */
  duration?: number;
}

/** Cached render of a generated (adapter) clip, from the clip render cache (SPEC §6.5). */
export interface GeneratedSource {
  /** Absolute file: VP9 WebM with alpha, or an opaque render. */
  path: string;
  /** True: VP9 with `alpha_mode=1`, decoded with libvpx so alpha survives (ADR 0002). */
  hasAlpha: boolean;
  /** Rendered size in pixels. */
  width: number;
  height: number;
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
  /** Render of every generated clip on a video track, by clip id; they composite like footage (SPEC §3.5 step 2). */
  generated?: ReadonlyMap<string, GeneratedSource>;
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

/**
 * One item of an audio track, in output samples. A clip item may carry equal-power (`qsin`) `ramps` (fades and
 * crossfades, `start` in samples from the item's start) and `gain`, its gain keys in dB as an expression of `t`
 * (seconds from the item's start), which replaces `gainDb` (ADR 0018).
 */
export type AudioItem =
  | {
      kind: "clip";
      clip: string;
      input: number;
      from: number;
      to: number;
      speed: number;
      gainDb: number;
      samples: number;
      ramps?: Ramp[];
      gain?: string;
      /** Factor (expression of `t`, seconds from the item's start) of the nested clips' fades that began before the item. */
      fade?: string;
    }
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
    /**
     * One sequence per audible track, each exactly `samples` long; a track whose clips crossfade takes one more
     * sequence for the overlapping ones (mixed like tracks). Empty = silent export.
     */
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
  /** See {@link RenderInput.generated}. */
  generated?: ReadonlyMap<string, GeneratedSource>;
  width: number;
  height: number;
  /** Timeline seconds; the frame showing at that time is captured. */
  at: number;
  /** Image to write (absolute, or relative to the work directory). */
  output: string;
  /** Default `png`. */
  format?: FrameFormat;
  /** JPEG and WebP quality, 1 to 100; default {@link DEFAULT_FRAME_QUALITY}. */
  quality?: number;
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
  /** Sound of a program track, own or flattened (`isProgramSound`): placed on exact samples from the clip's seconds, not on frames (`soundSamples`). */
  exact?: true;
  /** The clip after this one on its track, muted or not: an `exact` sound ends where it starts (the later clip wins). */
  next?: Placed;
  /**
   * Set on a multicam angle's picture: the source rectangle cropped out and
   * the output rectangle it fills. Replaces the fit-and-offset of `placement`.
   * `move`: the angle's reframe moves the crop, and `clock` is the group second
   * at timeline second 0 (the shot's `in - start`). `exact`: the angle has a
   * reframe, so its still crop keeps odd edges like the moving one.
   */
  tile?: { crop: LayerRect; rect: LayerRect; backdrop: boolean; exact?: boolean; move?: { path: CropPath; clock: number } };
  /** Effective fades and dissolve of the clip (`edgeTransitions`), when it has any. */
  edges?: ClipEdges;
  /** Frames drawn before `start`: the incoming half of this clip's dissolve, from its handle (ADR 0018 decision 3). */
  lead?: number;
  /** Frames drawn after `end`: the outgoing half of the next clip's dissolve. */
  trail?: number;
  /** On the base track: stays opaque under the next clip's dissolve, which is drawn over it (ADR 0018 decision 9). */
  bottom?: true;
  /** A generated clip's render: frames outside the clip hold its first or last rendered frame (ADR 0018 decision 5). */
  hold?: true;
}

/** Timeline frames [from, to) of a placed clip drawn by one chain: the clip, its handles, or part of them. */
interface Span {
  placed: Placed;
  from: number;
  to: number;
}

/** What export v1 renders of a timeline. */
interface Layout {
  frames: number;
  /** Every clip of the base (first) video track, sorted. */
  base: Placed[];
  /** Untransformed, unkeyed clips of the base track with their tails: they fill the frame, black elsewhere. */
  video: Span[];
  /**
   * Layers composited over the base, bottom first (SPEC §5.3: track order is
   * stacking order): transformed or keyed clips of the base track and the
   * dissolving heads of the others, then every upper video track. Only clips
   * with a picture that is not fully transparent.
   */
  overlays: Span[][];
  /** Clips carrying sound, one list per track (base video track first). */
  audio: Placed[][];
  /** Frames where a multicam shot starts or ends: segments prefer to split there. */
  shotEdges: number[];
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
 * timeline is empty or holds what export cannot render (adapter clips
 * without a render, nested timelines left unresolved, a program track whose
 * group is missing).
 */
export function compileRender(input: RenderInput): RenderPlan {
  const { timeline, fps, preset } = input;
  const layout = layoutTimeline(timeline, fps, input.sources, preset.video, input.transcripts, input.generated);
  const outFps = preset.video.fps ?? fps;
  const rate = fpsRational(outFps);
  const { width, height } = preset.video;
  const segmentFrames = Math.max(1, Math.round((input.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS) * fps));
  const edges = [...layout.video.flatMap(({ placed }) => [placed.start, placed.end]), ...layout.shotEdges];
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
  const layout = layoutTimeline(input.timeline, fps, input.sources, { width, height }, input.transcripts, input.generated);
  const frame = Math.floor((input.at + 0.0005) * fps);
  if (frame < 0 || frame >= layout.frames) {
    const last = seconds(layout.frames - 1, fps);
    throw new RpcError(
      ErrorCode.InvalidOperation,
      `at ${input.at} s is outside timeline ${input.timeline.id} (frames start from 0 to ${last} s).`,
      { op: "frame", reason: "out of range", field: "at", valid: { min: 0, max: last } },
    );
  }
  const encoding = frameEncoding(input.format ?? "png", input.quality ?? DEFAULT_FRAME_QUALITY);
  const graph = videoGraph(layout, frame, frame + 1, { fps, width, height, pixFmt: encoding.pixFmt, project: input.resolution });
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
      ...encoding.args,
      ...["-f", "image2", "-update", "1", input.output],
    ],
  };
}

/** Pixel format and encoder args of a `frame` image. */
function frameEncoding(format: FrameFormat, quality: number): { pixFmt: string; args: string[] } {
  switch (format) {
    case "png":
      return { pixFmt: "rgb24", args: ["-c:v", "png"] };
    case "jpg":
      // mjpeg's scale runs 2 (best) to 31; full-range 4:4:4 keeps text edges sharp.
      return { pixFmt: "yuvj444p", args: ["-c:v", "mjpeg", "-q:v", String(Math.round(2 + ((100 - quality) * 29) / 99))] };
    case "webp":
      return { pixFmt: "yuv420p", args: ["-c:v", "libwebp", "-quality", String(quality)] };
  }
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

/**
 * Place the timeline's clips on the frame grid, resolve subtitle cues, and
 * reject what export cannot render. A generated clip plays its cached render
 * like footage: from its `in` (render time = composition time), for its
 * `duration`, transformed and stacked by its track like any clip.
 */
function layoutTimeline(
  timeline: Timeline,
  fps: number,
  sources: ReadonlyMap<string, ExportSource>,
  output: Size,
  transcripts: ReadonlyMap<string, Transcript> = new Map(),
  generated: ReadonlyMap<string, GeneratedSource> = new Map(),
): Layout {
  const grid = new FrameGrid(fps);
  const warnings: string[] = [];
  /** Picture layers in track order (SPEC §5.3: track order is stacking order). */
  const pictures: { program: boolean; placed: Placed[] }[] = [];
  const audio: Placed[][] = [];
  const shotEdges: number[] = [];
  const pictureless = new Set<string>();
  let frames = 0;
  /** Clips of one video or audio track on the frame grid, sorted; the later of two overlapping clips wins. */
  const placeTrack = (track: ClipTrack): Placed[] => {
    const placed: Placed[] = [];
    const transitions = trackTransitions(track, fps, sources);
    for (const listed of track.clips) {
      const clip = track.kind === "video" ? asFootage(listed, generated) : listed;
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
          `Clip ${clip.id} on track ${track.id} is a \`${clip.type}\` clip with no render to export. Install and trust the plugin ` +
            `that renders \`${clip.type}\` clips (\`frameshell plugin list\`), or remove it: \`frameshell clip remove ${clip.id}\`.`,
          { track: track.id, clip: clip.id },
        );
      }
      const render = clip.asset.startsWith(GENERATED) ? generated.get(clip.id) : undefined;
      const source = render ? generatedSource(render) : sources.get(clip.asset);
      if (!source) throw new Error(`no export source for ${clip.asset}`);
      const speed = clip.speed ?? 1;
      const start = grid.frame(clip.start);
      const end = Math.max(start + 1, grid.frame(clip.start + (clip.out - clip.in) / speed));
      // Program sound flattened onto an audio track plays at exact samples, like a program track's own.
      const exact = isProgramSound(clip) ? { exact: true as const } : {};
      const edges = transitions?.get(clip.id);
      placed.push({
        clip,
        source,
        start,
        end,
        in: Math.round(clip.in * fps),
        speed,
        placement: fixedPlacement(clip),
        ...exact,
        ...(edges ? { edges } : {}),
        ...(render ? { hold: true as const } : {}),
      });
      frames = Math.max(frames, end);
    }
    placed.sort((a, b) => a.start - b.start);
    // The engine never overlaps clips, but a hand-edited file may: the later clip wins from its start.
    for (let i = 1; i < placed.length; i++) {
      const before = placed[i - 1]!;
      before.next = placed[i]!;
      if (before.end > placed[i]!.start) before.end = Math.max(before.start, placed[i]!.start);
      // Each half of a dissolve is whole frames: the outgoing clip plays it past the cut, the incoming one before.
      const half = placed[i]!.edges?.mode === "dissolve" ? Math.round(placed[i]!.edges!.dissolve * fps) : 0;
      if (half > 0 && before.end === placed[i]!.start) {
        before.trail = half;
        placed[i]!.lead = half;
      }
    }
    return placed.filter((p) => p.end > p.start);
  };
  const audible = (placed: Placed[]) => placed.filter(({ clip, source }) => source.audio && clip.audio?.muted !== true);
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    if (track.kind === "program") {
      const group = programGroup(timeline, track);
      if (!group) {
        throw unsupported(timeline.id, `Program track ${track.id} shows group ${track.group}, which the timeline does not have. Remove the track: \`frameshell track remove ${track.id} --force\`.`, {
          track: track.id,
        });
      }
      const layers = placeShots(track.clips, group, { grid, fps, sources, output, pictureless, edges: shotEdges });
      for (const edge of shotEdges) frames = Math.max(frames, edge);
      pictures.push({ program: true, placed: layers });
      // Every angle's sound plays under every shot, whatever the shot shows.
      for (const sound of programSound(track, group)) audio.push(audible(placeTrack(sound).map((placed) => ({ ...placed, exact: true as const }))));
      continue;
    }
    const placed = placeTrack(track);
    if (track.kind === "video") pictures.push({ program: false, placed });
    audio.push(audible(placed));
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
  // The first picture layer is the base when it is a video track; a program track first leaves the base black.
  const baseLayer = pictures[0]?.program === false ? pictures[0].placed : [];
  for (const placed of baseLayer) placed.bottom = true;
  const upper = (baseLayer === pictures[0]?.placed ? pictures.slice(1) : pictures).map((layer) => layer.placed);
  const visible = ({ placed }: Span) => placed.source.video !== null && (isKeyed(placed.clip, "opacity") || placed.placement.opacity > 0);
  const whole = (placed: Placed): Span => ({ placed, from: placed.start - (placed.lead ?? 0), to: placed.end + (placed.trail ?? 0) });
  // A base clip filling the frame is concatenated from where its dissolve ends; its dissolving head is a layer over the clip before.
  const fills = (placed: Placed) => isIdentityPlacement(placed.placement) && !hasPictureKeys(placed.clip);
  const baseLayers = baseLayer.flatMap((placed): Span[] => {
    if (!fills(placed)) return [whole(placed)];
    const lead = placed.lead ?? 0;
    return lead > 0 ? [{ placed, from: placed.start - lead, to: placed.start + lead }] : [];
  });
  const overlays = [baseLayers, ...upper.map((layer) => layer.map(whole))].map((layer) => layer.filter(visible)).filter((layer) => layer.length > 0);
  for (const angle of pictureless) {
    warnings.push(`Multicam angle ${angle} has no picture; its tile stays black.`);
  }
  return {
    frames,
    base: baseLayer,
    video: baseLayer.filter(fills).map((placed) => ({ placed, from: placed.start + (placed.lead ?? 0), to: placed.end + (placed.trail ?? 0) })),
    overlays,
    audio: audio.filter((track) => track.length > 0),
    shotEdges,
    subtitles: subtitles.filter((track) => track.cues.length > 0),
    warnings,
  };
}

/** What {@link placeShots} needs from the timeline layout in progress. */
interface ShotContext {
  grid: FrameGrid;
  fps: number;
  sources: ReadonlyMap<string, ExportSource>;
  output: Size;
  /** Collects angles (`<group>/<angle>`) whose asset has no picture. */
  pictureless: Set<string>;
  /** Collects the frames where shots start and end. */
  edges: number[];
}

/** Picture size assumed for an angle without a picture, so the layout of the others does not shift. */
const NO_PICTURE: Size = { width: 16, height: 9 };

/**
 * The pictures of a program track's shots as layers, shot by shot: each
 * angle's cropped picture from group time minus its offset, scaled into
 * its tile ({@link shotLayers}). Shots clamp at the next shot's start, like
 * overlapping clips. An angle that has not started yet at the shot's start
 * appears from its first frame; before that its tile shows what is below.
 */
function placeShots(shots: readonly ShotClip[], group: MulticamGroup, context: ShotContext): Placed[] {
  const { grid, fps, sources, output } = context;
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  const out: Placed[] = [];
  sorted.forEach((shot, index) => {
    const start = grid.frame(shot.start);
    let end = Math.max(start + 1, grid.frame(shot.start + (shot.out - shot.in)));
    const next = sorted[index + 1];
    if (next) end = Math.min(end, grid.frame(next.start));
    if (end <= start) return;
    context.edges.push(start, end);
    const sizeOf = (asset: string): Size => {
      const video = sources.get(asset)?.video;
      return video ? { width: video.width, height: video.height } : NO_PICTURE;
    };
    for (const layer of shotLayers(shot, group, output, sizeOf)) {
      const angle = group.angles.find((candidate) => candidate.id === layer.angle)!;
      const source = sources.get(layer.asset);
      if (!source) throw new Error(`no export source for ${layer.asset}`);
      if (!source.video) {
        context.pictureless.add(`${group.id}/${angle.id}`);
        continue;
      }
      const from = shot.in - angle.offset;
      const to = shot.out - angle.offset;
      if (to <= 0) continue;
      const skipped = Math.max(0, -from);
      const first = Math.max(start, grid.frame(shot.start + skipped));
      if (first >= end) continue;
      out.push({
        clip: { id: `${shot.id}/${angle.id}`, type: "media", asset: layer.asset, start: shot.start + skipped, in: from + skipped, out: to },
        source,
        start: first,
        end,
        in: Math.round((from + skipped) * fps),
        speed: 1,
        placement: placementOf(undefined),
        tile: {
          crop: layer.crop,
          rect: layer.tile,
          backdrop: layer.backdrop,
          ...(angle.reframe ? { exact: true } : {}),
          ...(layer.reframe ? { move: { path: layer.reframe, clock: shot.in - shot.start } } : {}),
        },
      });
    }
  });
  return out;
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

/** Asset prefix of a generated clip standing in as footage; never a real project path (those start with a folder). */
const GENERATED = "generated:";

/** A generated clip with a render, as the media clip playing that render; any other clip unchanged. */
function asFootage(clip: Clip, generated: ReadonlyMap<string, GeneratedSource>): Clip {
  if (clip.type === "media" || clip.type === "timeline" || !generated.has(clip.id)) return clip;
  const adapter = clip as AdapterClip;
  const clipIn = adapter.in ?? 0;
  return {
    id: adapter.id,
    type: "media",
    asset: `${GENERATED}${adapter.id}`,
    start: adapter.start,
    in: clipIn,
    out: clipIn + adapter.duration,
    ...(adapter.transform ? { transform: adapter.transform } : {}),
    // Same clock as the render (from `in`, speed 1), so keys and nested hosts carry over as they are.
    ...(adapter.keys ? { keys: adapter.keys } : {}),
    ...(nestingOf(adapter) ? { nesting: nestingOf(adapter) } : {}),
  } as MediaClip;
}

function generatedSource(render: GeneratedSource): ExportSource {
  // ADR 0002: alpha renders are VP9, which `pieceChain` decodes with libvpx.
  const codec = render.hasAlpha ? "vp9" : "h264";
  return { path: render.path, video: { codec, still: false, width: render.width, height: render.height }, audio: false };
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
  for (const span of layout.video) {
    const { placed } = span;
    const start = Math.max(span.from, from);
    const end = Math.min(span.to, to);
    if (end <= start) continue;
    if (start > cursor) black(start - cursor);
    cursor = end;
    if (!placed.source.video) {
      black(end - start);
      continue;
    }
    const label = `p${labels.length}`;
    // Fades of the bottom track go to black: nothing is under it.
    const fades = fadeFilters(pictureRamps(placed, start, end, fps, false), false);
    const timed = fades.length > 0 ? [`setpts=PTS+${num(start / fps)}/TB`, ...fades, "setpts=PTS-STARTPTS"] : [];
    lines.push(`${[pieceChain(placed, start, end, fps, inputs), fit, ...timed].join(",")}[${label}]`);
    labels.push(label);
  }
  if (to > cursor) black(to - cursor);
  const joined = labels.length === 1 ? `[${labels[0]}]null` : `${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=1:a=0`;

  const pieces = layout.overlays.flatMap((layer) =>
    layer.flatMap((span) => {
      const start = Math.max(span.from, from);
      const end = Math.min(span.to, to);
      return end > start ? [{ placed: span.placed, start, end }] : [];
    }),
  );
  if (pieces.length === 0) {
    lines.push(joined);
    return { inputs, lines };
  }
  lines.push(`${joined}[base]`);
  let below = "base";
  pieces.forEach(({ placed, start, end }, n) => {
    const rect = placed.tile?.rect ?? layerRect(placed.source.video!, { width, height }, out.project, placed.placement);
    const { opacity } = placed.placement;
    const crop = placed.tile?.crop;
    const move = placed.tile?.move;
    const motion = placed.tile ? null : layerMotion(placed, start, end, from, out);
    const opacityKeys = !placed.tile && isKeyed(placed.clip, "opacity");
    const fades = placed.tile ? [] : fadeFilters(pictureRamps(placed, start, end, fps, true), true);
    // Ramps, keyed scale and keyed opacity read timeline seconds: the piece's timestamps move there and back.
    const timed = motion?.scale !== undefined || opacityKeys || fades.length > 0;
    const chain = [
      pieceChain(placed, start, end, fps, inputs),
      ...(move ? [movingCrop(move.path, move.clock + start / fps, (end - start) / fps)] : crop ? [staticCrop(crop, placed.tile?.exact === true)] : []),
      ...(timed ? [`setpts=PTS+${num(start / fps)}/TB`] : []),
      `${motion?.scale ?? `scale=${rect.width}:${rect.height}`},setsar=1,format=rgba`,
      ...(placed.tile?.backdrop ? [`pad=${width}:${height}:${rect.left}:${rect.top}:black`] : []),
      ...(opacityKeys ? [keyedOpacity(placed.clip, start, end, fps, `o${n}`)] : opacity < 1 ? [`colorchannelmixer=aa=${num(opacity)}`] : []),
      ...fades,
      ...(timed ? ["setpts=PTS-STARTPTS"] : []),
      ...(start > from ? [`tpad=start=${start - from}:color=black@0`] : []),
    ];
    lines.push(`${chain.join(",")}[o${n}]`);
    const position = motion?.x !== undefined ? `x=${motion.x}:y=${motion.y}:eval=frame` : `x=${placed.tile?.backdrop ? 0 : rect.left}:y=${placed.tile?.backdrop ? 0 : rect.top}`;
    const overlay = `[${below}][o${n}]overlay=${position}:eof_action=pass:format=auto`;
    below = `b${n}`;
    lines.push(n === pieces.length - 1 ? `${overlay},format=${pixFmt}` : `${overlay}[${below}]`);
  });
  return { inputs, lines };
}

/**
 * Effective fades and dissolves of a track's clips that have any (`edgeTransitions`, ADR 0018 decision 4); null when
 * no clip asks for one, so timelines without transitions compile as before.
 */
function trackTransitions(track: ClipTrack, fps: number, sources: ReadonlyMap<string, ExportSource>): Map<string, ClipEdges> | null {
  if (!track.clips.some((clip) => clip.dissolve !== undefined || clip.fadeIn !== undefined || clip.fadeOut !== undefined)) return null;
  const sourceDuration = (clip: Clip) => {
    if (!("asset" in clip)) return undefined;
    const source = sources.get(clip.asset);
    return source?.video?.still ? Number.POSITIVE_INFINITY : source?.duration;
  };
  const edges = edgeTransitions(track.clips, { fps, sourceDuration });
  for (const [id, edge] of edges) if (edge.fadeIn === 0 && edge.fadeOut === 0 && edge.dissolve === 0) edges.delete(id);
  return edges;
}

/**
 * Linear ramps (timeline seconds) multiplying `placed`'s picture on timeline frames [start, end): its fades
 * (`fadeWeight`) and, drawn as a layer (`layer`), its dissolve weights (`dissolveWeights`): the incoming clip rises
 * over its dissolve, the outgoing one falls unless it is on the bottom track; then the fades of the nested clips
 * it plays inside (`hostFades`). A ramp that leaves those frames as they are is left out. Ramps sit on the frame
 * grid, as the clip does.
 */
function pictureRamps(placed: Placed, start: number, end: number, fps: number, layer: boolean): Ramp[] {
  const ramps: Ramp[] = [];
  const add = (type: Ramp["type"], first: number, frames: number) => {
    const touched = type === "in" ? start < first + frames : end - 1 > first;
    if (frames > 0 && touched) ramps.push({ type, start: first / fps, length: frames / fps });
  };
  const fadeIn = Math.round((placed.edges?.fadeIn ?? 0) * fps);
  const fadeOut = Math.round((placed.edges?.fadeOut ?? 0) * fps);
  const lead = layer ? (placed.lead ?? 0) : 0;
  const trail = layer && !placed.bottom ? (placed.trail ?? 0) : 0;
  add("in", placed.start - lead, 2 * lead);
  add("in", placed.start, fadeIn);
  add("out", placed.end - fadeOut, fadeOut);
  add("out", placed.end - trail, 2 * trail);
  for (const host of hostFades(placed.clip)) {
    const hostOut = Math.round(host.fadeOut * fps);
    add("in", Math.round(host.start * fps), Math.round(host.fadeIn * fps));
    add("out", Math.round(host.end * fps) - hostOut, hostOut);
  }
  return ramps;
}

/**
 * Keyed placement of a layer piece on timeline frames [start, end) of a graph starting at frame `from`
 * (`placementAt` and `layerRect` as expressions, hosts composed): `scale` with `eval=frame` reading the piece's
 * timeline seconds, `overlay` x/y reading the graph's. Null when no `x`, `y` or `scale` keys move the clip.
 */
function layerMotion(placed: Placed, start: number, end: number, from: number, out: GraphTarget): { scale?: string; x: string; y: string } | null {
  const { clip } = placed;
  if (!isKeyed(clip, "x") && !isKeyed(clip, "y") && !isKeyed(clip, "scale")) return null;
  const { fps, width, height, project } = out;
  const video = placed.source.video!;
  const first = start / fps;
  const last = (end - 1) / fps;
  const fit = Math.min(width / video.width, height / video.height);
  const time = from === 0 ? "t" : `(${num(from / fps)}+t)`;
  const at = placementExpressions(clip, time, first, last);
  const axis = (value: string, size: number, projectSize: number, own: string) => `'floor(${num(size / 2)}+(${value})*${size}/${projectSize}-${own}/2+0.5)'`;
  const x = axis(at.x, width, project.width, "overlay_w");
  const y = axis(at.y, height, project.height, "overlay_h");
  if (!isKeyed(clip, "scale")) return { x, y };
  const factor = placementExpressions(clip, "t", first, last).scale;
  const side = (fitted: number) => `'max(1,floor(${num(fitted)}*(${factor})+0.5))'`;
  return { scale: `scale=w=${side(video.width * fit)}:h=${side(video.height * fit)}:eval=frame`, x, y };
}

/**
 * `crop` filter cutting `crop`. Chroma subsampling rounds an odd edge down;
 * `exact` keeps it, only when asked and needed so unreframed output stays as it was.
 */
function staticCrop(crop: LayerRect, exact: boolean): string {
  const odd = crop.left % 2 !== 0 || crop.top % 2 !== 0;
  return `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top}${exact && odd ? ":exact=1" : ""}`;
}

/**
 * `crop` filter cutting `path` ({@link cropAt} in `@frameshell/schema`) for a
 * piece whose first frame shows group second `from` and that lasts `length`
 * seconds: the group second is `from + t` (piece timestamps start at 0), the
 * edges are the same straight lines between keys, rounded and clamped. Keys
 * outside the piece are left out but for the one on each side. `exact`
 * keeps odd edges, which chroma subsampling would otherwise round down.
 */
function movingCrop(path: CropPath, from: number, length: number): string {
  const to = from + length;
  const before = path.keys.filter((key) => key.at <= from).at(-1);
  const after = path.keys.find((key) => key.at >= to);
  const keys = [...(before ? [before] : []), ...path.keys.filter((key) => key.at > from && key.at < to), ...(after && after !== before ? [after] : [])];
  const group = `(${num(from)}+t)`;
  const edge = (value: (key: CropPath["keys"][number]) => number, size: number, [lo, hi]: readonly [number, number]) => {
    if (lo === hi) return String(lo);
    const at = (index: number) => num(keys[index]!.at);
    const v = (index: number) => value(keys[index]!);
    let line = num(v(keys.length - 1));
    for (let index = keys.length - 2; index >= 0; index--) {
      const slope = (v(index + 1) - v(index)) / (keys[index + 1]!.at - keys[index]!.at);
      line = `if(lt(${group},${at(index + 1)}),${num(v(index))}+${num(slope)}*(${group}-${at(index)}),${line})`;
    }
    if (keys.length > 1) line = `if(lt(${group},${at(0)}),${num(v(0))},${line})`;
    return `'clip(round(${line}-${num(size / 2)}),${lo},${hi})'`;
  };
  const x = edge((key) => key.x, path.width, path.left);
  const y = edge((key) => key.y, path.height, path.top);
  return `crop=w=${path.width}:h=${path.height}:x=${x}:y=${y}:exact=1`;
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
  if (!placed.hold || (start >= placed.start && end <= placed.end)) return sourceChain(placed, start, end, fps, inputs);
  // A render holds its first and last frame for the handles: draw what it has (one edge frame at least), clone the rest.
  const frames = end - start;
  if (end <= placed.start) return `${sourceChain(placed, placed.start, placed.start + 1, fps, inputs)},tpad=start=${frames - 1}:start_mode=clone`;
  if (start >= placed.end) return `${sourceChain(placed, placed.end - 1, placed.end, fps, inputs)},tpad=stop=${frames - 1}:stop_mode=clone`;
  const first = Math.max(start, placed.start);
  const last = Math.min(end, placed.end);
  const pad = [...(first > start ? [`start=${first - start}:start_mode=clone`] : []), ...(end > last ? [`stop=${end - last}:stop_mode=clone`] : [])];
  return `${sourceChain(placed, first, last, fps, inputs)},tpad=${pad.join(":")}`;
}

/** {@link pieceChain} reading only the source: frames past the source's end repeat its last one. */
function sourceChain(placed: Placed, start: number, end: number, fps: number, inputs: string[]): string {
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
  // A tail handle may reach the last frame of a stream a little shorter than the probed duration.
  const tail = end > placed.end && !video.still ? `,tpad=stop=${end - placed.end}:stop_mode=clone` : "";
  return `[${index}:v:0]setpts=(PTS-${num(shift)}/TB)${speed},fps=${rate}:start_time=0${tail},trim=end_frame=${frames},setpts=PTS-STARTPTS`;
}

/**
 * Audio items per track in output samples. Boundaries are rounded from
 * frame times once, so every track sums to exactly the video length. A clip
 * whose dissolve overlaps the clip before it (ADR 0018 decision 3) goes to
 * another sequence of its track, so both play through the crossfade.
 */
function audioPlan(layout: Layout, fps: number, sampleRate: number): Omit<RenderPlan["audio"], "codec"> {
  const at = (frame: number) => Math.round((frame / fps) * sampleRate);
  const samples = at(layout.frames);
  const inputs: string[] = [];
  /** One sequence of a track; `joinable` is its last item when that is a program sound, with its start sample, for joining the next shot to it. */
  interface Lane {
    items: AudioItem[];
    cursor: number;
    joinable: { item: Extract<AudioItem, { kind: "clip" }>; start: number } | null;
  }
  const tracks = layout.audio.flatMap((track) => {
    const lanes: Lane[] = [{ items: [], cursor: 0, joinable: null }];
    /** First sample of `placed`, as this plan places it. */
    const startOf = (placed: Placed) => (placed.exact ? soundSamples(placed.clip, sampleRate).start : at(placed.start));
    for (const placed of track) {
      const lead = placed.lead ?? 0;
      const trail = placed.trail ?? 0;
      const exact = placed.exact ? soundSamples(placed.clip, sampleRate) : null;
      // Program sound: exact samples of the clip's seconds, clamped to the video's length, the previous item and the next clip.
      // Any other clip: frame samples, never before the previous item ends, so a track never outlasts the video.
      const planned = exact ? exact.start : at(placed.start - lead);
      let lane = lanes[0]!;
      if (lead > 0) {
        lane = lanes.find((candidate) => candidate.cursor <= planned) ?? { items: [], cursor: 0, joinable: null };
        if (!lanes.includes(lane)) lanes.push(lane);
      }
      const { cursor } = lane;
      const start = Math.min(samples, Math.max(cursor, planned));
      const end = exact ? Math.min(samples, exact.end, placed.next ? startOf(placed.next) : samples) : at(placed.end + trail);
      if (end <= start) continue;
      const skipped = start - planned;
      // Source samples the head handle reads before the clip's `in`.
      const head = Math.round((at(placed.start) - planned) * placed.speed);
      const from = exact ? exact.in + skipped : Math.round((placed.in / fps) * sampleRate) - head + Math.round(skipped * placed.speed);
      const sourceSamples = exact
        ? end - start
        : Math.round(((placed.end + trail - placed.start) / fps) * placed.speed * sampleRate) + head - Math.round(skipped * placed.speed);
      let input = inputs.indexOf(placed.source.path);
      if (input === -1) input = inputs.push(placed.source.path) - 1;
      const previous = lane.joinable;
      // A sound running on across a shot change stays one item: shots switch pictures, the edge fade belongs to real cuts (as in the preview).
      if (
        exact &&
        previous &&
        start - cursor <= 1 &&
        previous.item.input === input &&
        previous.item.gainDb === staticGain(placed.clip) &&
        Math.abs(from - previous.item.to) <= 1
      ) {
        previous.item.samples = end - previous.start;
        previous.item.to = previous.item.from + previous.item.samples;
        lane.cursor = end;
        continue;
      }
      if (start > cursor) lane.items.push({ kind: "silence", samples: start - cursor });
      const { ramps, fade } = soundRamps(placed, start, fps, at, sampleRate);
      const gainKeys = !exact && isKeyed(placed.clip, "gain");
      const item: Extract<AudioItem, { kind: "clip" }> = {
        kind: "clip",
        clip: placed.clip.id,
        input,
        from,
        to: from + sourceSamples,
        speed: placed.speed,
        gainDb: gainKeys ? 0 : staticGain(placed.clip),
        samples: end - start,
        ...(ramps.length > 0 ? { ramps } : {}),
        ...(gainKeys ? { gain: gainExpression(placed.clip, `(${num(start / sampleRate)}+t)`, start / sampleRate, end / sampleRate) } : {}),
        ...(fade ? { fade } : {}),
      };
      lane.items.push(item);
      lane.joinable = exact ? { item, start } : null;
      lane.cursor = end;
    }
    return lanes.map((lane) => (samples > lane.cursor ? [...lane.items, { kind: "silence" as const, samples: samples - lane.cursor }] : lane.items));
  });
  return { sampleRate, samples, inputs, tracks };
}

/**
 * Equal-power ramps of `placed`'s sound, in samples from its item's first sample `first` (`fadeWeight` and
 * `dissolveWeights` with `sound`): the incoming crossfade over its dissolve, its fades, the outgoing
 * crossfade under the next clip's dissolve, and the fades of the nested clips it plays inside (`hostFades`); those
 * that began before the item come back as `fade` instead. `at` puts a timeline frame on the sample grid.
 */
function soundRamps(placed: Placed, first: number, fps: number, at: (frame: number) => number, rate: number): { ramps: Ramp[]; fade?: string } {
  const ramps: Ramp[] = [];
  // Host fades that began before the item: `afade` cannot start before its input, so they become a `volume` factor of `t`.
  const factors: string[] = [];
  const add = (type: Ramp["type"], from: number, to: number) => {
    // An item clamped later by the one before it (hand-edited overlap) starts its ramp where it starts.
    const start = Math.max(first, at(from));
    if (at(to) > start) ramps.push({ type, start: start - first, length: at(to) - start });
  };
  const lead = placed.lead ?? 0;
  const trail = placed.trail ?? 0;
  add("in", placed.start - lead, placed.start + lead);
  add("in", placed.start, placed.start + Math.round((placed.edges?.fadeIn ?? 0) * fps));
  add("out", placed.end - Math.round((placed.edges?.fadeOut ?? 0) * fps), placed.end);
  add("out", placed.end - trail, placed.end + trail);
  const quarter = num(Math.PI / 2);
  const addHost = (type: Ramp["type"], from: number, to: number) => {
    if (at(to) <= at(from) || at(from) >= first) return add(type, from, to);
    if (at(to) <= first) return;
    const length = num((at(to) - at(from)) / rate);
    factors.push(
      type === "in"
        ? `sin(${quarter}*min(1,(t+${num((first - at(from)) / rate)})/${length}))`
        : `sin(${quarter}*max(0,(${num((at(to) - first) / rate)}-t)/${length}))`,
    );
  };
  for (const host of hostFades(placed.clip)) {
    const hostStart = Math.round(host.start * fps);
    const hostEnd = Math.round(host.end * fps);
    addHost("in", hostStart, hostStart + Math.round(host.fadeIn * fps));
    addHost("out", hostEnd - Math.round(host.fadeOut * fps), hostEnd);
  }
  return factors.length > 0 ? { ramps, fade: factors.join("*") } : { ramps };
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
        ...(item.gain !== undefined || item.fade !== undefined
          ? [`asetnsamples=n=${GAIN_FRAME_SAMPLES}:p=0`, gainVolume(item.gain ?? num(item.gainDb), item.fade)]
          : item.gainDb === 0
            ? []
            : [`volume=${num(item.gainDb)}dB`]),
        `apad=whole_len=${item.samples}`,
        `atrim=end_sample=${item.samples}`,
        ...(item.ramps ?? []).map((ramp) => `afade=t=${ramp.type}:ss=${ramp.start}:ns=${ramp.length}:curve=qsin`),
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

