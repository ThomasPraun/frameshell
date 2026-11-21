// Pointer zoom (`clip.zoom`, ADR 0048): push in where the pointer of a screen recording rests, ease back out when it
// moves on. Pure: samples in, keys out; the layer model is `layerRect` in @frameshell/schema.
import type { KeyEase, PointerSample } from "@frameshell/schema";

/** Tuning of the pointer zoom. Times in seconds, distances in units of the picture's height. */
export const ZOOM = Object.freeze({
  /** Default zoom factor over the clip's own scale. */
  scale: 1.8,
  /** The pointer counts as resting while it stays this close to where the rest began. */
  restRadius: 0.05,
  /** Shortest rest that earns a zoom: shorter stops are passing moves. */
  minRest: 0.8,
  /** The push in starts this long before the rest, so the zoom arrives as the pointer does. */
  lead: 0.3,
  /** The zoom holds this long after the pointer leaves. */
  tail: 0.4,
  /** Seconds of the push in and of the ease back out. */
  ramp: 0.5,
  /** Two zooms closer than this stay in: the picture glides from one spot to the next. */
  mergeGap: 1.2,
  /** Seconds of a glide between two spots of one zoom. */
  glide: 0.5,
  /** Shortest time a zoom holds fully in; a shorter one (at a clip edge) is dropped. */
  minHold: 0.4,
  /** A gap in the samples longer than this ends a rest (the pointer left the screen, or sampling stopped). */
  maxGap: 0.25,
});

/** A spot the pointer rested on: source seconds and the mean position, fractions of the picture. */
export interface PointerRest {
  from: number;
  to: number;
  x: number;
  y: number;
}

/**
 * The rests of `samples` within source seconds `from` to `to`: runs of at least {@link ZOOM.minRest} where the pointer
 * stays within {@link ZOOM.restRadius} of the run's first sample. `aspect` is the picture's width over its height, so
 * the radius is round on the picture. Samples off the picture break a run.
 */
export function pointerRests(samples: readonly PointerSample[], range: { from: number; to: number }, aspect: number, tuning = ZOOM): PointerRest[] {
  const inside = samples.filter(([t, x, y]) => t >= range.from && t <= range.to && x >= 0 && x <= 1 && y >= 0 && y <= 1);
  const rests: PointerRest[] = [];
  let run: PointerSample[] = [];
  const close = () => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first && last && last[0] - first[0] >= tuning.minRest) {
      const mean = (index: 1 | 2) => run.reduce((sum, sample) => sum + sample[index], 0) / run.length;
      rests.push({ from: first[0], to: last[0], x: mean(1), y: mean(2) });
    }
    run = [];
  };
  for (const sample of inside) {
    const anchor = run[0];
    const previous = run[run.length - 1];
    const near = anchor && Math.hypot((sample[1] - anchor[1]) * aspect, sample[2] - anchor[2]) <= tuning.restRadius;
    if (!anchor || (near && previous && sample[0] - previous[0] <= tuning.maxGap)) {
      run.push(sample);
      continue;
    }
    close();
    run = [sample];
  }
  close();
  return rests;
}

/** Fitted picture and project frame, in pixels: the picture as it plays (rotation applied) and `frameshell.json` resolution. */
export interface ZoomGeometry {
  source: { width: number; height: number };
  project: { width: number; height: number };
}

/** A placement of the clip: `scale` over the fitted size, `x` and `y` offsets in project pixels. */
export interface ZoomPlacement {
  scale: number;
  x: number;
  y: number;
}

/**
 * Placement that zooms the fitted picture by `scale` and brings the point `at` (fractions of the picture) as close
 * to the frame's center as it can go without the frame showing past the picture's edge.
 */
export function zoomPlacement(geometry: ZoomGeometry, scale: number, at: { x: number; y: number }): ZoomPlacement {
  const frame = geometry.project.width / geometry.project.height;
  const ratio = geometry.source.width / geometry.source.height;
  const fit = Math.min(frame / ratio, 1);
  const w = ratio * fit * scale;
  const h = fit * scale;
  const limitX = Math.max(0, (w - frame) / 2);
  const limitY = Math.max(0, (h - 1) / 2);
  const offsetX = clamp(w * (0.5 - at.x), limitX);
  const offsetY = clamp(h * (0.5 - at.y), limitY);
  return { scale: round4(scale), x: round4((offsetX / frame) * geometry.project.width), y: round4(offsetY * geometry.project.height) };
}

/** One key of a pointer zoom, on the timeline clock: the three properties move together. */
export interface ZoomKey extends ZoomPlacement {
  /** Timeline seconds. */
  time: number;
  /** How the values move from this key to the next; absent: they hold (the next key is the same). */
  ease?: KeyEase;
}

/** What {@link planZoom} plans. */
export interface ZoomPlan {
  keys: ZoomKey[];
  /** Zooms written: each pushes in once and eases back out once, gliding across the rests it merged. */
  zooms: number;
  /** Rests the pointer made; some merge into one zoom, some at a clip edge are too short to zoom. */
  rests: number;
}

/** Where a zoom runs: the clip's stretch on the timeline and how source seconds map onto it. */
export interface ZoomSpan {
  /** Source seconds of the clip (`in`, `out`). */
  from: number;
  to: number;
  toTimeline: (source: number) => number;
}

/**
 * Keys of `scale`, `x` and `y` that push in on each rest of the pointer and ease back to `base` (the clip's own
 * placement) when it moves on. Rests closer than {@link ZOOM.mergeGap} stay in one zoom that glides between them.
 * Every key that starts a move eases in and out; the rest hold. No rest: no keys.
 */
export function planZoom(
  geometry: ZoomGeometry,
  samples: readonly PointerSample[],
  span: ZoomSpan,
  options: { scale: number; base: ZoomPlacement },
  tuning = ZOOM,
): ZoomPlan {
  const rests = pointerRests(samples, span, geometry.source.width / geometry.source.height, tuning);
  const groups: PointerRest[][] = [];
  for (const rest of rests) {
    const group = groups[groups.length - 1];
    const last = group?.[group.length - 1];
    if (group && last && rest.from - tuning.lead - (last.to + tuning.tail) < tuning.mergeGap) group.push(rest);
    else groups.push([rest]);
  }
  const at = (source: number) => Math.round(span.toTimeline(source) * 1000) / 1000;
  const base = { scale: round4(options.base.scale), x: round4(options.base.x), y: round4(options.base.y) };
  const keys: ZoomKey[] = [];
  let zooms = 0;
  for (const group of groups) {
    const start = Math.max(span.from, group[0]!.from - tuning.lead - tuning.ramp);
    const end = Math.min(span.to, group[group.length - 1]!.to + tuning.tail + tuning.ramp);
    if (end - start < 2 * tuning.ramp + tuning.minHold) continue;
    const placed = group.map((rest) => zoomPlacement(geometry, options.scale * base.scale, rest));
    const local: { source: number; placement: ZoomPlacement }[] = [{ source: start, placement: base }, { source: start + tuning.ramp, placement: placed[0]! }];
    for (let i = 1; i < group.length; i++) {
      // Glide to the next spot so it arrives as the pointer settles there.
      const arrive = Math.max(local[local.length - 1]!.source + tuning.glide, group[i]!.from);
      if (arrive > end - tuning.ramp) break;
      local.push({ source: arrive - tuning.glide, placement: placed[i - 1]! }, { source: arrive, placement: placed[i]! });
    }
    const last = local[local.length - 1]!;
    if (end - tuning.ramp > last.source) local.push({ source: end - tuning.ramp, placement: last.placement });
    local.push({ source: end, placement: base });
    // Keys in one frame's millisecond collapse to the later one.
    for (const { source, placement } of local) {
      const time = at(source);
      if (keys.length > 0 && keys[keys.length - 1]!.time >= time) keys.pop();
      keys.push({ time, ...placement });
    }
    zooms++;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const next = keys[i + 1];
    if (next && (next.scale !== key.scale || next.x !== key.x || next.y !== key.y)) key.ease = "in-out";
  }
  return { keys, zooms, rests: rests.length };
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
