// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Timeline markers (ADR 0029) in the built app: added, renamed and deleted from the ruler's menu as `ui` operations,
// drawn on the marker lane, and a target dragged clips snap to. Real daemon; `titles` clips need no media or plugin.
const box = sandbox("editing");
const mainFile = join(box.projectDir, "timelines", "main.json");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

/** Content px as `layout.ts` stacks them: ruler, the marker lane once there are markers, then V2 above V1. */
const RULER = 22;
const MARKER_LANE = 16;
const LANE = 44;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

const lanes = () => page.getByTestId("timeline-lanes");
const scroller = () => page.locator(".timeline-scroller");
const menu = () => page.getByRole("menu");
const markerItems = () => page.getByRole("list", { name: "Timeline clips" }).locator("li[data-marker]");

/** Screen x of timeline second `time` and the scroller's top, once the lanes are laid out. */
async function geometry(time: number): Promise<{ x: number; top: number }> {
  let box = { left: 0, top: 0, scrollLeft: 0, width: 0, scrollWidth: 0 };
  await expect
    .poll(async () => {
      box = await scroller().evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, scrollLeft: element.scrollLeft, width: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      return box.width > 0;
    })
    .toBe(true);
  return { x: box.left + (time * box.scrollWidth) / FIT_SPAN_S - box.scrollLeft, top: box.top };
}

/** Markers as saved in the timeline file. */
function savedMarkers(): { id: string; at: number; label: string }[] {
  return JSON.parse(readFileSync(mainFile, "utf8")).markers ?? [];
}

function savedStart(id: string): number {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate: { id: string }) => candidate.id === id);
    if (clip) return clip.start;
  }
  throw new Error(`no clip ${id} in ${mainFile}`);
}

test("Add marker here on the ruler names a marker at that time; it shows on the marker lane", async () => {
  await expect(lanes()).toHaveAttribute("data-clips", "4");
  await expect(page.getByTestId("marker-lane-head")).toHaveCount(0);
  const { x, top } = await geometry(16);
  await page.mouse.click(x, top + RULER / 2, { button: "right" });
  await menu().getByRole("menuitem", { name: "Add marker here" }).click();
  const input = page.getByTestId("marker-name-input");
  await expect(input).toBeFocused();
  await input.fill("hook");
  await input.press("Enter");
  await expect(markerItems()).toHaveCount(1);
  await expect(markerItems().first()).toHaveText(/^Marker hook, 00:00:1[56]:/);
  await expect(page.getByTestId("marker-lane-head")).toBeVisible();
  const [marker] = savedMarkers();
  expect(marker).toMatchObject({ label: "hook" });
  expect(Math.abs(marker!.at - 16)).toBeLessThan(0.5);
});

test("a dragged clip snaps onto the marker", async () => {
  const [marker] = savedMarkers();
  const v2 = RULER + MARKER_LANE + LANE / 2;
  // c_card plays 20–22 on V2: grab it in the middle and let go with its start a little past the marker.
  const from = await geometry(21);
  const to = await geometry(marker!.at + 1 + 0.25);
  await page.mouse.move(from.x, from.top + v2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.top + v2, { steps: 10 });
  await expect(page.locator(".drag-tooltip")).toContainText("Snapped to marker hook");
  await page.mouse.up();
  await expect.poll(() => savedStart("c_card")).toBe(marker!.at);
});

test("the marker's menu renames it and deletes it", async () => {
  const [marker] = savedMarkers();
  const { x, top } = await geometry(marker!.at);
  await page.mouse.click(x, top + RULER + MARKER_LANE / 2, { button: "right" });
  await menu().getByRole("menuitem", { name: "Rename marker hook" }).click();
  const input = page.getByTestId("marker-name-input");
  await input.fill("cta");
  await input.press("Enter");
  await expect(markerItems().first()).toHaveText(/^Marker cta,/);
  expect(savedMarkers()).toEqual([{ ...marker, label: "cta" }]);

  await page.mouse.click(x, top + RULER + MARKER_LANE / 2, { button: "right" });
  await menu().getByRole("menuitem", { name: "Delete marker cta" }).click();
  await expect(markerItems()).toHaveCount(0);
  await expect(page.getByTestId("marker-lane-head")).toHaveCount(0);
  expect(savedMarkers()).toEqual([]);
});
