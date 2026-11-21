// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// #745: at 1280x720 with the terminal open the preview column is narrow. A project with formats keeps Play
// visible (the frame tools fold under the buttons), the custom letterbox field never scrolls the panel sideways,
// and selecting a clip leaves the picture about half the panel while the inspector scrolls, with no sideways bar.
const box = sandbox("colour-inspector");
const PLAIN = "assets/plain.mp4";

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const ffmpeg = await testFfmpeg();
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  const file = join(staging, "plain.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=3"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", file],
  ]);
  renameSync(file, join(box.projectDir, PLAIN));
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const mainFile = join(box.projectDir, "timelines", "main.json");
  const main = JSON.parse(readFileSync(mainFile, "utf8"));
  main.tracks[0].clips = [{ id: "c_plain", type: "media", asset: PLAIN, start: 0, in: 0, out: 3 }];
  writeFileSync(mainFile, JSON.stringify(main, null, 2));
  const configFile = join(box.projectDir, "frameshell.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.formats = [{ id: "wide", ...config.resolution }, { id: "tall", width: 540, height: 960 }, { id: "square", width: 540, height: 540 }];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  ({ app, page } = await launch(box));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, PLAIN);
});

test.afterAll(async () => {
  await app?.close();
});

/** True when `inner` lies inside `outer` horizontally (1 px slack for rounding). */
async function within(inner: string, outer: string): Promise<boolean> {
  return page.evaluate(
    ([inner, outer]) => {
      const a = document.querySelector(inner)!.getBoundingClientRect();
      const b = document.querySelector(outer)!.getBoundingClientRect();
      return a.width > 0 && a.left >= b.left - 1 && a.right <= b.right + 1;
    },
    [inner, outer] as const,
  );
}

/**
 * Elements of the preview panel scrolled sideways, or wider than they show. A box wider than it shows names the
 * deepest elements that reach past its right edge, with by how many pixels, so a failure on another platform's
 * fonts and native controls says which field to fix.
 */
const sideways = () =>
  page.evaluate(() =>
    [document.querySelector(".preview-body")!, ...document.querySelectorAll(".preview-body *")]
      .filter((element) => element.scrollLeft > 0 || (element.matches(".preview-body, .preview-transport, .clip-inspector") && element.scrollWidth > element.clientWidth + 1))
      .map((element) => {
        const edge = element.getBoundingClientRect().left + element.clientWidth;
        const past = [...element.querySelectorAll("*")]
          .filter((inner) => inner.getBoundingClientRect().right > edge + 1 && ![...inner.children].some((child) => child.getBoundingClientRect().right > edge + 1))
          .map((inner) => `${inner.tagName.toLowerCase()}.${inner.className} +${Math.round(inner.getBoundingClientRect().right - edge)}`);
        // Its width and each direct child's, to tell a child too wide from a box laid out too wide.
        const sizes = [element, ...element.children].map((each) => `${each.className.split(" ").pop()} ${Math.round(each.getBoundingClientRect().width)}`);
        const box = `client ${element.clientWidth}; ${sizes.join(", ")}`;
        return past.length > 0 ? `${element.className}: ${past.slice(0, 6).join(", ")} (${box})` : element.className;
      }),
  );

test("a narrow preview with formats keeps every transport button and the whole duration", async () => {
  expect(await page.evaluate(() => document.querySelector(".preview-body")!.getBoundingClientRect().width)).toBeLessThan(400);
  await expect(page.getByTestId("preview-format")).toBeVisible();
  for (const name of ["Go to start", "Play", "Go to end"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  expect(await within(".preview-play", ".preview-transport")).toBe(true);
  expect(await within(".preview-transport-buttons button:last-child", ".preview-transport")).toBe(true);
  expect(await within(".preview-duration", ".preview-body")).toBe(true);
  // Whole, not elided: Export video folds to its icon to leave the room.
  expect(await page.evaluate(() => { const duration = document.querySelector(".preview-duration")!; return duration.scrollWidth <= duration.clientWidth; })).toBe(true);
  await expect(page.getByRole("button", { name: "Export video" })).toBeVisible();
  expect(await sideways()).toEqual([]);
});

test("typing a custom letterbox never scrolls the preview sideways", async () => {
  await page.getByTestId("letterbox-menu").selectOption({ label: "Custom…" });
  const custom = page.locator(".preview-letterbox-custom");
  await custom.click();
  await custom.fill("2.76");
  expect(await sideways()).toEqual([]);
  expect(await within(".preview-play", ".preview-transport")).toBe(true);
  await custom.press("Escape");
});

test("selecting a clip keeps the picture about half the panel; the inspector scrolls, never sideways", async () => {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / 60;
  await page.mouse.click(rect.x + 1.5 * pxPerSecond, rect.y + 44);
  await expect(page.locator(".clip-inspector")).toContainText("plain.mp4");
  const [stage, body] = await page.evaluate(() => [".preview-stage", ".preview-body"].map((s) => document.querySelector(s)!.getBoundingClientRect().height));
  expect(stage!).toBeGreaterThanOrEqual(body! * 0.44);
  expect(await sideways()).toEqual([]);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  // Narrower still, the way macOS lays out 1280 px (an inspector of 210 px with a scrollbar): the colour rows
  // stay inside it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 720));
  await expect.poll(sideways).toEqual([]);
});
