import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_FX_DIR, MIX_FILE, audioFxArgs, audioFxCacheKey, compileRender, mixStep, sidecarArgs } from "@frameshell/core";
import type { AssetInfo, AudioBakeInfo, TimelineView } from "@frameshell/protocol";
import { type AudioEffect, type Timeline, VOICE_CHAIN, bakeRef } from "@frameshell/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegRun, testFfmpeg } from "../e2e/media.js";
import { audioReads, renderRead, sourceWindow } from "../src/renderer/src/preview/audio-plan.js";
import { compileProgram, readyBakes } from "../src/renderer/src/preview/program.js";

// Seam under test: a clip with audio effects plays its bake in the preview and in export, sample for sample
// (ADR 0031). The bake and the export mix run on the real managed ffmpeg.

const RATE = 48_000;
const effects: AudioEffect[] = [...VOICE_CHAIN];

let root: string;
let ffmpeg: string;
/** Project-relative bake and dry sidecar of `assets/voice.wav`. */
let bake: string;
let sidecar: string;

const asset: AssetInfo = {
  path: "assets/voice.wav",
  hash: `sha256:${"d".repeat(64)}`,
  state: "ready",
  error: null,
  media: { duration: 3, format: "wav", video: null, audio: { codec: "pcm_s16le", sampleRate: RATE, channels: 2 } },
  proxy: null,
  sidecar: null,
  waveform: null,
  thumbnails: null,
};

const clip = { id: "c_voice", type: "media", asset: "assets/voice.wav", start: 0.5, in: 1, out: 2.5, end: 2, audio: { effects } };
const shown: TimelineView = {
  timeline: "main",
  path: "timelines/main.json",
  revision: 1,
  fps: 30,
  duration: null,
  tracks: [{ id: "a1", kind: "audio", name: null, follows: null, clips: [clip] }] as TimelineView["tracks"],
  problems: [],
};

beforeAll(async () => {
  ffmpeg = await testFfmpeg();
  root = mkdtempSync(join(tmpdir(), "frameshell-audio-fx-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, ...AUDIO_FX_DIR.split("/")), { recursive: true });
  mkdirSync(join(root, ".frameshell", "proxies"), { recursive: true });
  const source = join(root, "assets", "voice.wav");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    ...["-i", `aevalsrc=0.3*sin(2*PI*220*t)*sin(2*PI*1.5*t)+0.1*sin(2*PI*40*t)+0.02*random(0):s=${RATE}:d=3`],
    ...["-ac", "2", "-c:a", "pcm_s16le", source],
  ]);
  bake = `${AUDIO_FX_DIR}/${audioFxCacheKey(asset.hash!, effects)}.pcm`;
  sidecar = ".frameshell/proxies/voice.pcm";
  await ffmpegRun(ffmpeg, audioFxArgs(source, join(root, ...bake.split("/")), effects));
  await ffmpegRun(ffmpeg, sidecarArgs(source, join(root, ...sidecar.split("/"))));
}, 180_000);

function ready(): AudioBakeInfo[] {
  return [{ asset: asset.path, effects, clips: [clip.id], state: "ready", file: bake, sampleRate: RATE, channels: 1, job: null, error: null }];
}

describe("audio effects in the preview (ADR 0031)", () => {
  const assets = new Map<string, AssetInfo>([[asset.path, { ...asset, sidecar: { path: ".frameshell/proxies/voice.pcm", format: "s16le", sampleRate: RATE, channels: 1 } }]]);

  it("plays a clip's bake as its sidecar once ready, the dry sidecar before and for a bake of another chain", () => {
    const dry = compileProgram(shown, assets);
    expect(dry.audio[0]!.sidecar).toBe(sidecar);
    expect(compileProgram(shown, assets, { bakes: readyBakes([{ ...ready()[0]!, state: "baking", file: null }]) }).audio[0]!.sidecar).toBe(sidecar);
    const other = readyBakes([{ ...ready()[0]!, effects: [{ kind: "highpass", frequency: 85 }] }]);
    expect(compileProgram(shown, assets, { bakes: other }).audio[0]!.sidecar).toBe(sidecar);
    const baked = compileProgram(shown, assets, { bakes: readyBakes(ready()) });
    expect(baked.audio).toEqual([{ ...dry.audio[0]!, sidecar: bake }]);
    // Omitted parameters are their defaults: the same bake.
    expect(readyBakes(ready()).has(bakeRef(asset.path, [{ kind: "highpass" }, { kind: "denoise" }, { kind: "compressor" }]))).toBe(true);
  });

  it("hears the same samples as the export mix of the same clip", async () => {
    const program = compileProgram(shown, assets, { bakes: readyBakes(ready()) });
    const [span] = program.audio;
    const pcm = new Int16Array(readFileSync(join(root, ...bake.split("/"))).buffer.slice(0));
    const preview = new Float32Array(span!.end - span!.start);
    for (const read of audioReads(program.audio, span!.start, span!.end, 4096)) {
      const { first, count } = sourceWindow(read);
      preview.set(renderRead(read, pcm.subarray(first, first + count), first), read.from - span!.start);
    }

    const timeline: Timeline = { schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "a1", kind: "audio", clips: [{ ...clip, type: "media" as const }].map(({ end: _end, ...c }) => c) }] };
    const plan = compileRender({
      timeline,
      fps: 30,
      preset: { id: "tiny", container: "mp4", video: { codec: "h264", width: 64, height: 64 }, audio: { codec: "aac", sampleRate: RATE } },
      loudness: -16,
      sources: new Map([[asset.path, { path: join(root, "assets", "voice.wav"), video: null, audio: true }]]),
      resolution: { width: 64, height: 64 },
      audioFx: new Map([[bakeRef(asset.path, effects), join(root, ...bake.split("/"))]]),
    });
    const work = mkdtempSync(join(tmpdir(), "frameshell-audio-fx-mix-"));
    const mix = mixStep(plan)!;
    for (const [name, content] of Object.entries(mix.files)) writeFileSync(join(work, name), content);
    await ffmpegRun(ffmpeg, mix.args.map((arg) => (arg === MIX_FILE || arg === "mix.filter" ? join(work, arg) : arg)));
    const left = join(work, "left.f32");
    await ffmpegRun(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", join(work, MIX_FILE), "-af", "pan=mono|c0=c0", "-f", "f32le", left]);
    const exported = new Float32Array(readFileSync(left).buffer.slice(0));
    expect(statSync(left).size / 4).toBe(plan.audio.samples);

    // Export places the clip from program sample 24 000 (0.5 s); both fade 2 ms at the edges, so compare inside them.
    const edge = 96;
    let worst = 0;
    for (let i = edge; i < preview.length - edge; i++) worst = Math.max(worst, Math.abs(preview[i]! - exported[span!.start + i]!));
    expect(span!.start).toBe(24_000);
    expect(worst).toBeLessThan(1e-6);
  }, 180_000);
});
