// app.evaluate bodies run in main.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// File > Export OpenTimelineIO and File > Export Premiere XML (ADR 0045, 0047): one hand-off path. Main asks where in
// the save dialog (replaced here), the daemon writes the file and the window says what was left out. Real daemon; the
// `titles` clips of the fixture are generated, so no media is needed.
const box = sandbox("editing");

let app: ElectronApplication;

test.afterAll(async () => {
  await app?.close();
});

/** Click a File menu item as the focused project window would. */
async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow, Menu }, itemId) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.focus();
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click(undefined, window, window?.webContents);
  }, id);
}

test("both menu items are on in a video project; a cancelled dialog writes nothing, a picked file is written by the daemon", async () => {
  test.setTimeout(180_000);
  const { app: launched, page } = await launch(box);
  app = launched;
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "4");
  for (const id of ["export-otio", "export-premiere"]) {
    await expect.poll(() => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled, id)).toBe(true);
  }
  const timelineRevision = () => JSON.parse(readFileSync(join(box.projectDir, "timelines", "main.json"), "utf8")).revision;

  const otio = join(box.projectDir, "exports", "handoff.otio");
  const xml = join(box.projectDir, "exports", "handoff.xml");
  await app.evaluate(({ dialog }) => {
    const asked = ((globalThis as { asked?: string[] }).asked = [] as string[]);
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      asked.push(String((args.at(-1) as { defaultPath?: string }).defaultPath));
      return { canceled: true, filePath: "" };
    }) as typeof dialog.showSaveDialog;
  });
  const asked = () => app.evaluate(() => (globalThis as { asked?: string[] }).asked);
  await clickMenu(app, "export-otio");
  await expect.poll(async () => (await asked())?.length).toBe(1);
  await clickMenu(app, "export-premiere");
  await expect.poll(async () => (await asked())?.length).toBe(2);
  await page.waitForTimeout(500);
  expect(existsSync(otio)).toBe(false);
  expect(existsSync(xml)).toBe(false);
  // Both dialogs start in exports/, made for them (#749: Windows opened the parent of a missing folder).
  expect(await asked()).toEqual([
    join(box.projectDir, "exports", "main.otio"),
    join(box.projectDir, "exports", "main.xml"),
  ]);
  expect(existsSync(join(box.projectDir, "exports"))).toBe(true);

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, otio);
  await clickMenu(app, "export-otio");
  // Four generated clips, each a missing-media warning: the notice counts them.
  await expect(page.locator(".statusbar")).toContainText("Exported handoff.otio. 4 things are not in the OpenTimelineIO file.", { timeout: 60_000 });
  // What it leaves out is one click away, never a terminal command (#749).
  await page.getByTestId("notice-details").click();
  await expect(page.getByTestId("notice-details-list").locator("li")).toHaveCount(4);
  await page.getByTestId("notice-details").click();
  await expect(page.getByTestId("notice-details-list")).toHaveCount(0);
  await app.evaluate(({ shell }) => {
    const shown = ((globalThis as { shown?: string[] }).shown = [] as string[]);
    shell.showItemInFolder = (path: string) => void shown.push(path);
  });
  await page.getByTestId("notice-reveal").click();
  await expect.poll(() => app.evaluate(() => (globalThis as { shown?: string[] }).shown)).toEqual([otio]);
  const timeline = JSON.parse(readFileSync(otio, "utf8"));
  expect(timeline.OTIO_SCHEMA).toBe("Timeline.1");
  expect(timeline.tracks.children).toHaveLength(2);

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, xml);
  await clickMenu(app, "export-premiere");
  await expect(page.locator(".statusbar")).toContainText("Exported handoff.xml. 4 things are not in the Premiere file.", { timeout: 60_000 });
  const premiere = readFileSync(xml, "utf8");
  expect(premiere).toContain('<xmeml version="4">');
  expect(premiere).toContain("<sequence");
  // The timeline is as it was: exporting never edits it.
  expect(timelineRevision()).toBe(0);
});
