// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Timeline clip right-click menu (#416): the edit commands of the keys, on the right-clicked clip or the selection
// holding it, disabled where the key would do nothing. Real daemon; generated `titles` clips need no media or plugin.
const box = sandbox("editing");
const mainFile = join(box.projectDir, "timelines", "main.json");
const DELETE = process.platform === "darwin" ? "⌫" : "Del";

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
const LANE_MIDDLE = { v2: 22 + 22, v1: 22 + 44 + 22 } as const;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

const lanes = () => page.getByTestId("timeline-lanes");
const scroller = () => page.locator(".timeline-scroller");
const menu = () => page.getByRole("menu");

/** Screen point of timeline second `time` on a lane, once the lanes are laid out. */
async function at(time: number, lane: keyof typeof LANE_MIDDLE): Promise<{ x: number; y: number }> {
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
  return { x: box.left + (time * box.scrollWidth) / FIT_SPAN_S - box.scrollLeft, y: box.top + LANE_MIDDLE[lane] };
}

async function rightClick(time: number, lane: keyof typeof LANE_MIDDLE): Promise<void> {
  const point = await at(time, lane);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

/** Put the playhead on whole second `seconds` with the keyboard, after a click on the ruler focuses the lanes. */
async function playheadTo(seconds: number): Promise<void> {
  await at(0, "v1");
  await scroller().click({ position: { x: 5, y: 8 } });
  await page.keyboard.press("Home");
  for (let i = 0; i < seconds; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(lanes()).toHaveAttribute("data-playhead", String(seconds));
}

function savedIds(): string[] {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  return timeline.tracks.flatMap((track: { clips: { id: string }[] }) => track.clips.map((clip) => clip.id));
}

test("a clip's menu lists the edit commands with their keys, and Split splits it at the playhead", async () => {
  await playheadTo(7);
  await rightClick(6, "v1");
  await expect(menu().getByRole("menuitem")).toHaveText([
    /Ask agent/,
    "Split at playheadS",
    "Trim start to playhead[",
    "Trim end to playhead]",
    `Delete clip${DELETE}`,
    `Ripple delete clip${process.platform === "darwin" ? "⇧" : "Shift+"}${DELETE}`,
  ]);
  await expect(menu().getByRole("separator")).toHaveCount(2);
  await menu().getByRole("menuitem", { name: /Split at playhead/ }).click();
  await expect(lanes()).toHaveAttribute("data-clips", "5");
  expect(savedIds()).toHaveLength(5);
});

test("commands the key would refuse are disabled: the playhead is not over the clip", async () => {
  await playheadTo(0);
  // The middle of c_three (12 to 15 s): a small CI window shows ~6 px a second, so 1 s from an edge offers transitions.
  await rightClick(13.5, "v1");
  await expect(menu().getByRole("menuitem", { name: /Split at playhead/ })).toBeDisabled();
  await expect(menu().getByRole("menuitem", { name: /Trim start to playhead/ })).toBeDisabled();
  await expect(menu().getByRole("menuitem", { name: /^Delete clip/ })).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("an unselected clip's menu acts on that clip alone, not on the earlier selection", async () => {
  const two = await at(5.5, "v1");
  await page.mouse.click(two.x, two.y);
  // c_one, 0 to 4 s: wide enough at the fitted zoom that its middle is not near an edge (that menu offers transitions).
  await rightClick(2, "v1");
  await menu().getByRole("menuitem", { name: /^Delete clip/ }).click();
  await expect.poll(savedIds).not.toContain("c_one");
  expect(savedIds()).toHaveLength(4);
});

test("on a selection of several clips the menu deletes them all", async () => {
  const three = await at(13.5, "v1");
  const second = await at(8.5, "v1");
  await page.mouse.click(three.x, three.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up("Shift");
  await expect(lanes()).toHaveAttribute("data-selected", /^\S+ \S+$/);
  await rightClick(13.5, "v1");
  await menu().getByRole("menuitem", { name: /^Delete 2 clips/ }).click();
  await expect.poll(savedIds).not.toContain("c_three");
  expect(savedIds()).toHaveLength(2);
});

function savedTracks(): { id: string; kind: string; name?: string; clips: unknown[] }[] {
  return JSON.parse(readFileSync(mainFile, "utf8")).tracks;
}

const head = (track: string) => page.locator(`.track-head[data-track="${track}"]`);

test("a track header's menu renames the track in place", async () => {
  await head("v2").click({ button: "right" });
  await expect(menu().getByRole("menuitem")).toHaveText(["Rename track", "Add subtitles of V2", "Add video track", "Add audio track", "Delete track V2 and its clip"]);
  await menu().getByRole("menuitem", { name: "Rename track" }).click();
  const input = page.getByTestId("track-rename-input");
  await expect(input).toBeFocused();
  await input.fill("Logos");
  await input.press("Enter");
  await expect.poll(() => savedTracks().find((track) => track.id === "v2")?.name).toBe("Logos");
  await expect(head("v2")).toContainText("Logos");
});

test("empty lane space adds tracks, and a header deletes a track with its clips", async () => {
  await rightClick(40, "v1");
  await menu().getByRole("menuitem", { name: "Add audio track" }).click();
  await expect.poll(() => savedTracks().filter((track) => track.kind === "audio")).toHaveLength(1);

  await head("v2").click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Delete track V2 and its clip" }).click();
  await expect.poll(() => savedTracks().map((track) => track.id)).not.toContain("v2");
});
