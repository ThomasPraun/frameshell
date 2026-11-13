import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { CREDITS_FILE, EXACT_DETECTOR, MUSIC_LUFS, MUSIC_PEAK_DBFS, MUSIC_TAIL_SECONDS, type MusicSection, SOUND_RISER_END_BEFORE_MS, type Timeline, createCreditsFile, parseBeatsFile } from "@frameshell/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Daemon,
  type MusicRender,
  type MusicSpec,
  arrangeSections,
  defaultSections,
  integratedLoudness,
  limitPeaks,
  measureLoudness,
  musicFile,
  musicGrid,
  musicKey,
  musicMarkOf,
  parseChord,
  scoreOf,
  sectionStarts,
  startDaemon,
  synthesizeMusic,
} from "../src/index.js";
import { wavBytes } from "../src/transcripts/window.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";

// Seams under test: the sequencer and its grid (`synthesizeMusic`, `musicGrid`, `arrangeSections`), the loudness meter
// and limiter, and `sound.music` through a real in-process daemon: the take, its exact beats file, the placement in one
// transaction and the tempo (ADR 0038 slice 3).

const MEDIA_TIMEOUT = 120_000;
const SR = 48_000;

const spec = (overrides: Partial<MusicSpec> = {}): MusicSpec => ({
  preset: "synthwave",
  bpm: 120,
  meter: 4,
  sections: [{ kind: "full", bars: 2 }],
  chords: ["Am", "F", "C", "G"],
  seed: 1,
  accents: [],
  ...overrides,
});

const hashOf = (render: MusicRender) => {
  const hash = createHash("sha256");
  for (const channel of render.channels) hash.update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
  return hash.digest("hex").slice(0, 16);
};

/** RMS of both channels over [from, to) seconds, as a fraction of full scale. */
const rms = (render: MusicRender, from: number, to: number) => {
  let sum = 0;
  let count = 0;
  for (const channel of render.channels) {
    for (let i = Math.floor(from * SR); i < Math.min(channel.length, Math.ceil(to * SR)); i++) {
      sum += (channel[i]! / 8_388_607) ** 2;
      count += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
};

describe("musicGrid", () => {
  it("puts beat i at 60 i / bpm, through the final hit after the last bar, and the take rings after it", () => {
    const grid = musicGrid(spec({ bpm: 100, meter: 3, sections: [{ kind: "intro", bars: 1 }, { kind: "full", bars: 2 }] }));
    expect(grid.beats).toHaveLength(3 * 3 + 1);
    expect(grid.beats[1]).toBe(0.6);
    expect(grid.beats[7]).toBe(4.2);
    expect(grid.hitAt).toBe(5.4);
    expect(grid.duration).toBe(5.4 + MUSIC_TAIL_SECONDS);
  });

  it("lists the final hit, accents and the start of a drop or a gap as onsets", () => {
    const grid = musicGrid(spec({ sections: [{ kind: "full", bars: 1 }, { kind: "drop", bars: 1 }], accents: [2] }));
    expect(grid.onsets).toEqual([1, 2, 4]);
  });
});

describe("sections", () => {
  it("are intro, full, build, drop and outro by length when none are asked for", () => {
    expect(defaultSections(2)).toEqual([{ kind: "full", bars: 2 }]);
    expect(defaultSections(4)).toEqual([
      { kind: "intro", bars: 1 },
      { kind: "full", bars: 2 },
      { kind: "outro", bars: 1 },
    ]);
    expect(defaultSections(16)).toEqual([
      { kind: "intro", bars: 2 },
      { kind: "full", bars: 5 },
      { kind: "build", bars: 2 },
      { kind: "drop", bars: 5 },
      { kind: "outro", bars: 2 },
    ]);
    for (const bars of [1, 3, 7, 8, 9, 31, 128]) expect(defaultSections(bars).reduce((sum, section) => sum + section.bars, 0)).toBe(bars);
  });

  it("chain parts by their bars and start a part on its own bar, the last running to the end", () => {
    const parts = (...asked: { kind: MusicSection; bars?: number; startBar?: number }[]) => asked;
    expect(arrangeSections(10, parts({ kind: "intro", bars: 2 }, { kind: "full" , startBar: 2 }, { kind: "drop", startBar: 6 }))).toEqual([
      { kind: "intro", bars: 2 },
      { kind: "full", bars: 4 },
      { kind: "drop", bars: 4 },
    ]);
    expect(arrangeSections(null, parts({ kind: "intro", bars: 1 }, { kind: "outro", bars: 3 }))).toEqual([
      { kind: "intro", bars: 1 },
      { kind: "outro", bars: 3 },
    ]);
  });

  it("refuse parts that leave a gap in what is known, overlap, disagree with the length or start late", () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return [(error as RpcError).code, (error as Error).message];
      }
      return null;
    };
    expect(code(() => arrangeSections(8, [{ kind: "intro" }, { kind: "full" }]))).toEqual([ErrorCode.InvalidParams, expect.stringContaining("part 2 (full) needs `at`")]);
    expect(code(() => arrangeSections(8, [{ kind: "intro", bars: 4 }, { kind: "drop", startBar: 2 }]))).toEqual([ErrorCode.InvalidParams, expect.stringContaining("has `bars` 4")]);
    expect(code(() => arrangeSections(8, [{ kind: "intro" }, { kind: "full", startBar: 3 }, { kind: "drop", startBar: 2 }]))).toEqual([
      ErrorCode.InvalidParams,
      expect.stringContaining("part 3 (drop) starts on bar 3, not after part 2 (bar 4)"),
    ]);
    expect(code(() => arrangeSections(4, [{ kind: "intro", bars: 2 }, { kind: "outro", bars: 3 }]))).toEqual([ErrorCode.InvalidParams, expect.stringContaining("the track has 4 bars")]);
    expect(code(() => arrangeSections(4, [{ kind: "intro", startBar: 1 }]))).toEqual([ErrorCode.InvalidParams, expect.stringContaining("the first part starts the track")]);
    expect(code(() => arrangeSections(null, [{ kind: "intro" }]))).toEqual([ErrorCode.InvalidParams, expect.stringContaining("nothing says where the track ends")]);
  });
});

describe("parseChord", () => {
  it("reads a root, an accidental and a quality", () => {
    expect(parseChord("Am")).toEqual({ root: 9, intervals: [0, 3, 7], minor: true });
    expect(parseChord("F")).toMatchObject({ root: 5, minor: false });
    expect(parseChord("Bbmaj7")).toMatchObject({ root: 10, intervals: [0, 4, 7, 11] });
    expect(parseChord("C#m9")).toMatchObject({ root: 1, minor: true });
    expect(parseChord("Cb")).toMatchObject({ root: 11 });
    expect(parseChord("H7")).toBeNull();
    expect(parseChord("Amaj13")).toBeNull();
  });
});

describe("loudness", () => {
  it("reads a stereo 997 Hz sine of amplitude 0.1 as -20 LUFS", () => {
    const sine = Float64Array.from({ length: 3 * SR }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 997 * i) / SR));
    expect(integratedLoudness([sine, sine])).toBeCloseTo(-20, 1);
    expect(integratedLoudness([new Float64Array(SR), new Float64Array(SR)])).toBe(Number.NEGATIVE_INFINITY);
  });

  it("limits every sample to the ceiling and leaves quiet parts alone", () => {
    const signal = Float64Array.from({ length: SR }, (_, i) => (i === SR / 2 ? 2 : 0.2 * Math.sin((2 * Math.PI * 100 * i) / SR)));
    const [limited] = limitPeaks([signal], 0.5);
    expect(Math.max(...limited!.map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-12);
    expect(limited![1000]).toBeCloseTo(signal[1000]!, 12);
  });
});

// PCM hashes of 2 bars of `full` at 120 BPM, seed 1: a voice, the sequencer or a primitive that changes a sample fails here, and so does a machine whose Math functions differ.
const HASHES: Record<MusicSpec["preset"], string> = {
  synthwave: "1585f7fc0af4bad8",
  lofi: "c336cb4428da7ab4",
  minimal: "f32a6cb6e5beef3d",
};

describe("synthesizeMusic", () => {
  it.each(["synthwave", "lofi", "minimal"] as const)("renders %s as the same samples for the same spec, at -14 LUFS under a -1 dBFS peak", (preset) => {
    const render = synthesizeMusic(spec({ preset }));
    expect(hashOf(render)).toBe(HASHES[preset]);
    expect(render.channels).toHaveLength(2);
    expect(render.channels[0]!.length).toBe(Math.round((4 + MUSIC_TAIL_SECONDS) * SR));
    expect(Math.abs(render.lufs - MUSIC_LUFS)).toBeLessThanOrEqual(0.15);
    expect(render.peakDb).toBeLessThanOrEqual(MUSIC_PEAK_DBFS + 0.01);
    // The ring after the final hit fades to silence.
    expect(Math.abs(render.channels[0]![render.channels[0]!.length - 1]!)).toBeLessThan(100);
  });

  it("gives another track for another seed, tempo or chords", () => {
    const base = hashOf(synthesizeMusic(spec()));
    expect(hashOf(synthesizeMusic(spec({ seed: 2 })))).not.toBe(base);
    expect(hashOf(synthesizeMusic(spec({ chords: ["Dm", "G"] })))).not.toBe(base);
  });

  it("stops after the hit of a gap so the next downbeat lands hard, and ends a build's riser 75 ms before the next part", () => {
    const parts = spec({ sections: [{ kind: "full", bars: 1 }, { kind: "gap", bars: 1 }, { kind: "build", bars: 1 }, { kind: "drop", bars: 1 }] });
    const render = synthesizeMusic(parts);
    // Bars are 2 s: full 0-2, gap 2-4 (its hit rings out), build 4-6, drop 6-8.
    expect(rms(render, 3.5, 4)).toBeLessThan(rms(render, 0.5, 1.5) / 8);
    expect(rms(render, 6, 6.2)).toBeGreaterThan(rms(render, 3.8, 4) * 4);
    const gap = scoreOf(parts).filter((note) => note.time >= 2 && note.time < 4);
    expect(new Set(gap.map((note) => note.time))).toEqual(new Set([2]));
    const riser = scoreOf(parts).find((note) => note.voice === "riser")!;
    expect(riser.time).toBe(4);
    expect(riser.time + (riser as { length: number }).length).toBeCloseTo(6 - SOUND_RISER_END_BEFORE_MS / 1000, 9);
    expect(sectionStarts(parts).map((part) => part.start)).toEqual([0, 2, 4, 6]);
  });

  it("puts a crash and a big kick on accents, on the first beat of a drop and on the final hit", () => {
    const hits = scoreOf(spec({ sections: [{ kind: "full", bars: 1 }, { kind: "drop", bars: 1 }], accents: [3] })).filter((note) => note.voice === "crash");
    expect(hits.map((note) => note.time).sort((a, b) => a - b)).toEqual([1.5, 2, 4]);
  });

  it("is measured at its own loudness by ffmpeg's ebur128", async () => {
    const render = synthesizeMusic(spec({ preset: "lofi", sections: [{ kind: "full", bars: 3 }] }));
    const path = join(tempDir(), "music.wav");
    writeFileSync(path, wavBytes({ sampleRate: SR, bits: 24, channels: render.channels }));
    const reading = await measureLoudness((await mediaTools()).ffmpeg, path);
    expect(reading!.integrated).not.toBeNull();
    expect(Math.abs(reading!.integrated! - render.lufs)).toBeLessThanOrEqual(0.3);
  }, MEDIA_TIMEOUT);
});

describe("music takes", () => {
  it("key every part of the spec and are named by preset and key", () => {
    const key = musicKey(spec());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const other of [{ preset: "lofi" }, { bpm: 121 }, { meter: 3 }, { sections: [{ kind: "drop", bars: 2 }] }, { chords: ["Am"] }, { seed: 2 }, { accents: [1] }] as Partial<MusicSpec>[]) {
      expect(musicKey(spec(other))).not.toBe(key);
    }
    expect(musicFile("lofi", key)).toBe(`assets/sound/music-lofi-${key.slice(0, 8)}.wav`);
  });
});

let daemon: Daemon;
let conn: DaemonConnection;
let root: string;

beforeEach(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  root = join(tempDir(), "promo");
  await conn.request("project.init", { dir: root });
}, 60_000);

afterEach(async () => {
  conn.close();
  await daemon.close();
});

const music = (params: Record<string, unknown> = {}, options = {}) => conn.request("sound.music", { cwd: root, preset: "minimal", bpm: 120, bars: 2, ...params } as never, options);
const timeline = (): Timeline => JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")) as Timeline;
const rejection = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
};

describe("sound.music take", () => {
  it("writes a marked 24-bit stereo take, imports it and writes its exact beat grid beside it", async () => {
    const result = await music({ place: false, chords: ["Dm", "Bb"] });
    expect(result).toMatchObject({
      state: "generated",
      preset: "minimal",
      bpm: 120,
      meter: 4,
      bars: 2,
      seed: 0,
      chords: ["Dm", "Bb"],
      sections: [{ kind: "full", bars: 2, start: 0 }],
      hitAt: 4,
      duration: 4 + MUSIC_TAIL_SECONDS,
      timeline: null,
      tx: null,
      clip: null,
      tempo: null,
      credited: false,
    });
    expect(result.file).toMatch(/^assets\/sound\/music-minimal-[0-9a-f]{8}\.wav$/);
    expect(Math.abs(result.lufs - MUSIC_LUFS)).toBeLessThanOrEqual(0.15);
    expect(result.imported.map((entry) => entry.asset)).toEqual([result.file]);
    const bytes = readFileSync(join(root, result.file));
    expect(bytes.readUInt16LE(22)).toBe(2);
    expect(bytes.readUInt16LE(34)).toBe(24);
    expect(musicMarkOf(bytes)).toMatchObject({ kind: "music", preset: "minimal", bpm: 120, hitAt: 4, chords: ["Dm", "Bb"] });

    expect(result.beats).toEqual({ file: `${result.file.replace(/^assets\//, "beats/").replace(/\.wav$/, "")}.beats.json`, state: "written", count: 9 });
    const parsed = parseBeatsFile(JSON.parse(readFileSync(join(root, result.beats.file), "utf8")));
    expect(parsed.ok && parsed.value).toMatchObject({
      asset: result.file,
      assetHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      detector: EXACT_DETECTOR,
      bpm: 120,
      meter: 4,
      downbeat: 0,
      confidence: 1,
      beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
      onsets: [4],
    });
    const shown = await conn.request("beats.show", { cwd: root, asset: result.file });
    expect(shown).toMatchObject({ current: true, detector: "exact", low: false, beatCount: 9 });
  }, MEDIA_TIMEOUT);

  it("reuses the same take and keeps its grid with the person's edits, and writes another for other arguments", async () => {
    const first = await music({ place: false });
    const grid = join(root, first.beats.file);
    const edited = { ...JSON.parse(readFileSync(grid, "utf8")), edits: { offset: 0.01 } };
    writeFileSync(grid, `${JSON.stringify(edited, null, 2)}\n`);
    const again = await music({ place: false });
    expect(again).toMatchObject({ file: first.file, state: "cached", imported: [], lufs: first.lufs, hitAt: first.hitAt, beats: { state: "kept" } });
    expect(JSON.parse(readFileSync(grid, "utf8")).edits).toEqual({ offset: 0.01 });
    expect((await music({ place: false, seed: 3 })).file).not.toBe(first.file);
  }, MEDIA_TIMEOUT);

  it("never overwrites a file of that name that it did not write", async () => {
    const { file } = await music({ place: false });
    writeFileSync(join(root, file), "mine");
    expect(await rejection(music({ place: false }))).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("never overwritten") });
    expect(readFileSync(join(root, file), "utf8")).toBe("mine");
  }, MEDIA_TIMEOUT);

  it("records the take as own work only when the project keeps a ledger", async () => {
    expect((await music({ place: false })).credited).toBe(false);
    expect(existsSync(join(root, CREDITS_FILE))).toBe(false);
    writeFileSync(join(root, CREDITS_FILE), `${JSON.stringify(createCreditsFile(), null, 2)}\n`);
    const result = await music({ place: false });
    expect(result.credited).toBe(true);
    const ledger = JSON.parse(readFileSync(join(root, CREDITS_FILE), "utf8")) as { assets: { asset: string; licence: string; author: string }[] };
    expect(ledger.assets).toEqual([expect.objectContaining({ asset: result.file, licence: "own", author: "Frameshell sound synth" })]);
  }, MEDIA_TIMEOUT);

  it("refuses a length it cannot go by and parts that disagree", async () => {
    expect(await rejection(music({ bars: undefined, place: false }))).toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("nothing to go by") });
    expect(await rejection(music({ length: 10 }))).toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("not both") });
    expect(await rejection(music({ sections: [{ kind: "intro", bars: 3 }] }))).toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("the track has 2 bars") });
    expect(await rejection(music({ bars: 128, bpm: 50 }))).toMatchObject({ code: ErrorCode.InvalidParams, message: expect.stringContaining("at most") });
    expect(await rejection(music({ chords: ["H"] }))).toMatchObject({ code: ErrorCode.InvalidParams });
    expect(await rejection(music({ accents: ["nowhere"] }))).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("nowhere") });
  }, MEDIA_TIMEOUT);
});

describe("sound.music placement", () => {
  it("puts the take on a new Music track in one transaction, under the voice, with the tempo following it; revert undoes it", async () => {
    const result = await music({ at: 1 });
    expect(result).toMatchObject({ timeline: "main", start: 1, gain: -12, tempo: "set", track: { name: "Music", created: true } });
    const after = timeline();
    const track = after.tracks.find((candidate) => candidate.id === result.track!.id)!;
    expect(track).toMatchObject({ kind: "audio", name: "Music" });
    expect(track.kind !== "subtitles" && track.clips).toEqual([expect.objectContaining({ id: result.clip, asset: result.file, start: 1, audio: { gain: -12 } })]);
    expect(after.tempo).toEqual({ clip: result.clip });
    const shown = (await conn.request("tempo.show", { cwd: root })) as unknown as { grid: { beats: number[]; bars: number[]; bpm: number } };
    expect(shown.grid.bpm).toBe(120);
    expect(shown.grid.beats.slice(0, 3)).toEqual([1, 1.5, 2]);
    expect(shown.grid.bars.slice(0, 2)).toEqual([1, 3]);

    const { transactions } = await conn.request("history", { cwd: root });
    const tx = transactions.find((entry) => entry.tx === result.tx)!;
    expect(tx.label).toBe("Music: minimal 120 BPM, 2 bars");
    expect(tx.operations.map((operation) => operation.op)).toEqual(["track.add", "clip.add", "tempo.set"]);
    await conn.request("revert", { cwd: root, target: result.tx! });
    expect(timeline().tempo).toBeUndefined();
    expect(timeline().tracks.some((candidate) => candidate.id === result.track!.id)).toBe(false);
  }, MEDIA_TIMEOUT);

  it("covers the timeline when no length is given, starts a part on a marker, and puts a second bed on Music 2 keeping the tempo", async () => {
    await conn.request("marker.add", { cwd: root, at: 4, label: "reveal" });
    await conn.request("track.add", { cwd: root, kind: "audio", name: "Pad" });
    const pad = timeline().tracks.find((candidate) => candidate.name === "Pad")!.id;
    // A 12 s timeline: something on it that ends at 12 s.
    const bed = await music({ bars: 6, place: true, track: pad });
    expect(bed.track).toMatchObject({ id: pad, created: false });
    const cover = await music({ bars: undefined, sections: [{ kind: "intro" }, { kind: "drop", at: "reveal" }], seed: 2 });
    expect(cover.bars).toBe(Math.round((12 + MUSIC_TAIL_SECONDS) / 2));
    expect(cover.sections).toEqual([
      { kind: "intro", bars: 2, start: 0 },
      { kind: "drop", bars: cover.bars - 2, start: 4 },
    ]);
    expect(cover).toMatchObject({ tempo: "kept", track: { name: "Music", created: true } });
    expect(cover.warnings.join("\n")).toContain("tempo still follows");
    const third = await music({ bars: 2, seed: 4 });
    expect(third.track).toMatchObject({ name: "Music 2", created: true });
    expect(await rejection(music({ bars: 2, seed: 5, track: pad }))).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("already has a clip") });
  }, MEDIA_TIMEOUT);

  it("is one proposal in review mode", async () => {
    const ui = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
    try {
      await ui.request("review.set", { cwd: root, enabled: true });
      const before = readFileSync(join(root, "timelines", "main.json"), "utf8");
      const result = await music();
      expect(readFileSync(join(root, "timelines", "main.json"), "utf8")).toBe(before);
      const { proposal } = await conn.request("proposal.status", { cwd: root });
      expect(proposal).toMatchObject({ tx: result.tx, label: "Music: minimal 120 BPM, 2 bars", operations: 3, state: "ready" });
      await ui.request("proposal.accept", { cwd: root, tx: result.tx! });
      expect(timeline().tempo).toEqual({ clip: result.clip });
    } finally {
      ui.close();
    }
  }, MEDIA_TIMEOUT);

  it("replays a retried request from its idempotency key", async () => {
    const key = "music-retry-0001";
    const first = await music({}, { idempotencyKey: key });
    expect(await music({}, { idempotencyKey: key })).toEqual(first);
    expect(timeline().tracks.filter((candidate) => candidate.kind === "audio")).toHaveLength(1);
  }, MEDIA_TIMEOUT);

  it("gives music.fit a final hit it finds and lands on a cut", async () => {
    const result = await music({ preset: "synthwave", bars: 4, sections: [{ kind: "full", bars: 3 }, { kind: "outro", bars: 1 }] });
    await conn.request("marker.add", { cwd: root, at: 12, label: "end-card" });
    const fit = await conn.request("music.fit", { cwd: root, timeline: "main", clip: result.clip!, end: "end-card", dryRun: true });
    expect(Math.abs(fit.hit.at - result.hitAt)).toBeLessThanOrEqual(0.02);
    expect(fit.hit.confidence).toBeGreaterThanOrEqual(0.5);
    expect(fit.after.start).toBeCloseTo(12 - result.hitAt, 2);
  }, MEDIA_TIMEOUT);
});

