// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { addBarcodeAsset, installFrameReader, readShownFrame, waitForIngest } from "./preview-probe.js";

// Preview player (ADR 0001): media clips play from their proxies at the shared playhead. The source clip carries
// its frame index as a barcode, so every check reads what the preview canvas really shows.
const box = sandbox("preview");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/take.mp4";

let app: ElectronApplication;
let page: Page;

/** Program: three cuts from one 6 s take, then a generated clip no plugin renders here. Source frames per program frame below. */
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
  // Current revision: the daemon journals the edit as author `file` (SPEC §6.4).
  timeline.tracks[0].clips = clips;
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/**
 * Hover the clip `id` (on the first track, from `start` to `end` s) until its tooltip shows, and return the point.
 * The lane's middle comes from the first track head; the x is swept across the clip, so a scroll or a zoom a test
 * before left behind cannot put the pointer beside it.
 */
async function hoverClip(id: string, start: number, end: number): Promise<{ x: number; y: number }> {
  const scroller = page.locator(".timeline-scroller");
  await scroller.evaluate((element) => (element.scrollLeft = 0));
  const rect = await laidOutBox(scroller);
  const head = await laidOutBox(page.locator(".track-head").first());
  const y = head.y + head.height / 2;
  const tooltip = page.locator(".clip-tooltip");
  const tried: string[] = [];
  for (let step = 1; step < 10; step++) {
    const { scrollLeft, pxPerSecond } = await scroller.evaluate((element) => ({ scrollLeft: element.scrollLeft, pxPerSecond: element.scrollWidth / 60 }));
    const x = rect.x + (start + ((end - start) * step) / 10) * pxPerSecond - scrollLeft;
    // From outside the lanes first, so every point is a fresh hover.
    await page.mouse.move(rect.x + 2, rect.y + 2);
    await page.mouse.move(x, y, { steps: 2 });
    const shown = await tooltip.waitFor({ timeout: 1_000 }).then(
      () => true,
      () => false,
    );
    const name = shown ? await tooltip.locator("strong").textContent() : null;
    tried.push(`${Math.round(x)},${Math.round(y)}:${name ?? "-"}`);
    if (name === null) continue;
    // A click tells which clip is under the point; the selection is the test's next step anyway.
    await page.mouse.click(x, y);
    if ((await page.getByTestId("timeline-lanes").getAttribute("data-selected")) === id) {
      await page.mouse.move(x + 1, y);
      return { x, y };
    }
  }
  throw new Error(`no point over ${id} showed its tooltip: ${tried.join(" ")}`);
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
  // No plugin renders `hyperframes` here: the layer says why instead of showing a render.
  await expect(page.getByTestId("preview-layer-pending")).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByTestId("preview-layer-pending")).toContainText("frameshell plugin install @frameshell/hyperframes");
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

test("a generated clip's inspector says its render state and why, opens its composition, and toggles motion blur (#746)", async () => {
  const { x, y } = await hoverClip("c_gen", 3, 4);
  // The lane marks the clip that cannot render, with the reason in its tooltip.
  await expect(page.locator(".clip-tooltip")).toContainText("Render failed:");
  await page.mouse.click(x, y);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-selected", "c_gen");
  const generated = page.getByTestId("generated-control");
  await expect(page.getByTestId("generated-state")).toHaveText("Cannot render");
  await expect(page.getByTestId("generated-error")).toContainText("@frameshell/hyperframes");
  await expect(generated).toContainText("compositions/hyperframes/intro/index.html");
  // A generated clip has no image to replace.
  await expect(page.getByRole("button", { name: /Replace image|Use an image instead/ })).toHaveCount(0);
  // The switch sends `clip.set motionBlur: {}`; with no plugin for the type the daemon refuses it, and says so.
  await expect(generated.getByRole("button", { name: "Motion blur" })).toHaveAttribute("aria-pressed", "false");
  await generated.getByRole("button", { name: "Motion blur" }).click();
  await expect(page.locator(".clip-inspector-error")).toContainText('clip type "hyperframes" is not registered');
  await generated.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: "compositions/hyperframes/intro/index.html" })).toHaveAttribute("aria-selected", "true");
});

test("a video clip offers an image in its place, not to replace an image (#746)", async () => {
  await hoverClip("c_a", 0, 1);
  await expect(page.getByRole("button", { name: "Use an image instead…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace image…" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Keyframes" })).toContainText("Keyframes");
  await expect(page.getByRole("group", { name: "Transitions" })).toContainText("Transitions");
});
