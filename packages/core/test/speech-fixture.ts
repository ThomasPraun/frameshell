/**
 * Synthetic speech-like audio: "words" are tones with a 4 Hz syllable
 * modulation (energy dips inside words that are not pauses), gaps carry
 * -63 dBFS noise. Gaps: 0.8-1.1 (300 ms pause), 1.6-1.7 (100 ms, too short
 * to be a pause), 2.5-3.5 (1 s), 7.0-7.4 (400 ms). 3.5-7.0 is one long word.
 */
export const WORDS = [
  { start: 0.1, end: 0.8, hz: 220 },
  { start: 1.1, end: 1.6, hz: 330 },
  { start: 1.7, end: 2.5, hz: 262 },
  { start: 3.5, end: 7.0, hz: 196 },
  { start: 7.4, end: 8.0, hz: 294 },
] as const;

/** Length of {@link speechLike} in seconds. */
export const SPEECH_DURATION_S = 8.3;

/** True when `t` (seconds) is inside a word. */
export function voicedAt(t: number): boolean {
  return WORDS.some((word) => t >= word.start && t < word.end);
}

/** Mono s16 samples at `rate`, deterministic. */
export function speechLike(rate: number): Int16Array {
  const out = new Int16Array(Math.round(SPEECH_DURATION_S * rate));
  let seed = 12345;
  const noise = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed / 2 ** 32) * 2 - 1;
  };
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const word = WORDS.find((w) => t >= w.start && t < w.end);
    const value = word
      ? 0.3 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * (t - word.start))) * Math.sin(2 * Math.PI * word.hz * t)
      : 0.0012 * noise();
    out[i] = Math.round(value * 32767);
  }
  return out;
}

/** {@link speechLike} as a 16-bit mono WAV file body. */
export function speechLikeWav(rate: number): Buffer {
  const pcm = speechLike(rate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
