// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, runInTerminal, sandbox, terminalText } from "./harness.js";
import { ffmpegRun, testFfmpeg, useTestBinaries } from "./media.js";

// Pick inside photos (ADR 0022, #362, #363): a real daemon whose segmentation answers with nested squares
// (FRAMESHELL_SEGMENT_STAND_IN) instead of downloading MobileSAM, and the stand-in agent TUI of the Ask spec.
const FAKE_AGENT = join(import.meta.dirname, "fake-agent.mjs");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** The app on a new image project made from one 800x600 picture, `poster.png`. */
async function openPoster(): Promise<{ app: ElectronApplication; page: Page }> {
  const box = sandbox("demo");
  await useTestBinaries(box.configDir);
  const folder = join(dirname(box.projectDir), "pictures");
  mkdirSync(folder, { recursive: true });
  const photo = join(folder, "poster.png");
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=800x600", "-frames:v", "1", photo]);
  const { app, page } = await launch({ ...box, projectDir: folder }, { env: { FRAMESHELL_SEGMENT_STAND_IN: "1" } });
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
  }, [photo]);
  await page.getByRole("button", { name: "New from video, audio or image…" }).click();
  await page.getByRole("form", { name: "New project from video, audio or image" }).getByRole("button", { name: "Create project" }).click();
  await expect(page.locator(".titlebar-project")).toHaveText("poster", { timeout: 60_000 });
  await expect(page.getByTestId("layers-panel").locator(".layers-label")).toHaveText(["poster"], { timeout: 30_000 });
  return { app, page };
}

test("Pick in a photo outlines the part under the click, up and down change its size, and Ask names the segment", async () => {
  test.setTimeout(240_000);
  const { app, page } = await openPoster();
  try {
    await runInTerminal(page, `node "${FAKE_AGENT}"`);
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("fake-agent ready");

    await page.getByRole("button", { name: "Pick" }).click();
    const frame = await laidOutBox(page.getByTestId("preview-frame"));
    await page.mouse.click(frame.x + frame.width * 0.5, frame.y + frame.height * 0.5);

    const mask = page.getByTestId("preview-pick-mask");
    await expect(mask).toBeVisible({ timeout: 60_000 });
    // The stand-in scores the middle size best.
    await expect(mask).toHaveAttribute("data-size", "2");
    const middle = await laidOutBox(mask);
    await page.keyboard.press("ArrowUp");
    await expect(mask).toHaveAttribute("data-size", "3");
    expect((await laidOutBox(mask)).width).toBeGreaterThan(middle.width);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(mask).toHaveAttribute("data-size", "1");
    expect((await laidOutBox(mask)).width).toBeLessThan(middle.width);

    await page.keyboard.press(`${MOD}+l`);
    await expect
      .poll(() => terminalText(page), { timeout: 60_000 })
      .toMatch(/\[frameshell\] point \(0\.50,0\.50\) @ [\d:.]+ · clip c_\w+ media assets\/poster\.png · segment \.frameshell\/context\/m_\d+_\d+_\d+_1\.png bbox /);
  } finally {
    await app.close();
  }
});

test("Cut out as layer adds the picked part as a new layer over the photo, and undo takes it off", async () => {
  test.setTimeout(240_000);
  const { app, page } = await openPoster();
  try {
    const layers = page.getByTestId("layers-panel").locator(".layers-label");
    await page.getByRole("button", { name: "Pick" }).click();
    const frame = await laidOutBox(page.getByTestId("preview-frame"));
    await page.mouse.click(frame.x + frame.width * 0.5, frame.y + frame.height * 0.5);
    await expect(page.getByTestId("preview-pick-mask")).toHaveAttribute("data-size", "2", { timeout: 60_000 });

    await page.mouse.click(frame.x + frame.width * 0.5, frame.y + frame.height * 0.5, { button: "right" });
    await page.getByRole("menuitem", { name: "Cut out as layer" }).click();
    await expect(layers).toHaveText(["poster-cutout-1", "poster"], { timeout: 60_000 });

    // One transaction: one undo removes the layer.
    await page.keyboard.press(`${MOD}+z`);
    await expect(layers).toHaveText(["poster"]);
  } finally {
    await app.close();
  }
});
