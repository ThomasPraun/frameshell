/** A hit of {@link music}: a decaying 200 Hz burst. */
export interface MusicHit {
  /** Seconds. */
  at: number;
  amplitude: number;
  /** Seconds the sound takes to fall by 60 dB. */
  decay: number;
}

/** Mono float samples of synthetic music: a 110 Hz bed at amplitude `bed` plus a decaying 200 Hz burst per hit. Deterministic. */
export function music(seconds: number, hits: MusicHit[], { bed = 0.01, rate = 16_000 } = {}): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = bed * Math.sin((2 * Math.PI * 110 * i) / rate);
  for (const hit of hits) {
    const start = Math.round(hit.at * rate);
    const tau = hit.decay / Math.log(1000);
    for (let k = 0; start + k < out.length; k++) {
      const t = k / rate;
      if (t > hit.decay * 1.2) break;
      out[start + k] = out[start + k]! + hit.amplitude * Math.exp(-t / tau) * Math.sin(2 * Math.PI * 200 * t);
    }
  }
  return out;
}

/** A kick every half second up to `until` seconds. */
export const kicks = (until: number): MusicHit[] => Array.from({ length: Math.floor(until / 0.5) }, (_, i) => ({ at: 0.5 * (i + 1), amplitude: 0.25, decay: 0.2 }));

/** 16-bit samples of float `samples`. */
export const toInt16 = (samples: Float32Array): Int16Array => Int16Array.from(samples, (value) => Math.max(-32768, Math.min(32767, Math.round(value * 32767))));
