// Backdrop of a generated clip in the preview engine (ADR 0031): the Canvas2D twin of export's `backdropUnder`
// (packages/core/src/export/compiler.ts). Runs in the engine worker.
import type { LayerRect } from "@frameshell/schema/composite";
import type { BackdropLayer } from "@frameshell/schema/effects";

/** How the canvas draws a {@link BackdropLayer}: a CSS filter for blur and saturation, then black at `dim` alpha. */
export interface CanvasBackdrop {
  filter: string;
  dim: number;
}

/** The canvas steps of `layer`: the same sigma, saturation and scrim as export's `gblur` + `colorchannelmixer`. */
export function canvasBackdrop(layer: BackdropLayer): CanvasBackdrop {
  const steps = [...(layer.sigma > 0 ? [`blur(${layer.sigma}px)`] : []), ...(layer.saturate !== 1 ? [`saturate(${layer.saturate})`] : [])];
  return { filter: steps.length > 0 ? steps.join(" ") : "none", dim: layer.dim };
}

/** Alpha of a decoded render: one byte per pixel (the luma of its alpha stream, ADR 0002). */
export interface AlphaBytes {
  data: Uint8Array;
  offset: number;
  stride: number;
  width: number;
  height: number;
}

/** Where the picture with the backdrop is drawn, and what limits the glass to it. */
export interface BackdropTarget {
  /** The picture's rectangle on the canvas. */
  rect: Pick<LayerRect, "left" | "top" | "width" | "height">;
  /** The picture's alpha; null for an opaque picture (the whole rectangle is glass). */
  alpha: AlphaBytes | null;
  /** The picture's opacity at this frame (keys and fades included): the glass fades with it. */
  opacity: number;
}

/**
 * Lays a backdrop on a canvas before its picture is drawn: the canvas so far, blurred and saturated (`filter`),
 * dimmed, cut to the picture's alpha above the threshold (times its opacity), drawn back over itself. A clip region
 * set on `context` (a shaped dissolve) limits it as it limits the picture.
 */
export class BackdropPass {
  readonly #scratch = new OffscreenCanvas(1, 1);
  readonly #scratchContext = this.#scratch.getContext("2d")!;
  readonly #mask = new OffscreenCanvas(1, 1);
  readonly #maskContext = this.#mask.getContext("2d")!;
  #pixels: ImageData | null = null;

  draw(context: OffscreenCanvasRenderingContext2D, layer: BackdropLayer, target: BackdropTarget): void {
    const canvas = context.canvas;
    const scratch = this.#scratch;
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch.width = canvas.width;
      scratch.height = canvas.height;
    }
    const s = this.#scratchContext;
    const steps = canvasBackdrop(layer);
    s.globalCompositeOperation = "copy";
    s.globalAlpha = 1;
    s.filter = steps.filter;
    s.drawImage(canvas, 0, 0);
    s.filter = "none";
    if (steps.dim > 0) {
      // `source-atop` keeps the blur's own alpha at the canvas edges.
      s.globalCompositeOperation = "source-atop";
      s.fillStyle = `rgba(0, 0, 0, ${steps.dim})`;
      s.fillRect(0, 0, scratch.width, scratch.height);
    }
    // `destination-in` clears everything the mask does not cover, inside the rectangle and outside it.
    s.globalCompositeOperation = "destination-in";
    s.globalAlpha = target.opacity;
    const { rect } = target;
    if (target.alpha) {
      s.imageSmoothingEnabled = false;
      s.drawImage(this.#maskOf(target.alpha, layer.threshold), rect.left, rect.top, rect.width, rect.height);
      s.imageSmoothingEnabled = true;
    } else {
      s.fillStyle = "#fff";
      s.fillRect(rect.left, rect.top, rect.width, rect.height);
    }
    s.globalCompositeOperation = "source-over";
    s.globalAlpha = 1;
    const alpha = context.globalAlpha;
    context.globalAlpha = 1;
    context.drawImage(scratch, 0, 0);
    context.globalAlpha = alpha;
  }

  /** White where `alpha` is above `threshold`, transparent elsewhere, at the alpha's size. */
  #maskOf(alpha: AlphaBytes, threshold: number): OffscreenCanvas {
    const { width: w, height: h } = alpha;
    if (!this.#pixels || this.#pixels.width !== w || this.#pixels.height !== h) {
      this.#pixels = new ImageData(w, h);
      this.#mask.width = w;
      this.#mask.height = h;
    }
    const words = new Uint32Array(this.#pixels.data.buffer);
    const bytes = alpha.data;
    // Little-endian RGBA words: alpha is the top byte.
    for (let y = 0; y < h; y++) {
      const row = alpha.offset + y * alpha.stride;
      const out = y * w;
      for (let x = 0; x < w; x++) words[out + x] = bytes[row + x]! > threshold ? 0xffffffff : 0x00ffffff;
    }
    this.#maskContext.putImageData(this.#pixels, 0, 0);
    return this.#mask;
  }
}
