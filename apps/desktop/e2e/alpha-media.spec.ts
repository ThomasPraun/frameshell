// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { blockDiff, blockMean, exportedPixels, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { addBarcodeAsset, waitForIngest } from "./preview-probe.js";

// VP9-alpha media assets (#90): their proxy keeps alpha (VP9 WebM), so the preview composites them over lower tracks
// as export does, instead of drawing them opaque.
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const TAKE = "assets/take.mp4";
const BADGE = "assets/badge.webm";
/** `frameshell.json` resolution: the preview canvas (540 px short side) and the captured frame are the same size. */
const W = 960;
const H = 540;
const SIZE = { width: W, height: H };

let app: ElectronApplication;
let page: Page;

/**
 * Two seconds of 480x270, VP9 with alpha, into `assets/`: left half opaque green; right half transparent, its hidden
 * colour blue (what an alpha-dropping proxy would show).
 */
async function addBadge(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "badge.webm");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=480x270:r=30:d=2,format=rgba"],
    ...["-vf", "geq=r=0:g='if(lt(X,240),200,0)':b='if(lt(X,240),0,255)':a='if(lt(X,240),255,0)'"],
    ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-deadline", "realtime", "-b:v", "0", "-crf", "30", file],
  ]);
  renameSync(file, join(box.projectDir, BADGE));
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addBarcodeAsset(box, "take.mp4", 3);
  await addBadge();
  ({ app, page } = await launch(box));
  await waitForIngest(page, TAKE);
  await waitForIngest(page, BADGE);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_base", type: "media", asset: TAKE, start: 0, in: 0, out: 2 }];
  // Fitted to the frame: the opaque half covers x 0-479, the transparent half shows the take.
  timeline.tracks[1].clips = [{ id: "c_badge", type: "media", asset: BADGE, start: 0, in: 0, out: 2 }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "2");
});

test.afterAll(async () => {
  await app?.close();
});

test("a VP9-alpha asset gets an alpha proxy and composites over the base: the preview frame matches `frameshell frame`", async () => {
  const proxy = await page.evaluate(async (asset) => {
    const list = await (window as unknown as { frameshell: { media: { assets(): Promise<{ path: string; proxy: string | null }[]> } } }).frameshell.media.assets();
    return list.find((a) => a.path === asset)?.proxy ?? null;
  }, BADGE);
  expect(proxy).toMatch(/^\.frameshell\/proxies\/.+\.webm$/);

  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:01:00");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "30");

  const preview = await previewPixels(page, SIZE);
  const exported = await exportedPixels(box, 1);
  for (const [name, pixels] of [["preview.rgb", preview], ["export.rgb", exported]] as const) {
    writeFileSync(test.info().outputPath(name), pixels);
  }
  const { mean, worst, worstAt } = blockDiff(preview, exported, SIZE);
  test.info().annotations.push({ type: "preview vs export", description: `mean block diff ${mean.toFixed(2)}, worst ${worst.toFixed(1)} at ${worstAt}` });
  // Same bounds as overlays.spec.ts: colour conversion only on average, layout in the worst block.
  expect(mean).toBeLessThan(10);
  expect(worst, `worst 16 px block at ${worstAt}`).toBeLessThan(32);

  // Opaque half green in both; through the transparent half the take shows, not the hidden blue.
  const green = ([r, g, b]: [number, number, number]) => g > 150 && Math.max(r, b) < 60;
  const blue = ([r, g, b]: [number, number, number]) => b > 200 && Math.max(r, g) < 60;
  for (const pixels of [preview, exported]) {
    expect(green(blockMean(pixels, SIZE, 200, 300, 16))).toBe(true);
    const through = [560, 680, 800, 900].flatMap((x) => [120, 300, 460].map((y) => blockMean(pixels, SIZE, x, y, 16)));
    expect(through.filter(blue).length).toBeLessThan(through.length / 2);
  }
});
