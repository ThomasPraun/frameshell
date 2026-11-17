import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, SPECTROGRAM_FLOOR_DB, SPECTROGRAM_MAX_COLUMNS, SPECTROGRAM_ROWS, spectrogram, startDaemon } from "../src/index.js";
import { wavOf } from "./beat-fixture.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seams under test: the spectrogram as data (`spectrogram`, pure) and `audio.inspect` through a real daemon (ADR 0038).

const RATE = 32_000;

function sine(hz: number, seconds: number, amplitude: number, rate = RATE): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
}

/** Row whose band holds `hz`. */
function rowOf(picture: ReturnType<typeof spectrogram>, hz: number): number {
  return Math.floor((Math.log(hz / picture.lowHz) / Math.log(picture.highHz / picture.lowHz)) * picture.rows);
}

describe("spectrogram", () => {
  it("shows a sine in the row of its frequency and nowhere far from it", () => {
    // Off the bin centres too. Below a few hundred Hz a 31 Hz bin spans several rows, so the low end is only checked for its loudest row.
    const low = spectrogram(sine(110, 1, 0.5), RATE).columns[100]!;
    expect(Math.abs(low.indexOf(Math.max(...low)) - rowOf(spectrogram(sine(110, 1, 0.5), RATE), 110))).toBeLessThanOrEqual(1);
    for (const hz of [1000, 1234, 5555]) {
      const picture = spectrogram(sine(hz, 1, 0.5), RATE);
      expect(picture).toMatchObject({ rows: SPECTROGRAM_ROWS, lowHz: 40, highHz: 16_000 });
      expect(picture.columns).toHaveLength(200);
      expect(picture.columnSeconds).toBeCloseTo(0.005, 6);
      const row = rowOf(picture, hz);
      // The first and last columns see the sine start and stop: a click is broadband.
      for (const column of picture.columns.slice(10, -10)) {
        const loudest = column.indexOf(Math.max(...column));
        expect(Math.abs(loudest - row)).toBeLessThanOrEqual(1);
        // Half scale is -6 dB; the Hann window loses at most 1.4 dB between two bins.
        expect(column[loudest]!).toBeGreaterThanOrEqual(-8);
        expect(column[loudest]!).toBeLessThanOrEqual(-5);
        const far = column.filter((_, index) => index < rowOf(picture, hz / 2) || index > rowOf(picture, hz * 2));
        expect(Math.max(...far)).toBeLessThan(-50);
      }
    }
  });

  it("puts silence on the floor and keeps long sounds to the column cap", () => {
    const quiet = spectrogram(new Float32Array(RATE), RATE);
    expect(quiet.columns.flat().every((value) => value === SPECTROGRAM_FLOOR_DB)).toBe(true);
    const long = spectrogram(sine(440, 30, 0.25), RATE);
    expect(long.columns).toHaveLength(SPECTROGRAM_MAX_COLUMNS);
    expect(long.columnSeconds).toBeCloseTo(30 / SPECTROGRAM_MAX_COLUMNS, 6);
    expect(spectrogram(new Float32Array(0), RATE).columns).toEqual([]);
  });

  it("stops the rows at the Nyquist frequency of a low rate", () => {
    expect(spectrogram(sine(1000, 0.2, 0.5, 16_000), 16_000).highHz).toBe(8000);
  });
});

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  root = join(tempDir(), "promo");
  await conn.request("project.init", { dir: root });
});

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("audio.inspect", () => {
  it(
    "reads loudness, the take mark and on request a spectrogram, and skips a file with no sound",
    async () => {
      const whoosh = await conn.request("sound.sfx", { cwd: root, kind: "whoosh", seed: 2 });
      const pop = await conn.request("sound.sfx", { cwd: root, kind: "pop", variant: 3, seed: 5 });
      mkdirSync(join(root, "assets", "music"), { recursive: true });
      writeFileSync(join(root, "assets", "music", "tone.wav"), wavOf(sine(440, 2, 1, 16_000), 16_000));
      writeFileSync(join(root, "assets", "notes.txt"), "not a sound");
      const files = [whoosh.file, pop.file, "assets/music/tone.wav", "assets/notes.txt"];

      const plain = await conn.request("audio.inspect", { cwd: root, assets: files });
      expect(methods["audio.inspect"].result.parse(plain)).toEqual(plain);
      expect(plain.items.map((item) => item.asset)).toEqual([whoosh.file, pop.file, "assets/music/tone.wav"]);
      expect(plain.items[0]).toMatchObject({ take: { kind: "whoosh", seed: 2, variant: 1, preset: null, bpm: null }, spectrogram: null });
      expect(plain.items[0]!.duration).toBeCloseTo(whoosh.duration, 2);
      expect(plain.items[1]!.take).toMatchObject({ kind: "pop", seed: 5, variant: 3 });
      // A pop is shorter than a 400 ms gating block: its loudness is that of the one block that holds it.
      expect(plain.items[1]!.duration!).toBeLessThan(0.4);
      expect(plain.items[1]!).toMatchObject({ shortSound: true, lufs: expect.any(Number) });
      expect(plain.items[1]!.lufs!).toBeLessThan(plain.items[0]!.lufs!);
      expect(plain.items[0]!.shortSound).toBe(false);
      // A half-scale 440 Hz sine: -6 dBFS, about -9 LUFS through K-weighting (a mono file counts once).
      expect(plain.items[2]).toMatchObject({ take: null });
      expect(plain.items[2]!.lufs).toBeGreaterThan(-12);
      expect(plain.items[2]!.lufs).toBeLessThan(-6);
      for (const item of plain.items.slice(0, 2)) expect(item.truePeak!).toBeLessThan(0);
      expect(plain.skipped).toEqual([{ asset: "assets/notes.txt", reason: expect.any(String) }]);

      const drawn = await conn.request("audio.inspect", { cwd: root, assets: ["assets/music/tone.wav", whoosh.file], spectrogram: true });
      const tone = drawn.items[0]!.spectrogram!;
      expect(tone).toMatchObject({ rows: SPECTROGRAM_ROWS, columns: expect.any(Array) });
      expect(tone.columns).toHaveLength(SPECTROGRAM_MAX_COLUMNS);
      const middle = tone.columns[200]!;
      expect(middle.indexOf(Math.max(...middle))).toBe(rowOf(spectrogram(new Float32Array(1), RATE), 440));
      expect(drawn.items[1]!.spectrogram!.columns.length).toBeGreaterThan(50);
      expect(drawn.items[1]!.lufs).toBe(plain.items[0]!.lufs);
    },
    120_000,
  );

  it("fails on a file that is not there", async () => {
    await expect(conn.request("audio.inspect", { cwd: root, assets: ["assets/missing.wav"] })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
  });
});
