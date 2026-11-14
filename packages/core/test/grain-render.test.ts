import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type ResolvedGrain, type Timeline, grainSpread, grainStrength } from "@frameshell/schema";
import { BUILTIN_PRESETS, type ExportSource, compileFrame, compileRender } from "../src/index.js";
import { grainedPicture } from "../src/export/grain.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Export side of the grain (ADR 0043 decision 7) on the managed ffmpeg: the plate's spread against `grainSpread` (the
// numbers the preview's pass is held to), and the same bytes for a timeline frame however the export cuts it.
const MEDIA_TIMEOUT = 180_000;
const W = 160;
const H = 90;
const CLIP = "assets/grey.mp4";
const FPS = 30;

let root: string;
let ffmpeg: string;

beforeAll(async () => {
  root = tempDir();
  ({ ffmpeg } = await mediaTools());
  mkdirSync(join(root, "assets"), { recursive: true });
  // A moving test pattern: identical frames would hide a plate that is off by one frame.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}:d=4`, "-pix_fmt", "yuv420p", join(root, CLIP)]);
}, MEDIA_TIMEOUT);

const grain = (amount: number, seed = 5): ResolvedGrain => ({ amount, size: 1, seed, strength: grainStrength(amount) });

/** Mean and standard deviation of `values`. */
function stats(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, std: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
}

/** Per-frame MD5 of the video a plan's graph writes, through ffmpeg `framemd5` instead of the encoder. */
async function frameHashes(args: string[], frames: number, cwd: string): Promise<string[]> {
  const map = args.indexOf("[v]");
  const out = join(cwd, `hashes-${String(Math.random()).slice(2)}.txt`);
  const graph = args.slice(0, map + 1).filter((arg) => arg !== "-progress" && arg !== "pipe:1");
  await run(ffmpeg, [...graph, "-frames:v", String(frames), "-f", "framemd5", "-y", out].map((arg) => (arg.endsWith(".filter") ? join(cwd, arg) : arg)));
  return readFileSync(out, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)!.trim());
}

describe("grain export (real ffmpeg, ADR 0043)", () => {
  it(
    "changes a mid-grey picture by the spread grainSpread names, the same on every channel, and keeps alpha",
    async () => {
      const size = { width: 120, height: 80 };
      for (const [plate, smooth] of [
        [size, false],
        [{ width: 60, height: 40 }, true],
      ] as const) {
        const look = grain(0.5);
        const lines: string[] = [];
        const picture = `color=c=0x808080@0.5:s=${size.width}x${size.height}:r=30,trim=end_frame=8,format=gbrap`;
        const head = grainedPicture(picture, size, plate, look, "30", 3, 8, "x", lines);
        const frames = (graph: string) => runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-filter_complex", `${graph},format=rgba[v]`, "-map", "[v]", "-f", "rawvideo", "-"]);
        const before = await frames(picture);
        const pixels = await frames(`${lines.join(";")};${head}`);
        expect(pixels.length).toBe(size.width * size.height * 4 * 8);
        expect(pixels.length).toBe(before.length);
        const deltas: number[] = [];
        for (let at = 0; at < pixels.length; at += 4) {
          const delta = pixels[at]! - before[at]!;
          expect([pixels[at + 1]! - before[at + 1]!, pixels[at + 2]! - before[at + 2]!, pixels[at + 3]]).toEqual([delta, delta, before[at + 3]]);
          deltas.push(delta);
        }
        const measured = stats(deltas);
        const expected = grainSpread(look, smooth);
        expect(Math.abs(measured.mean - expected.mean), `mean ${measured.mean} vs ${expected.mean}`).toBeLessThan(1);
        expect(Math.abs(measured.std / expected.std - 1), `std ${measured.std} vs ${expected.std}`).toBeLessThan(0.08);
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "gives a timeline frame the same bytes in one segment, split segments, a frame capture and the cover frame",
    async () => {
      const source: ExportSource = { path: join(root, CLIP), video: { codec: "h264", still: false, width: W, height: H }, audio: false, duration: 4 };
      const timeline: Timeline = {
        schemaVersion: 1,
        id: "main",
        revision: 1,
        tracks: [
          { id: "v1", kind: "video", clips: [{ id: "c_base", type: "media", asset: CLIP, start: 0, in: 0, out: 3, grain: { amount: 0.6, size: 2 } }] },
          { id: "v2", kind: "video", clips: [{ id: "c_inset", type: "media", asset: CLIP, start: 0.5, in: 0.5, out: 3, grain: { amount: 0.4 }, transform: { scale: 0.5 } }] },
        ],
      };
      const preset = BUILTIN_PRESETS.find((candidate) => candidate.id === "youtube-1080p")!;
      const common = { timeline, fps: FPS, preset: { ...preset, video: { ...preset.video, width: W, height: H } }, loudness: -17, sources: new Map([[CLIP, source]]), resolution: { width: W, height: H } };
      const work = join(root, "split");
      mkdirSync(work, { recursive: true });
      /** Every frame of a plan, its segments in order. */
      const rendered = async (plan: ReturnType<typeof compileRender>) => {
        for (const [name, text] of Object.entries(plan.files)) writeFileSync(join(work, name), text);
        const hashes: string[] = [];
        for (const segment of plan.segments) hashes.push(...(await frameHashes(segment.args, segment.frames, work)));
        return hashes;
      };
      const whole = await rendered(compileRender({ ...common, segmentSeconds: 10 }));
      expect(whole).toHaveLength(90);
      // Grain moves: no two neighbouring frames of the still-free pattern are alike, and the pattern is not the source's.
      expect(new Set(whole).size).toBe(90);
      const split = compileRender({ ...common, segmentSeconds: 0.7 });
      expect(split.segments.length).toBeGreaterThan(3);
      expect(await rendered(split)).toEqual(whole);
      for (const frame of [17, 70]) {
        const capture = compileFrame({ ...common, width: W, height: H, at: frame / FPS, format: "webp", output: join(work, "frame.webp") });
        expect(await frameHashes(capture.args, 1, work), `frame ${frame}`).toEqual([whole[frame]]);
      }
      const covered = compileRender({ ...common, segmentSeconds: 10, cover: { at: 70 / FPS, layout: null } });
      for (const [name, text] of Object.entries(covered.files)) writeFileSync(join(work, name), text);
      expect((await frameHashes(covered.segments[0]!.args, 1, work))[0]).toBe(whole[70]);
    },
    MEDIA_TIMEOUT,
  );
});
