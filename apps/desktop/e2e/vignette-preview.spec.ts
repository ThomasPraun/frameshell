// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Vignette in the preview (ADR 0043): the engine's WebGL2 pass against export's `geq` plate and `blend` on the same
// frame. A still in RGB keeps YUV out; the shader's single precision may round a plate level the other way, 1 level.
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const NOISE = "assets/noise.png";
/** `frameshell.json` resolution: the preview canvas (540 px short side), the captured frame and the still are the same size. */
const W = 960;
const H = 540;
const SIZE = { width: W, height: H };

let app: ElectronApplication;
let page: Page;
/** Export's frame 0 in the first test, before the grade is added. */
let first: Buffer | undefined;

/** A 960x540 still of random pixels (fixed seed), straight into `assets/`. */
async function addNoise(): Promise<void> {
  const pixels = Buffer.alloc(W * H * 3);
  let seed = 500;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    pixels[i] = seed >>> 24;
  }
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

/** Put the noise still on the bottom track with `look` (clip fields). */
function showNoise(look: Record<string, unknown>): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_noise", type: "media", asset: NOISE, start: 0, in: 0, out: 2, ...look }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/**
 * Poll until the preview matches export's frame 0 within 1 level. `unlike`: an earlier export, waited away first (the
 * daemon reads an edited timeline file a moment after it is written).
 */
async function matchesExport(unlike?: Buffer): Promise<{ max: number; share: number; exported: Buffer }> {
  let exported = await exportedPixels(box, 0);
  if (unlike) await expect.poll(async () => (exported = await exportedPixels(box, 0)).equals(unlike), { timeout: 20_000 }).toBe(false);
  expect(exported.length).toBe(W * H * 3);
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
  return { ...last, exported };
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addNoise();
  ({ app, page } = await launch(box));
  await waitForIngest(page, NOISE);
  showNoise({ vignette: { strength: 0.8, radius: 0.9, softness: 0.7 } });
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
});

test.afterAll(async () => {
  await app?.close();
});

test("the preview darkens a still's edges as export does: within 1 level, on few channels", async () => {
  const webgl2 = await page.evaluate(() => new OffscreenCanvas(1, 1).getContext("webgl2") !== null);
  test.skip(!webgl2, "no WebGL2 on this machine: the preview draws vignetted clips without it");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  const last = await matchesExport();
  first = last.exported;
  test.info().annotations.push({ type: "preview vs export", description: `max ${last.max}, ${(last.share * 100).toFixed(4)} % of channels differ` });
  expect(last.share).toBeLessThan(0.01);
  await expect(page.getByText(/cannot show colour grades/)).toHaveCount(0);
});

test("a grade and a vignette together: graded first, then darkened, as export does", async () => {
  const webgl2 = await page.evaluate(() => new OffscreenCanvas(1, 1).getContext("webgl2") !== null);
  test.skip(!webgl2, "no WebGL2 on this machine: the preview draws vignetted clips without it");
  showNoise({ grade: { exposure: 0.3, contrast: 1.2 }, vignette: { strength: 0.6, radius: 1.2, softness: 0 } });
  const last = await matchesExport(first);
  expect(last.share).toBeLessThan(0.01);
});
