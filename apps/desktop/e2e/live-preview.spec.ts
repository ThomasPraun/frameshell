// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { blockMean, previewPixels } from "./frames.js";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { testFfmpeg } from "./media.js";

// Live preview (ADR 0010): a generated clip whose render is not ready plays its composition in a sandboxed frame from
// `frameshell-live://`, seeked to the playhead, until the engine can play the render. The `card` fixture adapter's live
// page stores each seek in `data-seconds`; the fixture's `live.html` draws it as text. `still` is the same adapter
// without `livePreview`.
const box = sandbox("live");
const mainFile = join(box.projectDir, "timelines", "main.json");
const CARD_PLUGIN = fileURLToPath(new URL("../../../packages/core/test/fixtures/card-plugin/", import.meta.url));
const PINS = { "card-plugin": "file:card-plugin" };
const SIZE = { width: 960, height: 540 };

let app: ElectronApplication;
let page: Page;

/** Install the fixture plugin as `frameshell plugin install` would, and trust it for this project (SPEC §6.6), without npm. */
function installTrustedPlugin(): void {
  const store = join(box.projectDir, ".frameshell", "plugins");
  cpSync(CARD_PLUGIN, join(store, "node_modules", "card-plugin"), { recursive: true });
  writeFileSync(join(store, "package.json"), JSON.stringify({ name: "frameshell-project-plugins", private: true, dependencies: PINS }));
  writeFileSync(join(store, ".frameshell-pins.json"), JSON.stringify(PINS));
  const pluginsHash = createHash("sha256").update(JSON.stringify(Object.entries(PINS).sort())).digest("hex");
  mkdirSync(box.configDir, { recursive: true });
  const decision = { pluginsHash, decision: "trusted", decidedAt: new Date().toISOString() };
  writeFileSync(join(box.configDir, "trust.json"), JSON.stringify({ version: 1, projects: { [box.projectDir]: decision } }));
}

/** Replace the clips of the main timeline's tracks (`v1`, `v2`) with a direct edit (SPEC §6.4). */
function setClips(...tracks: object[][]): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (const [i, track] of timeline.tracks.entries()) track.clips = tracks[i] ?? [];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/** Focus the preview on its stage padding (a click on the picture would select a layer), then press `key`. */
async function press(key: string): Promise<void> {
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press(key);
}

const live = () => page.getByTestId("preview-live");
const liveText = () => page.frameLocator('[data-testid="preview-live"] iframe').locator("#time");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  installTrustedPlugin();
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg: await testFfmpeg() } }));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

test("a clip still rendering plays its live page at the playhead, labelled live, then hands over to its render", async () => {
  test.setTimeout(120_000);
  setClips([{ id: "c_slow", type: "card", source: "compositions/cards/slow.json", start: 0, in: 0.5, duration: 2 }]);

  await expect(live()).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(live()).toHaveAttribute("data-clip", "c_slow");
  // The slate steps aside for a label: the picture is the composition, not the render export will use.
  await expect(page.getByTestId("preview-layer-pending")).toHaveCount(0);
  await expect(page.getByTestId("preview-live-label")).toContainText("Live,");
  // Composition time = in + (playhead - start): 0.5 s at the program's first frame.
  await expect(live()).toHaveAttribute("data-shown", "0.500");
  await expect(liveText()).toHaveText("0.500");

  // The page is laid out at the project format and scaled to the frame, like the render.
  const frame = await laidOutBox(page.getByTestId("preview-frame"));
  // The label sits in the top right corner, clear of the lower third where titles play.
  const label = await laidOutBox(page.getByTestId("preview-live-label"));
  expect(Math.abs(label.y - frame.y - 8)).toBeLessThan(2);
  expect(Math.abs(frame.x + frame.width - (label.x + label.width) - 8)).toBeLessThan(2);
  const shown = await laidOutBox(live());
  expect(Math.abs(shown.width - frame.width)).toBeLessThan(2);
  expect(Math.abs(shown.height - frame.height)).toBeLessThan(2);
  const inner = await live().locator("iframe").evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(inner - frame.width)).toBeLessThan(2);

  await press("Shift+ArrowRight");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:01:00");
  await expect(live()).toHaveAttribute("data-shown", "1.500");
  await expect(liveText()).toHaveText("1.500");
  await page.keyboard.press("ArrowLeft");
  await expect(liveText()).toHaveText("1.467");

  // Render ready: the frame goes, the engine draws the red render.
  await expect(live()).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("preview-live-label")).toHaveCount(0);
  await expect
    .poll(async () => {
      const [r, g, b] = blockMean(await previewPixels(page, SIZE), SIZE, 472, 262, 16);
      return r > 180 && Math.max(g, b) < 70;
    }, { timeout: 20_000 })
    .toBe(true);
});

test("a clip under another picture, or whose adapter has no live preview, keeps its slate", async () => {
  test.setTimeout(120_000);
  await press("Home");
  // V1: a card that renders for a minute. V2: a `still` clip over it, rendering too, with no live preview.
  setClips(
    [{ id: "c_held", type: "card", source: "compositions/cards/held.json", start: 0, duration: 2 }],
    [{ id: "c_still", type: "still", source: "compositions/cards/still.json", start: 0, duration: 2 }],
  );
  const pending = page.getByTestId("preview-layer-pending");
  await expect(pending).toHaveCount(2, { timeout: 30_000 });
  // Long enough for a live page to have loaded had one been allowed.
  await page.waitForTimeout(1_500);
  await expect(live()).toHaveCount(0);

  // The overlay goes: the card is now the topmost picture and plays live.
  setClips([{ id: "c_held", type: "card", source: "compositions/cards/held.json", start: 0, duration: 2 }]);
  await expect(live()).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(live()).toHaveAttribute("data-clip", "c_held");
  await expect(liveText()).toHaveText("0.000");
});
