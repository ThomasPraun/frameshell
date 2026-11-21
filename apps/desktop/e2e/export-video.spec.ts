// app.evaluate bodies run in main.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { makeSource, testFfmpeg, useTestBinaries } from "./media.js";

// Export video without an agent (#738): the preview's Export video button and File > Export video… ask where in the
// save dialog (replaced here), the daemon renders in the background, the button shows the progress and the window says
// where the file went. Real daemon and managed ffmpeg on a one-second synthetic clip.
const box = sandbox("demo");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await useTestBinaries(box.configDir);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  await makeSource(await testFfmpeg(), join(box.projectDir, "assets", "clip.mp4"), { seconds: 1, width: 320, height: 180 });
  const mainFile = join(box.projectDir, "timelines", "main.json");
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks = [{ id: "t_v1", kind: "video", clips: [{ id: "c_a", type: "media", asset: "assets/clip.mp4", start: 0, in: 0, out: 1 }] }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

const button = () => page.getByTestId("preview-export-video");

test("a cancelled dialog exports nothing; a picked file is rendered and the window says where it went", async () => {
  test.setTimeout(240_000);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("export-video")?.enabled)).toBe(true);

  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
  await button().click();
  await expect(button()).toHaveText("Export video");
  await expect(button()).toBeEnabled();

  const out = join(box.projectDir, "exports", "film");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, out);
  await button().click();
  await expect(page.getByTestId("preview-export-done")).toContainText("Exported film.mp4", { timeout: 180_000 });
  expect(existsSync(`${out}.mp4`)).toBe(true);
  await expect(page.getByTestId("preview-export-done").getByRole("button", { name: "Show file" })).toBeVisible();
  await expect(button()).toHaveText("Export video");
});
