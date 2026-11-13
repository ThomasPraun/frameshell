// Program audio spans to sidecar reads and output samples. Pure: the engine worker does the I/O.
import { audioFadeGain, gainAt } from "@frameshell/schema/composite";
import { type AudioSpan, edgeWeight } from "./program.js";
import { type StretchChain, stretch, stretchWindow } from "./time-stretch.js";

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

/**
 * Sidecar frames `[first, first + count)` a read plays; at other speeds, the frames its time stretch reads
 * ({@link stretchWindow}). A shaped dissolve may reach before frame 0 (ADR 0030): those frames are not read, and
 * {@link renderRead} plays them as silence.
 */
export function sourceWindow(read: AudioRead): { first: number; count: number } {
  const { span } = read;
  if (span.speed !== 1) return stretchWindow(span, read.from, read.to);
  const first = Math.max(0, Math.floor(position(span, read.from)));
  const last = Math.floor(position(span, read.to - 1));
  return { first, count: Math.max(0, last - first + 1) };
}

/**
 * Output samples of `read`, mono float: channels averaged, stretched keeping the pitch when the clip plays at
 * another speed ({@link stretch}, like export's `atempo`), the clip's gain applied ({@link envelopeGain}
 * per sample when the span has an envelope). `pcm` holds
 * interleaved s16 frames from sidecar frame `first` on; frames it lacks
 * (past the sidecar's end) are silence. At speed 1 and unity gain on a mono
 * sidecar the output is exactly `s16 / 32768`. `chain` carries the stretch over from the span's read before.
 */
export function renderRead(read: AudioRead, pcm: Int16Array, first: number, chain?: StretchChain): Float32Array {
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
  let stretched: Float32Array | null = null;
  if (span.speed !== 1) {
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) mono[frame] = at(frame);
    stretched = stretch(span, read.from, read.to, mono, first, chain);
  }
  for (let i = 0; i < out.length; i++) {
    const value = stretched ? stretched[i]! : at(position(span, read.from + i) - first);
    const gain = span.envelope ? envelopeGain(span, read.from + i) : span.gain;
    out[i] = gain === 1 ? value : value * gain;
  }
  return out;
}

/**
 * Linear gain of `span` at program sample `sample` (ADR 0018): its clip's
 * `gainAt` (else `gain`) times its equal-power fades and crossfades and its sample-accurate audio fades.
 */
export function envelopeGain(span: AudioSpan, sample: number): number {
  const { envelope } = span;
  if (!envelope) return span.gain;
  const t = sample / envelope.rate;
  const gain = envelope.keyed ? 10 ** (gainAt(envelope.keyed, t) / 20) : span.gain;
  return gain * edgeWeight(envelope, t, "sound") * (envelope.fades ? audioFadeGain(envelope.fades, sample) : 1);
}

/**
 * Identity of a span's stretched sound: equal for the span of the same clip in a recompiled program while its sound
 * stays where it was, so a play keeps one `StretchChain` for it across edits elsewhere.
 */
export function stretchKey(span: AudioSpan): string {
  return `${span.clip}|${span.sidecar}|${span.start}|${span.in}|${span.speed}`;
}

/** Sidecar position (fractional frames) of program sample `sample`. */
function position(span: AudioSpan, sample: number): number {
  return span.in + (sample - span.start) * span.speed;
}
