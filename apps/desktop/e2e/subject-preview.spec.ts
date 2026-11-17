// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import type { EngineStats } from "../src/renderer/src/preview/engine-protocol.js";
import type { FrameshellApi } from "../src/shared/api.js";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { blockDiff, blockMean, exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { type Drops, describeDrops, drawnFrames, dropsIn, startDrawLog } from "./draw-log.js";
import { addBarcodeAsset, engineStats, installFrameReader, readShownFrame, statsDelta, waitForIngest } from "./preview-probe.js";

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

/**
 * Play from the first frame to the end. Returns the source frames read off the canvas at each page display frame (the
 * barcode; -1 where none reads), the program frames the engine drew, the drops inside the word (1 s to 5 s) by kind
 * (#567, `draw-log.ts`) and the engine's counters, annotated under `label`.
 */
async function playThroughWord(label: string): Promise<{ read: number[]; drawn: number[]; drops: Drops; after: EngineStats | null }> {
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  const before = await engineStats(page);
  await startDrawLog(page);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  // Until playback stops. Drops are counted from the engine's draws, not from these reads (#567; draw-log.ts).
  const read = await page.evaluate(async (limit) => {
    const readShown = (window as unknown as { readShownFrame: () => number }).readShownFrame;
    const box = document.querySelector('[data-testid="preview-frame"]')!;
    const frames: number[] = [];
    const start = performance.now();
    while (performance.now() - start < limit) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames.push(readShown());
      if (!box.hasAttribute("data-playing")) break;
    }
    return frames;
  }, 15_000);
  // The engine reports a draw after it, and its counters once a second: let the last ones arrive.
  await page.waitForTimeout(1_200);
  const drawn = await drawnFrames(page);
  const after = await engineStats(page);
  const drops = dropsIn(drawn, after?.dropped, 30, 150);
  const { dropped: _played, ...delta } = statsDelta(before, after);
  test.info().annotations.push({ type: `${label}: drops under the word`, description: describeDrops(drops, after?.dropped) });
  test.info().annotations.push({ type: `${label}: engine`, description: JSON.stringify({ ...delta, decodersPlayed: after?.decodersPlayed }) });
  expect(drawn.every((frame, i) => i === 0 || frame >= drawn[i - 1]!), "frames drawn in order").toBe(true);
  return { read, drawn, drops, after };
}

test("plays through the word with the subject layer: frames drawn in order, one matte decoder more", async () => {
  test.setTimeout(120_000);
  const { read, drawn, drops, after } = await playThroughWord("one plate clip");
  const shown = [...new Set(read.filter((frame) => frame >= 0))];
  expect(shown.every((frame, i) => i === 0 || frame > shown[i - 1]!), "frames in order").toBe(true);
  const announced = new Set(drawn);
  expect(shown.filter((frame) => !announced.has(frame)), "canvas frames the engine never reported").toEqual([]);
  // ADR 0001 threshold 3 allows 0.1 % of program frames: none of 120 starved. Cadence drops are host scheduling.
  expect(drops.starved, describeDrops(drops, after?.dropped)).toEqual([]);
  // The plate's decoder and the subject's matte decoder: the subject draws the plate's decoded frame (the word is a still).
  expect(after?.decodersPlayed).toBe(2);
});

test("plays a dissolve and a wipe of the plate inside the word: each subject draws its plate layer's frame", async () => {
  test.setTimeout(120_000);
  // Three cuts of the take, the second in by a dissolve at 2 s, the third by a wipe at 4 s, both under the word. Each
  // `in` after the first is 0.5 s past its start, so at 3 s the barcode reads source frame 105 once this cut plays.
  const take = (id: string, start: number, inS: number, out: number, extra: object = {}) => ({ id, type: "media", asset: TAKE, start, in: inS, out, ...extra });
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [
    take("c_a", 0, 0, 2),
    take("c_b", 2, 2.5, 4.5, { dissolve: 0.4 }),
    take("c_c", 4, 4.5, 6, { dissolve: 0.4, shape: { kind: "wipe", direction: "left" } }),
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "4");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:03:00");
  await expect.poll(() => readShownFrame(page), { timeout: 30_000 }).toBe(105);
  await expect(page.getByTestId("preview-layer-placeholder")).toHaveCount(0);

  const { drops, after } = await playThroughWord("dissolve and wipe");
  expect(drops.starved, describeDrops(drops, after?.dropped)).toEqual([]);
  // The colour decoders of the plate's main and dissolve layers, and the matte decoder of each of their subjects.
  expect(after?.decodersPlayed).toBe(4);
});

