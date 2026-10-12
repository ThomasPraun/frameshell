// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { testFfmpeg } from "./media.js";

// SPIKE (ADR 0012, #160): live page inside an auxiliary window. Throwaway.
// Live preview (ADR 0010): a generated clip whose render is not ready plays its composition in a sandboxed frame from
// `frameshell-live://`, seeked to the playhead, until the engine can play the render. The `card` fixture adapter's live
// page stores each seek in `data-seconds`; the fixture's `live.html` draws it as text. `still` is the same adapter
// without `livePreview`.
const box = sandbox("live");
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

test("live page plays and seeks inside the auxiliary preview window", async () => {
  test.setTimeout(120_000);
  const opened = app.waitForEvent("window");
  await page.getByTestId("spike-detach-preview").click();
  const child = await opened;
  await expect(child.getByTestId("preview-frame")).toBeVisible();
  setClips([{ id: "c_held", type: "card", source: "compositions/cards/held.json", start: 0, in: 0.5, duration: 2 }]);
  const childLive = child.getByTestId("preview-live");
  await expect(childLive).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  const text = child.frameLocator('[data-testid="preview-live"] iframe').locator("#time");
  await expect(text).toHaveText("0.500");
  await child.getByRole("button", { name: "Next frame" }).click();
  await expect(text).toHaveText("0.533");
  const frame = await laidOutBox(child.getByTestId("preview-frame"));
  const shown = await laidOutBox(childLive);
  console.log("[spike] frame", JSON.stringify(frame), "live", JSON.stringify(shown));
  expect(Math.abs(shown.width - frame.width)).toBeLessThan(2);
  // Fullscreen of the preview inside the child window.
  const full = await child.evaluate(async () => {
    await document.querySelector('[data-testid="preview-frame"]')!.requestFullscreen();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const ok = document.fullscreenElement?.getAttribute("data-testid") ?? null;
    await document.exitFullscreen();
    return ok;
  });
  console.log("[spike] fullscreen element:", full);
  expect(full).toBe("preview-frame");
  await child.close();
});
