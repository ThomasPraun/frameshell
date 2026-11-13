import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Clip,
  type ExportPreset,
  type MediaClip,
  type Timeline,
  type TransitionShape,
  circleReach,
  dissolveProgress,
  dissolveWeights,
  fadeWeight,
  flattenTimeline,
  hostFades,
  layerRect,
  placementAt,
  shapeAt,
} from "@frameshell/schema";
import { type ExportSource, applyOperation, compileRender, executeRender } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { frameLuma } from "./media-fixtures.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Transitions and keys (ADR 0018) rendered by real managed ffmpeg on tiny synthetic media, checked against the
// schema evaluator: what the export shows and plays must be what `composite.ts` computes.
const MEDIA_TIMEOUT = 180_000;

const TINY: ExportPreset = {
  id: "tiny",
  container: "mp4",
  video: { codec: "h264", width: 64, height: 64, crf: 4 },
  audio: { codec: "aac", bitrateKbps: 256, sampleRate: 48_000 },
};
const resolution = { width: 64, height: 64 };
const STEP = 8;
const LEVELS = 25;

let dir: string;
let ffmpeg: string;
/** 20 s, 64x64 at 30 fps, frame n flat luma 16 + 8 * (n mod 25 + 1), 440 Hz tone. */
let counter: ExportSource;
/** The same picture with a 1 kHz tone. */
let high: ExportSource;
let blackStill: ExportSource;
/** 16x16 opaque white. */
let patch: ExportSource;
let levels: number[];

beforeAll(async () => {
  dir = tempDir();
  ({ ffmpeg } = await mediaTools());
  const footage = async (name: string, tone: number): Promise<ExportSource> => {
    const path = join(dir, name);
    await run(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...["-f", "lavfi", "-i", `color=c=black:s=64x64:r=30:d=20,geq=lum='16+${STEP}*(mod(N\\,${LEVELS})+1)':cb=128:cr=128`],
      ...["-f", "lavfi", "-i", `sine=f=${tone}:r=48000:d=20`],
      ...["-c:v", "libx264", "-crf", "4", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", path],
    ]);
    return { path, video: { codec: "h264", still: false, width: 64, height: 64 }, audio: true, duration: 20 };
  };
  counter = await footage("counter.mp4", 440);
  high = await footage("high.mp4", 1000);
  const still = async (name: string, source: string, size: number): Promise<ExportSource> => {
    const path = join(dir, name);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source, "-frames:v", "1", path]);
    return { path, video: { codec: "png", still: true, width: size, height: size }, audio: false };
  };
  blackStill = await still("black.png", "color=c=black:s=64x64", 64);
  patch = await still("patch.png", "color=c=white:s=16x16", 16);
  levels = (await frameLuma(counter.path)).slice(0, LEVELS);
}, MEDIA_TIMEOUT);

const media = (id: string, asset: string, start: number, clipIn: number, out: number, extra: Partial<MediaClip> = {}): MediaClip => ({
  id,
  type: "media",
  asset,
  start,
  in: clipIn,
  out,
  ...extra,
});

const timelineOf = (tracks: Timeline["tracks"]): Timeline => ({ schemaVersion: 1, id: "main", revision: 1, tracks });

/** Luma (0-255) of pixel (x, y) in every frame of `path` (64x64). */
async function lumaAt(path: string, x: number, y: number): Promise<number[]> {
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const out: number[] = [];
  for (let offset = 0; offset + 4096 <= raw.length; offset += 4096) out.push(raw[offset + y * 64 + x]!);
  return out;
}

/** Every frame of `path` as 64x64 luma. */
async function frames(path: string): Promise<Buffer[]> {
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  return Array.from({ length: raw.length / 4096 }, (_, i) => raw.subarray(i * 4096, (i + 1) * 4096));
}

/** Decoded first audio channel of `path`, 48 kHz float. */
async function audioSamples(path: string): Promise<Float32Array> {
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"]);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.floor(raw.length / 4) * 4));
}

/** Amplitude of the `frequency` component in 20 ms of `samples` centered on second `at` (Hann-windowed DFT bin). */
function amplitude(samples: Float32Array, at: number, frequency: number): number {
  const length = 960;
  const first = Math.round(at * 48_000) - length / 2;
  let re = 0;
  let im = 0;
  let weights = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    const phase = (2 * Math.PI * frequency * (first + i)) / 48_000;
    re += samples[first + i]! * w * Math.cos(phase);
    im += samples[first + i]! * w * Math.sin(phase);
    weights += w;
  }
  return (2 * Math.hypot(re, im)) / weights;
}

describe("export transitions and keys (real ffmpeg)", () => {
  it(
    "dissolves on the bottom track from the outgoing clip's handle into the incoming one, without a seam at a segment join inside it",
    async () => {
      // a: source frames 30-59, then 60-65 from its handle; b: dissolve 0.4 s = 6 frames each side, source 144-179.
      const timeline = timelineOf([
        { id: "v1", kind: "video", clips: [media("a", "assets/counter.mp4", 0, 1, 2), media("b", "assets/counter.mp4", 1, 5, 6, { dissolve: 0.4 })] },
      ]);
      const sources = new Map([["assets/counter.mp4", counter]]);
      // 0.9 s segments: a join at frame 27, inside the dissolve and off the cut.
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 0.9 });
      expect(plan.segments.map((segment) => segment.from)).toContain(0.9);
      const output = join(dir, "bottom-dissolve.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-bottom"), output });

      const shown = await frameLuma(output);
      expect(shown).toHaveLength(60);
      const level = (frame: number) => levels[frame % LEVELS]!;
      shown.forEach((luma, n) => {
        const outgoing = level(30 + n);
        const incoming = level(120 + n);
        const w = dissolveProgress(1, 0.2, n / 30);
        const { incoming: over, outgoing: under } = dissolveWeights(w, "bottom");
        // Bottom track: the incoming picture over the opaque outgoing one.
        const expected = n < 24 ? outgoing : n >= 36 ? incoming : incoming * over + outgoing * under * (1 - over);
        expect(Math.abs(luma - expected), `frame ${n}: ${luma} vs ${expected}`).toBeLessThan(2.5);
      });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "dips through black where neither clip has a handle, and holds a generated clip's first frame for its head",
    async () => {
      // a then b (from source 0: no handle before it): a dip, 6 frames out and 6 in. Then render g (file time = composition
      // time) dissolving from b: frames before g's start hold its first frame, b's tail plays from its handle.
      const timeline = timelineOf([
        {
          id: "v1",
          kind: "video",
          clips: [
            media("a", "assets/counter.mp4", 0, 1, 2),
            media("b", "assets/counter.mp4", 1, 0, 1, { dissolve: 0.4 }),
            { id: "g", type: "hyperframes", start: 2, duration: 0.5, dissolve: 0.4 },
          ],
        },
      ]);
      const sources = new Map([["assets/counter.mp4", counter]]);
      const generated = new Map([["g", { path: counter.path, hasAlpha: false, width: 64, height: 64 }]]);
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, generated, resolution, segmentSeconds: 0.5 });
      const output = join(dir, "dip-hold.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-dip"), output });

      const shown = await frameLuma(output);
      expect(shown).toHaveLength(75);
      const level = (frame: number) => levels[frame % LEVELS]!;
      shown.forEach((luma, n) => {
        const t = n / 30;
        let expected: number;
        if (n < 30) expected = level(30 + n) * fadeWeight({ fadeIn: 0, fadeOut: 0.2 }, 0, 1, t);
        else if (n < 54) expected = level(n - 30) * fadeWeight({ fadeIn: 0.2, fadeOut: 0 }, 1, 2, t);
        else {
          const { incoming } = dissolveWeights(dissolveProgress(2, 0.2, t), "bottom");
          const held = level(Math.max(0, n - 60));
          expected = n >= 66 ? held : held * incoming + level(n - 30) * (1 - incoming);
        }
        expect(Math.abs(luma - expected), `frame ${n}: ${luma} vs ${expected}`).toBeLessThan(2.5);
      });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "dissolves on an upper track (outgoing 1 - w, incoming w over what is below) and fades a layer to transparent",
    async () => {
      const corner = { scale: 0.25, x: -24, y: -24 };
      const p1 = media("p1", "assets/patch.png", 0, 0, 0.5, { transform: corner });
      const p2 = media("p2", "assets/patch.png", 0.5, 0, 0.5, { transform: corner, dissolve: 0.4, fadeOut: 0.2 });
      const timeline = timelineOf([
        { id: "v1", kind: "video", clips: [media("bg", "assets/black.png", 0, 0, 1)] },
        { id: "v2", kind: "video", clips: [p1, p2] },
      ]);
      const sources = new Map([
        ["assets/black.png", blackStill],
        ["assets/patch.png", patch],
      ]);
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 0.4 });
      const output = join(dir, "upper-dissolve.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-upper"), output });

      const lumas = await lumaAt(output, 8, 8);
      expect(lumas).toHaveLength(30);
      lumas.forEach((luma, n) => {
        const t = n / 30;
        const w = dissolveProgress(0.5, 0.2, t);
        const { incoming, outgoing } = dissolveWeights(w, "upper");
        const a1 = t < 0.7 ? outgoing : 0;
        const a2 = t >= 0.3 ? incoming * fadeWeight({ fadeIn: 0, fadeOut: 0.2 }, 0.5, 1, t) : 0;
        // Black 0, white 255 (decoded to full-range gray); each layer mixes over what is below.
        const expected = 255 * a1 * (1 - a2) + 255 * a2;
        expect(Math.abs(luma - expected), `frame ${n}: ${luma} vs ${expected}`).toBeLessThan(3);
      });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "animates position, scale and opacity from eased keys exactly where placementAt and layerRect put them",
    async () => {
      const layer: Clip = media("p", "assets/patch.png", 0, 0, 1, {
        keys: {
          x: [
            { at: 0, value: -16, ease: "in-out" },
            { at: 1, value: 16 },
          ],
          scale: [
            { at: 0, value: 0.25, ease: "out" },
            { at: 1, value: 0.75 },
          ],
          opacity: [
            { at: 0.2, value: 1, ease: "in" },
            { at: 0.8, value: 0.25 },
          ],
        },
      });
      const timeline = timelineOf([
        { id: "v1", kind: "video", clips: [media("bg", "assets/black.png", 0, 0, 1)] },
        { id: "v2", kind: "video", clips: [layer] },
      ]);
      const sources = new Map([
        ["assets/black.png", blackStill],
        ["assets/patch.png", patch],
      ]);
      // Segments of 0.3 s: expressions must read timeline time in every one.
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 0.3 });
      const output = join(dir, "keys.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-keys"), output });

      const decoded = await frames(output);
      expect(decoded).toHaveLength(30);
      decoded.forEach((frame, n) => {
        const placement = placementAt(layer, n / 30);
        const rect = layerRect({ width: 16, height: 16 }, resolution, resolution, placement);
        const level = 255 * placement.opacity;
        const row = Math.min(63, Math.max(0, rect.top + Math.floor(rect.height / 2)));
        const lit = Array.from({ length: 64 }, (_, x) => frame[row * 64 + x]! > level / 2);
        const left = lit.indexOf(true);
        const width = lit.lastIndexOf(true) - left + 1;
        expect([left, width], `frame ${n} row ${row}`).toEqual([Math.max(0, rect.left), Math.min(64, rect.left + rect.width) - Math.max(0, rect.left)]);
        const center = frame[row * 64 + Math.min(63, Math.max(0, rect.left + Math.floor(rect.width / 2)))]!;
        expect(Math.abs(center - level), `frame ${n}: ${center} vs ${level}`).toBeLessThan(3);
      });
    },
    MEDIA_TIMEOUT,
  );

  it(
    "crossfades sound at equal power from the outgoing clip's handle, and follows gain keys",
    async () => {
      // low (440 Hz) 0-1 s, then high (1 kHz) with a 0.4 s crossfade centered on 1 s; on a second track, 440 Hz rising
      // from -20 dB to 0 dB by its gain keys over 2-3 s (the low clip plays source 7-8 s there).
      const timeline = timelineOf([
        {
          id: "a1",
          kind: "audio",
          clips: [media("low", "assets/counter.mp4", 0, 1, 2), media("high", "assets/high.mp4", 1, 5, 6, { dissolve: 0.4 })],
        },
        {
          id: "a2",
          kind: "audio",
          clips: [
            media("ramp", "assets/counter.mp4", 2, 7, 8.5, {
              keys: {
                gain: [
                  { at: 7, value: -20 },
                  { at: 8, value: 0 },
                ],
              },
            }),
          ],
        },
      ]);
      const sources = new Map([
        ["assets/counter.mp4", counter],
        ["assets/high.mp4", high],
      ]);
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution });
      expect(plan.audio.tracks).toHaveLength(3);
      const output = join(dir, "crossfade.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-crossfade"), output });

      const samples = await audioSamples(output);
      const low = amplitude(samples, 0.5, 440);
      const highLevel = amplitude(samples, 1.5, 1000);
      for (const t of [0.85, 0.95, 1, 1.05, 1.15]) {
        const { incoming, outgoing } = dissolveWeights(dissolveProgress(1, 0.2, t), "sound");
        expect(Math.abs(amplitude(samples, t, 440) / low - outgoing), `440 Hz at ${t}`).toBeLessThan(0.05);
        expect(Math.abs(amplitude(samples, t, 1000) / highLevel - incoming), `1 kHz at ${t}`).toBeLessThan(0.05);
      }
      // Equal power: the two weights' squares sum to 1 through the crossfade, so loudness holds.
      const middle = amplitude(samples, 1, 440) / low;
      expect(middle).toBeGreaterThan(0.65);

      const full = amplitude(samples, 3.25, 440);
      for (const [t, db] of [
        [2.25, -15],
        [2.5, -10],
        [2.75, -5],
      ] as const) {
        expect(Math.abs(amplitude(samples, t, 440) / full - 10 ** (db / 20)), `gain at ${t}`).toBeLessThan(0.02);
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "plays a keyed nested clip with its clips composed in, fading all its layers and its sound in and out",
    async () => {
      // Scene: the patch 8 px right of center on V1, the 440 Hz tone from 0.3 s on A1. The host zooms and slides it,
      // and fades in over 0.6 s (begun before the tone starts) and out over the last 0.4 s.
      const scene = timelineOf([
        { id: "v1", kind: "video", clips: [media("p", "assets/patch.png", 0, 0, 2, { transform: { x: 8 } })] },
        { id: "a1", kind: "audio", clips: [media("tone", "assets/counter.mp4", 0.3, 1, 3.3)] },
      ]);
      const host: Clip = {
        id: "n",
        type: "timeline",
        source: "timelines/scene.json",
        start: 0,
        duration: 2,
        fadeIn: 0.6,
        fadeOut: 0.4,
        keys: {
          x: [
            { at: 0, value: -16, ease: "in-out" },
            { at: 2, value: 8 },
          ],
          scale: [
            { at: 0, value: 0.25, ease: "out" },
            { at: 2, value: 0.75 },
          ],
        },
      };
      const timeline = flattenTimeline(
        timelineOf([
          { id: "v1", kind: "video", clips: [media("bg", "assets/black.png", 0, 0, 2)] },
          { id: "v2", kind: "video", clips: [host] },
        ]),
        (source) => (source === "timelines/scene.json" ? scene : null),
        30,
      );
      const layer = (timeline.tracks[1] as { clips: Clip[] }).clips[0]!;
      const sources = new Map([
        ["assets/black.png", blackStill],
        ["assets/patch.png", patch],
        ["assets/counter.mp4", counter],
      ]);
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 0.5 });
      const output = join(dir, "nested-keys.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-nested"), output });

      const fade = (t: number, sound = false) => hostFades(layer).reduce((w, host) => w * fadeWeight(host, host.start, host.end, t, sound), 1);
      const decoded = await frames(output);
      expect(decoded).toHaveLength(60);
      decoded.forEach((frame, n) => {
        const t = n / 30;
        const placement = placementAt(layer, t);
        const rect = layerRect({ width: 16, height: 16 }, resolution, resolution, placement);
        const level = 255 * placement.opacity * fade(t);
        const row = Math.min(63, Math.max(0, rect.top + Math.floor(rect.height / 2)));
        const center = frame[row * 64 + Math.min(63, Math.max(0, rect.left + Math.floor(rect.width / 2)))]!;
        expect(Math.abs(center - level), `frame ${n}: ${center} vs ${level}`).toBeLessThan(3);
        // Where the patch shows enough to find, its edges are where placementAt and layerRect put them.
        if (level < 64) return;
        const lit = Array.from({ length: 64 }, (_, x) => frame[row * 64 + x]! > level / 2);
        const left = lit.indexOf(true);
        expect([left, lit.lastIndexOf(true) - left + 1], `frame ${n} row ${row}`).toEqual([
          Math.max(0, rect.left),
          Math.min(64, rect.left + rect.width) - Math.max(0, rect.left),
        ]);
      });

      const samples = await audioSamples(output);
      const tone = (timeline.tracks.find((track) => track.id === "v2/a1") as { clips: Clip[] }).clips[0]!;
      const full = amplitude(samples, 1.1, 440);
      for (const t of [0.4, 0.5, 0.55, 1.7, 1.8, 1.9]) {
        const weight = hostFades(tone).reduce((w, host) => w * fadeWeight(host, host.start, host.end, t, true), 1);
        expect(Math.abs(amplitude(samples, t, 440) / full - weight), `440 Hz at ${t}`).toBeLessThan(0.05);
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "darkens a dip cut's outgoing clip over black on the bottom track, then cuts hard (ADR 0030)",
    async () => {
      const before = timelineOf([
        { id: "v1", kind: "video", clips: [media("a", "assets/counter.mp4", 0, 1, 2), media("b", "assets/counter.mp4", 1, 5, 6)] },
      ]);
      const { timeline } = await applyOperation(
        before,
        { op: "transition.set", args: { at: 1, kind: "dip-cut", duration: 0.5 } },
        {
          fps: 30,
          source: async () => ({ duration: 20, video: true, audio: true }),
          nestedDuration: async () => 0,
          clipTypes: async () => new Map(),
          newId: (prefix) => `${prefix}_1`,
        },
      );
      const sources = new Map([["assets/counter.mp4", counter]]);
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution });
      const output = join(dir, "dip-cut.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-dip-cut"), output });
      const shown = await frameLuma(output);
      const level = (frame: number) => levels[frame % LEVELS]!;
      // Frames 26-29 go from full to 60 % over black (full-range luma 0); frame 30 is b at full.
      for (const n of [20, 26, 27, 28, 29, 30, 31]) {
        const opacity = n <= 26 || n >= 30 ? 1 : 1 - (0.4 * (n - 26)) / 3;
        const expected = level(n < 30 ? 30 + n : 120 + n) * opacity;
        expect(Math.abs(shown[n]! - expected), `frame ${n}: ${shown[n]} vs ${expected}`).toBeLessThan(2.5);
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "wipes and pushes on the bottom track where shapeAt puts the edge, the incoming clip's missing handle held (ADR 0030)",
    async () => {
      const flat = async (name: string, colour: string): Promise<ExportSource> => {
        const path = join(dir, name);
        await run(ffmpeg, [
          ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=64x64:r=30:d=3`],
          ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=3"],
          ...["-c:v", "libx264", "-crf", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
        ]);
        return { path, video: { codec: "h264", still: false, width: 64, height: 64 }, audio: true, duration: 3 };
      };
      const sources = new Map([
        ["assets/dark.mp4", await flat("dark.mp4", "0x303030")],
        ["assets/bright.mp4", await flat("bright.mp4", "0xd0d0d0")],
      ]);
      for (const kind of ["wipe", "push", "iris"] as const) {
        const shape: TransitionShape = kind === "iris" ? { kind, origin: [0.5, 0.25, 0.75, 0.5] } : { kind, direction: "left" };
        // bright starts at its source's first frame: its push head holds that frame.
        const timeline = timelineOf([
          {
            id: "v1",
            kind: "video",
            clips: [media("a", "assets/dark.mp4", 0, 0.5, 1.5), media("b", "assets/bright.mp4", 1, 0, 1, { dissolve: 0.4, shape })],
          },
        ]);
        const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 2 });
        const output = join(dir, `shaped-${kind}.mp4`);
        await executeRender(plan, { ffmpeg, workDir: join(dir, `work-${kind}`), output });
        const shown = await frames(output);
        expect(shown).toHaveLength(60);
        // Frames 27, 30 and 33 of the 12-frame dissolve centered on frame 30: the iris's circle around (40, 24).
        for (const frame of kind === "iris" ? [27, 30, 33] : []) {
          const { circle } = shapeAt(shape, dissolveProgress(1, 0.2, frame / 30)).incoming;
          const radius = circle!.r * circleReach(circle!, 64, 64);
          for (let y = 2; y < 64; y += 4) {
            for (let x = 2; x < 64; x += 4) {
              const distance = Math.hypot(x + 0.5 - 40, y + 0.5 - 24);
              if (Math.abs(distance - radius) < 3) continue;
              expect(shown[frame]![y * 64 + x]! > 128, `iris frame ${frame} pixel ${x},${y} (radius ${radius})`).toBe(distance < radius);
            }
          }
        }
        // The same frames of the wipe and push: the incoming picture from column 64 * (1 - p).
        for (const frame of kind === "iris" ? [] : [27, 30, 33]) {
          const { incoming } = shapeAt({ kind: "wipe" }, dissolveProgress(1, 0.2, frame / 30));
          const edge = Math.round(64 * incoming.clip![0]);
          const row = shown[frame]!.subarray(32 * 64, 33 * 64);
          for (let x = 0; x < 64; x++) {
            if (Math.abs(x + 0.5 - edge) < 3) continue;
            expect(row[x]! > 128, `${kind} frame ${frame} column ${x} (edge ${edge}): ${row[x]}`).toBe(x >= edge);
          }
        }
        expect(shown[20]![32 * 64 + 60]!, `${kind} before`).toBeLessThan(100);
        expect(shown[40]![32 * 64 + 4]!, `${kind} after`).toBeGreaterThan(150);

        if (kind !== "wipe") continue;
        // Slice 3: the same wipe on an upper track, both clips a half-size inset over grey (columns and rows 16-47):
        // the outgoing inset shows only left of the edge, the incoming one right of it, grey around both.
        sources.set("assets/grey.mp4", await flat("grey.mp4", "0x808080"));
        const inset = { transform: { scale: 0.5 } };
        const upper = timelineOf([
          { id: "v0", kind: "video", clips: [media("g", "assets/grey.mp4", 0, 0, 2)] },
          { id: "v1", kind: "video", clips: [media("a", "assets/dark.mp4", 0, 0.5, 1.5, inset), media("b", "assets/bright.mp4", 1, 0, 1, { dissolve: 0.4, shape, ...inset })] },
        ]);
        const lifted = join(dir, "shaped-upper-wipe.mp4");
        await executeRender(compileRender({ timeline: upper, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 2 }), {
          ffmpeg,
          workDir: join(dir, "work-upper-wipe"),
          output: lifted,
        });
        const over = await frames(lifted);
        for (const frame of [27, 30, 33]) {
          const edge = Math.round(64 * shapeAt(shape, dissolveProgress(1, 0.2, frame / 30)).incoming.clip![0]);
          const row = over[frame]!.subarray(32 * 64, 33 * 64);
          for (let x = 0; x < 64; x++) {
            if (Math.abs(x + 0.5 - edge) < 3 || Math.abs(x - 16) < 2 || Math.abs(x - 48) < 2) continue;
            const expected = x < 16 || x >= 48 ? "grey" : x >= edge ? "bright" : "dark";
            const seen = row[x]! > 160 ? "bright" : row[x]! < 80 ? "dark" : "grey";
            expect(seen, `upper wipe frame ${frame} column ${x} (edge ${edge}): ${row[x]}`).toBe(expected);
          }
        }

        // And on the bottom track with keyed scale: the incoming picture grows from 0.75 while the edge crosses the
        // frame, so the mask reads the layer's corner and size on every frame.
        const keyed = timelineOf([
          {
            id: "v1",
            kind: "video",
            clips: [
              media("a", "assets/dark.mp4", 0, 0.5, 1.5),
              media("b", "assets/bright.mp4", 1, 0, 1, { dissolve: 0.4, shape, keys: { scale: [{ at: 0, value: 0.75 }, { at: 1, value: 1 }] } }),
            ],
          },
        ]);
        const scaled = join(dir, "shaped-keyed-wipe.mp4");
        await executeRender(compileRender({ timeline: keyed, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 2 }), {
          ffmpeg,
          workDir: join(dir, "work-keyed-wipe"),
          output: scaled,
        });
        const grown = await frames(scaled);
        for (const frame of [27, 30, 33]) {
          const edge = Math.round(64 * shapeAt(shape, dissolveProgress(1, 0.2, frame / 30)).incoming.clip![0]);
          const row = grown[frame]!.subarray(32 * 64, 33 * 64);
          // The picture covers at least columns 8-55 at scale 0.75; the outgoing clip shows beside it.
          for (let x = 12; x < 52; x++) {
            if (Math.abs(x + 0.5 - edge) < 3) continue;
            expect(row[x]! > 128, `keyed wipe frame ${frame} column ${x} (edge ${edge}): ${row[x]}`).toBe(x >= edge);
          }
        }
        // bright's sound reaches before its source's first sample: the mix pads it with silence (`adelay`).
        const samples = await audioSamples(output);
        expect(amplitude(samples, 0.5, 440)).toBeGreaterThan(0.2);
        expect(amplitude(samples, 1.5, 440)).toBeGreaterThan(0.2);
      }
    },
    MEDIA_TIMEOUT,
  );
});
