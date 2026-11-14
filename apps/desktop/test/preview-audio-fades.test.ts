import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIX_FILE, compileRender, mixStep, sidecarArgs } from "@frameshell/core";
import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { audioFadeGain } from "@frameshell/schema/composite";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegRun, testFfmpeg } from "../e2e/media.js";
import { audioReads, envelopeGain, renderRead, sourceWindow } from "../src/renderer/src/preview/audio-plan.js";
import { compileProgram } from "../src/renderer/src/preview/program.js";
import { StretchChain } from "../src/renderer/src/preview/time-stretch.js";

// Seam under test: a clip's sample-accurate audio fades (#585) ramp the preview's samples as export's `afade` does,
// sample for sample. The export mix runs on the real managed ffmpeg.

const RATE = 48_000;
let root: string;
let ffmpeg: string;
const sidecar = ".frameshell/proxies/voice.pcm";

const asset: AssetInfo = {
  path: "assets/voice.wav",
  kind: "media",
  hash: `sha256:${"e".repeat(64)}`,
  state: "ready",
  error: null,
  media: { duration: 3, format: "wav", video: null, audio: { codec: "pcm_s16le", sampleRate: RATE, channels: 2 } },
  proxy: null,
  sidecar: { path: sidecar, format: "s16le", sampleRate: RATE, channels: 1 },
  waveform: null,
  thumbnails: null,
};
const assets = new Map([[asset.path, asset]]);

// A phrase with 12 ms fades, and a one-frame clip whose 40 ms fades take half of it each.
const clips = [
  { id: "p1", type: "media", asset: asset.path, start: 0.5, in: 0.2, out: 1.2, end: 1.5, audio: { fadeInMs: 12, fadeOutMs: 12 } },
  { id: "p2", type: "media", asset: asset.path, start: 2, in: 1.5, out: 1.533, end: 2.033, audio: { fadeInMs: 40, fadeOutMs: 40 } },
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

beforeAll(async () => {
  ffmpeg = await testFfmpeg();
  root = mkdtempSync(join(tmpdir(), "frameshell-audio-fades-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, ".frameshell", "proxies"), { recursive: true });
  const source = join(root, "assets", "voice.wav");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    ...["-i", `aevalsrc=0.3*sin(2*PI*220*t)+0.1*sin(2*PI*40*t):s=${RATE}:d=3`],
    ...["-ac", "2", "-c:a", "pcm_s16le", source],
  ]);
  await ffmpegRun(ffmpeg, sidecarArgs(source, join(root, ...sidecar.split("/"))));
}, 180_000);

describe("sample-accurate audio fades in the preview (#585)", () => {
  it("multiplies each span's gain by audioFadeGain over the clip's own samples, none for a clip without fades", () => {
    const program = compileProgram(shown, assets);
    const [p1, p2] = program.audio;
    expect(p1!.envelope?.fades).toEqual({ start: 24_000, end: 72_000, fadeIn: 576, fadeOut: 576 });
    expect(p2!.envelope?.fades).toEqual({ start: 96_000, end: 97_600, fadeIn: 800, fadeOut: 800 });
    for (const sample of [24_000, 24_100, 24_575, 24_576, 48_000, 71_424, 71_999]) {
      expect(envelopeGain(p1!, sample)).toBeCloseTo(audioFadeGain(p1!.envelope!.fades!, sample), 12);
    }
    const plain = compileProgram({ ...shown, tracks: [{ ...shown.tracks[0]!, clips: clips.map(({ audio: _audio, ...clip }) => clip) }] as TimelineView["tracks"] }, assets);
    expect(plain.audio.every((span) => span.envelope === undefined)).toBe(true);
  });

  it("ramps a clip at speed != 1 over program samples, after its stretch (#499)", () => {
    // 2x and 0.75x: the ramps last fadeInMs / fadeOutMs of the program, not of the source.
    const sped = [
      { id: "fast", type: "media", asset: asset.path, start: 0.5, in: 0.2, out: 2.2, speed: 2, end: 1.5, audio: { fadeInMs: 20, fadeOutMs: 30 } },
      { id: "slow", type: "media", asset: asset.path, start: 2, in: 0.5, out: 1.25, speed: 0.75, end: 3, audio: { fadeInMs: 20, fadeOutMs: 30 } },
    ];
    const view = { ...shown, tracks: [{ ...shown.tracks[0]!, clips: sped }] as TimelineView["tracks"] };
    const program = compileProgram(view, assets);
    const pcm = new Int16Array(readFileSync(join(root, ...sidecar.split("/"))).buffer.slice(0));
    for (const span of program.audio) {
      expect(span.speed).not.toBe(1);
      const fades = span.envelope!.fades!;
      expect(fades).toMatchObject({ start: span.start, end: span.end, fadeIn: 960, fadeOut: 1440 });
      const { fades: _fades, ...unfaded } = span.envelope!;
      const flat = { ...span, envelope: unfaded };
      const render = (target: typeof span) => {
        const out = new Float32Array(target.end - target.start);
        const chain = new StretchChain();
        for (const read of audioReads([target], target.start, target.end, 4096)) {
          const { first, count } = sourceWindow(read);
          out.set(renderRead(read, pcm.subarray(first, first + count), first, chain), read.from - target.start);
        }
        return out;
      };
      const faded = render(span);
      const plain = render(flat);
      let checked = 0;
      for (let i = 0; i < faded.length; i++) {
        const expected = plain[i]! * audioFadeGain(fades, span.start + i);
        expect(Math.abs(faded[i]! - expected)).toBeLessThan(1e-6);
        if (audioFadeGain(fades, span.start + i) < 0.99 && Math.abs(plain[i]!) > 0.01) checked++;
      }
      // Both ramps hold sound to check, not only silence.
      expect(checked).toBeGreaterThan(1500);
    }
  });

  it("hears the same samples as the export mix of the same clips", async () => {
    const program = compileProgram(shown, assets);
    const pcm = new Int16Array(readFileSync(join(root, ...sidecar.split("/"))).buffer.slice(0));
    const preview = new Float32Array(program.audio.at(-1)!.end);
    for (const read of audioReads(program.audio, 0, preview.length, 4096)) {
      const { first, count } = sourceWindow(read);
      preview.set(renderRead(read, pcm.subarray(first, first + count), first), read.from);
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
      sources: new Map([[asset.path, { path: join(root, "assets", "voice.wav"), video: null, audio: true, duration: 3 }]]),
      resolution: { width: 64, height: 64 },
    });
    const work = mkdtempSync(join(tmpdir(), "frameshell-audio-fades-mix-"));
    const mix = mixStep(plan)!;
    for (const [name, content] of Object.entries(mix.files)) writeFileSync(join(work, name), content);
    await ffmpegRun(ffmpeg, mix.args.map((arg) => (arg === MIX_FILE || arg === "mix.filter" ? join(work, arg) : arg)));
    const left = join(work, "left.f32");
    await ffmpegRun(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", join(work, MIX_FILE), "-af", "pan=mono|c0=c0", "-f", "f32le", left]);
    const exported = new Float32Array(readFileSync(left).buffer.slice(0));
    expect(statSync(left).size / 4).toBe(plan.audio.samples);

    // Both fade 2 ms at every clip edge their own way (the mixer and a linear `afade`): compare inside them.
    const edge = 96;
    let worst = 0;
    let ramped = 0;
    for (const span of program.audio) {
      for (let i = span.start + edge; i < span.end - edge; i++) {
        worst = Math.max(worst, Math.abs(preview[i]! - exported[i]!));
        if (envelopeGain(span, i) < 0.99) ramped++;
      }
    }
    expect(worst).toBeLessThan(1e-6);
    // The comparison covers the ramps (about 2 100 samples under 0.99 past the edges), not only full-level samples.
    expect(ramped).toBeGreaterThan(2000);
  }, 180_000);
});
