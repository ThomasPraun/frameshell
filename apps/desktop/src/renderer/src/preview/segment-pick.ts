// Pick inside photos (ADR 0022): which photos to prepare, whether a pick can be segmented, and stepping the mask size.
import type { SegmentedPoint } from "@frameshell/protocol";
import type { SelectedPoint } from "../selection.js";
import type { Program } from "./program.js";

/** Project-relative image files of every photo (still media clip) the program shows, each once, in layer order. */
export function photoAssets(program: Program): string[] {
  const assets = new Set<string>();
  for (const layer of program.layers) for (const span of layer) if (span.kind === "still") assets.add(span.image);
  return [...assets];
}

/** Whether clip `clip` shows a photo at `frame`. */
export function isPhotoAt(program: Program, frame: number, clip: string): boolean {
  return program.layers.some((layer) => layer.some((span) => span.kind === "still" && span.clip === clip && span.start <= frame && frame < span.end));
}

/** `segment` with the mask `delta` steps larger (positive) or smaller, kept inside the three sizes; the same object when it cannot move. */
export function steppedSegment(segment: SegmentedPoint, delta: number): SegmentedPoint {
  const chosen = Math.max(0, Math.min(segment.masks.length - 1, segment.chosen + delta));
  return chosen === segment.chosen ? segment : { ...segment, chosen };
}

/**
 * `points` with the last segmented one stepped by `delta` sizes; null when
 * none is segmented or it is at the end of the range already.
 */
export function steppedPoints(points: readonly SelectedPoint[], delta: number): SelectedPoint[] | null {
  const at = points.findLastIndex((point) => point.segment);
  const point = points[at];
  if (!point?.segment) return null;
  const segment = steppedSegment(point.segment, delta);
  if (segment === point.segment) return null;
  return points.map((candidate, index) => (index === at ? { ...candidate, segment } : candidate));
}
