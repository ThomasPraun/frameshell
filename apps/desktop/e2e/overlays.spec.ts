// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { blockDiff, blockMean, exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { addBarcodeAsset, waitForIngest } from "./preview-probe.js";

// Overlays and audio tracks (#17): upper video tracks composite over the base in the preview exactly where export puts
// them, their transform and the clips' gain are edited from the preview and the inspector as `ui` operations.
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const TAKE = "assets/take.mp4";
const LOGO = "assets/logo.png";
/** `frameshell.json` resolution: the preview canvas (540 px short side) and the captured frame are the same size. */
const W = 960;
const H = 540;
const SIZE = { width: W, height: H };

let app: ElectronApplication;
let page: Page;

/**
 * Two seconds: the take on V1; a quarter-size picture-in-picture of a later part of the take on V2, 70 % opaque, up
 * and right; a red logo with a transparent half on V3, down and left; the take's sound again on A1 at -12 dB.
 */
function writeTimeline(): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  const media = (id: string, asset: string, start: number, inS: number, out: number, extra: object = {}) => ({ id, type: "media", asset, start, in: inS, out, ...extra });
  timeline.tracks[0].clips = [media("c_base", TAKE, 0, 0, 2)];
  timeline.tracks[1].clips = [media("c_pip", TAKE, 0.5, 3, 4.5, { transform: { x: 240, y: -120, scale: 0.4, opacity: 0.7 } })];
  timeline.tracks[2].clips = [media("c_logo", LOGO, 0, 0, 2, { transform: { x: -300, y: 150, scale: 0.3 } })];
  timeline.tracks[3].clips = [media("c_tone", TAKE, 0, 0, 2, { audio: { gain: -12 } })];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/** 200x200 red square, right half transparent, straight into `assets/`. */
async function addLogo(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "logo.png");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=200x200,format=rgba"],
    ...["-vf", "geq=r=255:g=0:b=0:a='if(lt(X,100),255,0)'", "-frames:v", "1", file],
  ]);
  renameSync(file, join(box.projectDir, LOGO));
}

const frame = () => page.getByTestId("preview-frame");
const lanes = () => page.getByTestId("timeline-lanes");
const inspector = () => page.getByRole("group", { name: /^Settings of clip/ });

/** Saved clip settings. */
function saved(id: string): { transform?: Record<string, number>; audio?: Record<string, number> } {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (const track of timeline.tracks) for (const clip of track.clips) if (clip.id === id) return clip;
  throw new Error(`no clip ${id}`);
}

function journaled(): { op: string; author: string }[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ op, author }) => ({ op, author }));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addBarcodeAsset(box, "take.mp4", 6);
  await addLogo();
  ({ app, page } = await launch(box));
  await waitForIngest(page, TAKE);
  await waitForIngest(page, LOGO);
  writeTimeline();
  await expect(lanes()).toHaveAttribute("data-clips", "4");
});

test.afterAll(async () => {
  await app?.close();
});

test("composites every layer where export puts it: the preview frame matches `frameshell frame`", async () => {
  // Stage padding, not the picture: a click on the picture would select a layer.
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:01:00");
  // Announced only once every layer (decoded frames, the loaded logo) is drawn.
  await expect(frame()).toHaveAttribute("data-shown", "30");

  const preview = await previewPixels(page, SIZE);
  const exported = await exportedPixels(box, 1);
  expect(exported.length).toBe(W * H * 3);
  // Kept with the results: `ffmpeg -f rawvideo -pix_fmt rgb24 -s 960x540 -i <file> out.png` shows them.
  for (const [name, pixels] of [["preview.rgb", preview], ["export.rgb", exported]] as const) {
    writeFileSync(test.info().outputPath(name), pixels);
  }

  // Compared in 16 px blocks: the proxy and the original differ in encoding noise and scaling filters, not in layout.
  const { mean, worst, worstAt } = blockDiff(preview, exported, SIZE);
  test.info().annotations.push({ type: "preview vs export", description: `mean block diff ${mean.toFixed(2)}, worst ${worst.toFixed(1)} at ${worstAt}` });
  // Mean: colour conversion only (macOS ~2; the software decode on Linux and Windows CI runners converts YUV to RGB
  // up to ~15 levels apart per channel, ~7 on average). Worst block: layout; a layer a few px off exceeds it at its edges.
  expect(mean).toBeLessThan(10);
  expect(worst, `worst 16 px block at ${worstAt}`).toBeLessThan(32);

  // And the layers are really there: the logo's opaque half is red in both, its transparent half is not.
  // Logo: 540 px fitted at 0.3 = 162 px, centered 300 px left and 150 px down of the center: x 99-261, y 339-501.
  const red = ([r, g, b]: [number, number, number]) => r > 200 && Math.max(g, b) < 60;
  for (const pixels of [preview, exported]) {
    expect(red(blockMean(pixels, SIZE, 120, 400, 16))).toBe(true);
    expect(red(blockMean(pixels, SIZE, 200, 400, 16))).toBe(false);
  }
});

test("clicking a layer selects its clip; the inspector sets its scale as one ui operation", async () => {
  const picture = await laidOutBox(frame());
  // Inside the logo's opaque half (fractions of the frame): V3 is the top layer there.
  await page.mouse.click(picture.x + picture.width * (140 / W), picture.y + picture.height * (420 / H));
  await expect(lanes()).toHaveAttribute("data-selected", "c_logo");
  await expect(inspector()).toContainText("V3");
  await expect(page.getByTestId("layer-handles")).toHaveAttribute("data-clip", "c_logo");

  const scale = inspector().getByRole("textbox", { name: "Scale (%)" });
  await expect(scale).toHaveValue("30");
  await scale.fill("45");
  await scale.press("Enter");
  await expect.poll(() => saved("c_logo").transform).toEqual({ x: -300, y: 150, scale: 0.45 });
  expect(journaled().at(-1)).toEqual({ op: "clip.set", author: "ui" });
  await expect(page.locator('li[data-clip="c_logo"]')).toContainText("45%");
});

test("dragging the selected layer's handles moves it by the pointer's travel, in project pixels", async () => {
  const handles = page.getByTestId("layer-handles");
  const before = await laidOutBox(handles);
  const picture = await laidOutBox(frame());
  const from = { x: before.x + before.width * 0.25, y: before.y + before.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y - 20, { steps: 8 });
  await page.mouse.up();
  const perPixel = W / picture.width;
  await expect.poll(() => saved("c_logo").transform?.["x"] ?? 0).toBeCloseTo(-300 + 40 * perPixel, -0.5);
  const moved = saved("c_logo").transform!;
  expect(Math.abs(moved["y"]! - (150 - 20 * perPixel))).toBeLessThan(2);
  expect(moved["scale"]).toBe(0.45);
  // The box follows the saved placement.
  await expect.poll(async () => (await laidOutBox(handles)).x - before.x).toBeGreaterThan(30);
});

test("an audio clip shows its gain; the inspector changes it and mutes it", async () => {
  await expect(page.locator('li[data-clip="c_tone"]')).toContainText("-12 dB");
  // The audio lane is the fourth (V3, V2, V1, A1): scroll the lanes to the bottom and click it.
  const scroller = page.locator(".timeline-scroller");
  const scrollTop = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  const lanesBox = await laidOutBox(scroller);
  const width = await scroller.evaluate((element) => element.scrollWidth);
  // Fitted zoom shows 60 s across the content width; the clip spans 0 to 2 s.
  await page.mouse.click(lanesBox.x + (width / 60) * 1, lanesBox.y + 22 + 3 * 44 + 22 - scrollTop);
  await expect(lanes()).toHaveAttribute("data-selected", "c_tone");
  await expect(inspector()).toContainText("A1");

  const gain = inspector().getByRole("textbox", { name: "Gain (dB)" });
  await expect(gain).toHaveValue("-12");
  await gain.fill("-6");
  await gain.press("Enter");
  await expect.poll(() => saved("c_tone").audio).toEqual({ gain: -6 });
  await expect(page.locator('li[data-clip="c_tone"]')).toContainText("-6 dB");
  await inspector().getByRole("button", { name: "Mute" }).click();
  await expect.poll(() => saved("c_tone").audio).toEqual({ gain: -6, muted: true });
  await expect(page.locator('li[data-clip="c_tone"]')).toContainText("muted");
  // No placement on an audio track.
  await expect(inspector().getByRole("group", { name: "Placement" })).toHaveCount(0);
});
