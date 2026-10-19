// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, runInTerminal, sandbox, terminalText } from "./harness.js";

// Scene spans on the timeline (ADR 0015): a script whose scenes name transcript words shows one span per scene in a
// band under the ruler, hollow until a clip with the scene's `scriptRef` exists. Real daemon, fixture project with a
// hand-written transcript (no media: spans come from the transcript and the timeline file), a stand-in agent TUI
// (e2e/fake-agent.mjs) for the "Ask agent" reference, clicks on canvas pixels.
const box = sandbox("scenes");
const mainFile = join(box.projectDir, "timelines", "main.json");
const FAKE_AGENT = join(import.meta.dirname, "fake-agent.mjs");
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const RULER = 22;
/** Words of "Intro" run 0.2-2.7 s, those of "Demo" 3.2-5.7 s. */
const INTRO = "scripts/plan.md#intro";
const DEMO = "scripts/plan.md#demo";

let app: ElectronApplication;
let page: Page;

const lanes = () => page.getByTestId("timeline-lanes");
const scene = (ref: string) => page.locator(`li[data-scene="${ref}"]`);

/** Click the scene band at timeline second `time` (the lanes show 60 s: a timeline under 48 s scrolls over a minute). */
async function clickBand(time: number): Promise<void> {
  const geometry = await page.locator(".timeline-scroller").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, scrollLeft: element.scrollLeft, pxPerSecond: element.scrollWidth / 60 };
  });
  await page.mouse.click(geometry.left + time * geometry.pxPerSecond - geometry.scrollLeft, geometry.top + RULER + 8);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ app, page } = await launch(box));
  await expect(lanes()).toHaveAttribute("data-clips", "1");
  await runInTerminal(page, `node "${FAKE_AGENT}"`);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("fake-agent ready");
});

test.afterAll(async () => {
  await app?.close();
});

test("a script with two scenes over a transcribed asset shows two hollow spans", async () => {
  await expect(page.locator("li[data-scene]")).toHaveCount(2);
  await expect(scene(INTRO)).toHaveAttribute("data-filled", "false");
  await expect(scene(DEMO)).toHaveAttribute("data-filled", "false");
  await expect(scene(INTRO)).toContainText("Intro, 00:00:00:06 to 00:00:02:21, no clips yet");
  await expect(scene(DEMO)).toContainText("Demo, 00:00:03:06 to 00:00:05:21, no clips yet");
});

test("a click on a span selects its time range and the scene", async () => {
  await clickBand(1.5);
  await expect(scene(INTRO)).toHaveAttribute("data-selected", "true");
  await expect(scene(DEMO)).not.toHaveAttribute("data-selected", "true");
  await expect(lanes()).toHaveAttribute("data-range", "0.2-2.7");
  await clickBand(4.5);
  await expect(scene(DEMO)).toHaveAttribute("data-selected", "true");
  await expect(lanes()).toHaveAttribute("data-range", "3.2-5.7");
});

test("Ask agent on a span references the scene and its time", async () => {
  await clickBand(1.5);
  await page.locator(".timeline-scroller").focus();
  await page.keyboard.press(`${MOD}+l`);
  await expect.poll(() => terminalText(page)).toContain('[frameshell] scene scripts/plan.md#intro "Intro" · 00:00:00.20–00:00:02.70');
});

test("adding a clip with the scene's scriptRef fills its span", async () => {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  const picture = timeline.tracks.find((track: { id: string }) => track.id === "v1");
  picture.clips = [{ id: "c_title", type: "titles", start: 0.2, duration: 2.5, scriptRef: INTRO }];
  // Direct edit at the revision it was read at; the daemon journals it as author `file` (SPEC §6.4).
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(scene(INTRO)).toHaveAttribute("data-filled", "true");
  await expect(scene(DEMO)).toHaveAttribute("data-filled", "false");
  await expect(scene(INTRO)).toContainText("1 clip");
});

test("the filled span selects its clip along with the scene", async () => {
  await clickBand(1.5);
  await expect(lanes()).toHaveAttribute("data-selected", "c_title");
  await expect(scene(INTRO)).toHaveAttribute("data-selected", "true");
});

test("editing the script moves the spans without a reload", async () => {
  const path = join(box.projectDir, "scripts", "plan.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("w_000001..w_000003", "w_000001..w_000002"));
  await expect(scene(INTRO)).toContainText("00:00:00:06 to 00:00:01:21");
});
