// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { addBarcodeAsset, installFrameReader, readShownFrame, waitForIngest } from "./preview-probe.js";

// Preview player (#15, ADR 0001): media clips play from their proxies at the shared playhead. The source clip carries
// its frame index as a barcode, so every check reads what the preview canvas really shows.
const box = sandbox("preview");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/take.mp4";

let app: ElectronApplication;
let page: Page;

/** Program: three cuts from one 6 s take, then a rendered clip the preview cannot play yet. Source frames per program frame below. */
const media = (id: string, start: number, inS: number, out: number) => ({ id, type: "media", asset: ASSET, start, in: inS, out });
const CLIPS = [
  media("c_a", 0, 1, 2), // program frames 0-29 show source 30-59
  media("c_b", 1, 4, 5), // 30-59 show 120-149
  media("c_c", 2, 2.5, 3.5), // 60-89 show 75-104
  { id: "c_gen", type: "hyperframes", start: 3, duration: 1, source: "compositions/hyperframes/intro/index.html" }, // 90-119
];
/** Source frame shown at each program frame of {@link CLIPS}; -1 for the placeholder. */
const expected = (frame: number, cClipIn = 75) =>
  frame < 30 ? 30 + frame : frame < 60 ? 120 + frame - 30 : frame < 90 ? cClipIn + frame - 60 : -1;

function writeTimeline(clips: unknown[]): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.revision += 1;
  timeline.tracks[0].clips = clips;
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

const playhead = () => page.getByTestId("playhead");
const frame = () => page.getByTestId("preview-frame");
const frameOfTimecode = (text: string) => {
  const [h, m, s, f] = text.split(":").map(Number);
  return ((h! * 60 + m!) * 60 + s!) * 30 + f!;
};

/**
 * Sample the shown source frame on every display frame until playback stops (at most `ms`); `stoppedEarly` when
 * it stopped anywhere but at the program's end.
 */
async function sampleWhilePlaying(ms: number): Promise<{ frames: number[]; stoppedEarly: boolean }> {
  return page.evaluate(async (limit) => {
    const read = (window as unknown as { readShownFrame: () => number }).readShownFrame;
    const frames: number[] = [];
    const until = performance.now() + limit;
    while (performance.now() < until) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames.push(read());
      if (!document.querySelector('[data-testid="preview-frame"]')?.hasAttribute("data-playing")) break;
    }
    const end = document.querySelector('[data-testid="playhead"]')?.textContent;
    return { frames, stoppedEarly: end !== "00:00:04:00" };
  }, ms);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addBarcodeAsset(box, "take.mp4", 6);
  ({ app, page } = await launch(box));
  await waitForIngest(page, ASSET);
  writeTimeline(CLIPS);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "4");
  await installFrameReader(page);
});

test.afterAll(async () => {
  await app?.close();
});

test("shows the program frame under the playhead, decoded from the proxy", async () => {
  await expect(page.locator(".preview-duration")).toHaveText("00:00:04:00");
  await expect(playhead()).toHaveText("00:00:00:00");
  await expect.poll(() => readShownFrame(page)).toBe(30);
});

test("steps frame by frame with the arrow keys, across a cut", async () => {
  await page.locator(".preview-stage").click();
  await page.keyboard.press("ArrowRight");
  await expect(playhead()).toHaveText("00:00:00:01");
  await expect.poll(() => readShownFrame(page)).toBe(31);
  for (let i = 0; i < 29; i++) await page.keyboard.press("ArrowRight");
  await expect(playhead()).toHaveText("00:00:01:00");
  await expect.poll(() => readShownFrame(page)).toBe(120);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => readShownFrame(page)).toBe(59);
});

test("clicking the ruler moves the playhead there and the preview follows", async () => {
  for (let i = 0; i < 6; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  await page.locator(".timeline-scroller").evaluate((element) => (element.scrollLeft = 0));
  const lanes = await laidOutBox(page.locator(".timeline-scroller"));
  // Find a ruler point inside the second or third clip (media, not the placeholder) at this zoom.
  let at = -1;
  let x = lanes.x + 4;
  const seen: number[] = [];
  for (; x < lanes.x + lanes.width && !(at > 30 && at < 90); x += 6) {
    await page.mouse.click(x, lanes.y + 8);
    at = frameOfTimecode((await playhead().textContent()) ?? "");
    seen.push(at);
  }
  test.info().annotations.push({ type: "ruler", description: seen.join(",") });
  expect(at, "a ruler click landed inside the media clips").toBeGreaterThan(30);
  expect(at).toBeLessThan(90);
  await expect.poll(() => readShownFrame(page)).toBe(expected(at));

  // Dragging scrubs: the preview keeps showing the frame under the pointer.
  await page.mouse.move(lanes.x + 4, lanes.y + 8);
  await page.mouse.down();
  await page.mouse.move(x - 6, lanes.y + 8, { steps: 5 });
  await page.mouse.up();
  const scrubbed = frameOfTimecode((await playhead().textContent()) ?? "");
  expect(scrubbed).toBe(at);
  await expect.poll(() => readShownFrame(page)).toBe(expected(scrubbed));
  await page.getByRole("button", { name: "Zoom to fit" }).click();
});

test("plays across the cuts on the audio clock: only program frames, in order, then stops at the end", async () => {
  await page.keyboard.press("Home");
  await expect(playhead()).toHaveText("00:00:00:00");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(frame()).toHaveAttribute("data-playing", "true");
  const { frames } = await sampleWhilePlaying(15_000);

  const shown = frames.filter((f) => f >= 0);
  // Program frame of each shown source frame: stray frames (pre-roll, other parts of the take) have none.
  const programFrame = (source: number) => [...Array(90).keys()].find((f) => expected(f) === source) ?? -1;
  const strays = shown.filter((f) => programFrame(f) < 0);
  expect(strays, `stray source frames ${strays.join(",")}`).toEqual([]);
  const order = shown.map(programFrame);
  expect(order.every((f, i) => i === 0 || f >= order[i - 1]!), "frames play in program order").toBe(true);
  const distinct = new Set(order).size;
  test.info().annotations.push({ type: "playback", description: `${distinct} of 90 program frames seen in ${frames.length} display frames` });
  // Loose: CI runners decode in software and drop frames; the ADR thresholds are measured by preview-thresholds.spec.ts.
  expect(distinct).toBeGreaterThanOrEqual(45);

  await expect(frame()).not.toHaveAttribute("data-playing");
  await expect(playhead()).toHaveText("00:00:04:00");
  await expect(page.getByTestId("preview-placeholder")).toHaveAttribute("data-reason", "generated");
  await expect(page.getByTestId("preview-placeholder")).toContainText("Rendered clips are not previewed yet");
});

test("reflects a timeline change made during playback without restarting it", async () => {
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(frame()).toHaveAttribute("data-playing", "true");
  // Well before the third clip: it now plays source frames 0-29 instead of 75-104.
  const sampling = sampleWhilePlaying(15_000);
  await page.waitForTimeout(500);
  writeTimeline([CLIPS[0], CLIPS[1], media("c_c", 2, 0, 1), CLIPS[3]]);
  const { frames, stoppedEarly } = await sampling;

  expect(stoppedEarly, "playback kept running through the change").toBe(false);
  const third = frames.filter((f) => (f >= 0 && f < 30) || (f >= 75 && f <= 104));
  expect(third.length).toBeGreaterThan(10);
  expect(third.every((f) => f < 30), `third clip shows its new source range, saw ${third.join(",")}`).toBe(true);
  await expect(playhead()).toHaveText("00:00:04:00");
});
