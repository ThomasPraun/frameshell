// Live preview of generated clips (ADR 0010): which clip plays its composition in a frame, and at what time. Pure.
import { type FrameBox, frameBox } from "./transform-edit.js";
import { type Program, type VideoSpan, programAt } from "./program.js";

type GeneratedSpan = Extract<VideoSpan, { kind: "generated" }>;

/** The generated clip the preview shows live at a frame. */
export interface LiveTarget {
  /** Flattened clip id, as `clip.renders` and `clip.live` address it (`<nested clip>/<clip>` inside a nested timeline). */
  clip: string;
  /** Layer index, 0 = base. */
  layer: number;
  /** Render cache key being rendered: the live page is built for it. */
  key: string;
  span: GeneratedSpan;
  /** Where the page shows, in fractions of the frame: the project format placed like a render of it. */
  box: FrameBox;
  opacity: number;
}

/**
 * The clip to show live at program frame `frame`: the topmost picture there,
 * when it is a generated clip whose render is queued or rendering. Live
 * pages sit above the engine's canvas, so a clip under another picture keeps
 * its slate rather than covering what export would show over it. Ready
 * renders play in the engine; failed and unavailable ones keep their slate.
 */
export function liveTarget(program: Program, frame: number): LiveTarget | null {
  for (let layer = program.layers.length - 1; layer >= 0; layer--) {
    const span = programAt(program, frame, layer);
    if (!span) continue;
    if (span.kind !== "generated" || !span.render) return null;
    const { render } = span;
    if ((render.state !== "queued" && render.state !== "rendering") || !render.key) return null;
    // Renders are made at the project format, so the page is laid out at it too.
    const box = frameBox(program.resolution, program.resolution, span.placement);
    return { clip: span.clip, layer, key: render.key, span, box, opacity: span.placement.opacity };
  }
  return null;
}

/**
 * Composition seconds the live page shows at program time `time` (seconds):
 * render time `in + (t − start)`, as the engine maps a render's frames.
 * Paused, `time` is a frame boundary, so this is that frame's time exactly.
 */
export function liveSeconds(span: GeneratedSpan, time: number, fps: number): number {
  return Math.max(0, (span.in - span.start) / fps + time);
}
