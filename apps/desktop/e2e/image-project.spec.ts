// page.evaluate bodies run in the renderer, app.evaluate bodies in main.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { ffmpegRun, makeSource, testFfmpeg, useTestBinaries } from "./media.js";

// Image projects (ADR 0017): pictures start a project without a timeline. Each picture is a layer, the preview hides
// time, and the picture exports as PNG, JPEG or WebP. The native file dialogs are replaced in main.

/** Whether the video-only menu items (View > Transcript, File > New Image from Frame) are enabled now. */
async function videoMenu(app: ElectronApplication): Promise<boolean[]> {
  return app.evaluate(({ Menu }) => ["view-transcript", "image-from-frame"].map((id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled ?? false));
}

/** Focus the window showing `title`, as a click on it would. */
async function focusWindow(app: ElectronApplication, title: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === `${title} — Frameshell`)?.focus(), title);
}

async function picture(ffmpeg: string, out: string, color: string, size: string): Promise<void> {
  await ffmpegRun(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", out]);
}

test("pictures start an image project: layers instead of the timeline, no playhead, an image export", async () => {
  const box = sandbox("demo");
  await useTestBinaries(box.configDir);
  const folder = join(dirname(box.projectDir), "pictures");
  mkdirSync(folder, { recursive: true });
  const ffmpeg = await testFfmpeg();
  const back = join(folder, "poster.png");
  const logo = join(folder, "logo.png");
  await picture(ffmpeg, back, "navy", "801x601");
  await picture(ffmpeg, logo, "orange", "120x80");
  const { app, page } = await launch({ ...box, projectDir: folder });
  try {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, [back, logo]);
    await page.getByRole("button", { name: "New from video, audio or image…" }).click();
    const form = page.getByRole("form", { name: "New project from video, audio or image" });
    await expect(form.getByText("An image project: no timeline, just the picture.")).toBeVisible();
    await expect(form.getByLabel("Transcribe what is said")).toHaveCount(0);
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.locator(".titlebar-project")).toHaveText("poster", { timeout: 60_000 });

    const dir = join(folder, "poster");
    expect(JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"))).toMatchObject({ kind: "image", resolution: { width: 801, height: 601 } });

    // Layers, topmost first, in the timeline's place; the preview shows the picture's size, not a playhead.
    const layers = page.getByTestId("layers-panel");
    await expect(layers.locator(".layers-label")).toHaveText(["logo", "poster"], { timeout: 30_000 });
    await expect(page.getByTestId("timeline-lanes")).toHaveCount(0);
    await expect(page.getByTestId("playhead")).toHaveCount(0);
    await expect(page.getByTestId("preview-size")).toHaveText("801×601");
    await expect(page.getByRole("button", { name: "Play" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pick" })).toBeVisible();
    // Thumbnails load from the project's media URL.
    await expect
      .poll(() => layers.locator(".layers-thumb img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth > 0)))
      .toEqual([true, true]);

    // No transcript view in an image project (#289): no key, no tab-strip button, no View menu item.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+t" : "Control+Shift+t");
    await expect(page.getByRole("tab", { name: "Transcript" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Transcript", exact: true })).toHaveCount(0);
    await expect(page.locator(".editor-empty")).toContainText("Open a script or JSON file from the explorer.");
    await focusWindow(app, "poster");
    await expect.poll(() => videoMenu(app)).toEqual([false, false]);

    // Move the logo under the poster, then undo: one history step each. Row buttons show on the selected row.
    await layers.locator(".layers-row", { hasText: "logo" }).click();
    await layers.locator(".layers-row", { hasText: "logo" }).getByRole("button", { name: "Move down" }).click();
    await expect(layers.locator(".layers-label")).toHaveText(["poster", "logo"]);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(layers.locator(".layers-label")).toHaveText(["logo", "poster"]);

    // Selecting a layer selects its clip: the inspector follows.
    await layers.locator(".layers-row", { hasText: "logo" }).click();
    await expect(layers.locator(".layers-row.is-active .layers-label")).toHaveText("logo");

    // Rename by double-click.
    await layers.locator(".layers-row", { hasText: "logo" }).dblclick();
    await layers.getByRole("textbox").fill("Brand");
    await layers.getByRole("textbox").press("Enter");
    await expect(layers.locator(".layers-label")).toHaveText(["Brand", "poster"]);

    // Export: the extension picked in the save dialog decides the format.
    const out = join(dir, "exports", "poster.jpg");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, out);
    await page.getByTestId("preview-export-image").click();
    await expect(page.locator(".preview-notice")).toHaveText("Saved poster.jpg", { timeout: 60_000 });
    expect(existsSync(out)).toBe(true);
    expect([...readFileSync(out).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    // Delete a layer.
    await layers.locator(".layers-row", { hasText: "Brand" }).click();
    await layers.locator(".layers-row", { hasText: "Brand" }).getByRole("button", { name: "Delete layer" }).click();
    await expect(layers.locator(".layers-label")).toHaveText(["poster"]);
  } finally {
    await app.close();
  }
});

test("Mod+Shift+S makes an image project from the frame at the playhead, beside the video's, in a new window", async () => {
  const box = sandbox("demo");
  await useTestBinaries(box.configDir);
  const folder = join(dirname(box.projectDir), "videos");
  mkdirSync(folder, { recursive: true });
  const take = join(folder, "interview.mp4");
  await makeSource(await testFfmpeg(), take, { seconds: 2, fps: 25, width: 640, height: 360 });
  const { app, page } = await launch({ ...box, projectDir: folder });
  try {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      // The size question: the first button, the YouTube thumbnail.
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, [take]);
    await page.getByRole("button", { name: "New from video, audio or image…" }).click();
    const form = page.getByRole("form", { name: "New project from video, audio or image" });
    await form.getByLabel("Transcribe what is said").uncheck();
    await form.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1", { timeout: 60_000 });

    // Nothing new on screen until asked: no button, only the shortcut, the File menu and the preview's context menu.
    await page.getByTestId("preview-frame").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: /New image from this frame/ })).toBeVisible();
    await page.keyboard.press("Escape");

    const opened = app.waitForEvent("window");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+s" : "Control+Shift+s");
    const second = await opened;
    const dir = join(folder, "interview frame 00-00");
    await expect(second.locator(".titlebar-project")).toHaveText("interview frame 00-00", { timeout: 60_000 });
    expect(JSON.parse(readFileSync(join(dir, "frameshell.json"), "utf8"))).toMatchObject({ kind: "image", resolution: { width: 1280, height: 720 } });
    await expect(second.getByTestId("layers-panel").locator(".layers-label")).toHaveText(["frame-00-00"], { timeout: 30_000 });
    // One press, one project: the key and the File menu's accelerator never both run it.
    expect(existsSync(join(folder, "interview frame 00-00 (2)"))).toBe(false);
    // The video project is unchanged and still open.
    await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
    await expect(page.locator(".statusbar")).toContainText("Opened interview frame 00-00 in a new window.");
    // The video-only menu items follow the focused window's kind (#289).
    await focusWindow(app, "interview frame 00-00");
    await expect.poll(() => videoMenu(app)).toEqual([false, false]);
    await focusWindow(app, "interview");
    await expect.poll(() => videoMenu(app)).toEqual([true, true]);
  } finally {
    await app.close();
  }
});
