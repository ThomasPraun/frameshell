// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// The Finish section of the clip inspector and the letterbox menu of the preview (ADR 0043): vignette and
// grain sliders, each release one `ui` clip.set that merges its number into the clip's field (a drag is one step),
// switches that turn each on with the defaults or remove it, one Reset for both; the menu beside the format switcher
// sets and clears the timeline's letterbox, or a format's own once that format is shown.
const box = sandbox("colour-inspector");
const mainFile = join(box.projectDir, "timelines", "main.json");
const configFile = join(box.projectDir, "frameshell.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Content px of the only (44 px) lane's middle, under the 22 px ruler. */
const LANE_MIDDLE = 22 + 22;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;
const PLAIN = "assets/plain.mp4";

let app: ElectronApplication;
let page: Page;

const lanes = () => page.getByTestId("timeline-lanes");
const finish = () => page.getByRole("group", { name: "Finish", exact: true });
const vignetteGroup = () => finish().getByRole("group", { name: "Vignette", exact: true });
const grainGroup = () => finish().getByRole("group", { name: "Grain", exact: true });
const slider = (group: "vignette" | "grain", name: string) => (group === "vignette" ? vignetteGroup() : grainGroup()).getByRole("slider", { name, exact: true });
const menu = () => page.getByTestId("letterbox-menu");

function timeline(): { tracks: { clips: Record<string, unknown>[] }[]; letterbox?: { aspect: number }; formats?: Record<string, { letterbox?: { aspect: number } }> } {
  return JSON.parse(readFileSync(mainFile, "utf8"));
}

/** The saved `field` of clip `index` of the first track; undefined when it has none. */
const saved = (index: number, field: "vignette" | "grain") => timeline().tracks[0]!.clips[index]![field] as Record<string, unknown> | undefined;

/** Journal lines: operation and author, oldest first; none before the first edit. */
function journaled(): { op: string; author: string }[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; author: string })
    .map(({ op, author }) => ({ op, author }));
}

/** Click the clip at timeline second `at` (lane middle). */
async function select(at: number, id: string): Promise<void> {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  await page.mouse.click(rect.x + at * pxPerSecond, rect.y + LANE_MIDDLE);
  await expect(lanes()).toHaveAttribute("data-selected", id);
}

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
  const main = JSON.parse(readFileSync(mainFile, "utf8"));
  const inner = { ...main, tracks: [{ ...main.tracks[0], clips: [{ id: "c_inner", type: "media", asset: PLAIN, start: 0, in: 0, out: 3 }] }] };
  writeFileSync(join(box.projectDir, "timelines", "inner.json"), JSON.stringify(inner, null, 2));
  main.tracks[0].clips = [
    { id: "c_plain", type: "media", asset: PLAIN, start: 0, in: 0, out: 3 },
    { id: "c_nest", type: "timeline", source: "timelines/inner.json", start: 3, in: 0, duration: 3 },
  ];
  writeFileSync(mainFile, JSON.stringify(main, null, 2));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, PLAIN);
});

test.afterAll(async () => {
  await app?.close();
});

test("a clip with no finish shows two switches, nothing to reset and no title tooltips", async () => {
  await select(1.5, "c_plain");
  await expect(finish()).toBeVisible();
  await expect(vignetteGroup().getByRole("button", { name: "Vignette" })).toHaveAttribute("aria-pressed", "false");
  await expect(grainGroup().getByRole("button", { name: "Grain" })).toHaveAttribute("aria-pressed", "false");
  await expect(vignetteGroup().getByRole("slider")).toHaveCount(0);
  await expect(grainGroup().getByRole("slider")).toHaveCount(0);
  await expect(finish().getByRole("button", { name: "Reset" })).toBeDisabled();
  // The grain rule of the skill is on screen before it is turned on.
  await expect(grainGroup()).toContainText("not for screen recordings, UI or text");
  await expect(finish().locator("[title]")).toHaveCount(0);
  await expect(page.getByTestId("finish-shared")).toHaveCount(0);
  expect(saved(0, "vignette")).toBeUndefined();
  expect(saved(0, "grain")).toBeUndefined();
});

test("the Vignette switch turns it on with the defaults, a slider release changes that number only, a drag is one step", async () => {
  const before = journaled().length;
  await vignetteGroup().getByRole("button", { name: "Vignette" }).click();
  await expect.poll(() => saved(0, "vignette")).toEqual({});
  await expect.poll(() => journaled().slice(before)).toEqual([{ op: "clip.set", author: "ui" }]);
  await expect(slider("vignette", "Strength")).toHaveValue("0.35");
  await expect(slider("vignette", "Radius")).toHaveValue("1");
  await expect(slider("vignette", "Softness")).toHaveValue("0.6");

  const edits = journaled().length;
  await slider("vignette", "Strength").fill("0.6");
  await expect.poll(() => saved(0, "vignette")).toEqual({ strength: 0.6 });
  await expect.poll(() => journaled().slice(edits)).toEqual([{ op: "clip.set", author: "ui" }]);

  // A drag across the track moves the thumb many times and saves once, on release; the other numbers stay.
  await slider("vignette", "Radius").scrollIntoViewIfNeeded();
  const rect = await laidOutBox(slider("vignette", "Radius"));
  const y = rect.y + rect.height / 2;
  const dragged = journaled().length;
  await page.mouse.move(rect.x + rect.width * 0.6, y);
  await page.mouse.down();
  for (const fraction of [0.4, 0.3, 0.2, 0.1]) await page.mouse.move(rect.x + rect.width * fraction, y);
  expect(journaled().length).toBe(dragged);
  await page.mouse.up();
  await expect.poll(() => (saved(0, "vignette") as { radius?: number }).radius).toBeLessThan(0.7);
  expect(saved(0, "vignette")).toMatchObject({ strength: 0.6 });
  await expect.poll(() => journaled().slice(dragged)).toEqual([{ op: "clip.set", author: "ui" }]);

  // One undo takes back the drag only.
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => saved(0, "vignette")).toEqual({ strength: 0.6 });
  await expect(slider("vignette", "Radius")).toHaveValue("1");
});

test("the Grain switch, its sliders and a typed seed each save one ui clip.set", async () => {
  const before = journaled().length;
  await grainGroup().getByRole("button", { name: "Grain" }).click();
  await expect.poll(() => saved(0, "grain")).toEqual({});
  await expect(slider("grain", "Amount")).toHaveValue("0.35");
  await expect(slider("grain", "Size")).toHaveValue("1.5");
  // Without a seed of its own the field shows the one the clip's id gives.
  const seed = grainGroup().getByRole("textbox", { name: "Seed" });
  await expect(seed).toHaveValue(/^\d+$/);

  await slider("grain", "Amount").fill("0.5");
  await expect.poll(() => saved(0, "grain")).toEqual({ amount: 0.5 });
  await seed.fill("42");
  await seed.press("Enter");
  await expect.poll(() => saved(0, "grain")).toEqual({ amount: 0.5, seed: 42 });
  await slider("grain", "Size").fill("3");
  await expect.poll(() => saved(0, "grain")).toEqual({ amount: 0.5, seed: 42, size: 3 });
  await expect.poll(() => journaled().slice(before)).toEqual(Array(4).fill({ op: "clip.set", author: "ui" }));
  // The vignette stays as it was.
  expect(saved(0, "vignette")).toEqual({ strength: 0.6 });
});

test("Reset removes both in one step and one undo brings them back; the switches remove each alone", async () => {
  const before = journaled().length;
  await finish().getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => saved(0, "vignette")).toBeUndefined();
  expect(saved(0, "grain")).toBeUndefined();
  await expect.poll(() => journaled().slice(before)).toEqual([{ op: "clip.set", author: "ui" }]);
  await expect(finish().getByRole("button", { name: "Reset" })).toBeDisabled();
  await expect(vignetteGroup().getByRole("slider")).toHaveCount(0);

  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => saved(0, "vignette")).toEqual({ strength: 0.6 });
  expect(saved(0, "grain")).toEqual({ amount: 0.5, seed: 42, size: 3 });

  await grainGroup().getByRole("button", { name: "Grain" }).click();
  await expect.poll(() => saved(0, "grain")).toBeUndefined();
  expect(saved(0, "vignette")).toEqual({ strength: 0.6 });
  await vignetteGroup().getByRole("button", { name: "Vignette" }).click();
  await expect.poll(() => saved(0, "vignette")).toBeUndefined();
});

test("a nested timeline clip has no Finish section", async () => {
  await select(4.5, "c_nest");
  await expect(page.getByRole("group", { name: "Colour", exact: true })).toBeVisible();
  await expect(finish()).toHaveCount(0);
  await select(1.5, "c_plain");
  await expect(finish()).toBeVisible();
});

test("the letterbox menu sets a preset, a custom aspect and no bars: one ui letterbox.set each, bars in the preview, undo", async () => {
  await expect(menu()).toHaveValue("none");
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(0);
  const before = journaled().length;

  await menu().selectOption("2.39");
  await expect.poll(() => timeline().letterbox).toEqual({ aspect: 2.39 });
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(2);
  await expect(menu()).toHaveValue("2.39");

  await menu().selectOption("custom");
  const custom = page.getByTestId("letterbox-custom");
  await expect(custom).toBeFocused();
  await custom.fill("oops");
  await custom.press("Enter");
  await expect(custom).toHaveAttribute("aria-invalid", "true");
  expect(timeline().letterbox).toEqual({ aspect: 2.39 });
  await custom.fill("2:1");
  await custom.press("Enter");
  await expect.poll(() => timeline().letterbox).toEqual({ aspect: 2 });
  await expect(menu()).toHaveValue("custom");
  await expect(custom).toHaveValue("2");

  await menu().selectOption("4:3");
  await expect.poll(() => timeline().letterbox?.aspect).toBeCloseTo(4 / 3, 6);
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(2);

  await menu().selectOption("none");
  await expect.poll(() => timeline().letterbox).toBeUndefined();
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(0);
  await expect.poll(() => journaled().slice(before)).toEqual(Array(4).fill({ op: "letterbox.set", author: "ui" }));

  // Undo steps back one choice at a time: from none to 4:3.
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => timeline().letterbox?.aspect).toBeCloseTo(4 / 3, 6);
  await expect(menu()).toHaveValue("4:3");
});

test("with a format shown the menu and the Finish section follow it: bars are that format's own, vignette and grain say they are shared", async () => {
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.formats = [
    { id: "landscape", width: 960, height: 540 },
    { id: "9x16", width: 1080, height: 1920 },
  ];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const switcher = page.getByTestId("preview-format");
  await expect(switcher).toBeVisible();
  const primaryBars = timeline().letterbox;
  expect(primaryBars).toBeDefined();

  await switcher.selectOption("9x16");
  // The primary's bars do not show in another format, and the menu starts from none there.
  await expect(menu()).toHaveValue("none");
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(0);
  await expect(page.getByTestId("finish-shared")).toHaveText("Shared by every format");

  await menu().selectOption("1.85");
  await expect.poll(() => timeline().formats?.["9x16"]?.letterbox).toEqual({ aspect: 1.85 });
  expect(timeline().letterbox).toEqual(primaryBars);
  await expect(page.getByTestId("preview-letterbox")).toHaveCount(2);

  await menu().selectOption("none");
  await expect.poll(() => timeline().formats?.["9x16"]?.letterbox).toBeUndefined();

  await switcher.selectOption("landscape");
  await expect(menu()).toHaveValue("4:3");
  await expect(page.getByTestId("finish-shared")).toHaveCount(0);
});
