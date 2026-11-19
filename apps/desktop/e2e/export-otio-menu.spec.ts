// app.evaluate bodies run in main.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// File > Export OpenTimelineIO (ADR 0045): main asks where in the save dialog (replaced here), the daemon writes the
// file and the window says what was left out. Real daemon; the `titles` clips of the fixture are generated, so no media is needed.
const box = sandbox("editing");

let app: ElectronApplication;

test.afterAll(async () => {
  await app?.close();
});

/** Click File > Export OpenTimelineIO as the focused project window would. */
async function clickExport(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.focus();
    Menu.getApplicationMenu()?.getMenuItemById("export-otio")?.click(undefined, window, window?.webContents);
  });
}

test("the menu item is on in a video project; a cancelled dialog writes nothing, a picked file is written by the daemon", async () => {
  test.setTimeout(120_000);
  const { app: launched, page } = await launch(box);
  app = launched;
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "4");
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("export-otio")?.enabled)).toBe(true);

  const out = join(box.projectDir, "exports", "handoff.otio");
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
  await clickExport(app);
  await page.waitForTimeout(500);
  expect(existsSync(out)).toBe(false);

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, out);
  await clickExport(app);
  // Four generated clips, each a missing-media warning: the notice counts them.
  await expect(page.locator(".statusbar")).toContainText("Exported handoff.otio. 4 things are not in the file", { timeout: 60_000 });
  const otio = JSON.parse(readFileSync(out, "utf8"));
  expect(otio.OTIO_SCHEMA).toBe("Timeline.1");
  expect(otio.tracks.children).toHaveLength(2);
  // The timeline is as it was: exporting never edits it.
  expect(JSON.parse(readFileSync(join(box.projectDir, "timelines", "main.json"), "utf8")).revision).toBe(0);
});
