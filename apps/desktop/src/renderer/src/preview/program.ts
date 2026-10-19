// What the preview plays, derived from one `timeline.show` and `asset.list`. Pure: shared by the page and the engine worker.
import type { AssetInfo, ClipRenderInfo, TimelineView } from "@frameshell/protocol";
import type { Angle, Clip, MulticamGroup, ProgramTrack, ShotClip, Timeline, Track } from "@frameshell/schema";
import {
  type LayerRect,
  type NestedTimelines,
  type Placement,
  type Size,
  flattenTimeline,
  movedProgramGroups,
  placementOf,
  programGroup,
  shotLayers,
  shotSound,
  soundSamples,
} from "@frameshell/schema/composite";
import { EDGE_FADE_SAMPLES } from "./mixer.js";

/** Program audio rate: the PCM sidecar rate (SPEC §6.3). */
export const PROGRAM_SAMPLE_RATE = 48_000;

/** Frame size when `frameshell.json` has none. */
const DEFAULT_RESOLUTION: Size = { width: 1920, height: 1080 };

/** Why a stretch of a layer shows a placeholder instead of footage. */
export type PlaceholderReason =
  /** Nested timeline clip whose file cannot be read (missing, invalid, nesting itself). */
  | "timeline"
  /** Proxy not built yet: ingest pending or running. */
  | "ingest"
  /** Ingest failed, or the asset is not in `asset.list` (missing file). */
  | "unavailable"
  /** Shot of a program track inside a nested clip with a transform: shots fill the frame, so they would show in the wrong place. */
  | "multicam";

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
  | {
      /**
       * Adapter clip (HyperFrames, …): its cached render (SPEC §6.5, VP9 WebM, alpha kept) decoded and composited by
       * the engine like footage. Rendered at the project format, so one render frame per program frame.
       */
      kind: "generated";
      clip: string;
      /** Adapter clip type, e.g. `hyperframes`. */
      type: string;
      start: number;
      end: number;
      /** Render frame shown at `start`: the clip's `in` in frames (render time = composition time). */
      in: number;
      /** Render cache state; null until known. */
      render: LayerRender | null;
      /** Rendered size once ready (placement uses it, as export does); null before. */
      size: Size | null;
      placement: Placement;
    }
  | {
      /** One angle of a multicam shot (ADR 0016): its proxy, cut into the shot's tile ({@link angleLayer}). */
      kind: "angle";
      /** Shot clip id. */
      clip: string;
      start: number;
      end: number;
      /** Project-relative CFR proxy of the angle's asset. */
      proxy: string;
      /** Source frame (project fps) shown at `start`. */
      in: number;
      /** Always 1: shots have no speed. */
      speed: number;
      /** Angle id. */
      angle: string;
      /** Shared by every angle span of one shot. */
      layout: ShotFrame;
    }
  | {
      kind: "placeholder";
      clip: string;
      start: number;
      end: number;
      reason: PlaceholderReason;
      type: string;
      /** Set when it stands in for one angle of a shot: it shows in that angle's tile, not over the whole frame. */
      angle?: { id: string; layout: ShotFrame };
    };

/** What {@link angleLayer} needs to lay a shot out at any frame size, as export does (`shotLayers`). */
export interface ShotFrame {
  shot: ShotClip;
  group: MulticamGroup;
  /** Source picture size by angle asset: probed, or the project resolution while unknown. */
  sizes: Record<string, Size>;
}

/** An angle's picture in an `output`-sized frame: `crop` (source pixels, of `source`) drawn into `tile`. */
export interface AngleLayer {
  tile: LayerRect;
  crop: LayerRect;
  source: Size;
  /** True: black fills the frame behind the tile (`ShotLayer.backdrop`). */
  backdrop: boolean;
}

/** Render cache state of a generated clip as the preview needs it (daemon `clip.renders`). */
export type LayerRender =
  | { state: "ready"; file: string }
  | {
      state: "queued" | "rendering" | "failed" | "unavailable";
      progress: number;
      error: string | null;
      /** Cache key being rendered (null when unavailable): the live page of the clip is built for it (ADR 0010). */
      key: string | null;
    };

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
 * clip on every track, mixed. A program track takes one layer per angle a
 * shot shows at most (one decoder each), its shots laid out by `shotLayers`,
 * and plays every angle's sound under every shot. Nested timelines are
 * flattened first. Timing and placement follow export exactly: clip edges
 * on the project frame grid, sample boundaries rounded from frames, layers
 * placed by `layerRect`.
 */
export interface Program {
  fps: number;
  sampleRate: number;
  /** Project resolution: placement offsets are in its pixels. */
  resolution: Size;
  /** Length in frames: end of the last span. */
  frames: number;
  /**
   * One per video track and per angle slot of a program track, bottom first
   * (layer 0 is the bottom picture track).
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
  /** Render cache states of generated clips by clip id (`clip.renders`); absent ones are not known yet. */
  renders?: ReadonlyMap<string, ClipRenderInfo>;
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

  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const resolve = nestedResolver(options.nested);
  const root = asTimeline(view, true);
  const flat = flattenTimeline(root, resolve);
  const moved = movedProgramGroups(root, resolve);

  for (const track of flat.tracks) {
    if (track.kind === "subtitles") continue;
    if (track.kind === "program") {
      const shots = placeShots(track, frame);
      for (const { end } of shots) frames = Math.max(frames, end);
      const group = programGroup(flat, track);
      if (!group || moved.has(group.id)) {
        layers.push(shots.map(({ shot, start, end }) => ({ kind: "placeholder", clip: shot.id, start, end, reason: group ? "multicam" : "unavailable", type: shot.type })));
      } else {
        layers.push(...angleSlots(shots, group, assets, fps, resolution));
      }
      if (group) audio.push(...shotAudio(shots, group, assets, rate));
      continue;
    }
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
        const span = pictureOf(clip, info, start, end, fps, options.renders);
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
  return { fps, sampleRate: rate, resolution, frames, layers, audio };
}

/** A placeholder span. */
export type PlaceholderSpan = Extract<VideoSpan, { kind: "placeholder" }>;

/** Placeholders showing at a frame, by where the preview draws them. */
export interface PlaceholdersAt {
  /** The base layer's, over the whole frame; null when layer 0 has none or it stands in for a shot's angle. */
  base: PlaceholderSpan | null;
  /** Angles of a shot with no picture yet, each in its own tile (project pixels). */
  tiles: { span: PlaceholderSpan; layer: number; tile: LayerRect }[];
  /** Upper layers' placeholders, listed small over the picture. */
  notes: { span: PlaceholderSpan; layer: number }[];
}

/** Where the placeholders at program frame `frame` show: a shot's angle never covers the frame, only its tile. */
export function placeholdersAt(program: Program, frame: number): PlaceholdersAt {
  const found: PlaceholdersAt = { base: null, tiles: [], notes: [] };
  program.layers.forEach((_, layer) => {
    const span = programAt(program, frame, layer);
    if (span?.kind !== "placeholder") return;
    if (span.angle) {
      const shown = angleLayer({ angle: span.angle.id, layout: span.angle.layout }, program.resolution);
      if (shown) found.tiles.push({ span, layer, tile: shown.tile });
    } else if (layer === 0) found.base = span;
    else found.notes.push({ span, layer });
  });
  return found;
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
  if ((x.kind === "media" || x.kind === "angle") && x.kind === y.kind) {
    return x.proxy === y.proxy && x.speed === y.speed && x.in - x.start * x.speed === y.in - y.start * y.speed;
  }
  if (x.kind === "still" && y.kind === "still") return x.image === y.image && x.version === y.version;
  if (x.kind === "generated" && y.kind === "generated") {
    // Not ready yet: nothing drawn either way. Ready: the same file shows the same frames.
    const file = (s: typeof x) => (s.render?.state === "ready" ? s.render.file : null);
    return file(x) === file(y) && (file(x) === null ? x.clip === y.clip : x.in - x.start === y.in - y.start);
  }
  return x.kind === "placeholder" && y.kind === "placeholder" && x.reason === y.reason && x.clip === y.clip;
}

/**
 * `view` as a timeline file with its nested timelines flattened (SPEC §3.5
 * step 1), as export resolves it; `nested` = views by clip `source`, absent
 * ones stay unresolved.
 */
export function flattenView(view: TimelineView, nested?: ReadonlyMap<string, TimelineView>): Timeline {
  return flattenTimeline(asTimeline(view, true), nestedResolver(nested));
}

function nestedResolver(nested: ReadonlyMap<string, TimelineView> | undefined): NestedTimelines {
  return (source) => {
    const found = nested?.get(source);
    return found ? asTimeline(found, false) : null;
  };
}

/**
 * `view` as a timeline file for {@link flattenTimeline}: clips as stored.
 * The root keeps its derived `end` (the only length an unreadable nested
 * clip has); nested views drop it, their times move.
 */
function asTimeline(view: TimelineView, root: boolean): Timeline {
  const tracks = view.tracks.map((track): Track => {
    if (track.kind === "subtitles") {
      return { id: track.id, kind: "subtitles", follows: track.follows ?? "", ...(track.style ? { style: track.style } : {}) };
    }
    const clips = track.clips.map((clip) => {
      if (root) return clip as unknown as Clip;
      const { end: _end, ...stored } = clip;
      return stored as unknown as Clip;
    });
    if (track.kind === "program") return { id: track.id, kind: "program", group: track.group ?? "", clips: clips as unknown as ProgramTrack["clips"] };
    return { id: track.id, kind: track.kind, clips };
  });
  return { schemaVersion: 1, id: view.timeline, revision: view.revision, tracks, ...(view.groups ? { groups: view.groups } : {}) };
}

/** One angle of a multicam shot in the preview. */
export type AngleSpan = Extract<VideoSpan, { kind: "angle" }>;

/**
 * Where the angle of `span` shows in an `output`-sized frame, and which of
 * its source pixels fill it (`shotLayers`, as export lays shots out); null
 * when its shot does not show that angle.
 */
export function angleLayer(span: Pick<AngleSpan, "angle" | "layout">, output: Size): AngleLayer | null {
  const { shot, group, sizes } = span.layout;
  const size = (asset: string) => sizes[asset] ?? output;
  const layer = shotLayers(shot, group, output, size).find((candidate) => candidate.angle === span.angle);
  return layer ? { tile: layer.tile, crop: layer.crop, source: size(layer.asset), backdrop: layer.backdrop } : null;
}

/** A shot as the preview plays it: program frames `[start, end)`. */
interface PlacedShot {
  /** `out` cut where an overlapping later shot starts. */
  shot: ShotClip;
  start: number;
  end: number;
}

/** Shots of `track` in program frames, sorted; an overlapping later shot (a hand-edited file) wins from its start. */
function placeShots(track: ProgramTrack, frame: (seconds: number) => number): PlacedShot[] {
  const placed = track.clips
    .map((shot): PlacedShot => {
      const start = frame(shot.start);
      return { shot, start, end: Math.max(start + 1, frame(shot.start + shot.out - shot.in)) };
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < placed.length; i++) {
    const previous = placed[i - 1]!;
    const next = placed[i]!;
    if (previous.end <= next.start) continue;
    previous.end = next.start;
    previous.shot = { ...previous.shot, out: Math.min(previous.shot.out, previous.shot.in + (next.shot.start - previous.shot.start)) };
  }
  return placed.filter((p) => p.end > p.start);
}

/**
 * Picture layers of a program track: one per angle slot, as many as the most
 * angles one shot shows (at least one). An angle keeps its slot from shot to
 * shot while it is shown, so a layout change goes on decoding it with no
 * restart; a newly shown angle takes a slot the previous shot left free.
 */
function angleSlots(shots: readonly PlacedShot[], group: MulticamGroup, assets: ReadonlyMap<string, AssetInfo>, fps: number, resolution: Size): VideoSpan[][] {
  const sizes: Record<string, Size> = {};
  for (const angle of group.angles) {
    const video = assets.get(angle.asset)?.media?.video;
    sizes[angle.asset] = video ? { width: video.width, height: video.height } : resolution;
  }
  const slots: VideoSpan[][] = [[]];
  let held: (string | null)[] = [];
  for (const placed of shots) {
    const shown = placed.shot.angles.filter((id) => group.angles.some((angle) => angle.id === id));
    const next = held.map((id) => (id !== null && shown.includes(id) ? id : null));
    for (const id of shown) {
      if (next.includes(id)) continue;
      const free = next.indexOf(null);
      if (free >= 0) next[free] = id;
      else next.push(id);
    }
    // Slots paint bottom first: a pip inset (second angle) must sit above its screen (first angle).
    if (placed.shot.shot === "pip") {
      const [screen, inset] = [next.indexOf(shown[0] ?? ""), next.indexOf(shown[1] ?? "")];
      if (screen > inset && inset >= 0) [next[screen], next[inset]] = [next[inset]!, next[screen]!];
    }
    held = next;
    while (slots.length < next.length) slots.push([]);
    const layout: ShotFrame = { shot: placed.shot, group, sizes };
    next.forEach((id, slot) => {
      const angle = id === null ? undefined : group.angles.find((candidate) => candidate.id === id);
      const span = angle ? angleSpan(placed, angle, layout, assets.get(angle.asset), fps) : null;
      if (span) slots[slot]!.push(span);
    });
  }
  return slots;
}

/** The picture of `angle` under `placed`: its proxy, a placeholder while it has none, null for no picture. */
function angleSpan(placed: PlacedShot, angle: Angle, layout: ShotFrame, info: AssetInfo | undefined, fps: number): VideoSpan | null {
  const { shot, start, end } = placed;
  const placeholder = (reason: PlaceholderReason): VideoSpan => ({ kind: "placeholder", clip: shot.id, start, end, reason, type: shot.type, angle: { id: angle.id, layout } });
  if (!info || info.media?.video?.still) return placeholder("unavailable");
  if (!info.proxy) {
    if (info.state === "pending" || info.state === "processing") return placeholder("ingest");
    return info.state === "ready" && info.media && !info.media.video ? null : placeholder("unavailable");
  }
  // Source time = group time - offset. An asset that starts after the shot shows from its time 0 on.
  let first = start;
  let sourceIn = Math.round((shot.in - angle.offset) * fps);
  if (sourceIn < 0) {
    first = start - sourceIn;
    sourceIn = 0;
  }
  if (first >= end) return null;
  return { kind: "angle", clip: shot.id, start: first, end, proxy: info.proxy, in: sourceIn, speed: 1, angle: angle.id, layout };
}

/**
 * Sound of a program track: every angle's `shotSound` under each shot, in
 * exact samples rather than frames, so the mics of one room stay aligned with
 * each other. An angle's sound that runs on unbroken across a shot change
 * stays one span: the mixer fades span edges, and shots switch pictures only.
 */
function shotAudio(shots: readonly PlacedShot[], group: MulticamGroup, assets: ReadonlyMap<string, AssetInfo>, rate: number): AudioSpan[] {
  const spans: AudioSpan[] = [];
  const last = new Map<string, AudioSpan>();
  for (const { shot } of shots) {
    for (const clip of shotSound(shot, group)) {
      const sidecar = assets.get(clip.asset)?.sidecar;
      if (clip.audio?.muted === true || !sidecar) continue;
      const samples = soundSamples(clip, rate, sidecar.sampleRate);
      const span: AudioSpan = {
        clip: clip.id,
        start: samples.start,
        end: samples.end,
        sidecar: sidecar.path,
        channels: sidecar.channels,
        in: samples.in,
        speed: 1,
        gain: 10 ** ((clip.audio?.gain ?? 0) / 20),
      };
      if (span.end <= span.start) continue;
      // `shotSound` names its clips `<shot>/<angle>`.
      const angle = clip.id.slice(shot.id.length + 1);
      const previous = last.get(angle);
      const continues =
        previous !== undefined &&
        previous.sidecar === span.sidecar &&
        previous.gain === span.gain &&
        Math.abs(span.start - previous.end) <= 1 &&
        Math.abs(span.in - (previous.in + (span.start - previous.start))) <= 1;
      if (continues) {
        previous.end = span.end;
        continue;
      }
      spans.push(span);
      last.set(angle, span);
    }
  }
  return spans;
}

/** Timeline seconds just after the clip's last frame; null when unknown (unreadable nested timeline). */
function endOf(clip: Clip): number | null {
  if ("asset" in clip) return clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
  if (clip.duration !== undefined) return clip.start + clip.duration;
  const derived = (clip as { end?: unknown }).end;
  return typeof derived === "number" ? derived : null;
}

function pictureOf(
  clip: Clip,
  info: AssetInfo | undefined,
  start: number,
  end: number,
  fps: number,
  renders: ReadonlyMap<string, ClipRenderInfo> | undefined,
): VideoSpan | null {
  const placeholder = (reason: PlaceholderReason): VideoSpan => ({ kind: "placeholder", clip: clip.id, start, end, reason, type: clip.type });
  if (clip.type !== "media" && clip.type !== "timeline") return generatedOf(clip, start, end, fps, renders?.get(clip.id));
  if (!("asset" in clip)) return placeholder("timeline");
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

function generatedOf(clip: Clip, start: number, end: number, fps: number, info: ClipRenderInfo | undefined): VideoSpan {
  const ready = info?.state === "ready" && info.file ? info : null;
  const render: LayerRender | null = ready
    ? { state: "ready", file: ready.file! }
    : info && info.state !== "ready"
      ? { state: info.state, progress: info.progress, error: info.error, key: info.key }
      : null;
  const size = ready && ready.width && ready.height ? { width: ready.width, height: ready.height } : null;
  const clipIn = "in" in clip && typeof clip.in === "number" ? clip.in : 0;
  return { kind: "generated", clip: clip.id, type: clip.type, start, end, in: Math.round(clipIn * fps), render, size, placement: placementOf(clip.transform) };
}
