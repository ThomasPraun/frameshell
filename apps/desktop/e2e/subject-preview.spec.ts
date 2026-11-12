// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import type { FrameshellApi } from "../src/shared/api.js";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { blockDiff, blockMean, exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { addBarcodeAsset, installFrameReader, waitForIngest } from "./preview-probe.js";

// A track behind a plate (ADR 0032) in the preview: the subject layer draws the plate's proxy through its matte (the
// stand-in matte, FRAMESHELL_MATTE_STAND_IN: brighter than mid-gray is the subject) over the word, as export does.
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const TAKE = "assets/take.mp4";
const WORD = "assets/word.png";
/** `frameshell.json` resolution: the preview canvas (540 px short side) and the captured frame are the same size. */
const SIZE = { width: 960, height: 540 };
/** Seconds of the take; the word shows from 1 s to 5 s, scaled to the middle half of the frame (clear of the barcode). */
const SECONDS = 6;

let app: ElectronApplication;
let page: Page;

/** A flat red picture the size of the frame, into `assets/`. */
async function addWord(): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "word.png");
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${SIZE.width}x${SIZE.height}`, "-frames:v", "1", file]);
  renameSync(file, join(box.projectDir, WORD));
}

const mattes = () =>
  page.evaluate(async () => (await (window as unknown as { frameshell: FrameshellApi }).frameshell.media.mattes("main")).mattes.map((m) => `${m.asset}:${m.state}`));

const engineStats = () =>
  page.evaluate(() => (window as unknown as { frameshellPreviewProbe: { stats: () => Record<string, number> | null } }).frameshellPreviewProbe.stats());

/**
 * The preview at 2 s once it draws the subject: the app reads `matte.status` on its own clock, so the matte may reach
 * the program only after the daemon says ready. Placeholder gone first, then `data-shown` of that program's draw.
 */
async function showSubjectAt2s(): Promise<void> {
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:02:00");
  await expect(page.getByTestId("preview-layer-placeholder")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "60");
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await addBarcodeAsset(box, "take.mp4", SECONDS);
  await addWord();
  ({ app, page } = await launch(box, { env: { FRAMESHELL_MATTE_STAND_IN: "1", FRAMESHELL_PREVIEW_PROBE: "1" } }));
  await waitForIngest(page, TAKE);
  await waitForIngest(page, WORD);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_take", type: "media", asset: TAKE, start: 0, in: 0, out: SECONDS }];
  timeline.tracks[1].behind = timeline.tracks[0].id;
  timeline.tracks[1].clips = [{ id: "c_word", type: "media", asset: WORD, start: 1, in: 0, out: 4, transform: { scale: 0.5 } }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "2");
  // The preview's read queues the matte; the stand-in makes it in seconds.
  await expect.poll(mattes, { timeout: 180_000, intervals: [500, 1000] }).toEqual([`${TAKE}:ready`]);
  await installFrameReader(page);
  // Before either test, so playback never starts while the program still swaps the placeholder for the subject.
  await showSubjectAt2s();
});

test.afterAll(async () => {
  await app?.close();
});

test("the subject layer draws the person over the word behind them: the preview frame matches `frameshell frame`", async () => {
  await showSubjectAt2s();

  const preview = await previewPixels(page, SIZE);
  const exported = await exportedPixels(box, 2);
  for (const [name, pixels] of [["preview.rgb", preview], ["export.rgb", exported]] as const) {
    writeFileSync(test.info().outputPath(name), pixels);
  }
  const { mean, worst, worstAt } = blockDiff(preview, exported, SIZE);
  test.info().annotations.push({ type: "preview vs export", description: `mean block diff ${mean.toFixed(2)}, worst ${worst.toFixed(1)} at ${worstAt}` });
  // Same bounds as alpha-media.spec.ts: colour conversion only on average, layout in the worst block.
  expect(mean).toBeLessThan(10);
  expect(worst, `worst 16 px block at ${worstAt}`).toBeLessThan(32);

  // Inside the word's box both show red where the take is dark and the take where it is bright (the subject).
  const red = ([r, g, b]: [number, number, number]) => r > 200 && Math.max(g, b) < 60;
  for (const pixels of [preview, exported]) {
    const inside = [280, 400, 520, 640].flatMap((x) => [160, 270, 380].map((y) => blockMean(pixels, SIZE, x, y, 8)));
    expect(inside.some(red)).toBe(true);
    expect(inside.some((rgb) => !red(rgb))).toBe(true);
  }
});

test("plays through the word with the subject layer: frames drawn in order, one colour and one matte decoder more", async () => {
  test.setTimeout(120_000);
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  const before = await engineStats();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  // The source frame on the canvas at every display frame until playback stops.
  const seen = await page.evaluate(async (limit) => {
    const read = () => (window as unknown as { readShownFrame: () => number }).readShownFrame();
    const frames: number[] = [];
    const start = performance.now();
    while (performance.now() - start < limit) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames.push(read());
      if (!document.querySelector('[data-testid="preview-frame"]')?.hasAttribute("data-playing")) break;
    }
    return frames;
  }, 15_000);
  await page.waitForTimeout(1_200);
  const after = await engineStats();

  const shown = [...new Set(seen.filter((frame) => frame >= 0))];
  expect(shown.every((frame, i) => i === 0 || frame > shown[i - 1]!), "frames in order").toBe(true);
  // Inside the word (1 s to 5 s): source frames never shown are dropped frames (ADR 0001 threshold 3).
  const inside = shown.filter((frame) => frame >= 30 && frame < 150);
  const dropped = 120 - inside.length;
  const delta = Object.fromEntries(Object.entries(after ?? {}).map(([key, value]) => [key, key === "decoders" ? value : value - (before?.[key] ?? 0)]));
  test.info().annotations.push({ type: "subject playback", description: JSON.stringify({ dropped, ...delta }) });
  // Threshold 3 allows 0.1 % (none of 120); 2 leaves room for a late rAF of the sampler, not the preview.
  expect(dropped).toBeLessThanOrEqual(2);
  // The plate and the subject's colour and matte decoders (the word is a still).
  expect(after?.["decoders"]).toBe(3);
});
