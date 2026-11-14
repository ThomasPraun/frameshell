// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { grainOf, grainSpread } from "@frameshell/schema";
import { launch, sandbox } from "./harness.js";
import { exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Grain in the preview (ADR 0043 decision 6): the engine's WebGL2 pass and export's `noise` plate on the same mid-grey
// still, each held to `grainSpread` (statistically matched, not pixel for pixel). A still in RGB keeps YUV out.
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const GREY = "assets/grey.png";
/** `frameshell.json` resolution: the preview canvas (540 px short side), the captured frame and the still are the same size. */
const W = 960;
const H = 540;
const GRAIN = { amount: 0.5, size: 1, seed: 4 };

let app: ElectronApplication;
let page: Page;

/** Mean and standard deviation of every channel's change from 128. */
function spread(pixels: Buffer): { mean: number; std: number } {
  let sum = 0;
  let squares = 0;
  for (const value of pixels) {
    sum += value - 128;
    squares += (value - 128) ** 2;
  }
  const mean = sum / pixels.length;
  return { mean, std: Math.sqrt(squares / pixels.length - mean * mean) };
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x808080:s=${W}x${H}`, "-frames:v", "1", join(staging, "grey.png")]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(join(staging, "grey.png"), join(box.projectDir, GREY));
  ({ app, page } = await launch(box));
  await waitForIngest(page, GREY);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_grey", type: "media", asset: GREY, start: 0, in: 0, out: 2, grain: GRAIN }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
});

test.afterAll(async () => {
  await app?.close();
});

test("the preview grains a grey still with the spread export's plate has: same mean, same deviation", async () => {
  const webgl2 = await page.evaluate(() => new OffscreenCanvas(1, 1).getContext("webgl2") !== null);
  test.skip(!webgl2, "no WebGL2 on this machine: the preview draws grained clips without it");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  const expected = grainSpread(grainOf({ id: "c_grey", type: "media", grain: GRAIN })!, false);
  const exported = spread(await exportedPixels(box, 0));
  expect(Math.abs(exported.mean - expected.mean)).toBeLessThan(1);
  expect(Math.abs(exported.std / expected.std - 1)).toBeLessThan(0.08);
  let shown = { mean: 0, std: 0 };
  await expect
    .poll(
      async () => {
        shown = spread(await previewPixels(page, { width: W, height: H }));
        return Math.abs(shown.std / expected.std - 1);
      },
      { timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toBeLessThan(0.08);
  expect(Math.abs(shown.mean - expected.mean)).toBeLessThan(1);
  test.info().annotations.push({ type: "grain spread", description: `preview ${JSON.stringify(shown)}, export ${JSON.stringify(exported)}, expected ${JSON.stringify(expected)}` });
  await expect(page.getByText(/cannot show colour grades/)).toHaveCount(0);
});
