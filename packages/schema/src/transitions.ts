// What a clip's `dissolve`, `fadeIn` and `fadeOut` play as (ADR 0018 decisions 2 to 5), and the geometry of a shaped
// dissolve (ADR 0030). The file stores the requested lengths; export, preview and engine warnings all read the
// effective ones from here.
import { DEFAULT_GRID_COLUMNS, DEFAULT_SLATS, type Clip, type ClipKeys, type Transform, type TransitionDirection, type TransitionShape } from "./timeline.js";

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
  /**
   * The shaped dissolve it comes in by (ADR 0030), on clips of its extra video tracks: their picture follows `shapeAt`
   * over `half` seconds each side of `start` instead of fading in by the dissolve. `fadeIn` here is the picture's
   * fade in (its own `fadeIn`, effective); the host's `fadeIn` above still includes the dissolve for sound.
   */
  shapeIn?: { shape: TransitionShape; half: number; fadeIn: number };
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
 * A shaped dissolve ({@link playedShape}) is cut by the clips only: past a handle its edge frame holds.
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
    // A shaped dissolve never dips: where a handle runs out, its edge frame holds (ADR 0030 decision 3).
    const handles = playedShape(clip)
      ? Number.POSITIVE_INFINITY
      : Math.min(floorFrames(clipHandles(previous, context).after), floorFrames(clipHandles(clip, context).before));
    const half = Math.min(requested, handles, floorFrames(lengths[i - 1]! / 2), room);
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
  /**
   * Its dissolve's shape when the dissolve plays as one (a clip ends where it starts, {@link playedShape}): its extra
   * video tracks follow `shapeAt` over `half` (= `dissolveIn`) seconds each side of its start instead of fading in.
   */
  shapeIn?: { shape: TransitionShape; half: number };
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
  let shapeIn: NestedFades["shapeIn"];
  if (clip.dissolve !== undefined) {
    const sorted = [...track].sort((a, b) => a.start - b.start);
    const previous = sorted[sorted.indexOf(clip) - 1];
    const butted = previous !== undefined && Math.abs(previous.start + clipLength(previous, context) - clip.start) <= BUTT_EPSILON;
    dissolveIn = fade(butted ? clip.dissolve / 2 : clip.dissolve);
    const shape = playedShape(clip);
    if (shape && butted && dissolveIn > 0) shapeIn = { shape, half: dissolveIn };
  }
  return { fadeIn: fade(clip.fadeIn), fadeOut: fade(clip.fadeOut), dissolveIn, ...(shapeIn ? { shapeIn } : {}) };
}

/**
 * The shape `clip`'s dissolve plays as (ADR 0030), on any video track. On a nested clip flattening carries it to the
 * clip starting its window on its own track and, through {@link NestHost.shapeIn}, to its extra video tracks.
 */
export function playedShape(clip: Clip): TransitionShape | undefined {
  return clip.shape;
}

/** A shaped dissolve a nested clip comes in by, as one of its clips plays it (ADR 0030): `half` seconds each side of `at`. */
export interface HostShape {
  shape: TransitionShape;
  /** Timeline second of the cut: the nested clip's start. */
  at: number;
  half: number;
}

/** Shaped dissolves of the hosts of `clip` ({@link NestHost.shapeIn}), outermost first. */
export function hostShapes(clip: Clip): HostShape[] {
  return (nestingOf(clip)?.hosts ?? []).flatMap((host) => (host.shapeIn ? [{ shape: host.shapeIn.shape, at: host.start, half: host.shapeIn.half }] : []));
}

/** Rectangle in fractions of the frame being rendered: left, top, right, bottom (0 to 1). */
export type FrameRect = readonly [x0: number, y0: number, x1: number, y1: number];

/**
 * A circle of a shaped dissolve (ADR 0030): a circle in pixels whatever the frame's aspect. `cx`, `cy`: its centre in
 * fractions of the frame; `r`: its radius as a fraction (0 to 1) of {@link circleReach}, so at 1 it covers the frame.
 */
export interface FrameCircle {
  cx: number;
  cy: number;
  r: number;
}

/**
 * Blinds of a `slats` shape (ADR 0030): the frame is `count` equal strips across `axis`, and each shows the picture in
 * the share `r` (0 to 1) of itself, counted from its own `from` edge.
 */
export interface FrameSlats {
  count: number;
  axis: "x" | "y";
  from: "start" | "end";
  r: number;
}

/**
 * Cells of a `grid` shape (ADR 0030): `count` columns of square cells; a cell shows the picture once `r` (0 to 1)
 * passes its {@link gridRank}.
 */
export interface FrameGrid {
  count: number;
  r: number;
}

/**
 * A zoom's change of scale (ADR 0030), as a map of the frame: a point at `[u, v]` (fractions of the frame) lands at
 * `[s * u + tx, s * v + ty]`, so `s` is the scale and the point it stays on is `[tx / (1 - s), ty / (1 - s)]`.
 */
export interface FrameZoom {
  s: number;
  tx: number;
  ty: number;
}

/** Where one picture of a shaped dissolve draws (ADR 0030): moved, then cut to `clip`, `circle`, `slats` or `grid`. */
export interface ShapePart {
  /** Horizontal offset from its own placement, fraction of the frame width (positive: right). */
  dx: number;
  /** Vertical offset from its own placement, fraction of the frame height (positive: down). */
  dy: number;
  /** The part of the frame it shows in; null: wherever it lands. */
  clip: FrameRect | null;
  /** An iris's circle it shows inside; absent: no circle cuts it. */
  circle?: FrameCircle;
  /** A `slats` shape's strips it shows in; absent: no strips cut it. */
  slats?: FrameSlats;
  /** A `grid` shape's cells it shows in; absent: no cells cut it. */
  grid?: FrameGrid;
  /** A zoom's scale about its point, applied to the picture as placed (after `dx` and `dy`, which a zoom leaves at 0). */
  zoom?: FrameZoom;
}

/** Both pictures of a shaped dissolve at one moment. Their opacity is their own: a shape replaces the mix. */
export interface ShapeFrame {
  /** The clip that carries the shaped `dissolve`. */
  incoming: ShapePart;
  /** The clip that ends where the incoming one starts. */
  outgoing: ShapePart;
}

/** Unit step of each direction in frame fractions: the way the incoming picture travels. */
const DIRECTION_STEPS: Record<TransitionDirection, readonly [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Unit step `[x, y]` of `shape`'s direction in frame fractions (y down): the way the incoming picture travels. */
export function shapeStep(shape: TransitionShape): readonly [number, number] {
  return DIRECTION_STEPS[shape.direction ?? "left"];
}

/** Centre `[x, y]` in frame fractions an iris opens from: the centre of its `origin`, the frame's centre without one. */
export function irisCentre(shape: TransitionShape): readonly [number, number] {
  const [x0, y0, x1, y1] = shape.origin ?? [0, 0, 1, 1];
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** Pixels from a circle's centre (`cx`, `cy`, frame fractions) to the farthest corner of a `width` x `height` frame. */
export function circleReach(circle: Pick<FrameCircle, "cx" | "cy">, width: number, height: number): number {
  return Math.hypot(Math.max(circle.cx, 1 - circle.cx) * width, Math.max(circle.cy, 1 - circle.cy) * height);
}

/** How far a shape has moved at dissolve progress `f` (`dissolveProgress`): `f` eased in and out, f²(3−2f). */
export function shapeProgress(f: number): number {
  const w = Math.min(1, Math.max(0, f));
  return w * w * (3 - 2 * w);
}

/** Most a zoom magnifies the outgoing picture: a larger one would make the layer too big to render. */
export const ZOOM_MAX = 4;

/** The rectangle a zoom dives into when `origin` is not given: the middle half of the frame. */
export const DEFAULT_ZOOM_ORIGIN: FrameRect = [0.25, 0.25, 0.75, 0.75];

/** The rectangle `shape` (an iris or a zoom) works from: its `origin`; none: the frame for an iris, the middle half for a zoom. */
export function shapeOrigin(shape: TransitionShape): FrameRect {
  return shape.origin ?? (shape.kind === "zoom" ? DEFAULT_ZOOM_ORIGIN : [0, 0, 1, 1]);
}

/** How much a zoom magnifies the outgoing picture by its end: its `origin`'s larger side fills the frame, 1 to {@link ZOOM_MAX}. */
export function zoomFactor(shape: TransitionShape): number {
  const [x0, y0, x1, y1] = shapeOrigin(shape);
  return Math.min(ZOOM_MAX, Math.max(1, 1 / Math.max(x1 - x0, y1 - y0)));
}

/** Slats of a `slats` shape: its `count` or {@link DEFAULT_SLATS}. */
export function slatCount(shape: TransitionShape): number {
  return shape.count ?? DEFAULT_SLATS;
}

/** Columns of a `grid` shape: its `count` or {@link DEFAULT_GRID_COLUMNS}. */
export function gridColumns(shape: TransitionShape): number {
  return shape.count ?? DEFAULT_GRID_COLUMNS;
}

/** Rows of cells a grid of `columns` has in a `width` x `height` frame: as many as keep its cells about square. */
export function gridRows(columns: number, width: number, height: number): number {
  return Math.max(1, Math.round((columns * height) / width));
}

/** Number of distinct {@link gridRank}s; a cell shows once `r * GRID_RANKS` passes its rank. */
export const GRID_RANKS = 257;

/**
 * When cell (`column`, `row`) of a grid shows: a whole number 0 to {@link GRID_RANKS} - 1 in a fixed scattered order,
 * made of whole-number steps only so ffmpeg's `mod` and this agree to the bit.
 */
export function gridRank(column: number, row: number): number {
  const a = (column * 131 + row * 517) % 251;
  return (a * a + column * row * 89 + column * 7 + row * 3) % GRID_RANKS;
}

/** A zoom about `[px, py]` (frame fractions) by `s`: that point stays where it is. */
function zoomAbout([px, py]: readonly [number, number], s: number): FrameZoom {
  return { s, tx: px * (1 - s) + 0, ty: py * (1 - s) + 0 };
}

/** Strips of `slats` in frame fractions, the part of each that shows the picture. */
export function slatRects(slats: FrameSlats): FrameRect[] {
  const { count, axis, from, r } = slats;
  return Array.from({ length: count }, (_, i): FrameRect => {
    const a = i / count;
    const b = (i + 1) / count;
    const [lo, hi] = from === "start" ? [a, a + r / count] : [b - r / count, b];
    return axis === "x" ? [lo, 0, hi, 1] : [0, lo, 1, hi];
  });
}

/**
 * Geometry of `shape` at dissolve progress `f` (0 to 1, `dissolveProgress`), the one truth export and preview draw
 * (ADR 0030). `push`: both pictures travel one frame in the direction, the outgoing one out, the incoming one in.
 * `wipe`: the incoming picture shows in the strip of the frame its edge has crossed, over the outgoing one.
 * `iris`: the incoming picture shows in a circle that grows from {@link irisCentre} until it covers the frame.
 * `zoom`: both pictures scale about the centre of {@link shapeOrigin}: the outgoing one up to {@link zoomFactor}, the
 * incoming one from nothing to its size, over it. `slats`: the wipe, in each of {@link slatCount} strips at once.
 * `grid`: the incoming picture shows in the cells whose {@link gridRank} the progress has passed.
 */
export function shapeAt(shape: TransitionShape, f: number): ShapeFrame {
  const p = shapeProgress(f);
  const still: ShapePart = { dx: 0, dy: 0, clip: null };
  if (shape.kind === "iris") {
    const [cx, cy] = irisCentre(shape);
    return { outgoing: still, incoming: { ...still, circle: { cx, cy, r: p } } };
  }
  if (shape.kind === "zoom") {
    const [x0, y0, x1, y1] = shapeOrigin(shape);
    const pivot = [(x0 + x1) / 2, (y0 + y1) / 2] as const;
    return { outgoing: { ...still, zoom: zoomAbout(pivot, 1 + (zoomFactor(shape) - 1) * p) }, incoming: { ...still, zoom: zoomAbout(pivot, p) } };
  }
  if (shape.kind === "grid") return { outgoing: still, incoming: { ...still, grid: { count: gridColumns(shape), r: p } } };
  const [ux, uy] = shapeStep(shape);
  if (shape.kind === "slats") {
    return { outgoing: still, incoming: { ...still, slats: { count: slatCount(shape), axis: ux !== 0 ? "x" : "y", from: ux < 0 || uy < 0 ? "end" : "start", r: p } } };
  }
  // `+ 0` turns -0 into 0, so frames compare and print alike.
  if (shape.kind === "push") {
    return {
      outgoing: { dx: ux * p + 0, dy: uy * p + 0, clip: null },
      incoming: { dx: ux * (p - 1) + 0, dy: uy * (p - 1) + 0, clip: null },
    };
  }
  const clip: FrameRect = ux < 0 ? [1 - p, 0, 1, 1] : ux > 0 ? [0, 0, p, 1] : uy < 0 ? [0, 1 - p, 1, 1] : [0, 0, 1, p];
  return { outgoing: still, incoming: { ...still, clip } };
}

/** How much a dip cut darkens the outgoing picture over black (ADR 0030 decision 5, #483: "darken ~40 %"). */
export const DIP_DEPTH = 0.4;

/** Frames a dip cut darkens before the cut (#483: "for 3 frames"). */
export const DIP_FRAMES = 3;

/**
 * Indexes in `lane` (a clip's `opacity` keys, sorted, on its own clock) of the two keys a dip cut wrote (ADR 0030
 * decision 5): one at `from`, the clip-clock second of its first darkened frame, then one at `last`, its last frame,
 * {@link DIP_DEPTH} lower (4 decimals, as written). Keys within `half` a frame count as on it. Null when it has none.
 */
export function dipKeyIndexes(lane: readonly { at: number; value: number }[], from: number, last: number, half: number): [number, number] | null {
  const near = (key: { at: number } | undefined, at: number) => key !== undefined && Math.abs(key.at - at) < half;
  const end = lane.findIndex((key) => near(key, last));
  const start = end - 1;
  if (end < 1 || !near(lane[start], from)) return null;
  const darker = Math.round(lane[start]!.value * (1 - DIP_DEPTH) * 10000) / 10000;
  return Math.abs(lane[end]!.value - darker) < 1e-4 ? [start, end] : null;
}
