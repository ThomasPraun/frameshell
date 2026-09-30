// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Scene <-> clip linking (SPEC §5.5) in the built app, against the canvas timeline (#14):
// real daemon, fixture timeline with scene and whole-script scriptRefs, clicks on canvas pixels.
const box = sandbox("scripted");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

/** Content px of each lane, as `layout.ts` stacks them: ruler, then V2 above V1 (44 px each). */
const RULER = 22;
const LANE = 44;
const ROW_TOP = { v2: RULER, v1: RULER + LANE } as const;
/** Fixture clips: track and time span, seconds. */
const CLIPS = {
  c_intro: { row: "v1", start: 0, end: 4 },
  c_demo: { row: "v1", start: 4, end: 10 },
  c_spare: { row: "v1", start: 10, end: 13 },
  c_card: { row: "v2", start: 2, end: 8 },
} as const;
type ClipId = keyof typeof CLIPS;

const lanes = () => page.getByTestId("timeline-lanes");
const line = (text: string) => page.locator(".editor-host .view-line", { hasText: text });
const selectedHeadings = () => page.locator(".editor-host .scene-heading-selected");

/**
 * Where a clip is on screen. The panel keeps the whole timeline fitted until
 * the user zooms: a timeline under 48 s spans 60 s of lane width.
 */
async function clipGeometry(id: ClipId): Promise<{ x: number; y: number; left: number; top: number; pxPerSecond: number }> {
  const scroller = (await page.locator(".timeline-scroller").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: element.clientWidth };
  })) as { left: number; top: number; width: number };
  const clip = CLIPS[id];
  const pxPerSecond = scroller.width / 60;
  const top = ROW_TOP[clip.row];
  return {
    x: scroller.left + ((clip.start + clip.end) / 2) * pxPerSecond,
    y: scroller.top + top + LANE / 2,
    left: clip.start * pxPerSecond + 0.5,
    top,
    pxPerSecond,
  };
}

/** Click a clip where the canvas draws it. */
async function clickClip(id: ClipId, modifiers: ("Shift" | "Meta")[] = []): Promise<void> {
  const { x, y } = await clipGeometry(id);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(x, y);
  for (const key of modifiers) await page.keyboard.up(key);
}

/** RGB the canvas painted just inside a clip's left edge, where the selection frame goes. */
async function frameColor(id: ClipId): Promise<[number, number, number]> {
  const { left, top } = await clipGeometry(id);
  return page.locator(".timeline-canvas").evaluate(
    (canvas, at) => {
      const ratio = window.devicePixelRatio || 1;
      const pixel = (canvas as HTMLCanvasElement)
        .getContext("2d")!
        .getImageData(Math.floor((at.left + 1) * ratio), Math.floor((at.top + 22) * ratio), 1, 1).data;
      return [pixel[0]!, pixel[1]!, pixel[2]!] as [number, number, number];
    },
    { left, top },
  );
}

/** The accent (`--accent`, #e3a53c), give or take antialiasing. */
const isAccent = ([r, g, b]: [number, number, number]) => r > 190 && g > 130 && g < 200 && b < 110;

test("opens the script with scenes without clips flagged in the gutter", async () => {
  await expect(lanes()).toHaveAttribute("data-clips", "4");
  await page.getByRole("treeitem", { name: "scripts/launch.md", exact: true }).locator("button").first().click();
  await expect(line("## Outro")).toBeVisible();
  await expect(page.locator(".editor-host .scene-glyph-linked")).toHaveCount(2);
  await expect(page.locator(".editor-host .scene-glyph-unlinked")).toHaveCount(1);
  // The whole-script clip covers no scene, but gets its own flag on line 1.
  await expect(page.locator(".editor-host .script-glyph-linked")).toHaveCount(1);
  const flag = (await page.locator(".editor-host .scene-glyph-unlinked").boundingBox())!;
  const outro = (await line("## Outro").boundingBox())!;
  expect(Math.abs(flag.y - outro.y)).toBeLessThan(2);
});

test("clicking a clip on the canvas selects it and highlights its scene", async () => {
  expect(isAccent(await frameColor("c_intro"))).toBe(false);
  await clickClip("c_intro");
  await expect(lanes()).toHaveAttribute("data-selected", "c_intro");
  await expect(page.locator('li[data-clip="c_intro"]')).toHaveAttribute("data-selected", "true");
  await expect.poll(async () => isAccent(await frameColor("c_intro"))).toBe(true);
  expect(isAccent(await frameColor("c_demo"))).toBe(false);
  await expect(selectedHeadings()).toHaveCount(1);
  const intro = (await line("## Intro").boundingBox())!;
  expect(Math.abs((await selectedHeadings().boundingBox())!.y - intro.y)).toBeLessThan(2);
});

test("Shift-click adds a clip, a click on empty lane clears", async () => {
  await clickClip("c_demo", ["Shift"]);
  await expect(lanes()).toHaveAttribute("data-selected", "c_intro c_demo");
  await expect(selectedHeadings()).toHaveCount(2);
  const { pxPerSecond } = await clipGeometry("c_spare");
  const scroller = (await page.locator(".timeline-scroller").boundingBox())!;
  // V1 lane at 30 s: past every clip.
  await page.mouse.click(scroller.x + 30 * pxPerSecond, scroller.y + ROW_TOP.v1 + LANE / 2);
  await expect(lanes()).toHaveAttribute("data-selected", "");
  await expect(selectedHeadings()).toHaveCount(0);
});

test("clicking a scene heading selects its clips on the canvas", async () => {
  await line("## Demo").click();
  await expect(lanes()).toHaveAttribute("data-selected", "c_demo");
  await expect.poll(async () => isAccent(await frameColor("c_demo"))).toBe(true);
  expect(isAccent(await frameColor("c_intro"))).toBe(false);
  const demo = (await line("## Demo").boundingBox())!;
  await expect.poll(async () => Math.abs((await selectedHeadings().boundingBox())!.y - demo.y)).toBeLessThan(2);
});

test("a clip linked to the whole script highlights every scene", async () => {
  await clickClip("c_card");
  await expect(lanes()).toHaveAttribute("data-selected", "c_card");
  await expect(selectedHeadings()).toHaveCount(3);
  await expect(page.locator(".editor-host .script-selected").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lanes()).toHaveAttribute("data-selected", "");
  await expect(page.locator(".editor-host .script-selected")).toHaveCount(0);
});

test("linking a clip on disk clears the scene's flag live", async () => {
  const path = join(box.projectDir, "timelines", "main.json");
  const timeline = JSON.parse(readFileSync(path, "utf8"));
  timeline.tracks[0].clips[2].scriptRef = "scripts/launch.md#outro";
  timeline.revision += 1;
  writeFileSync(path, JSON.stringify(timeline, null, 2));
  await expect(page.locator(".editor-host .scene-glyph-unlinked")).toHaveCount(0);
  await expect(page.locator(".editor-host .scene-glyph-linked")).toHaveCount(3);
  await line("## Outro").click();
  await expect(lanes()).toHaveAttribute("data-selected", "c_spare");
  await expect.poll(async () => isAccent(await frameColor("c_spare"))).toBe(true);
});
