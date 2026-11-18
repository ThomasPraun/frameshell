import { type FrameSpan, type SpeedInterval, peakSpeed } from "./speed.js";

// The chart of `review --speed` (#457), drawn into RGB pixels with no library: speed over the clip's frames, linear
// stretches shaded amber, dead stops red. Pure; `encodeRgbPng` writes it and the sheet step burns the label in.

/** An RGB picture, `width * height * 3` bytes, rows top to bottom. */
export interface RgbPixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Colours of the chart, RGB. */
export const CHART_COLOURS = {
  background: [32, 32, 32],
  axis: [110, 110, 110],
  line: [240, 240, 240],
  linear: [120, 88, 20],
  stop: [130, 32, 32],
} as const satisfies Record<string, readonly [number, number, number]>;

/** Pixels around the plot. */
const PAD = 16;

/**
 * Speed over frames `first` to `end` (`intervals` in px per frame) as a chart `width` x `height`: x the frames, y the
 * speed from 0 at the bottom to a little over the fastest; each `spans` stretch shaded over the whole height.
 */
export function speedChart(intervals: readonly SpeedInterval[], spans: readonly FrameSpan[], frames: { first: number; end: number }, width: number, height: number): RgbPixels {
  const pixels = new Uint8Array(width * height * 3);
  const paint = (x: number, y: number, colour: readonly number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    pixels.set(colour, (y * width + x) * 3);
  };
  for (let i = 0; i < width * height; i++) pixels.set(CHART_COLOURS.background, i * 3);
  const left = PAD;
  const right = width - PAD;
  const top = PAD;
  const bottom = height - PAD;
  const span = Math.max(1, frames.end - frames.first);
  const xOf = (frame: number) => Math.round(left + ((frame - frames.first) / span) * (right - left));
  const peak = peakSpeed(intervals);
  const ceiling = peak > 0 ? peak * 1.1 : 1;
  const yOf = (speed: number) => Math.round(bottom - (Math.min(speed, ceiling) / ceiling) * (bottom - top));

  for (const found of spans) {
    const colour = found.kind === "linear" ? CHART_COLOURS.linear : CHART_COLOURS.stop;
    for (let x = xOf(found.from); x < Math.max(xOf(found.from) + 1, xOf(found.to)); x++) for (let y = top; y <= bottom; y++) paint(x, y, colour);
  }
  for (let x = left; x <= right; x++) paint(x, bottom, CHART_COLOURS.axis);
  for (let y = top; y <= bottom; y++) paint(left, y, CHART_COLOURS.axis);

  // The speed is held over each interval: a flat run per interval, a vertical step between two, 2 px thick.
  let previous: number | null = null;
  for (const interval of intervals) {
    const y = yOf(interval.speed);
    const x0 = xOf(interval.from);
    const x1 = Math.max(x0 + 1, xOf(interval.to));
    if (previous !== null) for (let k = Math.min(previous, y); k <= Math.max(previous, y); k++) for (const dx of [0, 1]) paint(x0 + dx, k, CHART_COLOURS.line);
    for (let x = x0; x <= x1; x++) for (const dy of [0, 1]) paint(x, y - dy, CHART_COLOURS.line);
    previous = y;
  }
  return { width, height, pixels };
}
