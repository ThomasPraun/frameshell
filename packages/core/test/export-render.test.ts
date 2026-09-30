import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExportPreset, MediaClip, Timeline } from "@frameshell/schema";
import { type ExportSource, compileFrame, compileRender, executeRender } from "../src/index.js";
import { runTool } from "../src/media/ffmpeg.js";
import { tempDir } from "./helpers.js";
import { ffprobeJson, frameLuma } from "./media-fixtures.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Real managed ffmpeg on tiny synthetic media: the plan is only proven by decoding what it renders.
const MEDIA_TIMEOUT = 180_000;

/** Tiny preset: same pipeline as the built-ins, 64x64 so CI renders in seconds. */
const TINY: ExportPreset = {
  id: "tiny",
  container: "mp4",
  video: { codec: "h264", width: 64, height: 64, crf: 12 },
  audio: { codec: "aac", bitrateKbps: 192, sampleRate: 48_000 },
};

/** Luma step between consecutive source frames; the pattern repeats every {@link LEVELS} frames. */
const STEP = 8;
const LEVELS = 25;

let dir: string;
let ffmpeg: string;
/** 64x64 at 30 fps whose frame n has flat luma 16 + 8 * (n mod 25 + 1), plus a 440 Hz tone. */
let counter: ExportSource;

beforeAll(async () => {
  dir = tempDir();
  ({ ffmpeg } = await mediaTools());
  const path = join(dir, "counter.mp4");
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=black:s=64x64:r=30:d=20,geq=lum='16+${STEP}*(mod(N\\,${LEVELS})+1)':cb=128:cr=128`],
    ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=20"],
    ...["-c:v", "libx264", "-crf", "8", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path],
  ]);
  counter = { path, video: { codec: "h264", still: false, width: 64, height: 64 }, audio: true };
}, MEDIA_TIMEOUT);

const media = (id: string, start: number, clipIn: number, out: number, speed?: number): MediaClip => ({
  id,
  type: "media",
  asset: "assets/counter.mp4",
  start,
  in: clipIn,
  out,
  ...(speed ? { speed } : {}),
});

/** Project resolution of these tests: the tiny preset's frame. */
const resolution = { width: 64, height: 64 };

const oneTrack = (clips: MediaClip[]): Timeline => ({
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "v1", kind: "video", clips }],
});

/** Source frame index (mod the pattern) shown by each decoded frame; -1 for black. */
async function sourceFrames(path: string): Promise<number[]> {
  const reference = await frameLuma(counter.path);
  const levels = reference.slice(0, LEVELS);
  return (await frameLuma(path)).map((luma) => {
    if (luma < levels[0]! - STEP / 2) return -1;
    let best = 0;
    for (let i = 1; i < levels.length; i++) if (Math.abs(levels[i]! - luma) < Math.abs(levels[best]! - luma)) best = i;
    return best;
  });
}

/** RGB of pixel (x, y) in every decoded frame of `path` (64x64). */
async function pixels(path: string, x: number, y: number): Promise<[number, number, number][]> {
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const size = 64 * 64 * 3;
  const out: [number, number, number][] = [];
  for (let offset = 0; offset + size <= raw.length; offset += size) {
    const at = offset + (y * 64 + x) * 3;
    out.push([raw[at]!, raw[at + 1]!, raw[at + 2]!]);
  }
  return out;
}

/** Decoded audio of `path`: first channel, 48 kHz float. */
async function audioSamples(path: string): Promise<Float32Array> {
  const raw = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"]);
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

/** Integrated loudness of `path` in LUFS, measured by ffmpeg's EBU R128 scanner. */
async function integratedLoudness(path: string): Promise<number> {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af", "ebur128", "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)![1]);
}

describe("export render (real ffmpeg)", () => {
  it(
    "shows exactly the source frames each clip names: cuts, speed, gaps, across segment joins",
    async () => {
      // 36 frames: source 30-44; 2x speed from 90 (90, 92 … 100); 6 black; source 6-14.
      const timeline = oneTrack([media("a", 0, 1, 1.5), media("b", 0.5, 3, 3.4, 2), media("c", 0.9, 0.2, 0.5)]);
      const sources = new Map([["assets/counter.mp4", counter]]);
      // 0.3 s segments: joins fall inside clips and at cuts.
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 0.3 });
      expect(plan.segments.length).toBeGreaterThan(3);
      const output = join(dir, "frames.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-frames"), output });

      const expected = [
        ...[30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44],
        ...[90, 92, 94, 96, 98, 100],
        ...[-1, -1, -1, -1, -1, -1],
        ...[6, 7, 8, 9, 10, 11, 12, 13, 14],
      ].map((n) => (n < 0 ? -1 : n % LEVELS));
      expect(await sourceFrames(output)).toEqual(expected);

      // Joined segments play as one constant-rate stream: 36 packets of 1/30 s each.
      const probed = (await ffprobeJson(output, ["-select_streams", "v:0", "-show_entries", "stream=r_frame_rate:packet=pts_time,duration_time"])) as {
        streams: { r_frame_rate: string }[];
        packets: { pts_time: string; duration_time: string }[];
      };
      expect(probed.streams[0]!.r_frame_rate).toBe("30/1");
      const times = probed.packets.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
      expect(times).toHaveLength(36);
      times.forEach((time, i) => expect(time - times[0]!).toBeCloseTo(i / 30, 3));
    },
    MEDIA_TIMEOUT,
  );

  it(
    "exports a 200-cut timeline with no click at any cut or segment join, at the loudness target within 1 LU",
    async () => {
      // Deterministic pseudo-random cut list: 3 to 6 frame clips from anywhere in the 20 s source, some at 1.25x.
      let seed = 42;
      const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const clips: MediaClip[] = [];
      let frame = 0;
      for (let i = 0; i < 200; i++) {
        const frames = 3 + Math.floor(random() * 4);
        const speed = i % 5 === 0 ? 1.25 : 1;
        const from = Math.floor(random() * 500);
        const clipIn = Math.round((from / 30) * 1000) / 1000;
        const out = Math.round(((from + frames * speed) / 30) * 1000) / 1000;
        clips.push(media(`c${i}`, Math.round((frame / 30) * 1000) / 1000, clipIn, out, speed === 1 ? undefined : speed));
        frame += frames;
      }
      const sources = new Map([["assets/counter.mp4", counter]]);
      const plan = compileRender({ timeline: oneTrack(clips), fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 1 });
      expect(plan.audio.tracks[0]!.filter((item) => item.kind === "clip")).toHaveLength(200);
      expect(plan.segments.length).toBeGreaterThan(20);
      const output = join(dir, "cuts.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-cuts"), output });

      const samples = await audioSamples(output);
      expect(Math.abs(samples.length - plan.audio.samples)).toBeLessThan(2048); // AAC frame padding at most.
      // A 440 Hz sine of peak A moves at most A * 2π * 440 / 48000 ≈ 0.058 A per sample. A hard cut between two
      // phases jumps up to 2 A; with the edge fades no sample step may exceed a tone's own slope by much.
      let peak = 0;
      let worst = 0;
      let worstAt = 0;
      for (let i = 1; i < samples.length; i++) {
        peak = Math.max(peak, Math.abs(samples[i]!));
        const step = Math.abs(samples[i]! - samples[i - 1]!);
        if (step > worst) [worst, worstAt] = [step, i];
      }
      const naturalStep = peak * 2 * Math.sin((Math.PI * 440) / 48_000);
      expect(worst, `worst step ${worst} at sample ${worstAt} (${worstAt / 48_000} s), peak ${peak}`).toBeLessThan(naturalStep * 1.5);

      expect(Math.abs((await integratedLoudness(output)) - -17)).toBeLessThanOrEqual(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "captures the single frame the timeline shows at a time, as PNG",
    async () => {
      const timeline = oneTrack([media("a", 0, 1, 1.5), media("b", 0.5, 3, 3.4, 2)]);
      const sources = new Map([["assets/counter.mp4", counter]]);
      const png = join(dir, "frame.png");
      // 0.6 s = timeline frame 18 = clip b (from frame 15, 2x from source 90) fourth frame = source 96.
      const plan = compileFrame({ timeline, fps: 30, sources, resolution, width: 64, height: 64, at: 0.6, output: png });
      await runTool(ffmpeg, plan.args);
      expect(plan).toMatchObject({ frame: 18, clip: "b" });
      // Reference levels through the same RGB conversion a PNG goes through.
      const rgb = join(dir, "reference-rgb.mkv");
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", counter.path, "-frames:v", String(LEVELS), "-vf", "format=rgb24", "-c:v", "png", rgb]);
      const levels = await frameLuma(rgb);
      const [luma] = await frameLuma(png);
      const nearest = levels.reduce((best, level, i) => (Math.abs(level - luma!) < Math.abs(levels[best]! - luma!) ? i : best), 0);
      expect(nearest).toBe(96 % LEVELS);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "composites overlays over the base: placed by transform, alpha and opacity kept, on exactly their frames",
    async () => {
      // Badge: 32x32, left half opaque red, right half transparent. Patch: 16x16 opaque white.
      const badge = join(dir, "badge.png");
      await run(ffmpeg, [
        ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=32x32,format=rgba"],
        ...["-vf", "geq=r=255:g=0:b=0:a='if(lt(X,16),255,0)'", "-frames:v", "1", badge],
      ]);
      const patch = join(dir, "patch.png");
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=16x16", "-frames:v", "1", patch]);
      const still = (path: string, size: number): ExportSource => ({ path, video: { codec: "png", still: true, width: size, height: size }, audio: false });
      const sources = new Map([
        ["assets/counter.mp4", counter],
        ["assets/badge.png", still(badge, 32)],
        ["assets/patch.png", still(patch, 16)],
      ]);
      const timeline: Timeline = {
        schemaVersion: 1,
        id: "main",
        revision: 1,
        tracks: [
          { id: "v1", kind: "video", clips: [media("base", 0, 1, 2)] },
          // Fitted 64 px at half scale = 32 px, centered 16 px right: x 32-63, y 16-47. Frames 6-14.
          { id: "v2", kind: "video", clips: [{ id: "badge", type: "media", asset: "assets/badge.png", start: 0.2, in: 0, out: 0.3, transform: { scale: 0.5, x: 16 } }] },
          // A quarter scale = 16 px at the top left corner, half transparent. Frames 3-20.
          { id: "v3", kind: "video", clips: [{ id: "patch", type: "media", asset: "assets/patch.png", start: 0.1, in: 0, out: 0.6, transform: { scale: 0.25, x: -24, y: -24, opacity: 0.5 } }] },
        ],
      };
      const plan = compileRender({ timeline, fps: 30, preset: TINY, loudness: -17, sources, resolution, segmentSeconds: 0.25 });
      const output = join(dir, "overlays.mp4");
      await executeRender(plan, { ffmpeg, workDir: join(dir, "work-overlays"), output });

      const red = ([r, g, b]: [number, number, number]) => r > 180 && g < 90 && b < 90;
      const opaqueRed = (await pixels(output, 40, 32)).map(red);
      expect(opaqueRed).toEqual(Array.from({ length: 30 }, (_, frame) => frame >= 6 && frame < 15));
      // The transparent half shows the base: never red.
      expect((await pixels(output, 56, 32)).some(red)).toBe(false);
      // Half-transparent white over the base: brighter than the base alone, but not white.
      const lifted = await pixels(output, 8, 8);
      const plain = await pixels(output, 8, 56);
      lifted.forEach(([r], frame) => {
        const base = plain[frame]![0];
        if (frame >= 3 && frame < 21) expect(r, `frame ${frame}`).toBeCloseTo((255 + base) / 2, -1.2);
        else expect(Math.abs(r - base), `frame ${frame}`).toBeLessThan(6);
      });
    },
    MEDIA_TIMEOUT,
  );
});
