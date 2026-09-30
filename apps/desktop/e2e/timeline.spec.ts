// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, runInTerminal, sandbox, terminalText } from "./harness.js";

// Live timeline (#14): the panel follows the daemon while the CLI edits the project from the integrated terminal.
const box = sandbox("timeline");
const mainFile = join(box.projectDir, "timelines", "main.json");

/** CLI change on disk to timeline on screen, SPEC acceptance for #14. */
const LIVE_BUDGET_MS = 200;
/** Paint of one frame, p95; half a 60 Hz frame leaves room for compositing. */
const PAINT_BUDGET_MS = 8;

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

const lanes = () => page.getByTestId("timeline-lanes");
const clipItems = () => page.getByRole("list", { name: "Timeline clips" }).getByRole("listitem");

test("shows the project's tracks, top layer first", async () => {
  await expect(page.locator(".titlebar-project")).toHaveText("Timeline demo");
  await expect(lanes()).toHaveAttribute("data-revision", "0");
  await expect(page.locator(".track-head")).toHaveText(["V1Picture", "A1Voice"]);
  await expect(page.locator(".timeline-empty")).toContainText("Ask the agent");
});

test("a clip added with the CLI in the terminal appears within 200 ms", async () => {
  // Stamp the moment each revision reaches the screen; the canvas repaints in the same commit.
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="timeline-lanes"]')!;
    const seen: Record<string, number> = {};
    (window as unknown as { revisionSeenAt: Record<string, number> }).revisionSeenAt = seen;
    new MutationObserver(() => {
      seen[target.getAttribute("data-revision") ?? ""] ??= Date.now();
    }).observe(target, { attributes: true, attributeFilter: ["data-revision"] });
  });

  await runInTerminal(page, "frameshell clip add t_video --type timeline --source intro --start 2");
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("revision 1");
  await expect(lanes()).toHaveAttribute("data-revision", "1");

  const shownAt = await page.evaluate(() => (window as unknown as { revisionSeenAt: Record<string, number> }).revisionSeenAt["1"]!);
  // The daemon writes the file, then notifies: its mtime is when the change happened.
  const writtenAt = statSync(mainFile).mtimeMs;
  const latency = shownAt - writtenAt;
  test.info().annotations.push({ type: "latency", description: `${latency.toFixed(1)} ms from file write to screen` });
  expect(latency).toBeLessThan(LIVE_BUDGET_MS);

  await expect(lanes()).toHaveAttribute("data-clips", "1");
  await expect(clipItems()).toHaveText(["V1: intro, 00:00:02:00 to 00:00:06:00"]);
  await expect(page.locator(".timeline-empty")).toHaveCount(0);
});

test("follows direct edits of the timeline file too", async () => {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.revision += 1;
  timeline.tracks[0].name = "Camera";
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.locator(".track-head").first()).toHaveText("V1Camera");
});

test("stays smooth with 250 clips per track while scrolling and zooming", async () => {
  const clips = (prefix: string) =>
    Array.from({ length: 250 }, (_, i) => ({
      id: `c_${prefix}${i}`,
      type: "media",
      asset: `assets/take-${i % 12}.mp4`,
      start: i * 2,
      in: 0,
      out: 1.5,
    }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.revision += 1;
  timeline.tracks[0].clips = clips("v");
  timeline.tracks[1].clips = clips("a");
  writeFileSync(mainFile, JSON.stringify(timeline));
  await expect(lanes()).toHaveAttribute("data-clips", "500");
  // Fitted: every clip on screen at once, the heaviest frame.
  await page.getByRole("button", { name: "Zoom to fit" }).click();

  const { paints, frames } = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroller")!;
    const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const zoom = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
    performance.clearMeasures("timeline-paint");
    const frames: number[] = [];
    let last = await nextFrame();
    const tick = async () => {
      const now = await nextFrame();
      frames.push(now - last);
      last = now;
    };
    for (let i = 0; i < 12; i++) {
      zoom(i < 6 ? "Zoom in" : "Zoom out");
      await tick();
    }
    // About 11x the fitted zoom: some 20 clips per track on screen.
    for (let i = 0; i < 6; i++) zoom("Zoom in");
    scroller.scrollLeft = 0;
    await tick();
    const step = Math.floor((scroller.scrollWidth - scroller.clientWidth) / 100);
    for (let i = 0; i < 90; i++) {
      scroller.scrollLeft += step;
      await tick();
    }
    return { paints: performance.getEntriesByName("timeline-paint").map((entry) => entry.duration), frames };
  });

  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
  test.info().annotations.push({
    type: "performance",
    description: `${paints.length} paints, p95 ${p95(paints).toFixed(2)} ms; frame interval p95 ${p95(frames).toFixed(1)} ms`,
  });
  // Every scrolled frame was repainted, each well inside its frame.
  expect(paints.length).toBeGreaterThanOrEqual(90);
  expect(p95(paints)).toBeLessThan(PAINT_BUDGET_MS);
  await expect(clipItems()).toHaveCount(500);
});
