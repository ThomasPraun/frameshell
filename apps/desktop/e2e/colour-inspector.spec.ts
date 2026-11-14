// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// The Colour section of the clip inspector (#384, ADR 0031): sliders for the correction, a project LUT with its mix and a
// reset, each change one `ui` clip.set that merges its number into the clip's grade (a drag is one step); footage tagged
// HLG shows the LOG note, plain footage does not.
const box = sandbox("colour-inspector");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Content px of the only (44 px) lane's middle, under the 22 px ruler. */
const LANE_MIDDLE = 22 + 22;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;
const PLAIN = "assets/plain.mp4";
const HLG = "assets/night.mp4";
const LUT = "luts/look.cube";

let app: ElectronApplication;
let page: Page;

const lanes = () => page.getByTestId("timeline-lanes");
const colour = () => page.getByRole("group", { name: "Colour", exact: true });
const slider = (name: string) => colour().getByRole("slider", { name });

/** The saved grade of clip `index` of the first track; undefined when it has none. */
function saved(index: number): Record<string, unknown> | undefined {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  return timeline.tracks[0].clips[index].grade;
}

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
  const make = async (name: string, tags: string[]) => {
    const file = join(staging, name);
    await ffmpegRun(ffmpeg, [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=3"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...tags, "-an", file],
    ]);
    renameSync(file, join(box.projectDir, "assets", name));
  };
  await make("plain.mp4", []);
  await make("night.mp4", ["-vf", "setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67"]);
  mkdirSync(join(box.projectDir, "luts"), { recursive: true });
  writeFileSync(join(box.projectDir, LUT), `LUT_3D_SIZE 2\n${[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b}`))).join("\n")}\n`);
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [
    { id: "c_plain", type: "media", asset: PLAIN, start: 0, in: 0, out: 3 },
    { id: "c_hlg", type: "media", asset: HLG, start: 3, in: 0, out: 3 },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, PLAIN);
  await waitForIngest(page, HLG);
});

test.afterAll(async () => {
  await app?.close();
});

test("a clip without a grade shows neutral sliders and nothing to reset; the controls fit the window and name themselves in tooltips", async () => {
  await select(1.5, "c_plain");
  await expect(slider("Exposure (stops)")).toHaveValue("0");
  await expect(slider("Contrast")).toHaveValue("1");
  await expect(slider("Saturation")).toHaveValue("1");
  await expect(colour().getByRole("button", { name: "Reset" })).toBeDisabled();
  await expect(colour().getByRole("combobox", { name: "LUT" })).toHaveValue("");
  await expect(colour().getByRole("combobox", { name: "LUT" }).locator("option")).toHaveText(["No LUT", LUT]);
  await expect(page.getByTestId("grade-log-warning")).toHaveCount(0);
  expect(saved(0)).toBeUndefined();

  // Tooltips are data-tip (one host in App.tsx), never native `title`.
  await expect(colour().locator("[title]")).toHaveCount(0);
  await expect(colour().locator('[data-grade="exposure"]')).toHaveAttribute("data-tip", /stops of light/);
  // The inspector scrolls vertically in a narrow panel: the sliders wrap, none runs past its right edge.
  const panel = await laidOutBox(page.getByRole("group", { name: "Settings of clip plain.mp4" }));
  for (const name of ["Exposure (stops)", "Temperature", "Tint", "Contrast", "Saturation"]) {
    await slider(name).scrollIntoViewIfNeeded();
    const rect = await laidOutBox(slider(name));
    expect(rect.x + rect.width, name).toBeLessThanOrEqual(panel.x + panel.width);
  }
});

test("a slider release changes that number only: one ui clip.set, a drag is one step", async () => {
  const before = journaled().length;
  await slider("Exposure (stops)").fill("0.5");
  await expect.poll(() => saved(0)).toEqual({ exposure: 0.5 });
  expect(journaled().slice(before)).toEqual([{ op: "clip.set", author: "ui" }]);
  await expect(colour().getByRole("button", { name: "Reset" })).toBeEnabled();

  // A drag across the track moves the thumb many times and saves once, on release; the other numbers stay.
  await slider("Saturation").scrollIntoViewIfNeeded();
  const rect = await laidOutBox(slider("Saturation"));
  const y = rect.y + rect.height / 2;
  const edits = journaled().length;
  await page.mouse.move(rect.x + rect.width / 2, y);
  await page.mouse.down();
  for (const fraction of [0.6, 0.7, 0.8, 0.9]) await page.mouse.move(rect.x + rect.width * fraction, y);
  expect(journaled().length).toBe(edits);
  await page.mouse.up();
  await expect.poll(() => (saved(0) as { saturation?: number }).saturation).toBeGreaterThan(1);
  expect(saved(0)).toMatchObject({ exposure: 0.5 });
  expect(journaled().slice(edits)).toEqual([{ op: "clip.set", author: "ui" }]);
});

test("a project LUT is picked, mixed in and removed; a file added later is listed", async () => {
  const lut = colour().getByRole("combobox", { name: "LUT" });
  await expect(slider("LUT mix")).toHaveCount(0);
  await lut.selectOption(LUT);
  await expect.poll(() => saved(0)).toMatchObject({ exposure: 0.5, lut: LUT });
  await expect(slider("LUT mix")).toHaveValue("1");
  await slider("LUT mix").fill("0.5");
  await expect.poll(() => saved(0)).toMatchObject({ lut: LUT, lutMix: 0.5 });

  writeFileSync(join(box.projectDir, "luts", "second.cube"), readFileSync(join(box.projectDir, LUT)));
  await expect(lut.locator("option")).toHaveText(["No LUT", LUT, "luts/second.cube"]);

  await lut.selectOption("");
  await expect.poll(() => (saved(0) as { lut?: string }).lut).toBeUndefined();
  await expect(slider("LUT mix")).toHaveCount(0);
});

test("reset removes the grade and one undo brings it back", async () => {
  await colour().getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => saved(0)).toBeUndefined();
  await expect(slider("Exposure (stops)")).toHaveValue("0");
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => saved(0)).toMatchObject({ exposure: 0.5 });
  await expect(slider("Exposure (stops)")).toHaveValue("0.5");
});

test("footage tagged HLG shows the LOG note, and is graded all the same", async () => {
  await select(4.5, "c_hlg");
  await expect(page.getByTestId("grade-log-warning")).toContainText("May be LOG or HDR footage (transfer curve tagged arib-std-b67)");
  await slider("Temperature").fill("0.3");
  await expect.poll(() => saved(1)).toEqual({ temperature: 0.3 });
  await expect(page.getByTestId("grade-log-warning")).toHaveCount(1);

  await select(1.5, "c_plain");
  await expect(page.getByTestId("grade-log-warning")).toHaveCount(0);
  expect(new Set(journaled().map((entry) => `${entry.op}:${entry.author}`))).toEqual(new Set(["clip.set:ui", "revert:ui"]));
});
