// Geometry of the preview's on-canvas transform handles. Pure: the panel forwards pointer positions, this says where
// a layer is and what placement a drag makes; boxes come from `layerRect` (shots: `shotLayers`), as the engine and
// export place layers.
import { IDENTITY_PLACEMENT, type Placement, type Size, layerRect } from "@frameshell/schema/composite";
import type { TimelineEdit } from "../../../shared/api.js";
import { type Program, type VideoSpan, angleLayer, programAt } from "./program.js";

/** A point or box in fractions of the frame: 0 = left/top edge, 1 = right/bottom edge. */
export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a clip's picture shows at a frame. */
export interface LayerBox {
  /** Layer index, 0 = base. */
  layer: number;
  size: Size;
  placement: Placement;
  /** In fractions of the frame; may reach outside [0, 1]. */
  box: FrameBox;
}

/**
 * Box of `clip` at program frame `frame`, the one its handles move; null when
 * it shows no movable picture then (gap, placeholder, other clip, media of
 * unknown size, a multicam shot: shots fill their tiles). A generated clip
 * whose render is not ready yet takes the project format, the size its
 * render will have, so it can be hit and moved while it renders.
 */
export function layerBox(program: Program, frame: number, clip: string): LayerBox | null {
  for (let layer = program.layers.length - 1; layer >= 0; layer--) {
    const span = programAt(program, frame, layer);
    if (!span || span.clip !== clip || span.kind === "angle") continue;
    const found = spanBox(program, span, layer);
    if (found) return found;
  }
  return null;
}

/** Where `span` (on `layer`) shows; null for a placeholder or media of unknown size. A shot's angle shows in its tile. */
function spanBox(program: Program, span: VideoSpan, layer: number): LayerBox | null {
  if (span.kind === "placeholder") return null;
  const { resolution } = program;
  if (span.kind === "angle") {
    const shown = angleLayer(span, resolution);
    if (!shown) return null;
    const { tile } = shown;
    const box = { left: tile.left / resolution.width, top: tile.top / resolution.height, width: tile.width / resolution.width, height: tile.height / resolution.height };
    return { layer, size: shown.source, placement: IDENTITY_PLACEMENT, box };
  }
  const size = span.size ?? (span.kind === "generated" ? resolution : null);
  if (!size) return null;
  return { layer, size, placement: span.placement, box: frameBox(resolution, size, span.placement) };
}

/** Hit kind and clip type of a picture span: a shot's angle is footage of a `shot` clip. */
function hitKind(span: Exclude<VideoSpan, { kind: "placeholder" }>): Pick<LayerHit, "kind" | "type"> {
  if (span.kind === "generated") return { kind: "generated", type: span.type };
  if (span.kind === "angle") return { kind: "media", type: "shot" };
  return { kind: span.kind, type: "media" };
}

/** Box of a `size` picture placed with `placement`, in fractions of a `resolution` frame. */
export function frameBox(resolution: Size, size: Size, placement: Placement): FrameBox {
  const rect = layerRect(size, resolution, resolution, placement);
  return {
    left: rect.left / resolution.width,
    top: rect.top / resolution.height,
    width: rect.width / resolution.width,
    height: rect.height / resolution.height,
  };
}

/** One layer under a point of the frame (ADR 0011). */
export interface LayerHit {
  /** Clip id; inside a nested timeline `<nested clip>/<clip>`. */
  clip: string;
  /** Layer index, 0 = base. */
  layer: number;
  kind: "media" | "still" | "generated";
  /** Clip type: `media` for footage and stills, `shot` for a multicam shot's angle, the adapter type (e.g. `hyperframes`) for generated clips. */
  type: string;
  /**
   * The layer's picture covers the point: inside its box, not fully
   * transparent there (its opacity, and its alpha when known), so the user
   * sees it, or sees it blended, at that pixel.
   */
  paints: boolean;
}

/**
 * Alpha at least this strong (alpha × opacity, 0-1) counts as painting the
 * pixel: fainter than this, what the user sees there is the layer below.
 */
export const PAINT_MIN = 0.05;

/**
 * Every layer whose box holds `point` (fractions of the frame) at `frame`,
 * topmost first. `alphaOf` gives a layer's alpha at the point, 0-1, when the
 * engine knows it (pictures with alpha); absent means opaque inside its box.
 * The target the user points at is the first hit that {@link LayerHit.paints}.
 */
export function layersAt(
  program: Program,
  frame: number,
  point: { x: number; y: number },
  alphaOf: (layer: number) => number | undefined = () => undefined,
): LayerHit[] {
  const hits: LayerHit[] = [];
  for (let layer = program.layers.length - 1; layer >= 0; layer--) {
    const span = programAt(program, frame, layer);
    if (!span || span.kind === "placeholder") continue;
    const found = spanBox(program, span, layer);
    if (!found) continue;
    const { left, top, width, height } = found.box;
    if (point.x < left || point.x >= left + width || point.y < top || point.y >= top + height) continue;
    const strength = found.placement.opacity * (alphaOf(layer) ?? 1);
    hits.push({ clip: span.clip, layer, ...hitKind(span), paints: strength >= PAINT_MIN });
  }
  return hits;
}

/** Clip whose picture is topmost at `point` (fractions of the frame) at `frame`; null over black. See {@link layersAt}. */
export function layerAt(
  program: Program,
  frame: number,
  point: { x: number; y: number },
  alphaOf?: (layer: number) => number | undefined,
): string | null {
  return layersAt(program, frame, point, alphaOf).find((hit) => hit.paints)?.clip ?? null;
}

/**
 * Clips whose visible box meets the rectangle `rect` (fractions of the
 * frame, `x0 <= x1`, `y0 <= y1`) at `frame`, topmost first. Layers at
 * opacity 0 are left out.
 */
export function layersIn(program: Program, frame: number, rect: { x0: number; y0: number; x1: number; y1: number }): LayerHit[] {
  const hits: LayerHit[] = [];
  for (let layer = program.layers.length - 1; layer >= 0; layer--) {
    const span = programAt(program, frame, layer);
    if (!span || span.kind === "placeholder") continue;
    const found = spanBox(program, span, layer);
    if (!found || found.placement.opacity < PAINT_MIN) continue;
    const { left, top, width, height } = found.box;
    if (rect.x1 <= left || rect.x0 >= left + width || rect.y1 <= top || rect.y0 >= top + height) continue;
    hits.push({ clip: span.clip, layer, ...hitKind(span), paints: true });
  }
  return hits;
}

/** One handle drag, pointer positions in CSS px relative to the frame's top left corner. */
export interface PlacementDrag {
  /** Body: move. Corner: scale about the layer's center. */
  kind: "move" | "scale";
  start: Placement;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Frame size on screen, CSS px. */
  frame: Size;
  /** Project resolution: placement offsets are in its pixels. */
  project: Size;
}

/** Smallest scale a corner drag makes: the layer never vanishes under the pointer. */
const MIN_SCALE = 0.01;

/**
 * Placement after a drag: moves are whole project pixels, scales three
 * decimals, never below {@link MIN_SCALE}. Opacity is untouched.
 */
export function dragPlacement(drag: PlacementDrag): Placement {
  const { start, from, to, frame, project } = drag;
  const px = project.width / frame.width;
  const py = project.height / frame.height;
  if (drag.kind === "move") {
    return { ...start, x: Math.round(start.x + (to.x - from.x) * px), y: Math.round(start.y + (to.y - from.y) * py) };
  }
  const cx = frame.width / 2 + start.x / px;
  const cy = frame.height / 2 + start.y / py;
  const before = Math.hypot(from.x - cx, from.y - cy);
  const after = Math.hypot(to.x - cx, to.y - cy);
  const scale = before === 0 ? start.scale : Math.max(MIN_SCALE, Math.round(start.scale * (after / before) * 1000) / 1000);
  return { ...start, scale };
}

/** The `clip.set` that turns `before` into `after`, naming only changed fields; null when nothing changed. */
export function placementEdit(clip: string, before: Placement, after: Placement): TimelineEdit | null {
  const transform: Partial<Placement> = {};
  for (const key of ["x", "y", "scale", "opacity"] as const) if (after[key] !== before[key]) transform[key] = after[key];
  return Object.keys(transform).length === 0 ? null : { op: "clip.set", args: { clip, transform } };
}
