import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MUSIC_FIT_MAX_VARISPEED } from "@frameshell/protocol";
import { mediaTools } from "./media-tools.js";

// The check ADR 0037 asks of slice 2: how the export's varispeed (`atempo`, pitch kept) treats percussive music at the
// largest change `music.fit` allows (±1.7 %), against the tape-style resample slice 7 would add. The signal is 24 s at
// 120 BPM: a 60 Hz kick (80 ms decay) every beat, noise snares on the backbeat, 8 ms noise hats between. Numbers
// measured on ffmpeg 9.0.2 are in docs/adr/0037; the bounds here are loose so another build passes, tight enough that
// an atempo which smears or drifts audibly fails.
const RATE = 48_000;
const BPM = 120;
const SECONDS = 24;

function percussion(): { samples: Float32Array; kicks: number[] } {
  const out = new Float32Array(RATE * SECONDS);
  let seed = 12345;
  const noise = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const add = (at: number, length: number, shape: (t: number) => number) => {
    const start = Math.round(at * RATE);
    for (let k = 0; k < length * RATE && start + k < out.length; k++) out[start + k] = out[start + k]! + shape(k / RATE);
  };
  const kicks: number[] = [];
  for (let beat = 0; (beat * 60) / BPM < SECONDS - 1; beat++) {
    const at = 0.25 + (beat * 60) / BPM;
    add(at, 0.3, (t) => 0.8 * Math.exp(-t / 0.08) * Math.sin(2 * Math.PI * 60 * t));
    kicks.push(at);
    if (beat % 2 === 1) add(at, 0.3, (t) => 0.6 * Math.exp(-t / 0.05) * noise());
    add(at + 30 / BPM, 0.05, (t) => 0.35 * Math.exp(-t / 0.008) * noise());
  }
  return { samples: out, kicks };
}

async function filtered(input: Float32Array, filter: string): Promise<Float32Array> {
  const { ffmpeg } = await mediaTools();
  const pcm = Buffer.alloc(input.length * 4);
  input.forEach((value, i) => pcm.writeFloatLE(value, i * 4));
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", "pipe:0", "-af", filter, "-f", "f32le", "-ar", String(RATE), "-ac", "1", "pipe:1"],
      { encoding: "buffer", maxBuffer: 1 << 28 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin!.end(pcm);
  });
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.floor(bytes.length / 4) * 4));
}

/** 1 ms moving mean of |x|. */
function magnitude(x: Float32Array): Float32Array {
  const width = 48;
  const out = new Float32Array(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += Math.abs(x[i]!);
    if (i >= width) sum -= Math.abs(x[i - width]!);
    out[i] = sum / width;
  }
  return out;
}

interface Kick {
  /** Onset against where speed puts it, ms (negative = early). */
  shiftMs: number;
  /** 10 % to 90 % rise of the kick's envelope, ms. */
  riseMs: number;
  peakDb: number;
}

function measure(signal: Float32Array, kicks: number[], speed: number): Kick[] {
  const envelope = magnitude(signal);
  const rows: Kick[] = [];
  for (const kick of kicks) {
    const expected = kick / speed;
    const from = Math.round((expected - 0.06) * RATE);
    const to = Math.round((expected + 0.12) * RATE);
    if (to >= envelope.length) continue;
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, envelope[i]!);
    let onset = from;
    while (onset < to && envelope[onset]! < 0.1 * peak) onset++;
    let top = onset;
    while (top < to && envelope[top]! < 0.9 * peak) top++;
    rows.push({ shiftMs: (onset / RATE - expected) * 1000, riseMs: ((top - onset) / RATE) * 1000, peakDb: 20 * Math.log10(peak) });
  }
  return rows;
}

const mean = (rows: Kick[], key: keyof Kick) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;

describe("varispeed at the music.fit limit on percussive music", () => {
  const { samples, kicks } = percussion();
  const plain = measure(samples, kicks, 1);

  for (const speed of [1 + MUSIC_FIT_MAX_VARISPEED, 1 - MUSIC_FIT_MAX_VARISPEED]) {
    it(
      `atempo ${speed} keeps the hits in place, sharp and as loud, and tape resampling is the clean reference`,
      async () => {
        const stretched = measure(await filtered(samples, `atempo=${speed}`), kicks, speed);
        const tape = measure(await filtered(samples, `asetrate=${Math.round(RATE * speed)},aresample=${RATE}`), kicks, speed);
        const note = { atempo: { shiftMs: mean(stretched, "shiftMs"), riseMs: mean(stretched, "riseMs"), peakDb: mean(stretched, "peakDb") }, tape: { shiftMs: mean(tape, "shiftMs"), riseMs: mean(tape, "riseMs") } };
        // Every kick found at both ends of the file, none lost.
        expect(stretched.length).toBeGreaterThan(40);
        // Tape resampling: exactly where speed puts the hit, with the attack the signal has.
        expect(Math.abs(note.tape.shiftMs), JSON.stringify(note)).toBeLessThan(1.5);
        expect(note.tape.riseMs).toBeLessThan(mean(plain, "riseMs") + 1);
        // atempo starts up about 21 ms (1024 samples) early, the same for every hit, so it does not drift; it softens the
        // attack by a few ms and loses a fraction of a dB. All still inside what a frame (33 ms at 30 fps) hides.
        expect(note.atempo.shiftMs, JSON.stringify(note)).toBeGreaterThan(-30);
        expect(note.atempo.shiftMs).toBeLessThan(0);
        const spread = Math.max(...stretched.map((row) => row.shiftMs)) - Math.min(...stretched.map((row) => row.shiftMs));
        expect(spread).toBeLessThan(8);
        expect(note.atempo.riseMs).toBeLessThan(10);
        expect(mean(plain, "peakDb") - note.atempo.peakDb).toBeLessThan(1);
      },
      120_000,
    );
  }
});
