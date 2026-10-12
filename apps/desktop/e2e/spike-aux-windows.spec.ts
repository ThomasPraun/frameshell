// SPIKE (ADR 0012, #160): throwaway. page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, runInTerminal, sandbox, terminalText } from "./harness.js";
import { addBarcodeAsset, installFrameReader, readShownFrame, waitForIngest } from "./preview-probe.js";

const box = sandbox("preview");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/take.mp4";

let app: ElectronApplication;
let page: Page;

const log = (...args: unknown[]) => console.log("[spike]", ...args);

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

test("preview in an auxiliary window plays, also with the project window minimized", async () => {
  test.setTimeout(120_000);
  const opened = app.waitForEvent("window");
  await page.getByTestId("spike-detach-preview").click();
  const child = await opened;
  await expect(child.getByTestId("detached-preview")).toBeVisible();
  await expect(child.locator(".preview-canvas")).toBeVisible();
  await expect(page.locator(".spike-placeholder")).toHaveCount(1);
  log("styles in child:", await child.evaluate(() => getComputedStyle(document.querySelector(".preview-transport")!).display));

  await installFrameReader(child);
  await expect.poll(() => readShownFrame(child), { timeout: 20_000 }).toBe(0);

  // Keys typed in the child window.
  await child.locator(".preview-stage").click({ position: { x: 4, y: 4 } });
  await child.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  log("ArrowRight in child -> shown frame", await readShownFrame(child), "playhead", await child.getByTestId("playhead").textContent());

  // Play from the child's own button, then minimize the project window.
  await child.getByRole("button", { name: "Play" }).click();
  const visible = await sample(child, 1000);
  log("visible main window:", JSON.stringify(visible.frames), JSON.stringify(visible.playheads.slice(-3)));

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().startsWith("about:")) w.minimize();
  });
  await page.waitForTimeout(1000);
  log("main minimized:", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => `${w.webContents.getURL().slice(0, 12)}:${w.isMinimized()}`)));
  log("main visibility:", await page.evaluate(() => document.visibilityState));
  const minimized = await sample(child, 2500);
  log("minimized main window:", JSON.stringify(minimized.frames), JSON.stringify(minimized.playheads));
  // Hidden (another Space / Cmd+H path): stronger than minimize.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().startsWith("about:")) { w.restore(); w.hide(); }
  });
  await child.getByRole("button", { name: "Go to start" }).click();
  await child.getByRole("button", { name: "Play" }).click().catch(() => undefined);
  await page.waitForTimeout(1000);
  log("hidden main visibility:", await page.evaluate(() => document.visibilityState));
  const hidden = await sample(child, 2500);
  log("hidden main window:", JSON.stringify(hidden.frames), JSON.stringify(hidden.playheads));
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.isMinimized()) w.restore();
  });
  await child.getByRole("button", { name: "Pause" }).click().catch(() => undefined);

  const advanced = hidden.frames.filter((f) => f >= 0);
  expect(advanced.length).toBeGreaterThan(5);
  expect(advanced.at(-1)!).toBeGreaterThan(advanced[0]!);

  // Dock back by closing the window.
  await child.close();
  await expect(page.locator(".spike-placeholder")).toHaveCount(0);
  await expect(page.locator(".preview-canvas")).toBeVisible();
});

test("terminal in an auxiliary window runs commands", async () => {
  const opened = app.waitForEvent("window");
  await page.getByTestId("spike-detach-terminal").click();
  const child = await opened;
  await expect(child.locator(".terminal-view:not([hidden])")).toBeVisible();
  await runInTerminal(child, "echo spike-$((40+2))");
  await expect.poll(() => terminalText(child), { timeout: 20_000 }).toContain("spike-42");
  log("xterm renderer:", await child.evaluate(() => (document.querySelector(".xterm canvas") ? "canvas/webgl" : "dom")));
  await child.close();
  await expect(page.locator(".spike-placeholder")).toHaveCount(0);
});
