import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type AudioEffect, type ExportPreset, type MediaClip, type Timeline, VOICE_CHAIN, bakeRef } from "@frameshell/schema";
import {
  AUDIO_FX_DIR,
  AudioFxService,
  DENOISE_LATENCY_SAMPLES,
  SWEEP_MAX_STEPS,
  audioFxArgs,
  audioFxCacheKey,
  audioFxFilter,
  classifyAudioFx,
  compileRender,
  executeRender,
  sidecarArgs,
  sweepCommands,
} from "../src/index.js";
import { JobQueue } from "../src/jobs/queue.js";
import { hashFile } from "../src/media/store.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Real managed ffmpeg on synthetic sound: the bake is proven by measuring what it and an export of it hold.
const MEDIA_TIMEOUT = 180_000;
const RATE = 48_000;

let dir: string;
let ffmpeg: string;

/** Stereo WAV of `seconds`: a 1 kHz tone at 0.2 plus 40 Hz rumble at 0.2. */
async function toneWithRumble(path: string, seconds: number): Promise<void> {
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `aevalsrc=0.2*sin(2*PI*1000*t)+0.2*sin(2*PI*40*t):s=${RATE}:d=${seconds}`],
    ...["-ac", "2", "-c:a", "pcm_s16le", path],
  ]);
}

/** Raw s16le mono samples of `path` as floats. */
function samples(bytes: Buffer): Float64Array {
  const out = new Float64Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}

/** Amplitude of the `frequency` component of `x` (Goertzel over whole periods of the window). */
function amplitude(x: Float64Array, frequency: number, from: number, length: number): number {
  const w = (2 * Math.PI * frequency) / RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < from + length; i++) {
    const s0 = x[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / length;
}

const db = (ratio: number) => 20 * Math.log10(ratio);

beforeAll(async () => {
  dir = tempDir();
  ({ ffmpeg } = await mediaTools());
  mkdirSync(join(dir, "assets"), { recursive: true });
  await toneWithRumble(join(dir, "assets", "voice.wav"), 3);
  // A 0.5 s chirp at 1 s on silence, for timing: its cross-correlation has one clear peak.
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `aevalsrc='if(between(t,1,1.5),0.5*sin(2*PI*(200*(t-1)+1600*(t-1)*(t-1))),0)':s=${RATE}:d=2`],
    ...["-ac", "1", "-c:a", "pcm_s16le", join(dir, "assets", "chirp.wav")],
  ]);
}, MEDIA_TIMEOUT);

/** Lag of `b` behind `a` in samples, -`range` to `range`, by cross-correlation over the chirp. */
function lag(a: Float64Array, b: Float64Array, range: number): number {
  let best = 0;
  let score = Number.NEGATIVE_INFINITY;
  for (let k = -range; k <= range; k++) {
    let sum = 0;
    for (let i = RATE; i < 1.5 * RATE; i++) sum += a[i]! * (b[i + k] ?? 0);
    if (sum > score) [best, score] = [k, sum];
  }
  return best;
}

describe("audio effects bake", () => {
  it("keeps the sidecar's length and clock: denoise latency is padded and trimmed away", async () => {
    const input = join(dir, "assets", "chirp.wav");
    await run(ffmpeg, sidecarArgs(input, join(dir, "chirp.dry.pcm")));
    await run(ffmpeg, audioFxArgs(input, join(dir, "chirp.denoise.pcm"), [{ kind: "denoise" }, { kind: "denoise", reduction: 12 }]));
    await run(ffmpeg, audioFxArgs(input, join(dir, "chirp.voice.pcm"), VOICE_CHAIN));
    const dry = samples(readFileSync(join(dir, "chirp.dry.pcm")));
    const denoised = samples(readFileSync(join(dir, "chirp.denoise.pcm")));
    expect(denoised.length).toBe(dry.length);
    expect(samples(readFileSync(join(dir, "chirp.voice.pcm"))).length).toBe(dry.length);
    // Two denoise stages would delay by 2 x DENOISE_LATENCY_SAMPLES; compensated, the chirp plays where it did.
    expect(lag(dry, denoised, 3000)).toBe(0);
  }, MEDIA_TIMEOUT);

  it("pins afftdn's own delay on the managed ffmpeg (DENOISE_LATENCY_SAMPLES)", async () => {
    const input = join(dir, "assets", "chirp.wav");
    const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", input, "-af", "afftdn=nf=-30:nr=8", "-f", "s16le", "-ac", "1", "-"]);
    const dry = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", input, "-f", "s16le", "-ac", "1", "-"]);
    expect(lag(samples(dry), samples(raw), 3000)).toBe(DENOISE_LATENCY_SAMPLES);
    expect(audioFxFilter([{ kind: "denoise" }, { kind: "denoise" }])).toContain(`apad=pad_len=${2 * DENOISE_LATENCY_SAMPLES}`);
  }, MEDIA_TIMEOUT);

  it("exports a high-passed clip with the rumble under 80 Hz measured at least 10 dB lower against the tone", async () => {
    const TINY: ExportPreset = {
      id: "tiny",
      container: "mp4",
      video: { codec: "h264", width: 64, height: 64, crf: 30 },
      audio: { codec: "aac", bitrateKbps: 192, sampleRate: RATE },
    };
    const clip = (effects?: AudioEffect[]): MediaClip => ({
      id: "c_voice",
      type: "media",
      asset: "assets/voice.wav",
      start: 0,
      in: 0,
      out: 3,
      ...(effects ? { audio: { effects } } : {}),
    });
    const timeline = (effects?: AudioEffect[]): Timeline => ({ schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "a1", kind: "audio", clips: [clip(effects)] }] });
    const source = { path: join(dir, "assets", "voice.wav"), video: null, audio: true };
    const effects: AudioEffect[] = [{ kind: "highpass", frequency: 85 }];
    const service = new AudioFxService({
      jobs: new JobQueue(),
      hash: async (root, rel) => hashFile(join(root, rel), statSync(join(root, rel)).size),
      hasAudio: async () => true,
      ffmpeg: async () => ffmpeg,
      timelines: async () => ["main"],
      flattened: async () => timeline(effects),
    });
    const audioFx = await service.ensure(dir, timeline(effects));
    const ratios: number[] = [];
    for (const [name, line] of [
      ["dry", timeline()],
      ["fx", timeline(effects)],
    ] as const) {
      const plan = compileRender({
        timeline: line,
        fps: 30,
        preset: TINY,
        loudness: -16,
        sources: new Map([["assets/voice.wav", source]]),
        resolution: { width: 64, height: 64 },
        audioFx,
      });
      // An audio-only timeline also gets the black first frame warning (platform thumbnail); only effects matter here.
      expect(plan.warnings.filter((warning) => /audio effects/.test(warning))).toEqual([]);
      const output = join(dir, `${name}.mp4`);
      await executeRender(plan, { ffmpeg, workDir: join(dir, `work-${name}`), output });
      const decoded = samples(await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]));
      // Middle second: whole periods of both 40 Hz and 1 kHz, clear of the edge fades and the encoder's priming.
      ratios.push(amplitude(decoded, 40, RATE, RATE) / amplitude(decoded, 1000, RATE, RATE));
    }
    const [dry, fx] = ratios as [number, number];
    expect(db(dry)).toBeGreaterThan(-2);
    expect(db(fx) - db(dry)).toBeLessThan(-10);
  }, MEDIA_TIMEOUT);
});

describe("swept high-pass bake (ADR 0037 slice 6)", () => {
  // 60 Hz bass under a 1 kHz tone for 8 s, 0.2 each; the build runs from 2 s to 4 s, 40 to 300 Hz, and the drop is at 4 s.
  const build: AudioEffect = { kind: "highpassSweep", from: 2, to: 4, startHz: 40, endHz: 300 };
  const WINDOW = 9600;
  /** 60 Hz against 1 kHz, in dB, over the 0.2 s window starting at `at` seconds (12 whole periods of 60 Hz). */
  const bass = (x: Float64Array, at: number) => db(amplitude(x, 60, Math.round(at * RATE), WINDOW) / amplitude(x, 1000, Math.round(at * RATE), WINDOW));

  async function bake(effects: AudioEffect[], name: string): Promise<{ dry: Float64Array; baked: Float64Array; bytes: Buffer }> {
    const input = join(dir, "assets", "bass.wav");
    if (!existsSync(input)) {
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", `aevalsrc=0.2*sin(2*PI*1000*t)+0.2*sin(2*PI*60*t):s=${RATE}:d=8`],
        ...["-ac", "1", "-c:a", "pcm_s16le", input],
      ]);
    }
    await run(ffmpeg, sidecarArgs(input, join(dir, `${name}.dry.pcm`)));
    await run(ffmpeg, audioFxArgs(input, join(dir, `${name}.pcm`), effects));
    const bytes = readFileSync(join(dir, `${name}.pcm`));
    return { dry: samples(readFileSync(join(dir, `${name}.dry.pcm`))), baked: samples(bytes), bytes };
  }

  it("lowers the low band more and more through the build, and brings it back whole at the drop", async () => {
    const { dry, baked } = await bake([build], "sweep");
    expect(baked.length).toBe(dry.length);
    const before = bass(baked, 1.0) - bass(dry, 1.0);
    const climb = [2.0, 2.8, 3.4, 3.8].map((at) => bass(baked, at) - bass(dry, at));
    const after = bass(baked, 4.3) - bass(dry, 4.3);
    // Out of the signal before the build and from the drop on: the same bass as the dry sound.
    expect(Math.abs(before)).toBeLessThan(0.5);
    expect(Math.abs(after)).toBeLessThan(0.5);
    // Each window is lower than the one before; by the end, the cutoff near 270 Hz takes the 60 Hz bass down by 15 dB or more.
    for (let i = 1; i < climb.length; i++) expect(climb[i]!).toBeLessThan(climb[i - 1]! - 1);
    expect(climb[3]!).toBeLessThan(-15);
    // The tone well above the cutoff is not touched anywhere.
    for (const at of [1.0, 3.8, 4.3]) expect(Math.abs(db(amplitude(baked, 1000, Math.round(at * RATE), WINDOW) / amplitude(dry, 1000, Math.round(at * RATE), WINDOW)))).toBeLessThan(0.3);
  }, MEDIA_TIMEOUT);

  it("is deterministic and keeps the sidecar's clock behind a denoise, whose delay shifts the commands", async () => {
    const first = await bake([build], "sweep-a");
    const second = await bake([build], "sweep-b");
    expect(second.bytes.equals(first.bytes)).toBe(true);
    const chain = await bake([{ kind: "denoise" }, build], "sweep-denoise");
    expect(chain.baked.length).toBe(chain.dry.length);
  }, MEDIA_TIMEOUT);

  it("writes the commands on the asset clock, shifted by the denoises before it, in at most 64 steps", () => {
    const sweep = { kind: "highpassSweep", from: 2, to: 4, startHz: 40, endHz: 300 } as const;
    const plain = sweepCommands(sweep, "highpass@sw0", 0).split(";");
    expect(plain).toHaveLength(SWEEP_MAX_STEPS);
    expect(plain[0]).toBe("2 highpass@sw0 frequency 40");
    expect(Number(plain.at(-1)!.split(" ").at(-1))).toBeLessThan(300);
    const hz = plain.map((command) => Number(command.split(" ").at(-1)));
    expect([...hz].sort((a, b) => a - b)).toEqual(hz);
    expect(sweepCommands(sweep, "highpass@sw0", 0.025).split(";")[0]).toBe("2.025 highpass@sw0 frequency 40");
    expect(sweepCommands({ ...sweep, to: 2.1 }, "x", 0).split(";")).toHaveLength(5);
    expect(audioFxFilter([build])).toContain("enable='gte(t,2)*lt(t,4)'");
    expect(audioFxFilter([{ kind: "denoise" }, build])).toContain("enable='gte(t,2.025)*lt(t,4.025)'");
    expect(audioFxFilter([{ kind: "highpass" }, build])).toContain("enable='gte(t,2)*lt(t,4)'");
  });

  it("names each sweep's filter by its place in the chain, so two builds do not share one", () => {
    const filter = audioFxFilter([build, { kind: "highpassSweep", from: 6, to: 7 }]);
    expect(filter).toContain("highpass@sw0=f=40");
    expect(filter).toContain("highpass@sw1=f=40");
    expect(filter).toContain("6 highpass@sw1 frequency 40");
  });

  it("exports the swept clip with the low band down in the build and back after it, like the bake", async () => {
    const TINY: ExportPreset = {
      id: "tiny",
      container: "mp4",
      video: { codec: "h264", width: 64, height: 64, crf: 30 },
      audio: { codec: "aac", bitrateKbps: 192, sampleRate: RATE },
    };
    const timeline = (effects?: AudioEffect[]): Timeline => ({
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [{ id: "a1", kind: "audio", clips: [{ id: "c_bass", type: "media", asset: "assets/bass.wav", start: 0, in: 0, out: 8, ...(effects ? { audio: { effects } } : {}) }] }],
    });
    const source = { path: join(dir, "assets", "bass.wav"), video: null, audio: true };
    const service = new AudioFxService({
      jobs: new JobQueue(),
      hash: async (root, rel) => hashFile(join(root, rel), statSync(join(root, rel)).size),
      hasAudio: async () => true,
      ffmpeg: async () => ffmpeg,
      timelines: async () => ["main"],
      flattened: async () => timeline([build]),
    });
    await bake([], "export-fixture");
    const audioFx = await service.ensure(dir, timeline([build]));
    const decoded: Float64Array[] = [];
    for (const [name, line] of [["bass-dry", timeline()], ["bass-fx", timeline([build])]] as const) {
      const plan = compileRender({
        timeline: line,
        fps: 30,
        preset: TINY,
        loudness: -16,
        sources: new Map([["assets/bass.wav", source]]),
        resolution: { width: 64, height: 64 },
        audioFx,
      });
      expect(plan.warnings.filter((warning) => /audio effects/.test(warning))).toEqual([]);
      const output = join(dir, `${name}.mp4`);
      await executeRender(plan, { ffmpeg, workDir: join(dir, `work-${name}`), output });
      decoded.push(samples(await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", output, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"])));
    }
    const [dry, fx] = decoded as [Float64Array, Float64Array];
    expect(Math.abs(bass(fx, 1.0) - bass(dry, 1.0))).toBeLessThan(1);
    expect(bass(fx, 3.8) - bass(dry, 3.8)).toBeLessThan(-12);
    expect(Math.abs(bass(fx, 4.5) - bass(dry, 4.5))).toBeLessThan(1);
  }, MEDIA_TIMEOUT);
});

describe("AudioFxService", () => {
  const voice: AudioEffect[] = [...VOICE_CHAIN];
  const clip = (id: string, start: number, effects: AudioEffect[] | null, muted = false): MediaClip => ({
    id,
    type: "media",
    asset: "assets/voice.wav",
    start,
    in: 0,
    out: 1,
    ...(effects || muted ? { audio: { ...(effects ? { effects } : {}), ...(muted ? { muted } : {}) } } : {}),
  });
  const timeline = (clips: MediaClip[]): Timeline => ({ schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips }] });

  function service(root: () => Timeline) {
    const jobs = new JobQueue();
    const fx = new AudioFxService({
      jobs,
      hash: async (at, rel) => hashFile(join(at, rel), statSync(join(at, rel)).size),
      hasAudio: async () => true,
      ffmpeg: async () => ffmpeg,
      timelines: async () => ["main"],
      flattened: async () => root(),
    });
    return { jobs, fx };
  }

  it("needs one bake per asset and chain, shared by clips (defaults count as given), none for muted or dry clips", () => {
    const { fx } = service(() => timeline([]));
    const needs = fx.needs(
      timeline([
        clip("c_1", 0, voice),
        clip("c_2", 1, [{ kind: "highpass" }, { kind: "denoise" }, { kind: "compressor" }]),
        clip("c_3", 2, null),
        clip("c_4", 3, voice, true),
      ]),
    );
    expect(needs).toEqual([{ ref: bakeRef("assets/voice.wav", voice), asset: "assets/voice.wav", effects: voice, clips: ["c_1", "c_2"] }]);
  });

  it("queues a missing bake as an audio-fx job, reports it ready, and ensure reuses it", async () => {
    const used = timeline([clip("c_1", 0, voice), clip("c_2", 1, voice)]);
    const { jobs, fx } = service(() => used);
    const root = tempDir();
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "voice.wav"), readFileSync(join(dir, "assets", "voice.wav")));
    const [queued] = await fx.status(root, used, true);
    expect(queued).toMatchObject({ file: null, clips: ["c_1", "c_2"] });
    expect(["queued", "baking"]).toContain(queued!.state);
    expect(jobs.list()).toEqual([expect.objectContaining({ kind: "audio-fx", asset: "assets/voice.wav", id: queued!.job })]);
    // Asking again while it is pending queues nothing new.
    await fx.status(root, used, true);
    await jobs.drained();
    expect(jobs.list()).toHaveLength(1);
    const [ready] = await fx.status(root, used, false);
    const hash = await hashFile(join(root, "assets", "voice.wav"), statSync(join(root, "assets", "voice.wav")).size);
    expect(ready).toMatchObject({ state: "ready", file: `${AUDIO_FX_DIR}/${audioFxCacheKey(hash, voice)}.pcm`, sampleRate: 48_000, channels: 1 });
    const path = join(root, ...ready!.file!.split("/"));
    // 3 s of mono s16 at 48 kHz: the sidecar's size.
    expect(statSync(path).size).toBe(3 * RATE * 2);
    const before = statSync(path).mtimeMs;
    expect(await fx.ensure(root, used)).toEqual(new Map([[bakeRef("assets/voice.wav", voice), path]]));
    expect(statSync(path).mtimeMs).toBe(before);
  }, MEDIA_TIMEOUT);

  it("gc deletes bakes no timeline plays and temps, keeps the used ones and what it does not know", async () => {
    let current = timeline([clip("c_1", 0, voice)]);
    const { fx } = service(() => current);
    const root = tempDir();
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "voice.wav"), readFileSync(join(dir, "assets", "voice.wav")));
    const kept = await fx.ensure(root, current);
    current = timeline([clip("c_1", 0, [{ kind: "highpass", frequency: 120 }])]);
    const other = await fx.ensure(root, current);
    const cacheDir = join(root, ...AUDIO_FX_DIR.split("/"));
    writeFileSync(join(cacheDir, "notes.txt"), "mine");
    const stale = [...kept.values()][0]!;
    expect((await fx.gc(root, { dryRun: true, temps: true, busy: false })).removed.map((entry) => entry.kind)).toEqual(["audio-fx"]);
    expect(existsSync(stale)).toBe(true);
    expect(await fx.gc(root, { dryRun: false, temps: true, busy: true })).toMatchObject({ removed: [], skipped: [{ area: "audio-fx" }] });
    const { removed } = await fx.gc(root, { dryRun: false, temps: true, busy: false });
    expect(removed).toEqual([{ path: `${AUDIO_FX_DIR}/${stale.split(/[\\/]/).at(-1)}`, kind: "audio-fx", bytes: 3 * RATE * 2 }]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync([...other.values()][0]!)).toBe(true);
    expect(existsSync(join(cacheDir, "notes.txt"))).toBe(true);
  }, MEDIA_TIMEOUT);

  it("classifies bake files and their temps, nothing else", () => {
    const key = `${"a".repeat(20)}-${"b".repeat(12)}-x1`;
    expect(classifyAudioFx(`${key}.pcm`, false)).toEqual({ kind: "audio-fx", key });
    expect(classifyAudioFx(`${key}.pcm.1a2b3c4d.partial`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyAudioFx(`${key}.pcm`, true)).toBeNull();
    expect(classifyAudioFx("notes.txt", false)).toBeNull();
  });

  it("keys a bake by content and normalized chain: omitted parameters equal their defaults", () => {
    const hash = `sha256:${"c".repeat(64)}`;
    expect(audioFxCacheKey(hash, [{ kind: "highpass" }])).toBe(audioFxCacheKey(hash, [{ kind: "highpass", frequency: 85 }]));
    expect(audioFxCacheKey(hash, [{ kind: "highpass", frequency: 90 }])).not.toBe(audioFxCacheKey(hash, [{ kind: "highpass" }]));
    expect(audioFxCacheKey(hash, voice)).toMatch(/^c{20}-[0-9a-f]{12}-x1$/);
  });
});
