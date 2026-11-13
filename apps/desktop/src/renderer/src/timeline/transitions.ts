// Transition marks, key diamonds and edge hit testing for the timeline panel (ADR 0018 decision 12): pure, DOM-free.
import type { Clip, KeyEase, TransitionShape } from "@frameshell/schema";
import { DIP_FRAMES, type TransitionContext, dipKeyIndexes, edgeTransitions, playedShape } from "@frameshell/schema/transitions";
import type { ClipBox, LaneViewport, TimelineLayout, TrackRow } from "./layout.js";

/** Properties a clip can keyframe; audio tracks take only `gain`. */
export const KEY_PROPS = ["x", "y", "scale", "opacity", "gain"] as const;

/** Name in {@link KEY_PROPS}. */
export type KeyProp = (typeof KEY_PROPS)[number];

/** One stored key; `at` counts on the clip's own clock (what its `in` counts). */
export interface KeyBox {
  at: number;
  value: number;
  ease: KeyEase | undefined;
}

/** What a transition looks like on a clip edge, timeline seconds. */
export interface TransitionMark {
  /**
   * A dissolve straddles the cut; a fade (also a dip's two halves, a fade in or out) stays inside its clip; a dip cut
   * (ADR 0030 decision 5) darkens its clip's last frames before a hard cut.
   */
  kind: "dissolve" | "fade" | "dip-cut";
  /** Which edge of the owning clip it belongs to. */
  side: "in" | "out";
  from: number;
  to: number;
  /** The shape a dissolve plays as (ADR 0030); absent for a mix. */
  shape?: TransitionShape;
}

/** Stored transition of one clip edge as the inspector edits it. */
export interface EdgeState {
  /** Timeline second of the edge, what `transition.set` takes as `at`. */
  at: number;
  /** `dip-cut`: the clip ending at the edge carries a dip cut's keys (ADR 0030 decision 5); its `length` is 0. */
  kind: "dissolve" | "fade" | "dip-cut" | null;
  /** Requested length in seconds as `transition.set` takes it (both halves of a dissolve or a dip); 0 without a transition. */
  length: number;
  /** Another clip on the track ends (start edge) or starts (end edge) there: a cut, where a dissolve can play. */
  butted: boolean;
  /** The dissolve's stored shape (ADR 0030); null for none. A length change keeps it. */
  shape: TransitionShape | null;
}

/** A clip edge under the pointer. */
export interface EdgeHit {
  row: TrackRow;
  /** Timeline second of the edge. */
  at: number;
  /** A transition is stored there. */
  hasTransition: boolean;
}

/** Edge grab distance, px. */
export const EDGE_GRAB_PX = 6;

/** Stored times carry 3 decimals. */
const EDGE_EPSILON = 0.0005;

/**
 * Marks of the clips of one video or audio track by clip id, at the effective lengths (handles and clip lengths cut
 * them). `dips`: the track is the bottom video track, where a clip's dip cut keys mark a dip cut (ADR 0030).
 */
export function transitionMarks(clips: readonly (Clip & { end?: number | null })[], context: TransitionContext, dips = false): Map<string, TransitionMark[]> {
  const marks = new Map<string, TransitionMark[]>();
  const edged = clips.some((clip) => clip.dissolve !== undefined || clip.fadeIn !== undefined || clip.fadeOut !== undefined);
  const edges = edged ? edgeTransitions(clips, context) : new Map<string, never>();
  for (const clip of clips) {
    const own = edges.get(clip.id);
    const found: TransitionMark[] = [];
    if (own?.mode === "dissolve") {
      const shape = playedShape(clip);
      found.push({ kind: "dissolve", side: "in", from: clip.start - own.dissolve, to: clip.start + own.dissolve, ...(shape ? { shape } : {}) });
    }
    if (own && own.fadeIn > 0) found.push({ kind: "fade", side: "in", from: clip.start, to: clip.start + own.fadeIn });
    if (own && own.fadeOut > 0 && typeof clip.end === "number") found.push({ kind: "fade", side: "out", from: clip.end - own.fadeOut, to: clip.end });
    if (dips && typeof clip.end === "number" && endsInDipCut(clip, clip.end, context.fps)) {
      found.push({ kind: "dip-cut", side: "out", from: clip.end - DIP_FRAMES / context.fps, to: clip.end });
    }
    if (found.length > 0) marks.set(clip.id, found);
  }
  return marks;
}

/**
 * True when `clip`, ending at timeline second `end`, carries the two `opacity` keys a dip cut writes on its last frames
 * (`transition.set kind: "dip-cut"`), as the engine finds them: on the frame grid, `at` rounded to the millisecond.
 */
export function endsInDipCut(clip: Clip, end: number, fps: number): boolean {
  const lane = clip.keys?.opacity;
  if (!lane) return false;
  const last = Math.round(end * fps) - 1;
  const from = Math.max(Math.round(clip.start * fps), last - DIP_FRAMES);
  if (from === last) return false;
  const speed = "asset" in clip ? (clip.speed ?? 1) : 1;
  const clipIn = "in" in clip && typeof clip.in === "number" ? clip.in : 0;
  const keyAt = (frame: number) => Math.round((clipIn + (frame / fps - clip.start) * speed) * 1000) / 1000;
  return dipKeyIndexes(lane, keyAt(from), keyAt(last), (0.5 / fps) * speed) !== null;
}

/** Keys of a clip as `timeline.show` carries them (loose JSON); entries that are not keys are dropped. */
export function keyBoxes(keys: unknown): Partial<Record<KeyProp, KeyBox[]>> {
  const found: Partial<Record<KeyProp, KeyBox[]>> = {};
  if (typeof keys !== "object" || keys === null) return found;
  for (const prop of KEY_PROPS) {
    const list = (keys as Record<string, unknown>)[prop];
    if (!Array.isArray(list)) continue;
    const boxes = list.flatMap((entry): KeyBox[] => {
      const key = entry as { at?: unknown; value?: unknown; ease?: unknown };
      if (typeof key.at !== "number" || typeof key.value !== "number") return [];
      return [{ at: key.at, value: key.value, ease: typeof key.ease === "string" ? (key.ease as KeyEase) : undefined }];
    });
    if (boxes.length > 0) found[prop] = boxes;
  }
  return found;
}

type Timed = Pick<ClipBox, "start" | "in" | "speed">;

/** Timeline second of clip-clock second `at`; inverse of {@link clipClock}. */
export function keyTimelineTime(clip: Timed, at: number): number {
  return clip.start + (at - clip.in) / clip.speed;
}

/** Clip-clock second playing at timeline second `t`; twin of `clipTime` in `@frameshell/schema/composite`. */
export function clipClock(clip: Timed, t: number): number {
  return clip.in + (t - clip.start) * clip.speed;
}

/** Timeline seconds of a clip's keys inside the clip, ascending, one per distinct time across properties. */
export function keyTimes(clip: ClipBox): number[] {
  const times: number[] = [];
  for (const list of Object.values(clip.keys)) {
    for (const key of list) {
      const time = keyTimelineTime(clip, key.at);
      if (time >= clip.start - EDGE_EPSILON && time <= clip.end + EDGE_EPSILON) times.push(time);
    }
  }
  times.sort((a, b) => a - b);
  return times.filter((time, index) => index === 0 || time - times[index - 1]! > EDGE_EPSILON);
}

/** The key of `keys` at timeline second `t` (within half a frame), or null. */
export function keyAt(clip: Timed, keys: readonly KeyBox[] | undefined, t: number, fps: number): KeyBox | null {
  const half = (0.5 / fps) * clip.speed;
  const at = clipClock(clip, t);
  return keys?.find((key) => Math.abs(key.at - at) < half) ?? null;
}

const near = (a: number, b: number) => Math.abs(a - b) < EDGE_EPSILON;

/**
 * The stored transition of one edge of `clip` on `row`: its start edge reads `dissolve` (a dissolve is the incoming
 * clip's) or `fadeIn`; its end edge reads the next butted clip's `dissolve` or its own `fadeOut`. A fade where clips
 * butt is two halves (`transition.set` splits it in whole frames), so its length is their sum.
 */
export function edgeState(row: TrackRow, clip: ClipBox, side: "in" | "out"): EdgeState {
  const dipped = (box: ClipBox | undefined) => box?.marks.some((mark) => mark.kind === "dip-cut") === true;
  if (side === "in") {
    const previous = row.clips.find((other) => other.id !== clip.id && !other.problem && near(other.end, clip.start));
    const butted = previous !== undefined;
    if (clip.dissolve !== null) return { at: clip.start, kind: "dissolve", length: clip.dissolve, butted, shape: clip.shape };
    if (clip.fadeIn !== null) return { at: clip.start, kind: "fade", length: clip.fadeIn + (previous?.fadeOut ?? 0), butted, shape: null };
    if (dipped(previous) && previous!.fadeOut === null) return { at: clip.start, kind: "dip-cut", length: 0, butted, shape: null };
    return { at: clip.start, kind: null, length: 0, butted, shape: null };
  }
  const next = row.clips.find((other) => other.id !== clip.id && near(other.start, clip.end));
  const butted = next !== undefined;
  if (next?.dissolve != null) return { at: clip.end, kind: "dissolve", length: next.dissolve, butted, shape: next.shape };
  if (clip.fadeOut !== null) return { at: clip.end, kind: "fade", length: clip.fadeOut + (next?.fadeIn ?? 0), butted, shape: null };
  if (dipped(clip) && next?.fadeIn == null) return { at: clip.end, kind: "dip-cut", length: 0, butted, shape: null };
  return { at: clip.end, kind: null, length: 0, butted, shape: null };
}

/**
 * The clip edge of a video or audio lane near a point of the canvas (`x` from the lanes' left edge, `y` from the top,
 * ruler included), within {@link EDGE_GRAB_PX}; null elsewhere. Clips of unknown length have no end edge.
 */
export function edgeAt(layout: TimelineLayout, viewport: LaneViewport, x: number, y: number): EdgeHit | null {
  if (y < layout.head) return null;
  const contentY = y + viewport.scrollTop;
  const row = layout.rows.find((candidate) => contentY >= candidate.top && contentY < candidate.top + candidate.height);
  if (!row || (row.kind !== "video" && row.kind !== "audio")) return null;
  const time = (x + viewport.scrollLeft) / viewport.pxPerSecond;
  const reach = EDGE_GRAB_PX / viewport.pxPerSecond;
  let best: number | null = null;
  for (const clip of row.clips) {
    const edges = clip.problem ? [clip.start] : [clip.start, clip.end];
    for (const edge of edges) {
      if (Math.abs(edge - time) <= reach && (best === null || Math.abs(edge - time) < Math.abs(best - time))) best = edge;
    }
  }
  if (best === null) return null;
  const at = Math.round(best * 1000) / 1000;
  const hasTransition = row.clips.some(
    (clip) => (near(clip.start, at) && (clip.dissolve !== null || clip.fadeIn !== null)) || (!clip.problem && near(clip.end, at) && clip.fadeOut !== null),
  );
  return { row, at, hasTransition };
}
