// What a clip's `dissolve`, `fadeIn` and `fadeOut` play as (ADR 0018 decisions 2 to 5). The file stores the requested
// lengths; export, preview and engine warnings all read the effective ones from here.
import type { Clip, ClipKeys, Transform } from "./timeline.js";

/**
 * A nested clip that a flattened clip plays inside (ADR 0018 decision 9), as `flattenTimeline` records it: what of
 * it composes with the clip at each time. Plain data, so it survives JSON and `structuredClone`.
 */
export interface NestHost {
  /** Id of the nested clip, as flattened (`<outer>/<inner>` deeper down). */
  id: string;
  /** Timeline seconds of its window: where it starts, and just after its last frame. */
  start: number;
  end: number;
  /** Second of its own clock (nested-timeline seconds, what its `in` counts) at `start`. */
  in: number;
  /** Its transform; only on clips with a picture. */
  transform?: Transform;
  /** Its keys on its own clock: picture keys only on clips with a picture. */
  keys?: ClipKeys;
  /** Its `audio.gain`, dB. */
  gain?: number;
  /** Seconds of its fade from black after `start` (whole frames); absent for none. */
  fadeIn?: number;
  /** Seconds of its fade to black before `end`; absent for none. */
  fadeOut?: number;
}

/** What flattening records on a clip of a nested timeline (`flattenTimeline`); absent on clips that need none. */
export interface Nesting {
  /** Nested clips it plays inside whose transform, keys, gain or fades compose with its own, outermost first. */
  hosts: NestHost[];
  /** Most timeline seconds it can play before its start: the nested timeline's seconds before the window it starts. */
  before?: number;
  /** Most timeline seconds it can play after its end: the nested timeline's seconds after the window it ends. */
  after?: number;
}

/** The {@link Nesting} flattening recorded on `clip`; undefined on clips that are not flattened or need none. */
export function nestingOf(clip: Clip): Nesting | undefined {
  return (clip as { nesting?: Nesting }).nesting;
}

/** What the schema layer cannot know: the project frame rate and the length of each clip's material. */
export interface TransitionContext {
  /** Project frames per second; effective lengths are whole frames. */
  fps: number;
  /**
   * Seconds of material a clip draws from: the asset's duration (`Infinity` for a still image) or, for a nested
   * timeline clip, the nested timeline's duration. Absent or `undefined`: unknown, so no handle after `out`.
   * Adapter clips never need it: their first and last frame are held.
   */
  sourceDuration?: (clip: Clip) => number | undefined;
}

/** Timeline seconds a clip can play past each of its edges. */
export interface ClipHandles {
  /** Before its `in`. */
  before: number;
  /** After its `out`. */
  after: number;
}

/** How a clip's `dissolve` plays. */
export type DissolveMode = "dissolve" | "dip" | "fade-in";

/** What plays at the edges of one clip. All lengths are timeline seconds, whole frames, 0 = none. */
export interface ClipEdges {
  /** Seconds of black (transparent, silence) ramp from the clip's start. Includes the incoming half of a dip and a dissolve with nothing butted. */
  fadeIn: number;
  /** Seconds of ramp to black ending at the clip's end. Includes the outgoing half of a dip into this clip's successor. */
  fadeOut: number;
  /**
   * Each half of this clip's dissolve from the clip butted before it: the outgoing clip plays this long past the cut,
   * this clip starts this long before it. 0 when the dissolve plays as a dip or a fade in, or the clip has none.
   */
  dissolve: number;
  /** How this clip's `dissolve` plays; null without one. */
  mode: DissolveMode | null;
  /** Total seconds the `dissolve` plays over (`2 * dissolve` for a dissolve, the dip's two halves, the fade in); 0 without one. */
  dissolveLength: number;
}

/** Slack for "ends where the next starts": stored times carry 3 decimals. */
const BUTT_EPSILON = 0.001;

const GRID_EPSILON = 1e-6;

/** Seconds a clip plays on the timeline; `Infinity` when its length depends on material the context cannot size. */
export function clipLength(clip: Clip, context: TransitionContext): number {
  if ("asset" in clip) return (clip.out - clip.in) / (clip.speed ?? 1);
  if (clip.duration !== undefined) return clip.duration;
  if (clip.type === "timeline") {
    const total = context.sourceDuration?.(clip);
    if (total !== undefined && Number.isFinite(total)) return Math.max(0, total - (clip.in ?? 0));
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Seconds `clip` can play past each edge. Media: the source before `in` and after `out`, divided by `speed`; still
 * images and adapter clips (first or last rendered frame held): unlimited; nested timelines: their own seconds
 * outside the window. A flattened clip on a window edge of its nested clip gets no more than the nested timeline's
 * seconds outside that edge (`nestingOf`).
 */
export function clipHandles(clip: Clip, context: TransitionContext): ClipHandles {
  const own = ownHandles(clip, context);
  const nesting = nestingOf(clip);
  if (nesting?.before === undefined && nesting?.after === undefined) return own;
  return { before: Math.min(own.before, nesting.before ?? Infinity), after: Math.min(own.after, nesting.after ?? Infinity) };
}

function ownHandles(clip: Clip, context: TransitionContext): ClipHandles {
  const unlimited = { before: Number.POSITIVE_INFINITY, after: Number.POSITIVE_INFINITY };
  if ("asset" in clip) {
    const speed = clip.speed ?? 1;
    const total = context.sourceDuration?.(clip);
    if (total === Number.POSITIVE_INFINITY) return unlimited;
    return { before: clip.in / speed, after: total === undefined ? 0 : Math.max(0, total - clip.out) / speed };
  }
  if (clip.type !== "timeline") return unlimited;
  const from = clip.in ?? 0;
  const total = context.sourceDuration?.(clip);
  const played = clip.duration ?? (total !== undefined && Number.isFinite(total) ? total - from : 0);
  return { before: from, after: total === undefined ? 0 : Math.max(0, total - from - played) };
}

/**
 * Effective edge transitions of the clips of one track, by clip id. `clips` are the track's clips in any order.
 * Each half of a dissolve is cut to the handle both clips have and to half of each clip, in whole frames; with no
 * such room it plays as a dip through black, and a dissolve with no clip ending where it starts as a fade in.
 */
export function edgeTransitions(clips: readonly Clip[], context: TransitionContext): Map<string, ClipEdges> {
  const frame = 1 / context.fps;
  const quantize = (seconds: number) => Math.round(seconds * context.fps) * frame;
  const floorFrames = (seconds: number) => (Number.isFinite(seconds) ? Math.floor(seconds * context.fps + GRID_EPSILON) * frame : seconds);
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const lengths = sorted.map((clip) => clipLength(clip, context));
  const edges = sorted.map<ClipEdges>(() => ({ fadeIn: 0, fadeOut: 0, dissolve: 0, mode: null, dissolveLength: 0 }));
  const raise = (index: number, key: "fadeIn" | "fadeOut", seconds: number) => {
    edges[index]![key] = Math.max(edges[index]![key], seconds);
  };

  sorted.forEach((clip, i) => {
    const room = floorFrames(lengths[i]! / 2);
    if (clip.fadeIn !== undefined) raise(i, "fadeIn", Math.min(quantize(clip.fadeIn), room));
    if (clip.fadeOut !== undefined) raise(i, "fadeOut", Math.min(quantize(clip.fadeOut), room));
    if (clip.dissolve === undefined) return;

    const previous = sorted[i - 1];
    const butted = previous !== undefined && Math.abs(previous.start + lengths[i - 1]! - clip.start) <= BUTT_EPSILON;
    const requested = quantize(clip.dissolve / 2);
    const own = edges[i]!;
    if (!butted) {
      const length = Math.min(quantize(clip.dissolve), room);
      raise(i, "fadeIn", length);
      own.mode = "fade-in";
      own.dissolveLength = length;
      return;
    }
    const half = Math.min(
      requested,
      floorFrames(clipHandles(previous, context).after),
      floorFrames(clipHandles(clip, context).before),
      floorFrames(lengths[i - 1]! / 2),
      room,
    );
    if (half > 0) {
      own.mode = "dissolve";
      own.dissolve = half;
      own.dissolveLength = half * 2;
      return;
    }
    const out = Math.min(requested, floorFrames(lengths[i - 1]! / 2));
    raise(i - 1, "fadeOut", out);
    raise(i, "fadeIn", Math.min(requested, room));
    own.mode = "dip";
    own.dissolveLength = out + Math.min(requested, room);
  });

  return new Map(sorted.map((clip, i) => [clip.id, edges[i]!]));
}

/** What a nested clip's own edges give every clip it plays (ADR 0018 decision 9). Timeline seconds, whole frames. */
export interface NestedFades {
  /** Its `fadeIn`, effective: at most half the nested clip. */
  fadeIn: number;
  /** Its `fadeOut`, effective. */
  fadeOut: number;
  /**
   * The fade in its extra layers and sound ride for its `dissolve`, which plays as a dissolve on its own track only:
   * the half after the cut when a clip ends where it starts, else the whole length (it plays as a fade in).
   */
  dissolveIn: number;
}

/**
 * {@link NestedFades} of nested clip `clip` among the clips of its track, from the requested lengths: whole frames,
 * each at most half the clip, as {@link edgeTransitions} cuts them. `context.sourceDuration` must give the length of
 * nested timelines without a `duration`.
 */
export function nestedFades(clip: Clip, track: readonly Clip[], context: TransitionContext): NestedFades {
  const frame = 1 / context.fps;
  const quantize = (seconds: number) => Math.round(seconds * context.fps) * frame;
  const length = clipLength(clip, context);
  const room = Number.isFinite(length) ? Math.floor((length / 2) * context.fps + GRID_EPSILON) * frame : length;
  const fade = (seconds: number | undefined) => (seconds === undefined ? 0 : Math.min(quantize(seconds), room));
  let dissolveIn = 0;
  if (clip.dissolve !== undefined) {
    const sorted = [...track].sort((a, b) => a.start - b.start);
    const previous = sorted[sorted.indexOf(clip) - 1];
    const butted = previous !== undefined && Math.abs(previous.start + clipLength(previous, context) - clip.start) <= BUTT_EPSILON;
    dissolveIn = fade(butted ? clip.dissolve / 2 : clip.dissolve);
  }
  return { fadeIn: fade(clip.fadeIn), fadeOut: fade(clip.fadeOut), dissolveIn };
}
