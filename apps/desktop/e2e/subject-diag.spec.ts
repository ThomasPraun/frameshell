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


/** One play from Home: engine-drawn frames, canvas reads, and per-play engine stats. */
async function playOnce(label: string): Promise<void> {
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  await page.waitForTimeout(1_500);
  const before = await engineStats();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  const { drawn, read, raf } = await page.evaluate(async (limit) => {
    const readShown = (window as unknown as { readShownFrame: () => number }).readShownFrame;
    const box = document.querySelector('[data-testid="preview-frame"]')!;
    const values: (string | null)[] = [];
    const observer = new MutationObserver((records) => values.push(...records.map((record) => record.oldValue)));
    observer.observe(box, { attributes: true, attributeFilter: ["data-shown"], attributeOldValue: true });
    const read: number[] = [];
    const raf: number[] = [];
    const start = performance.now();
    let last = start;
    while (performance.now() - start < limit) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      raf.push(now - last);
      last = now;
      read.push(readShown());
      if (!box.hasAttribute("data-playing")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    values.push(...observer.takeRecords().map((record) => record.oldValue), box.getAttribute("data-shown"));
    observer.disconnect();
    return { drawn: values.flatMap((value) => (value === null ? [] : [Number(value)])), read, raf };
  }, 15_000);
  await page.waitForTimeout(1_200);
  const after = (await engineStats()) ?? {};
  const set = new Set(drawn);
  const missing = [...Array(120).keys()].map((f) => f + 30).filter((f) => !set.has(f));
  const unread = 120 - new Set(read.filter((f) => f >= 30 && f < 150)).size;
  const sorted = [...raf].sort((a, b) => a - b);
  const delta = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, ["decoded", "discarded", "drawn", "starved", "restarts", "audioChunks"].includes(k) ? v - (before?.[k] ?? 0) : Math.round(v * 10) / 10]));
  console.log(`DIAG ${label} ${JSON.stringify({ dropped: missing.length, unread, missing: missing.join(","), rafP50: sorted[sorted.length >> 1]?.toFixed(1), rafMax: sorted.at(-1)?.toFixed(0), ...delta })}`);
}

test("diagnose subject playback", async () => {
  test.setTimeout(600_000);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (let round = 0; round < 5; round++) {
    await playOnce(`subject#${round}`);
  }
  // Control: the same take and word without the subject layer (the word over the take, two decoders less).
  delete timeline.tracks[1].behind;
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await page.waitForTimeout(3_000);
  for (let round = 0; round < 3; round++) {
    await playOnce(`plain#${round}`);
  }
});
