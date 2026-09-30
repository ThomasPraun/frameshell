// Program audio spans to sidecar reads and output samples. Pure: the engine worker does the I/O.
import type { AudioSpan } from "./program.js";

/** Program samples `[from, to)` of one span. */
export interface AudioRead {
  span: AudioSpan;
  from: number;
  to: number;
}

/**
 * Reads covering program samples `[from, to)`: per span (sorted by start),
 * chunks of at most `maxChunk` samples from where the window meets the span.
 */
export function audioReads(spans: readonly AudioSpan[], from: number, to: number, maxChunk: number): AudioRead[] {
  const reads: AudioRead[] = [];
  for (const span of spans) {
    if (span.start >= to) break;
    const a = Math.max(from, span.start);
    const b = Math.min(to, span.end);
    for (let at = a; at < b; at += maxChunk) reads.push({ span, from: at, to: Math.min(b, at + maxChunk) });
  }
  return reads;
}

/** Sidecar frames `[first, first + count)` a read plays; one more at other speeds, to interpolate. */
export function sourceWindow(read: AudioRead): { first: number; count: number } {
  const { span } = read;
  const first = Math.floor(position(span, read.from));
  const last = Math.floor(position(span, read.to - 1));
  return { first, count: last - first + (span.speed === 1 ? 1 : 2) };
}

/**
 * Output samples of `read`, mono float: channels averaged, linear
 * interpolation when sped up, the clip's gain applied. `pcm` holds
 * interleaved s16 frames from sidecar frame `first` on; frames it lacks
 * (past the sidecar's end) are silence. At speed 1 and unity gain on a mono
 * sidecar the output is exactly `s16 / 32768`.
 */
export function renderRead(read: AudioRead, pcm: Int16Array, first: number): Float32Array {
  const { span } = read;
  const channels = span.channels;
  const frames = Math.floor(pcm.length / channels);
  const out = new Float32Array(read.to - read.from);
  const at = (frame: number): number => {
    if (frame < 0 || frame >= frames) return 0;
    if (channels === 1) return pcm[frame]! / 32768;
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[frame * channels + c]!;
    return sum / channels / 32768;
  };
  for (let i = 0; i < out.length; i++) {
    const pos = position(span, read.from + i) - first;
    const whole = Math.floor(pos);
    const frac = pos - whole;
    const value = frac === 0 ? at(whole) : at(whole) + (at(whole + 1) - at(whole)) * frac;
    out[i] = span.gain === 1 ? value : value * span.gain;
  }
  return out;
}

/** Sidecar position (fractional frames) of program sample `sample`. */
function position(span: AudioSpan, sample: number): number {
  return span.in + (sample - span.start) * span.speed;
}
