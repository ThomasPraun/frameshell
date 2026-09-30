// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { blockDiff, blockMean, exportedPixels, previewPixels } from "./frames.js";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { addBarcodeAsset, waitForIngest } from "./preview-probe.js";

// Generated clips in the preview (#24, #98, SPEC §3.4 / §6.5): a clip added to the timeline renders in the daemon's
// background; the preview shows a slate with the render's progress, then the engine decodes the cached VP9-alpha
// render and composites it in track order with every other layer, as export does. The `card` fixture adapter renders
// a flat colour VP9-alpha card with ffmpeg (after a paced "paint" when the card asks for one), so no headless Chrome
// is needed.
const box = sandbox("layers");
const mainFile = join(box.projectDir, "timelines", "main.json");
const CARD_PLUGIN = fileURLToPath(new URL("../../../packages/core/test/fixtures/card-plugin/", import.meta.url));
const PINS = { "card-plugin": "file:card-plugin" };
const TAKE = "assets/take.mp4";
const BLACK = "assets/black.png";
/** `frameshell.json` resolution = the preview canvas (540 px short side), so both frames compare pixel for pixel. */
const SIZE = { width: 960, height: 540 };

let app: ElectronApplication;
let page: Page;

/** Install the fixture plugin as `frameshell plugin install` would, and trust it for this project (SPEC §6.6), without npm. */
function installTrustedPlugin(): void {
  const store = join(box.projectDir, ".frameshell", "plugins");
  cpSync(CARD_PLUGIN, join(store, "node_modules", "card-plugin"), { recursive: true });
  writeFileSync(join(store, "package.json"), JSON.stringify({ name: "frameshell-project-plugins", private: true, dependencies: PINS }));
  writeFileSync(join(store, ".frameshell-pins.json"), JSON.stringify(PINS));
  // Same record the daemon writes on `project.trust`: keyed by root and the hash of the sorted plugin list.
  const pluginsHash = createHash("sha256").update(JSON.stringify(Object.entries(PINS).sort())).digest("hex");
  mkdirSync(box.configDir, { recursive: true });
  const decision = { pluginsHash, decision: "trusted", decidedAt: new Date().toISOString() };
  writeFileSync(join(box.configDir, "trust.json"), JSON.stringify({ version: 1, projects: { [box.projectDir]: decision } }));
}

/** Replace the clips of the main timeline's tracks (`v1`, `v2`, `v3`) with a direct edit, journaled as author `file` (SPEC §6.4). */
function setClips(...tracks: object[][]): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (const [i, track] of timeline.tracks.entries()) track.clips = tracks[i] ?? [];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/** A black 960x540 PNG, straight into `assets/`: an opaque base under the card (export fills the frame with the base track). */
async function addBlack(): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "black.png");
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=960x540", "-frames:v", "1", file]);
  renameSync(file, join(box.projectDir, BLACK));
}

/** Mean RGB of the preview canvas's 16 px block at x, y (canvas px). */
async function previewBlock(x: number, y: number): Promise<[number, number, number]> {
  return blockMean(await previewPixels(page, SIZE), SIZE, x, y, 16);
}

const colour = ([r, g, b]: [number, number, number]) =>
  r > 180 && Math.max(g, b) < 70 ? "red" : b > 180 && Math.max(r, g) < 70 ? "blue" : `rgb(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})`;

/** Focus the preview on its stage padding (a click on the picture would select a layer), then jump to `key`. */
async function press(key: string): Promise<void> {
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press(key);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  installTrustedPlugin();
  await addBarcodeAsset(box, "take.mp4", 3);
  await addBlack();
  const ffmpeg = await testFfmpeg();
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, TAKE);
  await waitForIngest(page, BLACK);
});

test.afterAll(async () => {
  await app?.close();
});

test("a generated clip shows a slate with render progress, then the engine composites its cached render", async () => {
  test.setTimeout(120_000);
  setClips([{ id: "c_title", type: "card", source: "compositions/cards/title.json", start: 0, duration: 2 }]);

  const pending = page.getByTestId("preview-layer-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("data-clip", "c_title");
  await expect(pending).toContainText("c_title");
  // Progress comes from the daemon's `clip` job events while the adapter paints.
  await expect
    .poll(async () => Number((await pending.getByRole("progressbar").getAttribute("aria-valuenow").catch(() => null)) ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);

  await expect(pending).toHaveCount(0, { timeout: 60_000 });
  // No page video layer any more: the render is decoded in the engine worker and drawn on the program canvas.
  await expect(page.locator(".preview-frame video")).toHaveCount(0);
  await expect.poll(async () => colour(await previewBlock(472, 262)), { timeout: 20_000 }).toBe("red");

  // It follows the shared playhead to the program's end, and back.
  await press("End");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:02:00");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "59");
  expect(colour(await previewBlock(472, 262))).toBe("red");
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  expect(colour(await previewBlock(472, 262))).toBe("red");
});

test("a generated clip under a media overlay on a higher track is hidden there, exactly as in export", async () => {
  test.setTimeout(120_000);
  await press("Home");
  // V1: black. V2: a red card at 50 % alpha over the whole frame. V3: the take at half size, centered, opaque.
  setClips(
    [{ id: "c_black", type: "media", asset: BLACK, start: 0, in: 0, out: 2 }],
    [{ id: "c_under", type: "card", source: "compositions/cards/under.json", start: 0, duration: 2 }],
    [{ id: "c_take", type: "media", asset: TAKE, start: 0, in: 0, out: 2, transform: { scale: 0.5 } }],
  );
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "3");
  await expect(page.getByTestId("preview-layer-pending")).toHaveCount(0, { timeout: 60_000 });
  await press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:01:00");
  // Announced only once every layer (the take's decoded frame, the card's render frame) is drawn.
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "30");

  const preview = await previewPixels(page, SIZE);
  const exported = await exportedPixels(box, 1);
  expect(exported.length).toBe(SIZE.width * SIZE.height * 3);
  for (const [name, pixels] of [["preview.rgb", preview], ["export.rgb", exported]] as const) {
    writeFileSync(test.info().outputPath(name), pixels);
  }
  const { mean, worst, worstAt } = blockDiff(preview, exported, SIZE);
  test.info().annotations.push({ type: "preview vs export", description: `mean block diff ${mean.toFixed(2)}, worst ${worst.toFixed(1)} at ${worstAt}` });
  // Same bounds as the #17 overlay test: colour conversion on average, layout at the worst block.
  expect(mean).toBeLessThan(10);
  expect(worst, `worst 16 px block at ${worstAt}`).toBeLessThan(32);

  // The card shows at half alpha around the take (red over black: about 128), and not at all over it.
  const halfRed = ([r, g, b]: [number, number, number]) => r > 100 && r < 160 && Math.max(g, b) < 40;
  for (const pixels of [preview, exported]) {
    expect(halfRed(blockMean(pixels, SIZE, 32, 32, 16))).toBe(true);
    // Take: 480x270 centered, x 240-720, y 135-405. Its middle is testsrc2 footage, never the dark red card.
    expect(halfRed(blockMean(pixels, SIZE, 472, 262, 16))).toBe(false);
  }
});

test("a generated clip inside a nested timeline plays in the preview", async () => {
  test.setTimeout(120_000);
  await press("Home");
  setClips([{ id: "c_nest", type: "timeline", source: "timelines/inner.json", start: 0, in: 0.5, duration: 2 }]);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
  await expect(page.getByTestId("preview-placeholder")).toHaveCount(0);
  // Reported by `clip.renders` under its flattened id `c_nest/c_card`: no "Waiting to render" slate stays up.
  await expect(page.getByTestId("preview-layer-pending")).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(async () => colour(await previewBlock(472, 262)), { timeout: 20_000 }).toBe("blue");
  await press("Shift+ArrowRight");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "30");
  expect(colour(await previewBlock(472, 262))).toBe("blue");
});
