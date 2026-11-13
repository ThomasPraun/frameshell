// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Transitions and keyframes in the UI (ADR 0018 decision 12, #304): a right-click on a clip edge adds or removes a
// transition, the inspector edits it and keys properties at the playhead. Every edit is a `ui` operation saved at once.
const box = sandbox("transitions-ui");
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

/** Content px of the only lane's middle: the ruler, then half a lane (`layout.ts`). */
const LANE_MIDDLE = 22 + 22;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

const lanes = () => page.getByTestId("timeline-lanes");
const scroller = () => page.locator(".timeline-scroller");
const inspector = () => page.getByRole("group", { name: /^Settings of clip / });

/** Screen point of timeline second `time` on the lane. */
async function at(time: number): Promise<{ x: number; y: number }> {
  const geometry = await scroller().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth };
  });
  return { x: geometry.left + (time * geometry.scrollWidth) / FIT_SPAN_S - geometry.scrollLeft, y: geometry.top + LANE_MIDDLE };
}

/** The saved clip. */
function saved(id: string): Record<string, unknown> {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  return timeline.tracks.flatMap((track: { clips: { id: string }[] }) => track.clips).find((clip: { id: string }) => clip.id === id);
}

/** Journal lines: operation and author, oldest first. The daemon appends after it saves the timeline, so poll it. */
function journaled(): { op: string; author: string }[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ op, author }) => ({ op, author }));
}

async function rightClickEdge(time: number, item: string): Promise<void> {
  const point = await at(time);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

test("right-clicking a cut adds a dissolve, and removes it again", async () => {
  await expect(lanes()).toHaveAttribute("data-clips", "2");
  await rightClickEdge(4, "Add dissolve");
  await expect.poll(() => saved("c_two")["dissolve"]).toBe(0.5);
  await expect.poll(journaled).toEqual([{ op: "transition.set", author: "ui" }]);

  await rightClickEdge(4, "Remove transition");
  await expect.poll(() => saved("c_two")["dissolve"]).toBeUndefined();
  await expect.poll(() => journaled().at(-1)).toEqual({ op: "transition.remove", author: "ui" });
});

test("right-clicking a cut adds a fade as two halves; the inspector reads and edits it", async () => {
  // 0.5 s is 15 frames at 30 fps: 7 for the outgoing half, 8 for the incoming one.
  await rightClickEdge(4, "Add fade");
  await expect.poll(() => [saved("c_one")["fadeOut"], saved("c_two")["fadeIn"]]).toEqual([0.233, 0.267]);

  await page.mouse.click((await at(7)).x, (await at(7)).y);
  await expect(lanes()).toHaveAttribute("data-selected", "c_two");
  await expect(inspector().getByRole("combobox", { name: "Start transition" })).toHaveValue("fade");
  const length = inspector().getByRole("textbox", { name: "Length (s)" });
  await expect(length).toHaveValue("0.5");
  await length.fill("1");
  await length.press("Enter");
  await expect.poll(() => [saved("c_one")["fadeOut"], saved("c_two")["fadeIn"]]).toEqual([0.5, 0.5]);

  await inspector().getByRole("combobox", { name: "Start transition" }).selectOption("dissolve");
  await expect.poll(() => saved("c_two")["dissolve"]).toBe(1);
  expect(saved("c_two")["fadeIn"]).toBeUndefined();

  await inspector().getByRole("combobox", { name: "Start transition" }).selectOption("none");
  await expect.poll(() => saved("c_two")["dissolve"]).toBeUndefined();
});

test("the inspector picks a wipe and its direction, an iris, and a dip cut at a cut (ADR 0030)", async () => {
  await page.mouse.click((await at(7)).x, (await at(7)).y);
  await expect(lanes()).toHaveAttribute("data-selected", "c_two");
  const kind = inspector().getByRole("combobox", { name: "Start transition", exact: true });
  await kind.selectOption("wipe");
  await expect.poll(() => [saved("c_two")["dissolve"], saved("c_two")["shape"]]).toEqual([0.5, { kind: "wipe", direction: "left" }]);
  await expect(kind).toHaveValue("wipe");

  const direction = inspector().getByRole("combobox", { name: "Start transition direction" });
  await direction.selectOption("up");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "wipe", direction: "up" });
  // A push keeps the direction.
  await kind.selectOption("push");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "push", direction: "up" });

  await kind.selectOption("iris");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "iris" });
  await expect(direction).toHaveCount(0);

  // Zoom has no direction or count; slats take both, a grid only a count (ADR 0030 slice 4).
  await kind.selectOption("zoom");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "zoom" });
  await expect(direction).toHaveCount(0);
  await kind.selectOption("slats");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "slats", direction: "left" });
  await direction.selectOption("down");
  const count = inspector().getByRole("textbox", { name: "Count" });
  await count.fill("6");
  await count.press("Enter");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "slats", direction: "down", count: 6 });
  await kind.selectOption("grid");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "grid" });
  await expect(direction).toHaveCount(0);
  await expect(count).toHaveCount(1);
  await kind.selectOption("iris");
  await expect.poll(() => saved("c_two")["shape"]).toEqual({ kind: "iris" });
  await expect(count).toHaveCount(0);

  // A dip cut is a hard cut with the outgoing clip darkened by opacity keys; it has no length.
  await kind.selectOption("dip-cut");
  await expect.poll(() => (saved("c_one")["keys"] as { opacity?: unknown[] } | undefined)?.opacity?.length).toBe(2);
  expect(saved("c_two")["dissolve"]).toBeUndefined();
  await expect(kind).toHaveValue("dip-cut");
  await expect(inspector().getByRole("textbox", { name: "Length (s)" })).toHaveCount(0);

  await kind.selectOption("none");
  await expect.poll(() => saved("c_one")["keys"]).toBeUndefined();
  expect(journaled().slice(-6).every(({ author }) => author === "ui")).toBe(true);
});

test("a keyframe at the playhead is added, eased, re-valued and removed from the inspector", async () => {
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(lanes()).toHaveAttribute("data-playhead", "6");

  const add = inspector().getByRole("button", { name: "Add a x keyframe at the current time" });
  await add.click();
  // Keys count on the clip's clock: 6 s on the timeline is 2 s into a clip that starts at 4 s.
  await expect.poll(() => (saved("c_two")["keys"] as { x: unknown[] } | undefined)?.x).toEqual([{ at: 2, value: 0 }]);

  await inspector().getByRole("combobox", { name: "Ease of the x keyframe at the current time" }).selectOption("in-out");
  await expect.poll(() => (saved("c_two")["keys"] as { x: unknown[] }).x).toEqual([{ at: 2, value: 0, ease: "in-out" }]);

  // A keyed property keys at the playhead when edited.
  const x = inspector().getByRole("textbox", { name: "X (px)" });
  await x.fill("120");
  await x.press("Enter");
  await expect.poll(() => (saved("c_two")["keys"] as { x: unknown[] }).x).toEqual([{ at: 2, value: 120, ease: "in-out" }]);

  await inspector().getByRole("button", { name: "Remove the x keyframe at the current time" }).click();
  await expect.poll(() => saved("c_two")["keys"]).toBeUndefined();
  const keyed = () => journaled().filter(({ op }) => op === "clip.key");
  await expect.poll(() => keyed().length).toBeGreaterThan(0);
  expect(keyed().every(({ author }) => author === "ui")).toBe(true);
});
