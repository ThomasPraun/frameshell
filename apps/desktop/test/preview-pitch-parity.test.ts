import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIX_FILE, compileRender, mixStep, sidecarArgs } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegRun, testFfmpeg } from "../e2e/media.js";
import { audioReads, renderRead, sourceWindow } from "../src/renderer/src/preview/audio-plan.js";
import { compileProgram } from "../src/renderer/src/preview/program.js";
import { StretchChain } from "../src/renderer/src/preview/time-stretch.js";
import { dominantHz, envelope, onset, swingLag } from "./audio-measure.js";

// Seam under test: a clip at speed ≠ 1 sounds the same in the preview (its WSOLA stretch) as in the export mix
// (`atempo`), #499: same pitch, the tone where the speed puts it, its fades. The export mix runs on the real managed
// ffmpeg.

const RATE = 48_000;
let root: string;
let ffmpeg: string;
const sidecar = ".frameshell/proxies/tone.pcm";

const asset: AssetInfo = {
  path: "assets/tone.wav",
  kind: "media",
  hash: `sha256:${"f".repeat(64)}`,
  state: "ready",
  error: null,
  media: { duration: 3, format: "wav", video: null, audio: { codec: "pcm_s16le", sampleRate: RATE, channels: 2 } },
  proxy: null,
  sidecar: { path: sidecar, format: "s16le", sampleRate: RATE, channels: 1 },
  waveform: null,
  thumbnails: null,
};
const assets = new Map([[asset.path, asset]]);

/** The source: a 440 Hz tone from 0.5 s to 2.5 s, silence around it, its level swinging at `swing` Hz. */
const TONE = { from: 0.5, to: 2.5, hz: 440, swing: 2 };

// Each clip hears the tone start and stop, except `f`, inside the tone, whose 20 ms sample-accurate fades (#585) ramp it.
const clips = [
  { id: "s075", type: "media", asset: asset.path, start: 0, in: 0.2, out: 2.75, speed: 0.75, end: 3.4 },
  { id: "s125", type: "media", asset: asset.path, start: 4, in: 0.2, out: 2.7, speed: 1.25, end: 6 },
  { id: "s2", type: "media", asset: asset.path, start: 7, in: 0.2, out: 2.8, speed: 2, end: 8.3 },
  { id: "f", type: "media", asset: asset.path, start: 9, in: 1.1, out: 1.475, speed: 1.25, end: 9.3, audio: { fadeInMs: 20, fadeOutMs: 20 } },
];
const shown: TimelineView = {
  timeline: "main",
  path: "timelines/main.json",
  revision: 1,
  fps: 30,
  duration: null,
  tracks: [{ id: "a1", kind: "audio", name: null, follows: null, clips }] as TimelineView["tracks"],
  problems: [],
};

let preview: Float32Array;
let exported: Float32Array;

beforeAll(async () => {
  ffmpeg = await testFfmpeg();
  root = mkdtempSync(join(tmpdir(), "frameshell-pitch-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, ".frameshell", "proxies"), { recursive: true });
  const source = join(root, "assets", "tone.wav");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    ...["-i", `aevalsrc=0.3*sin(2*PI*${TONE.hz}*t)*between(t\\,${TONE.from}\\,${TONE.to})*(0.6+0.4*sin(2*PI*${TONE.swing}*t)):s=${RATE}:d=3`],
    ...["-ac", "2", "-c:a", "pcm_s16le", source],
  ]);
  await ffmpegRun(ffmpeg, sidecarArgs(source, join(root, ...sidecar.split("/"))));

  const program = compileProgram(shown, assets);
  const pcm = new Int16Array(readFileSync(join(root, ...sidecar.split("/"))).buffer.slice(0));
  preview = new Float32Array(program.audio.at(-1)!.end);
  // As the engine worker plays it: chunks of its size, one stretch chain per span carried from read to read.
  const chains = new Map<string, StretchChain>();
  for (const read of audioReads(program.audio, 0, preview.length, 24_000)) {
    const { first, count } = sourceWindow(read);
    const chain = chains.get(read.span.clip) ?? new StretchChain();
    chains.set(read.span.clip, chain);
    preview.set(renderRead(read, pcm.subarray(first, first + count), first, chain), read.from);
  }

  const timeline: Timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [{ id: "a1", kind: "audio", clips: clips.map(({ end: _end, ...clip }) => ({ ...clip, type: "media" as const })) }],
  };
  const plan = compileRender({
    timeline,
    fps: 30,
    preset: { id: "tiny", container: "mp4", video: { codec: "h264", width: 64, height: 64 }, audio: { codec: "aac", sampleRate: RATE } },
    loudness: -16,
    sources: new Map([[asset.path, { path: source, video: null, audio: true, duration: 3 }]]),
    resolution: { width: 64, height: 64 },
  });
  const work = mkdtempSync(join(tmpdir(), "frameshell-pitch-mix-"));
  const mix = mixStep(plan)!;
  for (const [name, content] of Object.entries(mix.files)) writeFileSync(join(work, name), content);
  await ffmpegRun(ffmpeg, mix.args.map((arg) => (arg === MIX_FILE || arg === "mix.filter" ? join(work, arg) : arg)));
  const left = join(work, "left.f32");
  await ffmpegRun(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", join(work, MIX_FILE), "-af", "pan=mono|c0=c0", "-f", "f32le", left]);
  exported = new Float32Array(readFileSync(left).buffer.slice(0));
}, 180_000);

/** Program samples `[start, end)` of clip `id`. */
function samplesOf(id: string, signal: Float32Array): Float32Array {
  const clip = clips.find((candidate) => candidate.id === id)!;
  return signal.subarray(Math.round(clip.start * RATE), Math.round(clip.end * RATE));
}

describe("preview and export of clips at speed ≠ 1 (#499)", () => {
  for (const id of ["s075", "s125", "s2"]) {
    it(`plays ${id} at the source pitch, the tone where the speed puts it, in both`, () => {
      const clip = clips.find((candidate) => candidate.id === id)!;
      /** Program sample of the clip where the speed puts source second `at`. */
      const where = (at: number) => ((at - clip.in) / clip.speed) * RATE;
      const heard = { preview: samplesOf(id, preview), exported: samplesOf(id, exported) };
      const middle = Math.round(where(1.5)) - 4096;
      const pitch = { preview: dominantHz(heard.preview.subarray(middle, middle + 8192), RATE), exported: dominantHz(heard.exported.subarray(middle, middle + 8192), RATE) };
      // Lag of the level swing behind where the speed puts it, over two of its cycles early and two late in the tone.
      const omega = (2 * Math.PI * TONE.swing * clip.speed) / RATE;
      const phase = 2 * Math.PI * TONE.swing * clip.in;
      const lagsOf = (signal: Float32Array) => [0.6, 1.4].map((at) => swingLag(signal, omega, phase, Math.round(where(at)), Math.round(where(at + 1))));
      const times = {
        preview: { on: onset(heard.preview, 0.5), lags: lagsOf(heard.preview) },
        exported: { on: onset(heard.exported, 0.5), lags: lagsOf(heard.exported) },
      };
      const note = JSON.stringify({ pitch, times, expectedOn: where(TONE.from) });
      // Pitch kept: the linear resample this replaced played 440 * speed.
      expect(Math.abs(pitch.preview - TONE.hz), note).toBeLessThan(2);
      expect(Math.abs(pitch.exported - TONE.hz), note).toBeLessThan(2);
      expect(Math.abs(pitch.preview - pitch.exported), note).toBeLessThan(2);
      for (const side of [times.preview, times.exported]) {
        // The onset after silence: within 21 ms (half the 2048-sample window both stretches use) of where the speed
        // puts it, which keeps preview and export within one 30 fps frame of each other.
        expect(Math.abs(side.on - where(TONE.from)), note).toBeLessThan(1024);
        // The level follows the source on time over both halves: no lead (the pre-roll) and no drift, so the clip
        // lasts as long as the speed makes it, within one 128-sample audio block.
        for (const lag of side.lags) expect(Math.abs(lag), note).toBeLessThan(128);
      }
      expect(Math.abs(times.preview.on - times.exported.on), note).toBeLessThan(RATE / 30);
    });
  }

  it("ramps a sped-up clip's sample-accurate fades (#585) over the same samples in both", () => {
    const level = { preview: envelope(samplesOf("f", preview)), exported: envelope(samplesOf("f", exported)) };
    // Against the level 40 ms in, past the ramp (the swing barely moves in 30 ms).
    const steady = { preview: level.preview[RATE * 0.04]!, exported: level.exported[RATE * 0.04]! };
    // 1 ms means at 10 ms (half way up the equal-power ramp: about sin(pi / 4) of full) and at 25 ms (past it).
    for (const at of [0.01, 0.025]) {
      const sample = Math.round(at * RATE);
      const ratio = { preview: level.preview[sample]! / steady.preview, exported: level.exported[sample]! / steady.exported };
      expect(Math.abs(ratio.preview - ratio.exported), JSON.stringify({ at, ratio })).toBeLessThan(0.1);
    }
    expect(level.preview[Math.round(0.01 * RATE)]! / steady.preview).toBeGreaterThan(0.55);
    expect(level.preview[Math.round(0.01 * RATE)]! / steady.preview).toBeLessThan(0.85);
    const end = level.preview.length - 1;
    expect(level.preview[end]! / steady.preview).toBeLessThan(0.1);
    expect(level.exported[end]! / steady.exported).toBeLessThan(0.1);
  });
});
