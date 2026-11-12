import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { effectiveBeatGrid, parseBeatsFile } from "@frameshell/schema";
import {
  BEATS_CACHE_DIR,
  BeatsStore,
  beatsCacheKey,
  beatsPathsFor,
  classifyBeatsCache,
  formatBeatsFile,
  ownBeatsFile,
  resolveBeatsFile,
} from "../src/index.js";
import { beatsFileOf } from "../src/media/beats-store.js";
import { clickTrack, wavOf } from "./beat-fixture.js";

// Seam under test: BeatsStore.measure(root, asset), the beats file and the cache classes around it.
// The sidecar path reads raw PCM without ffmpeg; the fallback path gets an injected decoder.

const HASH = `sha256:${"cd".repeat(32)}`;
const noFfmpeg = async (): Promise<string> => {
  throw new Error("ffmpeg must not run");
};

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-beats-")));
  mkdirSync(join(root, "assets"));
  return root;
}

/** A project holding a 20 s, 120 BPM click track as a raw 48 kHz sidecar, and a store reading it. */
function withSidecar() {
  const root = project();
  const samples = clickTrack({ bpm: 120, seconds: 20, offset: 0.2 });
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => pcm.writeInt16LE(Math.round(value * 16384), i * 2));
  mkdirSync(join(root, ".frameshell", "proxies"), { recursive: true });
  writeFileSync(join(root, ".frameshell", "proxies", "loop.pcm"), pcm);
  writeFileSync(join(root, "assets", "loop.wav"), "not read: the sidecar is");
  const sidecar = { path: ".frameshell/proxies/loop.pcm", format: "s16le" as const, sampleRate: 48_000, channels: 1 };
  return { root, store: new BeatsStore({ derivedAudio: async () => ({ hash: HASH, sidecar }), ffmpeg: noFfmpeg }) };
}

describe("BeatsStore", () => {
  it("measures the sidecar in a worker, caches the onset envelope and reuses it for another hint", async () => {
    const { root, store } = withSidecar();
    const progress: number[] = [];
    const first = await store.measure(root, "assets/loop.wav", { onProgress: (fraction) => progress.push(fraction) });
    expect(first).toMatchObject({ hash: HASH, sampleRate: 48_000, cached: false });
    expect(first.analysis.bpm).toBeCloseTo(120, 0);
    expect(first.analysis.beats[0]).toBeCloseTo(0.2, 2);
    expect(progress.length).toBeGreaterThan(0);
    const cache = readdirSync(join(root, ...BEATS_CACHE_DIR.split("/")));
    expect(cache).toEqual([`${beatsCacheKey(HASH)}-22050.f32`]);

    const again = await store.measure(root, "assets/loop.wav", { hint: 120 });
    expect(again.cached).toBe(true);
    expect(again.analysis).toEqual(first.analysis);
  });

  it("decodes an asset without sidecar at 16 kHz and caps the confidence", async () => {
    const root = project();
    writeFileSync(join(root, "assets", "loop.wav"), "decoded by the stand-in below");
    const decoded = wavOf(clickTrack({ bpm: 100, seconds: 20, offset: 0.1, rate: 16_000 }), 16_000);
    const store = new BeatsStore({
      derivedAudio: async () => ({ hash: HASH, sidecar: null }),
      ffmpeg: noFfmpeg,
      extractAudio: async (_input, output) => writeFileSync(output, decoded),
    });
    const measured = await store.measure(root, "assets/loop.wav");
    expect(measured.sampleRate).toBe(16_000);
    expect(measured.analysis.bpm).toBeCloseTo(100, 0);
    expect(measured.analysis.confidence).toBeLessThan(0.5);
    expect(readdirSync(join(root, ...BEATS_CACHE_DIR.split("/")))).toEqual([`${beatsCacheKey(HASH)}-16000.f32`]);
  });

  it("refuses silence as InvalidOperation `no beats`", async () => {
    const root = project();
    mkdirSync(join(root, ".frameshell"), { recursive: true });
    writeFileSync(join(root, ".frameshell", "quiet.pcm"), Buffer.alloc(48_000 * 2 * 8));
    const sidecar = { path: ".frameshell/quiet.pcm", format: "s16le" as const, sampleRate: 48_000, channels: 1 };
    const store = new BeatsStore({ derivedAudio: async () => ({ hash: HASH, sidecar }), ffmpeg: noFfmpeg });
    await expect(store.measure(root, "assets/quiet.wav")).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ reason: "no beats" }),
    });
  });

  it("stops when the signal aborts", async () => {
    const { root, store } = withSidecar();
    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    await expect(store.measure(root, "assets/loop.wav", { signal: controller.signal })).rejects.toThrow("canceled");
  });
});

describe("beats files", () => {
  it("name the file after the asset and keep the extension only when a sibling owns the short name", async () => {
    expect(beatsPathsFor("assets/music/theme.mp3")).toEqual(["beats/music/theme.beats.json", "beats/music/theme.mp3.beats.json"]);
    const { root, store } = withSidecar();
    const measured = await store.measure(root, "assets/loop.wav");
    const text = (asset: string) => formatBeatsFile(beatsFileOf({ asset, measured, previous: null, keepEdits: true }));
    mkdirSync(join(root, "beats"));
    writeFileSync(join(root, "beats", "loop.beats.json"), text("assets/loop.mp3"));
    // The short name belongs to loop.mp3, so loop.wav gets the long one; loop.mp3 still finds its own.
    expect(await resolveBeatsFile(root, "assets/loop.wav")).toMatchObject({ rel: "beats/loop.wav.beats.json", previous: null });
    expect(await ownBeatsFile(root, "assets/loop.mp3")).toMatchObject({ rel: "beats/loop.beats.json" });
    expect(await ownBeatsFile(root, "assets/loop.wav")).toBeNull();
    writeFileSync(join(root, "beats", "loop.wav.beats.json"), text("assets/loop.ogg"));
    await expect(resolveBeatsFile(root, "assets/loop.wav")).rejects.toMatchObject({ data: expect.objectContaining({ reason: "name taken" }) });
  });

  it("refuse a broken file instead of measuring over its edits", async () => {
    const root = project();
    mkdirSync(join(root, "beats"));
    writeFileSync(join(root, "beats", "song.beats.json"), '{"asset": 1}');
    await expect(resolveBeatsFile(root, "assets/song.wav")).rejects.toMatchObject({ code: ErrorCode.InvalidProjectFile });
  });

  it("are written with wrapped number rows, read back whole, and carry the human edits over a new measure", async () => {
    const { root, store } = withSidecar();
    const measured = await store.measure(root, "assets/loop.wav");
    const base = beatsFileOf({ asset: "assets/loop.wav", measured, previous: null, keepEdits: true });
    const edited = { ...base, edits: { tempo: "half" as const, offset: 0.01 } };
    const text = formatBeatsFile(edited);
    expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(104);
    const parsed = parseBeatsFile(JSON.parse(text));
    expect(parsed).toMatchObject({ ok: true, value: { asset: "assets/loop.wav", edits: { tempo: "half", offset: 0.01 }, beats: edited.beats, onsets: edited.onsets } });
    const kept = beatsFileOf({ asset: "assets/loop.wav", measured, previous: edited, keepEdits: true });
    const reset = beatsFileOf({ asset: "assets/loop.wav", measured, previous: edited, keepEdits: false });
    expect(kept.edits).toEqual({ tempo: "half", offset: 0.01 });
    expect(reset.edits).toEqual({});
    expect(effectiveBeatGrid(kept).bpm).toBeCloseTo(60, 0);
  });
});

describe("classifyBeatsCache", () => {
  it("knows envelopes of any rate by their content key, and temps; anything else is kept", () => {
    const key = beatsCacheKey(HASH);
    expect(classifyBeatsCache(`${key}-22050.f32`, false)).toEqual({ kind: "beats", key });
    expect(classifyBeatsCache(`${key}-16000.f32`, false)).toEqual({ kind: "beats", key });
    expect(classifyBeatsCache(`${key}-22050.f32.123.ab12.tmp`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyBeatsCache(".decode-1a2b3c4d.wav", false)).toEqual({ kind: "temp", key: null });
    expect(classifyBeatsCache(`${"ab".repeat(10)}-b9-22050.f32`, false)).toEqual({ kind: "beats", key: `${"ab".repeat(10)}-b9` });
    expect(classifyBeatsCache("notes.txt", false)).toBeNull();
    expect(classifyBeatsCache(key, true)).toBeNull();
  });
});
