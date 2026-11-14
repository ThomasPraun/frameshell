import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type FrameSize, type ResolvedVignette, type Timeline, vignetteGain, vignetteLevel } from "@frameshell/schema";
import { type ExportSource, compileFrame } from "../src/index.js";
import { vignettePlate, vignettedPicture } from "../src/export/vignette.js";
import { runTool } from "../src/media/ffmpeg.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Export side of the vignette parity (ADR 0043): the managed ffmpeg's plate against `vignetteGain`, the function the
// preview's pass evaluates, then the plate multiplied into a picture, then a whole exported frame.
const MEDIA_TIMEOUT = 180_000;
const W = 320;
const H = 180;
const CLIP = "assets/grey.mp4";

let root: string;
let ffmpeg: string;

beforeAll(async () => {
  root = tempDir();
  ({ ffmpeg } = await mediaTools());
  mkdirSync(join(root, "assets"), { recursive: true });
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=${W}x${H}:r=30:d=1`, "-pix_fmt", "yuv420p", join(root, CLIP)]);
}, MEDIA_TIMEOUT);

/** RGBA bytes of the first frame of lavfi graph `graph`. */
function rgba(graph: string): Promise<Buffer> {
  return runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", graph, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
}

/** The plate level `vignetteGain` gives pixel (x, y). */
const level = (x: number, y: number, size: FrameSize, vignette: ResolvedVignette) => vignetteLevel(vignetteGain(x + 0.5, y + 0.5, size, vignette));

describe("vignette export (real ffmpeg, ADR 0043)", () => {
  it(
    "writes exactly the levels vignetteGain gives, on odd sizes, any aspect and a hard edge",
    async () => {
      const cases: [FrameSize, ResolvedVignette][] = [
        [{ width: 97, height: 55 }, { strength: 0.5, radius: 0.9, softness: 0.5 }],
        [{ width: 64, height: 64 }, { strength: 0.35, radius: 1, softness: 0.6 }],
        [{ width: 41, height: 120 }, { strength: 1, radius: 0.6, softness: 0 }],
        [{ width: 160, height: 90 }, { strength: 0.8, radius: 1.5, softness: 1 }],
        [{ width: 33, height: 21 }, { strength: 0.25, radius: 0.2, softness: 0.7 }],
      ];
      for (const [size, vignette] of cases) {
        const pixels = await rgba(vignettePlate(size, vignette, "30"));
        expect(pixels.length).toBe(size.width * size.height * 4);
        const levels = new Set<number>();
        for (let y = 0; y < size.height; y++) {
          for (let x = 0; x < size.width; x++) {
            const at = (y * size.width + x) * 4;
            const want = level(x, y, size, vignette);
            levels.add(want);
            expect([pixels[at], pixels[at + 1], pixels[at + 2]], `pixel ${x},${y} of ${size.width}x${size.height} ${JSON.stringify(vignette)}`).toEqual([want, want, want]);
          }
        }
        // Not a flat plate: the falloff shows in every case.
        expect(levels.size).toBeGreaterThan(1);
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "multiplies colour by the plate as floor(byte * level / 255) and keeps the picture's alpha",
    async () => {
      const size = { width: 48, height: 27 };
      const vignette = { strength: 0.7, radius: 0.8, softness: 0.6 };
      const picture = `color=c=0xC86432@0.5:s=${size.width}x${size.height}:r=30,trim=end_frame=1,format=gbrap`;
      const before = await rgba(`${picture},format=rgba`);
      const lines: string[] = [];
      const head = vignettedPicture(picture, size, vignette, "30", "x", lines);
      const after = await rgba(`${lines.join(";")};${head},format=rgba`);
      expect(after.length).toBe(before.length);
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          const at = (y * size.width + x) * 4;
          const gain = level(x, y, size, vignette);
          const want = [0, 1, 2].map((c) => Math.floor((before[at + c]! * gain) / 255));
          expect([after[at], after[at + 1], after[at + 2], after[at + 3]], `pixel ${x},${y}`).toEqual([...want, before[at + 3]]);
        }
      }
    },
    MEDIA_TIMEOUT,
  );

  it(
    "darkens an exported frame's clip towards its edges, the bottom track and a scaled layer alike",
    async () => {
      const source: ExportSource = { path: join(root, CLIP), video: { codec: "h264", still: false, width: W, height: H }, audio: false, duration: 1 };
      const vignette = { strength: 0.6, radius: 1, softness: 0.8 };
      const grey = (id: string, extra: object) => ({ id, type: "media" as const, asset: CLIP, start: 0, in: 0, out: 1, vignette, ...extra });
      const timeline: Timeline = {
        schemaVersion: 1,
        id: "main",
        revision: 1,
        tracks: [
          { id: "v1", kind: "video", clips: [grey("c_base", {})] },
          { id: "v2", kind: "video", clips: [grey("c_inset", { transform: { scale: 0.5, x: 80, y: 0 } })] },
        ],
      };
      const work = join(root, "work");
      mkdirSync(work, { recursive: true });
      const out = join(work, "frame.png");
      const plan = compileFrame({ timeline, fps: 30, sources: new Map([[CLIP, source]]), resolution: { width: W, height: H }, width: W, height: H, at: 0.5, output: out });
      await runTool(ffmpeg, plan.args, { cwd: work });
      const pixels = await runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
      const at = (x: number, y: number) => pixels[y * W + x]!;
      const frame = { width: W, height: H };
      // The bottom clip: grey (126 after the YUV round trip) times the plate, within the round trip's rounding.
      const centre = at(40, 90);
      expect(Math.abs(centre - Math.floor((126 * level(40, 90, frame, vignette)) / 255))).toBeLessThanOrEqual(3);
      expect(Math.abs(at(1, 1) - Math.floor((126 * level(1, 1, frame, vignette)) / 255))).toBeLessThanOrEqual(3);
      expect(at(1, 1)).toBeLessThan(centre - 20);
      // The inset (160x90 at 160,45): its own corners darken, around its own centre, over the darkened bottom clip.
      const inset = { width: 160, height: 90 };
      expect(Math.abs(at(240, 90) - Math.floor((126 * level(80, 45, inset, vignette)) / 255))).toBeLessThanOrEqual(3);
      expect(Math.abs(at(161, 46) - Math.floor((126 * level(1, 1, inset, vignette)) / 255))).toBeLessThanOrEqual(3);
      expect(at(161, 46)).toBeLessThan(at(240, 90) - 20);
    },
    MEDIA_TIMEOUT,
  );
});
