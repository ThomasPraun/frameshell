// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";
import { addBarcodeAsset, installFrameReader, readShownFrame, waitForIngest } from "./preview-probe.js";

// Detachable panels (ADR 0012), part 1: the preview moves to its own window, drawn by the project window's renderer,
// so it shares the playhead and keys with it, keeps playing while the project window is minimized, docks back, and
// opens detached again, where it was, with the project.
const box = sandbox("preview");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/take.mp4";

let app: ElectronApplication;
let page: Page;

/** Playhead text and shown frame in `target`, every 100 ms for `ms`. */
async function sample(target: Page, ms: number): Promise<{ frames: number[]; playheads: string[] }> {
  return target.evaluate(async (limit) => {
    const read = (window as unknown as { readShownFrame: () => number }).readShownFrame;
    const frames: number[] = [];
    const playheads: string[] = [];
    const until = performance.now() + limit;
    while (performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      frames.push(read());
      playheads.push(document.querySelector('[data-testid="playhead"]')?.textContent ?? "?");
    }
    return { frames, playheads };
  }, ms);
}

/** Minimize (or restore) the project window, never the panel windows. */
async function minimizeProject(minimized: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow }, on) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().startsWith("about:")) continue;
      if (on) window.minimize();
      else window.restore();
    }
  }, minimized);
}

/** Whether the preview's panel window is full screen. */
function panelFullScreen(): Promise<boolean | undefined> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("about:"))
      ?.isFullScreen(),
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addBarcodeAsset(box, "take.mp4", 6);
  ({ app, page } = await launch(box));
  await waitForIngest(page, ASSET);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_a", type: "media", asset: ASSET, start: 0, in: 0, out: 6 }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
});

test.afterAll(async () => {
  await app?.close();
});

test("the preview detaches into its own window and shares the playhead and keys with the project window", async () => {
  const opened = panelWindow(app, "preview");
  await page.getByTestId("preview-detach").click();
  const child = await opened;
  await expect(page.getByTestId("panel-docked-elsewhere")).toContainText("Preview");
  await expect(page.locator(".preview-canvas")).toHaveCount(0);
  await expect(child.locator(".preview-canvas")).toBeVisible();
  // The project window's stylesheets reached the panel window.
  expect(await child.evaluate(() => getComputedStyle(document.querySelector(".preview-transport")!).display)).toBe("grid");
  await expect(child).toHaveTitle(/^Preview — /);

  await installFrameReader(child);
  await expect.poll(() => readShownFrame(child), { timeout: 20_000 }).toBe(0);
  // A key in the project window moves the playhead the panel window shows, and one in the panel window too.
  await page.getByTestId("panel-docked-elsewhere").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(child.getByTestId("playhead")).toHaveText("00:00:00:01");
  await child.locator(".preview-stage").click({ position: { x: 4, y: 4 } });
  await child.keyboard.press("ArrowRight");
  await expect(child.getByTestId("playhead")).toHaveText("00:00:00:02");
  await expect.poll(() => readShownFrame(child), { timeout: 10_000 }).toBe(2);
});

test("a detached preview keeps playing at full rate while the project window is minimized", async () => {
  const child = await panelWindow(app, "preview");
  await child.getByRole("button", { name: "Go to start" }).click();
  await child.getByRole("button", { name: "Play" }).click();
  await minimizeProject(true);
  try {
    const { frames, playheads } = await sample(child, 2500);
    const shown = frames.filter((frame) => frame >= 0);
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.at(-1)!).toBeGreaterThan(shown[0]!);
    // The playhead follows every display frame, not once a second (a throttled project window's timers).
    expect(new Set(playheads).size).toBeGreaterThan(10);
  } finally {
    await minimizeProject(false);
  }
  await child.getByRole("button", { name: "Pause" }).click({ timeout: 5000 }).catch(() => undefined);
});

test("F shows the detached preview full screen, Escape leaves it", async () => {
  const child = await panelWindow(app, "preview");
  await child.locator(".preview-stage").click({ position: { x: 4, y: 4 } });
  await child.keyboard.press("f");
  await expect.poll(() => child.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") ?? null)).toBe("preview-body");
  // Pressed at once: the app waits for macOS to finish animating into full screen before it leaves.
  await child.keyboard.press("Escape");
  await expect.poll(() => child.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  await expect.poll(() => panelFullScreen()).toBe(false);
});

test("right-click in the panel window opens the Ask agent menu there", async () => {
  const child = await panelWindow(app, "preview");
  await child.getByTestId("preview-frame").click({ button: "right" });
  await expect(child.getByRole("menuitem", { name: /Ask agent/ })).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await child.keyboard.press("Escape");
  await expect(child.getByRole("menu")).toHaveCount(0);
});

test("the View menu reaches the project window from the panel window", async () => {
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const panel = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith("about:"));
    const item = Menu.getApplicationMenu()?.getMenuItemById("view-transcript");
    item?.click(undefined, panel, panel?.webContents);
  });
  await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
});

test("Dock back returns the preview to its slot; closing the window does too", async () => {
  const child = await panelWindow(app, "preview");
  const closed = child.waitForEvent("close");
  await child.getByRole("button", { name: "Dock preview back" }).click();
  await closed;
  await expect(page.getByTestId("panel-docked-elsewhere")).toHaveCount(0);
  await expect(page.locator(".preview-canvas")).toBeVisible();

  const again = panelWindow(app, "preview");
  await page.getByTestId("preview-detach").click();
  const second = await again;
  await expect(second.locator(".preview-canvas")).toBeVisible();
  await second.close();
  await expect(page.getByTestId("panel-docked-elsewhere")).toHaveCount(0);
  await expect(page.locator(".preview-canvas")).toBeVisible();
});

test("a project reopens with its preview detached where it was", async () => {
  const opened = panelWindow(app, "preview");
  await page.getByTestId("preview-detach").click();
  await opened;
  const bounds = { x: 120, y: 90, width: 700, height: 460 };
  await app.evaluate(({ BrowserWindow }, rect) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("about:"))
      ?.setBounds(rect);
  }, bounds);
  // The placement is saved once the window stops moving.
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(join(box.configDir, "panel-windows.json"), "utf8")) as { detached: string[]; sets: object };
      } catch {
        return null;
      }
    })
    .toMatchObject({ detached: ["preview"] });
  await expect.poll(() => readFileSync(join(box.configDir, "panel-windows.json"), "utf8")).toContain('"width": 700');
  await app.close();

  ({ app, page } = await launch(box));
  const child = await panelWindow(app, "preview");
  await expect(child.locator(".preview-canvas")).toBeVisible();
  await expect(page.getByTestId("panel-docked-elsewhere")).toBeVisible();
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("about:"))
      ?.getBounds(),
  );
  expect(restored).toMatchObject({ width: bounds.width, height: bounds.height });
});
