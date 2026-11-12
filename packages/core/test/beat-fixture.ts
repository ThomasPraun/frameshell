/** Options of {@link clickTrack}. */
export interface ClickTrack {
  bpm: number;
  seconds: number;
  /** Seconds of the first click. */
  offset?: number;
  rate?: number;
  /** Beats per bar; the first beat of each bar is louder and carries a low boom. Default 4. */
  meter?: number;
  /** Beat index of the first accented click. Default 0. */
  accent?: number;
  /** Beats that carry no click, by index (a calm part). */
  skip?: (index: number) => boolean;
  /** Seconds of a quiet bed of noise under everything (amplitude 0.002). */
  bed?: boolean;
}

/** Time of beat `index` of a track, seconds. */
export function clickTime(track: ClickTrack, index: number): number {
  return (track.offset ?? 0) + (index * 60) / track.bpm;
}

/**
 * Mono float samples of a click track: every beat is a 25 ms decaying 1.4 kHz burst starting on the beat
 * (accented ones louder, with a 60 Hz boom), over silence or a faint bed. Deterministic.
 */
export function clickTrack(track: ClickTrack): Float32Array {
  const rate = track.rate ?? 48_000;
  const meter = track.meter ?? 4;
  const accent = track.accent ?? 0;
  const out = new Float32Array(Math.round(track.seconds * rate));
  let seed = 7;
  if (track.bed) {
    for (let i = 0; i < out.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      out[i] = 0.002 * ((seed / 2 ** 32) * 2 - 1);
    }
  }
  for (let index = 0; clickTime(track, index) < track.seconds; index++) {
    if (track.skip?.(index)) continue;
    const loud = (((index - accent) % meter) + meter) % meter === 0;
    const start = Math.round(clickTime(track, index) * rate);
    const length = Math.round(0.25 * rate);
    for (let k = 0; k < length && start + k < out.length; k++) {
      const t = k / rate;
      const burst = Math.exp(-t / 0.008) * Math.sin(2 * Math.PI * 1_400 * t) * (loud ? 0.8 : 0.5);
      const boom = loud ? Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * 60 * t) * 0.6 : 0;
      out[start + k] = (out[start + k] ?? 0) + burst + boom;
    }
  }
  return out;
}

/** A mono 16-bit PCM WAV file of float `samples` at `rate`, at half level so an accented click does not clip. */
export function wavOf(samples: Float32Array, rate: number): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 16384))), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
