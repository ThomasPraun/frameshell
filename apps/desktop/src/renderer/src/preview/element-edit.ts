// Geometry of element mode (ADR 0021): where a composition element shows, what adjustment a drag of it makes, and the
// `clip.set` that saves it. Pure: the preview forwards pointer positions and probed boxes. Units: screen CSS px of the
// app, fractions of the frame, page px (the live page is laid out at the project format) and the composition's CSS px
// (page px / the element's `unit`, which a stage scaled to fit the page makes ≠ 1).
import type { ElementAdjust } from "@frameshell/schema";
import type { Size } from "@frameshell/schema/composite";
import type { TimelineEdit } from "../../../shared/api.js";
import { type LayerRender, type Program, type VideoSpan, programAt } from "./program.js";
import type { FrameBox } from "./transform-edit.js";

/** An adjustment with its defaults filled. */
export interface Adjust {
  x: number;
  y: number;
  scale: number;
}

/** The adjustment `stored` means: absent fields at their defaults (no move, scale 1). */
export function filled(stored: ElementAdjust | undefined): Adjust {
  return { x: stored?.x ?? 0, y: stored?.y ?? 0, scale: stored?.scale ?? 1 };
}

/** One element drag, pointer positions in screen CSS px relative to the frame's top left corner. */
export interface ElementDrag {
  /** Body: move. Corner: scale about the element's centre. */
  kind: "move" | "scale";
  start: Adjust;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Frame size on screen, CSS px. */
  frame: Size;
  /** Where the clip's live page lies, in fractions of the frame. */
  page: FrameBox;
  /** Project resolution: the page's size in page px. */
  resolution: Size;
  /** Page px per composition CSS px of a move (`MovableElement.unit`). */
  unit: number;
  /** The element's box at drag start, in fractions of the frame. */
  box: FrameBox;
}

/** Smallest scale a corner drag makes: the element never vanishes under the pointer. */
const MIN_SCALE = 0.01;

/**
 * Adjustment after a drag: moves are whole composition px, scales three
 * decimals about the element's centre, never below {@link MIN_SCALE}.
 */
export function dragAdjust(drag: ElementDrag): Adjust {
  const { start, from, to, frame } = drag;
  if (drag.kind === "move") {
    const [px, py] = cssPerScreenPx(drag);
    return { ...start, x: Math.round(start.x + (to.x - from.x) * px), y: Math.round(start.y + (to.y - from.y) * py) };
  }
  const cx = (drag.box.left + drag.box.width / 2) * frame.width;
  const cy = (drag.box.top + drag.box.height / 2) * frame.height;
  const before = Math.hypot(from.x - cx, from.y - cy);
  const after = Math.hypot(to.x - cx, to.y - cy);
  const scale = before === 0 ? start.scale : Math.max(MIN_SCALE, Math.round(start.scale * (after / before) * 1000) / 1000);
  return { ...start, scale };
}

/** Composition CSS px per screen px, across and down. */
function cssPerScreenPx({ frame, page, resolution, unit }: Pick<ElementDrag, "frame" | "page" | "resolution" | "unit">): [number, number] {
  return [resolution.width / (frame.width * page.width * unit), resolution.height / (frame.height * page.height * unit)];
}

/**
 * Where the element shows with `next` instead of `start`, from its box at
 * `start` (fractions of the frame): moved by the difference and scaled about
 * its centre. Assumes the composition keeps the default centre origin.
 */
export function adjustedBox(box: FrameBox, start: Adjust, next: Adjust, geometry: Pick<ElementDrag, "page" | "resolution" | "unit">): FrameBox {
  const dx = ((next.x - start.x) * geometry.unit * geometry.page.width) / geometry.resolution.width;
  const dy = ((next.y - start.y) * geometry.unit * geometry.page.height) / geometry.resolution.height;
  const factor = next.scale / start.scale;
  const width = box.width * factor;
  const height = box.height * factor;
  return { left: box.left + dx + (box.width - width) / 2, top: box.top + dy + (box.height - height) / 2, width, height };
}

/** `adjust` as the clip stores it: defaults left out; null when nothing is left (the entry goes). */
export function stored(adjust: Adjust): ElementAdjust | null {
  const entry: ElementAdjust = {};
  if (adjust.x !== 0) entry.x = adjust.x;
  if (adjust.y !== 0) entry.y = adjust.y;
  if (adjust.scale !== 1) entry.scale = adjust.scale;
  return Object.keys(entry).length === 0 ? null : entry;
}

/** The `clip.set` that gives `selector` adjustment `after` (removing its entry at the defaults); null when nothing changes. */
export function elementEdit(clip: string, selector: string, before: ElementAdjust | undefined, after: Adjust): TimelineEdit | null {
  const was = filled(before);
  if (was.x === after.x && was.y === after.y && was.scale === after.scale) return null;
  return { op: "clip.set", args: { clip, elements: { [selector]: stored(after) } } };
}

/** `elements` with `selector` set to `adjust` (removed at the defaults): what the live sheet shows during a drag. */
export function withAdjust(elements: Readonly<Record<string, ElementAdjust>>, selector: string, adjust: Adjust): Record<string, ElementAdjust> {
  const next = { ...elements };
  const entry = stored(adjust);
  if (entry) next[selector] = entry;
  else delete next[selector];
  return next;
}

/**
 * A selector that may stop matching after the composition's code changes: no
 * `id` anywhere in its path, or a position among siblings (`:nth-child`).
 */
export function fragileSelector(selector: string): boolean {
  return !selector.includes("#") || selector.includes(":nth-child");
}

/** What Ask agent asks for a fragile selector (agent-facing, English): an `id` on the element, the entry keyed by it. */
export function idRequest(clip: string, selector: string): string {
  return (
    `Give the element \`${selector}\` of clip ${clip} an id in its composition source, then move its entry in the clip's ` +
    `\`elements\` to \`#<that id>\` (frameshell clip set ${clip} --elements), so the adjustment follows code edits.`
  );
}

/** Where `clip`'s picture is the topmost of the frame (the ADR 0010 rule): its live page may show over the canvas there. */
export function topmostAt(program: Program, frame: number, clip: string): boolean {
  for (let layer = program.layers.length - 1; layer >= 0; layer--) {
    const span = programAt(program, frame, layer);
    if (span) return span.clip === clip;
  }
  return false;
}

/** Render identity of a generated span, as pick pages key them: the ready render's file, else the key being rendered. */
export function renderIdentity(render: LayerRender | null): string | null {
  if (!render) return null;
  return render.state === "ready" ? render.file : render.key;
}

/**
 * True once a dropped element drag's page may go (ADR 0021 decision 8): the
 * clip's render identity moved on from `held.identity` (the saved adjustment
 * reached the program) and the new picture is there, its render ready or its
 * live page ready (`live`, the live preview's clip and key), or there is no
 * new picture to wait for (render failed or unavailable, clip gone).
 */
export function holdSettled(
  program: Program,
  frame: number,
  held: { clip: string; identity: string | null },
  live: { clip: string; key: string } | null,
): boolean {
  let span: VideoSpan | null = null;
  for (let layer = program.layers.length - 1; layer >= 0 && !span; layer--) {
    const found = programAt(program, frame, layer);
    if (found?.clip === held.clip) span = found;
  }
  if (!span || span.kind !== "generated" || !span.render) return true;
  const { render } = span;
  if (renderIdentity(render) === held.identity) return false;
  if (render.state !== "queued" && render.state !== "rendering") return true;
  return live?.clip === held.clip && live.key === render.key;
}
