// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Colour grade in the preview (ADR 0031, #384): the engine's WebGL2 pass against export's `lut3d` on the same frame.
// A still in RGB keeps YUV out: the frames agree within 1 level on almost every channel (docs/research/webgl2-grade.md).
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const NOISE = "assets/noise.png";
const LUT = "luts/look.cube";
/** `frameshell.json` resolution: the preview canvas (540 px short side), the captured frame and the still are the same size. */
const W = 960;
const H = 540;
const SIZE = { width: W, height: H };

let app: ElectronApplication;
let page: Page;

/** A 960x540 still of random pixels (fixed seed) with a grey ramp on top, straight into `assets/`. */
async function addNoise(): Promise<void> {
  const pixels = Buffer.alloc(W * H * 3);
  let seed = 384;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    pixels[i] = seed >>> 24;
  }
  for (let x = 0; x < W; x++) pixels.fill(Math.round((x / (W - 1)) * 255), x * 3, x * 3 + 3);
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "noise.rgb"), pixels);
  await ffmpegRun(await testFfmpeg(), [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", join(staging, "noise.rgb")],
    join(staging, "noise.png"),
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(join(staging, "noise.png"), join(box.projectDir, NOISE));
}

/** A 17-point look: S-curve and a cross-channel twist, so the lattice interpolation shows. */
function writeLut(): void {
  const size = 17;
  const lines = [`LUT_3D_SIZE ${size}`];
  const curve = (v: number) => v * v * (3 - 2 * v);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [x, y, z] = [r / (size - 1), g / (size - 1), b / (size - 1)];
        lines.push([curve(0.8 * x + 0.2 * z), curve(0.9 * y + 0.1 * x), 0.7 * z + 0.3 * y * y].map((v) => v.toFixed(6)).join(" "));
      }
    }
  }
  mkdirSync(join(box.projectDir, "luts"), { recursive: true });
  writeFileSync(join(box.projectDir, LUT), `${lines.join("\n")}\n`);
}

/** Largest channel difference and the share of channels that differ at all. */
function difference(a: Buffer, b: Buffer): { max: number; share: number } {
  let max = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i]! - b[i]!);
    if (diff > 0) differing++;
    max = Math.max(max, diff);
  }
  return { max, share: differing / a.length };
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addNoise();
  writeLut();
  ({ app, page } = await launch(box));
  await waitForIngest(page, NOISE);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [
    {
      id: "c_noise",
      type: "media",
      asset: NOISE,
      start: 0,
      in: 0,
      out: 2,
      grade: { exposure: 0.4, temperature: 0.35, tint: -0.2, contrast: 1.3, saturation: 1.4, lut: LUT, lutMix: 0.8 },
    },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
});

test.afterAll(async () => {
  await app?.close();
});

test("the preview grades a still as export does: within 1 level, on almost no channel", async () => {
  const webgl2 = await page.evaluate(() => new OffscreenCanvas(1, 1).getContext("webgl2") !== null);
  test.skip(!webgl2, "no WebGL2 on this machine: the preview draws graded clips ungraded");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  const exported = await exportedPixels(box, 0);
  expect(exported.length).toBe(W * H * 3);
  // The LUT is read after the timeline: the first picture may be ungraded until its table arrives.
  let last = { max: 255, share: 1 };
  await expect
    .poll(
      async () => {
        last = difference(await previewPixels(page, SIZE), exported);
        return last.max;
      },
      { timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toBeLessThanOrEqual(1);
  test.info().annotations.push({ type: "preview vs export", description: `max ${last.max}, ${(last.share * 100).toFixed(4)} % of channels differ` });
  expect(last.share).toBeLessThan(0.001);
  await expect(page.getByText(/cannot show colour grades/)).toHaveCount(0);
});
