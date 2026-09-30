// What the preview plays, derived from one `timeline.show` and `asset.list`. Pure: shared by the page and the engine worker.
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import { EDGE_FADE_SAMPLES } from "./mixer.js";

/** Program audio rate: the PCM sidecar rate (SPEC §6.3). */
export const PROGRAM_SAMPLE_RATE = 48_000;

/** Why a stretch of the picture shows a placeholder instead of footage. */
export type PlaceholderReason =
  /** Adapter clip (HyperFrames, Remotion): played from its render cache once #24 lands. */
  | "generated"
  /** Nested timeline clip: not flattened by the preview yet. */
  | "timeline"
  /** Still image: no proxy is built for stills. */
  | "still"
  /** Proxy not built yet: ingest pending or running. */
  | "ingest"
  /** Ingest failed, or the asset is not in `asset.list` (missing file). */
  | "unavailable";

/** One stretch of the base video track, program frames `[start, end)`. */
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
 * The preview's program: the picture of the first video track (upper tracks
 * are overlays, #17; export v1 renders the same track) and the sound of every
 * unmuted media clip on every track, mixed. Timing follows export v1 exactly:
 * clip edges on the project frame grid, sample boundaries rounded from frames.
 */
export interface Program {
  fps: number;
  sampleRate: number;
  /** Length in frames: end of the last span. */
  frames: number;
  /** Sorted, never overlapping; frames outside every span are black. */
  video: VideoSpan[];
  /** Sorted by start; spans may overlap (they are mixed). */
  audio: AudioSpan[];
}

type Clip = TimelineView["tracks"][number]["clips"][number];

/** Build the {@link Program} of `view`; `assets` by project-relative path. */
export function compileProgram(view: TimelineView, assets: ReadonlyMap<string, AssetInfo>): Program {
  const { fps } = view;
  const rate = PROGRAM_SAMPLE_RATE;
  const frame = (seconds: number) => Math.round(seconds * fps);
  const sample = (frames: number) => Math.round((frames / fps) * rate);
  const video: VideoSpan[] = [];
  const audio: AudioSpan[] = [];
  let frames = 0;
  let base = true;

  for (const track of view.tracks) {
    if (track.kind === "subtitles") continue;
    const placed: { clip: Clip; start: number; end: number }[] = [];
    for (const clip of track.clips) {
      const start = frame(clip.start);
      const end = Math.max(start + 1, frame(isMedia(clip) ? clip.start + (clip.out - clip.in) / (clip.speed ?? 1) : (clip.end ?? clip.start)));
      if (!isMedia(clip) && clip.end === null) continue; // Unknown length (missing nested timeline): nothing to place.
      placed.push({ clip, start, end });
    }
    placed.sort((a, b) => a.start - b.start);
    // A hand-edited file may overlap clips: the later clip wins from its start.
    for (let i = 1; i < placed.length; i++) placed[i - 1]!.end = Math.min(placed[i - 1]!.end, placed[i]!.start);
    const kept = placed.filter((p) => p.end > p.start);

    for (const { clip, start, end } of kept) {
      frames = Math.max(frames, end);
      const info = isMedia(clip) ? assets.get(clip.asset) : undefined;
      if (track.kind === "video" && base) {
        const span = pictureOf(clip, info, start, end, fps);
        if (span) video.push(span);
      }
      if (!isMedia(clip) || clip.audio?.muted === true || !info?.sidecar) continue;
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
    if (track.kind === "video") base = false;
  }
  audio.sort((a, b) => a.start - b.start);
  return { fps, sampleRate: rate, frames, video, audio };
}

/** Picture span at program frame `frame`; null in gaps and past the end. */
export function programAt(program: Program, frame: number): VideoSpan | null {
  const spans = program.video;
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
 * First program frame at or after `from` whose picture differs between `a`
 * and `b`; Infinity when none does. Frames showing the same source frame of
 * the same proxy (or the same placeholder) are equal.
 */
export function firstVideoDifference(a: Program, b: Program, from: number): number {
  const end = Math.max(a.frames, b.frames);
  for (let frame = Math.max(0, from); frame < end; ) {
    const x = programAt(a, frame);
    const y = programAt(b, frame);
    if (!samePicture(x, y)) return frame;
    frame = Math.min(x?.end ?? nextStart(a, frame), y?.end ?? nextStart(b, frame));
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

function nextStart(program: Program, frame: number): number {
  const next = program.video.find((span) => span.start > frame);
  return next ? next.start : Math.max(program.frames, frame + 1);
}

function samePicture(x: VideoSpan | null, y: VideoSpan | null): boolean {
  if (!x || !y) return x === y;
  if (x.kind === "media" && y.kind === "media") {
    return x.proxy === y.proxy && x.speed === y.speed && x.in - x.start * x.speed === y.in - y.start * y.speed;
  }
  return x.kind === "placeholder" && y.kind === "placeholder" && x.reason === y.reason && x.clip === y.clip;
}

interface MediaClip {
  id: string;
  type: "media";
  asset: string;
  start: number;
  in: number;
  out: number;
  speed?: number;
  audio?: { gain?: number; muted?: boolean };
}

function isMedia(clip: Clip): clip is Clip & MediaClip {
  return clip.type === "media" && typeof clip["asset"] === "string";
}

function pictureOf(clip: Clip, info: AssetInfo | undefined, start: number, end: number, fps: number): VideoSpan | null {
  const placeholder = (reason: PlaceholderReason): VideoSpan => ({ kind: "placeholder", clip: clip.id, start, end, reason, type: clip.type });
  if (!isMedia(clip)) return placeholder(clip.type === "timeline" ? "timeline" : "generated");
  if (!info) return placeholder("unavailable");
  if (info.media?.video?.still) return placeholder("still");
  if (info.proxy) return { kind: "media", clip: clip.id, start, end, proxy: info.proxy, in: Math.round(clip.in * fps), speed: clip.speed ?? 1 };
  if (info.state === "pending" || info.state === "processing") return placeholder("ingest");
  if (info.state === "ready" && info.media && !info.media.video) return null; // Audio only: black picture, as in export.
  return placeholder("unavailable");
}
