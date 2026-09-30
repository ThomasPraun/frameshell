import { writeFileSync } from "node:fs";

/** Mono 16-bit PCM WAV writer for fixtures. */
export function writeWav(path: string, samples: Int16Array, sampleRate = 16_000): void {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]));
}

/**
 * Stand-in for speech: 220 Hz tone at -6 dBFS inside `[from, to)` ranges
 * (seconds), digital silence elsewhere. Energy edges are exact.
 */
export function toneBursts(duration: number, bursts: readonly [number, number][], sampleRate = 16_000): Int16Array {
  const samples = new Int16Array(Math.round(duration * sampleRate));
  for (const [from, to] of bursts) {
    for (let i = Math.round(from * sampleRate); i < Math.round(to * sampleRate); i++) {
      samples[i] = Math.round(16_000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
    }
  }
  return samples;
}
