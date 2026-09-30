// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Timeline editing (#16) in the built app: pointer drags and keys on the canvas become daemon operations by `ui`,
// saved at once and journaled. Real daemon; generated `titles` clips need no media or plugin.
const box = sandbox("editing");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");

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
const LANE_MIDDLE = { v2: RULER + LANE / 2, v1: RULER + LANE + LANE / 2 } as const;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

const lanes = () => page.getByTestId("timeline-lanes");
const scroller = () => page.locator(".timeline-scroller");
const clipItems = () => page.getByRole("list", { name: "Timeline clips" }).getByRole("listitem");
const modifier = process.platform === "darwin" ? "Meta" : "Control";

/** Screen point of timeline second `time` on a lane, once the lanes are laid out. */
async function at(time: number, lane: keyof typeof LANE_MIDDLE): Promise<{ x: number; y: number }> {
  let geometry = { left: 0, top: 0, scrollLeft: 0, width: 0, pxPerSecond: 0 };
  // Polled: right after launch or a re-render the scroller may not have its size yet (slow CI runners).
  await expect
    .poll(async () => {
      geometry = await scroller().evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, scrollLeft: element.scrollLeft, width: element.clientWidth, pxPerSecond: 0 };
      });
      geometry.pxPerSecond = (await scroller().evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
      return geometry.width > 0;
    })
    .toBe(true);
  return { x: geometry.left + time * geometry.pxPerSecond - geometry.scrollLeft, y: geometry.top + LANE_MIDDLE[lane] };
}

/** Press at `from`, move to `to` in steps, run `during` with the button held, release. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await during?.();
  await page.mouse.up();
}

/** Put the playhead on whole second `seconds` with the keyboard (focus on the lanes). */
async function playheadTo(seconds: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let i = 0; i < seconds; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(lanes()).toHaveAttribute("data-playhead", String(seconds));
}

/** Clip as saved in the timeline file. */
function savedClip(id: string): { track: string; start: number; duration: number } {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate: { id: string }) => candidate.id === id);
    if (clip) return { track: track.id, start: clip.start, duration: clip.duration };
  }
  throw new Error(`no clip ${id} in ${mainFile}`);
}

/** Journal lines: operation and author, oldest first. */
function journaled(): { op: string; author: string }[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ op, author }) => ({ op, author }));
}

test("dragging a clip shows a ghost, and only the release sends a move", async () => {
  await expect(lanes()).toHaveAttribute("data-clips", "4");
  await drag(await at(21, "v2"), await at(25, "v2"), async () => {
    await expect(lanes()).toHaveAttribute("data-dragging", "body");
    await expect(page.locator(".drag-tooltip")).toContainText("Move titles");
    await expect(lanes()).toHaveAttribute("data-revision", "0");
  });
  await expect(lanes()).toHaveAttribute("data-revision", "1");
  await expect(lanes()).not.toHaveAttribute("data-dragging", /.*/);
  const moved = savedClip("c_card");
  expect(moved.track).toBe("v2");
  expect(Math.abs(moved.start - 24)).toBeLessThan(0.15);
  expect(journaled()).toEqual([{ op: "clip.move", author: "ui" }]);
  await expect(lanes()).toHaveAttribute("data-selected", "c_card");
});

test("a moved clip snaps to another clip's edge", async () => {
  const { start } = savedClip("c_card");
  // Aim a little past c_three's end (15 s): the start snaps onto it.
  await drag(await at(start + 1, "v2"), await at(15.25 + 1, "v2"));
  await expect(clipItems().first()).toHaveText(/^V2: titles, 00:00:15:00 to 00:00:17:00/);
});

test("dragging an edge trims the clip, snapping to the playhead", async () => {
  await (await laidOutScroller()).click({ position: { x: 5, y: 8 } });
  // Zoomed in from the start: a second is then comfortably more px than the drag threshold on small CI screens.
  await page.keyboard.press("+");
  await scroller().evaluate((element) => {
    element.scrollLeft = 0;
  });
  await playheadTo(14);
  const edge = await at(15, "v1");
  const target = await at(14, "v1");
  // Held 1 px inside the edge, released 1 px left of 14 s: the edge lands on the playhead.
  await drag({ x: edge.x - 1, y: edge.y }, { x: target.x - 1, y: target.y }, async () => {
    await expect(lanes()).toHaveAttribute("data-dragging", "tail");
  });
  await expect(page.locator('li[data-clip="c_three"]')).toHaveText(/^V1: titles, 00:00:12:00 to 00:00:14:00/);
  expect(savedClip("c_three")).toEqual({ track: "v1", start: 12, duration: 2 });
});

test("S splits the selected clip at the playhead", async () => {
  await page.mouse.click(...xy(await at(7, "v1")));
  await expect(lanes()).toHaveAttribute("data-selected", "c_two");
  await playheadTo(7);
  await page.keyboard.press("s");
  await expect(lanes()).toHaveAttribute("data-clips", "5");
  await expect(clipItems()).toContainText(["V1: titles, 00:00:04:00 to 00:00:07:00", "V1: titles, 00:00:07:00 to 00:00:10:00"]);
});

test("Shift+Delete ripple deletes a clip, closing the gap on its own track only", async () => {
  await page.mouse.click(...xy(await at(2, "v1")));
  await expect(lanes()).toHaveAttribute("data-selected", "c_one");
  await page.keyboard.press("Shift+Delete");
  await expect(lanes()).toHaveAttribute("data-clips", "4");
  await expect(clipItems()).toHaveText([
    "V2: titles, 00:00:15:00 to 00:00:17:00",
    "V1: titles, 00:00:00:00 to 00:00:03:00",
    "V1: titles, 00:00:03:00 to 00:00:06:00",
    "V1: titles, 00:00:08:00 to 00:00:10:00",
  ]);
  await expect(lanes()).toHaveAttribute("data-selected", "");
});

test("undo and redo revert the latest ui operation", async () => {
  const before = await lanes().getAttribute("data-revision");
  await page.keyboard.press(`${modifier}+z`);
  await expect(lanes()).toHaveAttribute("data-clips", "5");
  await expect(clipItems().nth(1)).toHaveText("V1: titles, 00:00:00:00 to 00:00:04:00");
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect(lanes()).toHaveAttribute("data-clips", "4");
  await expect(clipItems().nth(1)).toHaveText("V1: titles, 00:00:00:00 to 00:00:03:00");
  await expect(lanes()).toHaveAttribute("data-revision", String(Number(before) + 2));
  expect(journaled().slice(-2)).toEqual([
    { op: "revert", author: "ui" },
    { op: "revert", author: "ui" },
  ]);
});

test("a drag the daemon refuses shows why and changes nothing", async () => {
  const revision = await lanes().getAttribute("data-revision");
  // c_card onto V1 at 1 s: it would overlap the clip at 0 to 3 s.
  await drag(await at(16, "v2"), await at(2, "v1"), async () => {
    await expect(page.locator(".drag-tooltip")).toContainText("Overlaps a clip");
  });
  await expect(page.locator(".timeline-status")).toContainText(/overlap/i);
  await expect(lanes()).toHaveAttribute("data-revision", revision!);
  await expect(clipItems().first()).toHaveText(/^V2: titles, 00:00:15:00 to 00:00:17:00/);
});

test("period nudges the selected clip one frame", async () => {
  await page.mouse.click(...xy(await at(16, "v2")));
  await expect(lanes()).toHaveAttribute("data-selected", "c_card");
  await page.keyboard.press(".");
  await expect(clipItems().first()).toHaveText(/^V2: titles, 00:00:15:01 to 00:00:17:01/);
});

test("deleting two selected clips is one undo step", async () => {
  await page.mouse.click(...xy(await at(1, "v1")));
  await page.keyboard.down("Shift");
  await page.mouse.click(...xy(await at(4, "v1")));
  await page.keyboard.up("Shift");
  await expect(lanes()).toHaveAttribute("data-selected", /^\S+ \S+$/);
  const clipsBefore = await lanes().getAttribute("data-clips");
  await page.keyboard.press("Delete");
  await expect(lanes()).toHaveAttribute("data-clips", String(Number(clipsBefore) - 2));
  await expect(page.locator(".timeline-status")).toContainText("Delete of 2 clips saved as one step");

  await page.keyboard.press(`${modifier}+z`);
  await expect(lanes()).toHaveAttribute("data-clips", clipsBefore!);
  await expect(clipItems().nth(1)).toHaveText("V1: titles, 00:00:00:00 to 00:00:03:00");
  await expect(clipItems().nth(2)).toHaveText("V1: titles, 00:00:03:00 to 00:00:06:00");
  const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const [first, second, undo] = lines.slice(-3);
  expect([first.op, second.op, undo.op]).toEqual(["clip.remove", "clip.remove", "revert"]);
  expect(second.tx).toBe(first.tx);
  expect(first.txLabel).toBe("Delete 2 clips");
  expect(undo.args.target).toBe(first.tx);
});

test("every edit was saved at once and journaled as a ui operation", async () => {
  expect(journaled()).toEqual([
    { op: "clip.move", author: "ui" },
    { op: "clip.move", author: "ui" },
    { op: "clip.trim", author: "ui" },
    { op: "clip.split", author: "ui" },
    { op: "cut", author: "ui" },
    { op: "revert", author: "ui" },
    { op: "revert", author: "ui" },
    { op: "clip.move", author: "ui" },
    { op: "clip.remove", author: "ui" },
    { op: "clip.remove", author: "ui" },
    { op: "revert", author: "ui" },
  ]);
  const saved = JSON.parse(readFileSync(mainFile, "utf8"));
  await expect(lanes()).toHaveAttribute("data-revision", String(saved.revision));
});

async function laidOutScroller() {
  await at(0, "v1");
  return scroller();
}

function xy(point: { x: number; y: number }): [number, number] {
  return [point.x, point.y];
}
