// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { testFfmpeg } from "./media.js";

// Generated clips in the preview (#24, SPEC §3.4 / §6.5): a clip added to the timeline renders in the daemon's
// background; the preview shows a placeholder with the render's progress, then plays the cached render as a layer.
// The `card` fixture adapter renders a flat red VP9-alpha card with ffmpeg after a 4 s paced "paint", so the
// placeholder is observable and no headless Chrome is needed.
const box = sandbox("layers");
const mainFile = join(box.projectDir, "timelines", "main.json");
const CARD_PLUGIN = fileURLToPath(new URL("../../../packages/core/test/fixtures/card-plugin/", import.meta.url));
const PINS = { "card-plugin": "file:card-plugin" };

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

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  installTrustedPlugin();
  const ffmpeg = await testFfmpeg();
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

test("a generated clip shows a placeholder with render progress, then plays its cached render as a layer", async () => {
  test.setTimeout(120_000);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_title", type: "card", source: "compositions/cards/title.json", start: 0, duration: 2 }];
  // Direct edit at the current revision: journaled by the daemon as author `file` (SPEC §6.4), which starts the render.
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));

  const pending = page.getByTestId("preview-layer-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("data-clip", "c_title");
  await expect(pending).toContainText("c_title");
  // Progress comes from the daemon's `clip` job events while the adapter paints.
  await expect
    .poll(async () => Number((await pending.getByRole("progressbar").getAttribute("aria-valuenow").catch(() => null)) ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);

  const layer = page.getByTestId("preview-layer");
  await expect(layer).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(pending).toHaveCount(0);
  await expect(layer).toHaveAttribute("src", /\.frameshell\/cache\/clips\/[0-9a-f]{32}\.webm$/);
  // The render really plays: decoded, at the playhead's time, and red where the card is.
  await expect
    .poll(
      () =>
        layer.evaluate((element) => {
          const video = element as HTMLVideoElement;
          if (video.readyState < 2) return "loading";
          const canvas = document.createElement("canvas");
          canvas.width = 8;
          canvas.height = 8;
          const context = canvas.getContext("2d")!;
          context.drawImage(video, 0, 0, 8, 8);
          const [r, g, b] = context.getImageData(4, 4, 1, 1).data;
          return r! > 180 && g! < 80 && b! < 80 ? "red" : `rgb(${r},${g},${b})`;
        }),
      { timeout: 20_000 },
    )
    .toBe("red");

  // The layer follows the shared playhead: at the program's end it shows the render's last frame.
  await page.locator(".preview-stage").click();
  await page.keyboard.press("End");
  await expect(page.getByTestId("playhead")).toHaveText("00:00:02:00");
  await expect.poll(() => layer.evaluate((element) => Math.floor((element as HTMLVideoElement).currentTime * 30))).toBe(59);
  await page.keyboard.press("Home");
  await expect.poll(() => layer.evaluate((element) => Math.floor((element as HTMLVideoElement).currentTime * 30))).toBe(0);
  await expect(pending).toHaveCount(0);
});
