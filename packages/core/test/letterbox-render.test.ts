import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Timeline, type Transcript, letterboxBars } from "@frameshell/schema";
import { type ExportSource, compileFrame, writeFonts } from "../src/index.js";
import { runTool } from "../src/media/ffmpeg.js";
import { tempDir } from "./helpers.js";
import { mediaTools, run, runBuffer } from "./media-tools.js";

// Export side of the letterbox parity (ADR 0043): the managed ffmpeg's frame against `letterboxBars`, the numbers the
// preview's overlay draws. Grey footage, so a bar row is pure black and a picture row is not; captions burn over the bars.
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

const source: ExportSource = { path: "", video: { codec: "h264", still: false, width: W, height: H }, audio: false, duration: 1 };

/** One second of grey on the bottom track; `captions` adds a subtitle track showing one word the whole second. */
function boxed(aspect: number | null, captions = false): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: [{ id: "c_grey", type: "media", asset: CLIP, start: 0, in: 0, out: 1 }] },
      ...(captions ? [{ id: "s1", kind: "subtitles" as const, follows: "v1" }] : []),
    ],
    ...(aspect !== null ? { letterbox: { aspect } } : {}),
  };
}

const transcript: Transcript = {
  schemaVersion: 1,
  asset: CLIP,
  assetHash: `sha256:${"b".repeat(64)}`,
  provider: "whisper-cpp",
  model: "test",
  words: [{ id: "w_000001", text: "HOLA", start: 0, end: 0.95 }],
  edits: {},
};

/** RGB bytes of the PNG frame export captures at 0.5 s, through the same steps as `ExportService.frame`. */
async function exported(timeline: Timeline): Promise<Buffer> {
  const work = join(root, "work", String(Math.random()).slice(2));
  mkdirSync(work, { recursive: true });
  const out = join(work, "frame.png");
  const plan = compileFrame({
    timeline,
    fps: 30,
    sources: new Map([[CLIP, { ...source, path: join(root, CLIP) }]]),
    transcripts: new Map([[CLIP, transcript]]),
    resolution: { width: W, height: H },
    width: W,
    height: H,
    at: 0.5,
    output: out,
  });
  for (const [name, text] of Object.entries(plan.files)) writeFileSync(join(work, name), text);
  await writeFonts(work, plan.fonts);
  await runTool(ffmpeg, plan.args, { cwd: work });
  return runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/** Brightest channel of each pixel, row by row. */
function luma(rgb: Buffer): number[][] {
  return Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => Math.max(rgb[(y * W + x) * 3]!, rgb[(y * W + x) * 3 + 1]!, rgb[(y * W + x) * 3 + 2]!)));
}

/** Whether pixel (x, y) lies in one of `aspect`'s bars, as the preview draws them. */
function inBar(aspect: number, x: number, y: number): boolean {
  return letterboxBars({ width: W, height: H }, aspect).some((bar) => x >= bar.left && x < bar.left + bar.width && y >= bar.top && y < bar.top + bar.height);
}

describe("letterbox export (real ffmpeg, ADR 0043)", () => {
  it(
    "paints exactly the pixels letterboxBars names black, top and bottom or at the sides, and leaves the picture alone",
    async () => {
      for (const aspect of [2.39, 4 / 3, 1]) {
        const pixels = luma(await exported(boxed(aspect)));
        let bars = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (inBar(aspect, x, y)) {
              bars++;
              expect(pixels[y]![x], `bar pixel ${x},${y} at ${aspect}`).toBe(0);
            } else {
              expect(pixels[y]![x], `picture pixel ${x},${y} at ${aspect}`).toBeGreaterThan(100);
            }
          }
        }
        expect(bars).toBeGreaterThan(0);
      }
      const plain = luma(await exported(boxed(null)));
      expect(plain.every((row) => row.every((value) => value > 100))).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "burns the captions over the bars: a caption line inside the bottom bar stays readable",
    async () => {
      // At 4:1 the bottom bar covers rows 130-179, where the default caption line sits (its bottom 12 % above the frame's).
      const bar = letterboxBars({ width: W, height: H }, 4)[1]!;
      expect(bar.top).toBe(130);
      const brightest = (pixels: number[][]) => Math.max(...pixels.slice(bar.top, bar.top + bar.height).flat());
      expect(brightest(luma(await exported(boxed(4))))).toBe(0);
      expect(brightest(luma(await exported(boxed(4, true))))).toBeGreaterThan(200);
    },
    MEDIA_TIMEOUT,
  );
});
