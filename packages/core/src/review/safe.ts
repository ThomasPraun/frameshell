import type { ReviewSafeFlag, ZoneEdge } from "@frameshell/protocol";
import { type ResolvedSubtitleTrack, type SafeZone, type Size, type SubtitleCue, type SubtitleStyle, cueTokens, subtitleLayout } from "@frameshell/schema";
import type { FontMetrics } from "../export/font-metrics.js";

// Where a platform's UI covers the picture and which captions reach into it. Pure: the `safe` sheet of `review`.
// The zones are the numbers of `@frameshell/schema` `safe-zones.ts`, never copied here.

/** Pixels each edge's zone covers. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A rectangle in frame pixels, `x0 < x1` and `y0 < y1`. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Part of an em that glyphs with a descender (g j p q y, comma) reach below the baseline. */
const DESCENT_EM = 0.2;
/** Characters of the bundled face that hang below the baseline. */
const DESCENDERS = /[gjpqyQ,;]/;

/** The edges of `zone` in pixels of a `frame`-sized picture: the platform's reference numbers scaled per axis, rounded. */
export function filmInsets(zone: Pick<SafeZone, "width" | "height" | "top" | "right" | "bottom" | "left">, frame: Size): Insets {
  const x = frame.width / zone.width;
  const y = frame.height / zone.height;
  return { top: Math.round(zone.top * y), right: Math.round(zone.right * x), bottom: Math.round(zone.bottom * y), left: Math.round(zone.left * x) };
}

/** Whether the platform's reference frame and a `frame` are both vertical or both not (square counts as not vertical). */
export function sameOrientation(zone: Pick<SafeZone, "width" | "height">, frame: Size): boolean {
  return zone.height > zone.width === frame.height > frame.width;
}

/** The zone of each edge as a rectangle of the frame; edges that cover nothing are left out. */
export function zoneBoxes(insets: Insets, frame: Size): { edge: ZoneEdge; box: Box }[] {
  const { width, height } = frame;
  const all: { edge: ZoneEdge; inset: number; box: Box }[] = [
    { edge: "top", inset: insets.top, box: { x0: 0, y0: 0, x1: width, y1: insets.top } },
    { edge: "right", inset: insets.right, box: { x0: width - insets.right, y0: 0, x1: width, y1: height } },
    { edge: "bottom", inset: insets.bottom, box: { x0: 0, y0: height - insets.bottom, x1: width, y1: height } },
    { edge: "left", inset: insets.left, box: { x0: 0, y0: 0, x1: insets.left, y1: height } },
  ];
  return all.filter(({ inset }) => inset > 0).map(({ edge, box }) => ({ edge, box }));
}

/**
 * The zones `box` reaches into, with how far in (pixels, measured across the zone: its height for the top and bottom,
 * its width for the left and right). A box that only touches a zone's border does not cross it.
 */
export function crossings(box: Box, insets: Insets, frame: Size): { edge: ZoneEdge; reach: number }[] {
  const found: { edge: ZoneEdge; reach: number }[] = [];
  for (const { edge, box: zone } of zoneBoxes(insets, frame)) {
    const across = Math.min(box.x1, zone.x1) - Math.max(box.x0, zone.x0);
    const down = Math.min(box.y1, zone.y1) - Math.max(box.y0, zone.y0);
    if (across <= 0 || down <= 0) continue;
    found.push({ edge, reach: Math.max(1, Math.round(edge === "top" || edge === "bottom" ? down : across)) });
  }
  return found;
}

/**
 * Where a cue's glyphs are in a `frame`-sized picture: as wide as its text in the bundled face (no wrapping, as the
 * ASS export writes it) centred on the layout's x, from the cap height above the baseline, plus the outline, to the
 * baseline, plus room for descenders when the text has any. Ignores the keyword's entry scale.
 */
export function cueBox(style: SubtitleStyle, cue: SubtitleCue, frame: Size, metrics: FontMetrics): Box {
  const layout = subtitleLayout(style, frame);
  const text = cueTokens(cue).join(" ");
  const half = (metrics.width(text) * layout.fontSize) / 2 + layout.outline;
  return {
    x0: layout.centerX - half,
    x1: layout.centerX + half,
    y0: layout.baseline - metrics.capHeight * layout.fontSize - layout.outline,
    y1: layout.baseline + layout.outline + (DESCENDERS.test(text) ? DESCENT_EM * layout.fontSize : 0),
  };
}

/** A cue of a track that reaches into a zone. */
export interface CueCrossing {
  track: string;
  /** Timeline frames `[start, end)`. */
  start: number;
  end: number;
  zones: { edge: ZoneEdge; reach: number }[];
}

/** The cues of `tracks` that reach into a zone of `insets` in a `frame`-sized picture, in track then cue order. */
export function cueCrossings(tracks: readonly ResolvedSubtitleTrack[], insets: Insets, frame: Size, metrics: FontMetrics): CueCrossing[] {
  const found: CueCrossing[] = [];
  for (const track of tracks) {
    for (const cue of track.cues) {
      const zones = crossings(cueBox(track.style, cue, frame, metrics), insets, frame);
      if (zones.length > 0) found.push({ track: track.track, start: cue.start, end: cue.end, zones });
    }
  }
  return found;
}

/** `crossings` grouped by track and zone: how many cues, when the first and last start (`fps` converts frames to seconds), the deepest reach. */
export function safeFlags(crossings: readonly CueCrossing[], fps: number): ReviewSafeFlag[] {
  const groups = new Map<string, ReviewSafeFlag>();
  for (const cue of crossings) {
    for (const { edge, reach } of cue.zones) {
      const key = `${cue.track}\0${edge}`;
      const at = Math.round((cue.start / fps) * 1000) / 1000;
      const flag = groups.get(key);
      if (!flag) groups.set(key, { subject: "subtitle", track: cue.track, zone: edge, cues: 1, first: at, last: at, reach });
      else {
        flag.cues++;
        flag.first = Math.min(flag.first, at);
        flag.last = Math.max(flag.last, at);
        flag.reach = Math.max(flag.reach, reach);
      }
    }
  }
  return [...groups.values()];
}

/** Whether a cue of `crossings` shows at timeline frame `frame`. */
export function crossingAt(crossings: readonly CueCrossing[], frame: number): boolean {
  return crossings.some((cue) => frame >= cue.start && frame < cue.end);
}
