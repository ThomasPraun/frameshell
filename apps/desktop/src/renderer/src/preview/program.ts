// What the preview plays, derived from one `timeline.show` and `asset.list`. Pure: shared by the page and the engine worker.
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Clip, Timeline, Track } from "@frameshell/schema";
import { type Placement, type Size, flattenTimeline, placementOf } from "@frameshell/schema/composite";
import { EDGE_FADE_SAMPLES } from "./mixer.js";

/** Program audio rate: the PCM sidecar rate (SPEC §6.3). */
export const PROGRAM_SAMPLE_RATE = 48_000;

/** Frame size when `frameshell.json` has none. */
const DEFAULT_RESOLUTION: Size = { width: 1920, height: 1080 };

/** Why a stretch of a layer shows a placeholder instead of footage. */
export type PlaceholderReason =
  /** Adapter clip (HyperFrames, Remotion): played from its render cache once #24 lands. */
  | "generated"
  /** Nested timeline clip whose file cannot be read (missing, invalid, nesting itself). */
  | "timeline"
  /** Proxy not built yet: ingest pending or running. */
  | "ingest"
  /** Ingest failed, or the asset is not in `asset.list` (missing file). */
  | "unavailable";

/** One stretch of a video layer, program frames `[start, end)`. */
export type VideoSpan =
  | {
      kind: "media";
      clip: string;
      start: number;
      end: number;
      /** Project-relative CFR proxy (frame index = sample index). */
      proxy: string;
      /** Source frame (project fps) shown at `start`. */
      in: number;
      /** Source frames per program frame. */
      speed: number;
      /** Source picture size as probed (placement uses it, as export does); null when unknown. */
      size: Size | null;
      placement: Placement;
    }
  | {
      kind: "still";
      clip: string;
      start: number;
      end: number;
      /** Project-relative image file, drawn as is (alpha kept). */
      image: string;
      /** Content hash: a changed file is a new picture. */
      version: string;
      size: Size;
      placement: Placement;
    }
  | { kind: "placeholder"; clip: string; start: number; end: number; reason: PlaceholderReason; type: string };

/** Sound of one media clip, program samples `[start, end)` at {@link PROGRAM_SAMPLE_RATE}. */
export interface AudioSpan {
  clip: string;
  start: number;
  end: number;
  /** Project-relative s16le sidecar, starting at source time 0. */
  sidecar: string;
  channels: number;
  /** Sidecar sample played at `start`. */
  in: number;
  /** Source samples per program sample. */
  speed: number;
  /** Linear gain from the clip's `audio.gain` dB. */
  gain: number;
}

/**
 * The preview's program: every video track as a layer, composited bottom
 * first with each clip's placement, and the sound of every unmuted media
 * clip on every track, mixed. Nested timelines are flattened first. Timing
 * and placement follow export exactly: clip edges on the project frame
 * grid, sample boundaries rounded from frames, layers placed by `layerRect`.
 */
export interface Program {
  fps: number;
  sampleRate: number;
  /** Project resolution: placement offsets are in its pixels. */
  resolution: Size;
  /** Length in frames: end of the last span. */
  frames: number;
  /**
   * One per video track, bottom first (the first video track is the base).
   * Each sorted, never overlapping; frames outside every span of every
   * layer are black.
   */
  layers: VideoSpan[][];
  /** Sorted by start; spans may overlap (they are mixed). */
  audio: AudioSpan[];
}

/** Options of {@link compileProgram}. */
export interface ProgramOptions {
  /** `frameshell.json` resolution. Default 1920x1080. */
  resolution?: Size;
  /** Nested timelines by clip `source` (`timelines/<id>.json`); absent ones show a placeholder. */
  nested?: ReadonlyMap<string, TimelineView>;
}

/** Build the {@link Program} of `view`; `assets` by project-relative path. */
export function compileProgram(view: TimelineView, assets: ReadonlyMap<string, AssetInfo>, options: ProgramOptions = {}): Program {
  const { fps } = view;
  const rate = PROGRAM_SAMPLE_RATE;
  const frame = (seconds: number) => Math.round(seconds * fps);
  const sample = (frames: number) => Math.round((frames / fps) * rate);
  const layers: VideoSpan[][] = [];
  const audio: AudioSpan[] = [];
  let frames = 0;

  const nested = options.nested;
  const flat = flattenTimeline(asTimeline(view, true), (source) => {
    const found = nested?.get(source);
    return found ? asTimeline(found, false) : null;
  });

  for (const track of flat.tracks) {
    if (track.kind === "subtitles") continue;
    const placed: { clip: Clip; start: number; end: number }[] = [];
    for (const clip of track.clips) {
      const end = endOf(clip);
      if (end === null) continue; // Unknown length (missing nested timeline): nothing to place.
      const start = frame(clip.start);
      placed.push({ clip, start, end: Math.max(start + 1, frame(end)) });
    }
    placed.sort((a, b) => a.start - b.start);
    // A hand-edited file may overlap clips: the later clip wins from its start.
    for (let i = 1; i < placed.length; i++) placed[i - 1]!.end = Math.min(placed[i - 1]!.end, placed[i]!.start);
    const kept = placed.filter((p) => p.end > p.start);

    const layer: VideoSpan[] = [];
    for (const { clip, start, end } of kept) {
      frames = Math.max(frames, end);
      const info = "asset" in clip ? assets.get(clip.asset) : undefined;
      if (track.kind === "video") {
        const span = pictureOf(clip, info, start, end, fps);
        if (span) layer.push(span);
      }
      if (!("asset" in clip) || clip.audio?.muted === true || !info?.sidecar) continue;
      const speed = clip.speed ?? 1;
      const inFrame = frame(clip.in);
      audio.push({
        clip: clip.id,
        start: sample(start),
        end: sample(end),
        sidecar: info.sidecar.path,
        channels: info.sidecar.channels,
        in: Math.round((inFrame / fps) * info.sidecar.sampleRate),
        speed,
        gain: 10 ** ((clip.audio?.gain ?? 0) / 20),
      });
    }
    if (track.kind === "video") layers.push(layer);
  }
  audio.sort((a, b) => a.start - b.start);
  return { fps, sampleRate: rate, resolution: options.resolution ?? DEFAULT_RESOLUTION, frames, layers, audio };
}

/** Span of `layer` (0 = base) at program frame `frame`; null in gaps, past the end and for a missing layer. */
export function programAt(program: Program, frame: number, layer = 0): VideoSpan | null {
  return spanAt(program.layers[layer] ?? [], frame);
}

function spanAt(spans: readonly VideoSpan[], frame: number): VideoSpan | null {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.end <= frame) lo = mid + 1;
    else hi = mid;
  }
  const span = spans[lo];
  return span && span.start <= frame ? span : null;
}

/**
 * First program frame at or after `from` whose picture on `layer` differs
 * between `a` and `b` (a layer one of them lacks is empty); Infinity when
 * none does. Frames showing the same source frame of the same proxy, the
 * same image or the same placeholder are equal, wherever they are placed:
 * a placement change needs a redraw, not a new decode.
 */
export function firstVideoDifference(a: Program, b: Program, from: number, layer = 0): number {
  const x = a.layers[layer] ?? [];
  const y = b.layers[layer] ?? [];
  const end = Math.max(a.frames, b.frames);
  for (let frame = Math.max(0, from); frame < end; ) {
    const p = spanAt(x, frame);
    const q = spanAt(y, frame);
    if (!samePicture(p, q)) return frame;
    frame = Math.min(p?.end ?? nextStart(x, frame, end), q?.end ?? nextStart(y, frame, end));
  }
  return Infinity;
}

/**
 * First program sample at or after `from` whose sound may differ between
 * `a` and `b`; Infinity when none does. A span whose only change is its end
 * differs from its fade-out on ({@link EDGE_FADE_SAMPLES}).
 */
export function firstAudioDifference(a: Program, b: Program, from: number): number {
  const key = (s: AudioSpan) => `${s.start}|${s.end}|${s.sidecar}|${s.channels}|${s.in}|${s.speed}|${s.gain}`;
  const head = (s: AudioSpan) => `${s.start}|${s.sidecar}|${s.channels}|${s.in}|${s.speed}|${s.gain}`;
  const inB = new Set(b.audio.map(key));
  const inA = new Set(a.audio.map(key));
  const onlyA = a.audio.filter((s) => !inB.has(key(s)));
  const onlyB = b.audio.filter((s) => !inA.has(key(s)));
  let first = Infinity;
  for (const s of onlyA) {
    const twin = onlyB.find((t) => head(t) === head(s));
    first = Math.min(first, twin ? Math.min(s.end, twin.end) - EDGE_FADE_SAMPLES : s.start);
  }
  for (const t of onlyB) if (!onlyA.some((s) => head(s) === head(t))) first = Math.min(first, t.start);
  return first === Infinity ? Infinity : Math.max(from, first, 0);
}

function nextStart(spans: readonly VideoSpan[], frame: number, end: number): number {
  const next = spans.find((span) => span.start > frame);
  return next ? next.start : Math.max(end, frame + 1);
}

function samePicture(x: VideoSpan | null, y: VideoSpan | null): boolean {
  if (!x || !y) return x === y;
  if (x.kind === "media" && y.kind === "media") {
    return x.proxy === y.proxy && x.speed === y.speed && x.in - x.start * x.speed === y.in - y.start * y.speed;
  }
  if (x.kind === "still" && y.kind === "still") return x.image === y.image && x.version === y.version;
  return x.kind === "placeholder" && y.kind === "placeholder" && x.reason === y.reason && x.clip === y.clip;
}

/**
 * `view` as a timeline file for {@link flattenTimeline}: clips as stored.
 * The root keeps its derived `end` (the only length an unreadable nested
 * clip has); nested views drop it, their times move.
 */
function asTimeline(view: TimelineView, root: boolean): Timeline {
  const tracks = view.tracks.map((track): Track => {
    if (track.kind === "subtitles") return { id: track.id, kind: "subtitles", follows: track.follows ?? "" };
    const clips = track.clips.map((clip) => {
      if (root) return clip as unknown as Clip;
      const { end: _end, ...stored } = clip;
      return stored as unknown as Clip;
    });
    return { id: track.id, kind: track.kind, clips };
  });
  return { schemaVersion: 1, id: view.timeline, revision: view.revision, tracks };
}

/** Timeline seconds just after the clip's last frame; null when unknown (unreadable nested timeline). */
function endOf(clip: Clip): number | null {
  if ("asset" in clip) return clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
  if (clip.duration !== undefined) return clip.start + clip.duration;
  const derived = (clip as { end?: unknown }).end;
  return typeof derived === "number" ? derived : null;
}

function pictureOf(clip: Clip, info: AssetInfo | undefined, start: number, end: number, fps: number): VideoSpan | null {
  const placeholder = (reason: PlaceholderReason): VideoSpan => ({ kind: "placeholder", clip: clip.id, start, end, reason, type: clip.type });
  if (!("asset" in clip)) return placeholder(clip.type === "timeline" ? "timeline" : "generated");
  if (!info) return placeholder("unavailable");
  const video = info.media?.video;
  const placement = placementOf(clip.transform);
  const size = video ? { width: video.width, height: video.height } : null;
  if (video?.still && size) return { kind: "still", clip: clip.id, start, end, image: clip.asset, version: info.hash ?? "", size, placement };
  if (info.proxy) {
    return { kind: "media", clip: clip.id, start, end, proxy: info.proxy, in: Math.round(clip.in * fps), speed: clip.speed ?? 1, size, placement };
  }
  if (info.state === "pending" || info.state === "processing") return placeholder("ingest");
  if (info.state === "ready" && info.media && !info.media.video) return null; // Audio only: black picture, as in export.
  return placeholder("unavailable");
}
