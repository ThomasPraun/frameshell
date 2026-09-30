/** Energy frame hop, seconds: 10 ms = whisper.cpp timestamp resolution. */
export const HOP_SECONDS = 0.01;

/** dB below the speech level still counted as speech (ADR 0003 measurement setup). */
const AUDIBLE_DB = 40;
/** Minimum margin above the noise floor for a frame to count as speech. */
const FLOOR_MARGIN_DB = 10;

/** Mono PCM samples read from a WAV file. */
export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

/**
 * Read a mono 16-bit PCM WAV, walking chunks (ffmpeg writes LIST before
 * data). Throws on anything else: the host contract guarantees this format.
 */
export function readWav(bytes: Uint8Array): Pcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("audio is not a WAV file");
  let sampleRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error(`audio must be mono 16-bit PCM WAV (got format ${format}, ${channels} channels, ${bits} bits)`);
      }
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === "data") {
      if (sampleRate === 0) throw new Error("WAV data chunk precedes its fmt chunk");
      const length = Math.floor(Math.min(size, bytes.byteLength - body) / 2);
      const samples = new Int16Array(length);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/**
 * Per-frame speech flags: frame `i` covers `[i, i+1) * HOP_SECONDS` and is
 * speech when its RMS (20 ms window) is within 40 dB of the speech level
 * (p90 of frames) and 10 dB above the floor (p10). Same rule the spike used
 * to score word timing (ADR 0003).
 */
export function speechFrames(pcm: Pcm): boolean[] {
  const hop = Math.round(pcm.sampleRate * HOP_SECONDS);
  const count = Math.floor(pcm.samples.length / hop);
  const db = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const from = Math.max(0, i * hop - hop / 2);
    const to = Math.min(pcm.samples.length, i * hop + hop + hop / 2);
    let sum = 0;
    for (let j = from; j < to; j++) sum += pcm.samples[j]! * pcm.samples[j]!;
    db[i] = 10 * Math.log10(sum / Math.max(1, to - from) / (32768 * 32768) + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
  const threshold = Math.max(percentile(10) + FLOOR_MARGIN_DB, percentile(90) - AUDIBLE_DB);
  return Array.from(db, (value) => value >= threshold);
}
