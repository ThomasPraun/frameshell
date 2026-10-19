// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Correcting shots by hand (#241, ADR 0016 decision 5): the program track paints each shot's angles, the shot
// inspector changes layout and angles through `shot.set`, the group's angles through `multicam.angle`; the preview
// follows and undo restores. Each angle is a flat colour, so the preview's left and right halves read as letters.
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const SIZE = { width: 960, height: 540 };
const asset = (colour: string) => `assets/${colour}.mp4`;
const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Content px of the program lane's middle: under the 22 px ruler, the only (44 px) lane. */
const PROGRAM_LANE_MIDDLE = 22 + 22;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

let app: ElectronApplication;
let page: Page;

async function addColour(colour: string, hz: number): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, `${colour}.mp4`);
  await ffmpegRun(await testFfmpeg(), [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=${colour}:s=${SIZE.width}x${SIZE.height}:r=30:d=3`],
    ...["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=3`],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(file, join(box.projectDir, asset(colour)));
}

const lanes = () => page.getByTestId("timeline-lanes");
const shotItem = () => page.getByRole("list", { name: "Timeline clips" }).locator('[data-clip="c_shot"]');
const inspector = () => page.getByRole("group", { name: /^Settings of shot / });

/** Colour letters of the preview's left and right halves: R(ed), G(reen), ? for anything else. */
function halves(): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas");
    if (!canvas || canvas.width === 0) return "";
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(canvas, 0, 0);
    return [0.25, 0.75]
      .map((fx) => {
        const [r, g, b] = context.getImageData(Math.round(canvas.width * fx), Math.round(canvas.height / 2), 1, 1).data;
        if (r! > 170 && g! < 70 && b! < 70) return "R";
        if (r! < 70 && g! > 170 && b! < 70) return "G";
        return "?";
      })
      .join("");
  });
}

/** Saved shot and group, as the timeline file holds them. */
function saved(): { shot: Record<string, unknown>; angles: Record<string, unknown>[] } {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  return { shot: timeline.tracks[0].clips[0], angles: timeline.groups[0].angles };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await Promise.all([addColour("red", 220), addColour("lime", 330)]);
  const ffmpeg = await testFfmpeg();
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.groups = [
    {
      id: "g_talk",
      angles: ["red", "lime"].map((colour) => ({ id: colour, name: colour, asset: asset(colour), offset: 0 })),
    },
  ];
  timeline.tracks = [
    {
      id: "t_program",
      kind: "program",
      name: "Program",
      group: "g_talk",
      clips: [{ id: "c_shot", type: "shot", start: 0, in: 0, out: 2, shot: "solo", angles: ["red"], confidence: 0.3, reason: "quick exchange" }],
    },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  for (const colour of ["red", "lime"]) await waitForIngest(page, asset(colour));
});

test.afterAll(async () => {
  await app?.close();
});

test("the program track names a shot's angles and marks a doubtful director's shot", async () => {
  await expect(shotItem()).toHaveText("P1: Solo · red, 00:00:00:00 to 00:00:02:00, 30% sure");
});

test("solo to two-up in the inspector: timeline and preview follow, undo restores it", async () => {
  test.setTimeout(120_000);
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  await page.mouse.click(rect.x + 1 * pxPerSecond, rect.y + PROGRAM_LANE_MIDDLE);
  await expect(lanes()).toHaveAttribute("data-selected", "c_shot");
  await expect(inspector()).toContainText("Director: 30% sure, quick exchange");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  await expect.poll(halves).toBe("RR");

  await inspector().getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: "Two-up" }).click();
  await expect(shotItem()).toHaveText("P1: Two-up · red, lime, 00:00:00:00 to 00:00:02:00, selected");
  expect(saved().shot).toEqual({ id: "c_shot", type: "shot", start: 0, in: 0, out: 2, shot: "two-up", angles: ["red", "lime"] });
  await expect(inspector()).not.toContainText("Director");
  await expect.poll(halves).toBe("RG");

  // Picking the angle shown on the right for the left slot swaps the two.
  await inspector().getByRole("combobox", { name: "Angle 1" }).selectOption("lime");
  await expect(shotItem()).toContainText("Two-up · lime, red");
  await expect.poll(halves).toBe("GR");

  await page.keyboard.press(`${modifier}+z`);
  await expect(shotItem()).toContainText("Two-up · red, lime");
  await page.keyboard.press(`${modifier}+z`);
  await expect(shotItem()).toHaveText("P1: Solo · red, 00:00:00:00 to 00:00:02:00, 30% sure, selected");
  expect(saved().shot).toMatchObject({ shot: "solo", angles: ["red"], confidence: 0.3, reason: "quick exchange" });
  await expect.poll(halves).toBe("RR");
});

test("the group's angles: a rename shows on the shot, and the program track head opens them alone", async () => {
  await inspector().getByRole("button", { name: "Angles…" }).click();
  // By id: the row's name follows the rename.
  const red = inspector().locator('[data-angle="red"]');
  await red.getByRole("textbox", { name: "Name" }).fill("Ana");
  await red.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(shotItem()).toContainText("Solo · Ana");
  expect(saved().angles[0]).toEqual({ id: "red", name: "Ana", asset: asset("red"), offset: 0 });

  await red.getByRole("textbox", { name: "Gain (dB)" }).fill("-6");
  await red.getByRole("textbox", { name: "Gain (dB)" }).press("Enter");
  await expect.poll(() => saved().angles[0]!["audio"]).toEqual({ gain: -6 });
  const ops = readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; author: string })
    .slice(-2);
  expect(ops).toEqual([expect.objectContaining({ op: "multicam.angle", author: "ui" }), expect.objectContaining({ op: "multicam.angle", author: "ui" })]);

  await page.locator('.track-head[data-track="t_program"]').click();
  const group = page.getByRole("group", { name: "Angles of program track P1" });
  await expect(group.getByRole("group", { name: "Angle Ana" })).toBeVisible();
  await expect(group.getByRole("group", { name: "Angle lime" })).toBeVisible();
});

test("a crop the daemon refuses shows the error, and the field the saved value again", async () => {
  const lime = page.getByRole("group", { name: "Angles of program track P1" }).locator('[data-angle="lime"]');
  await lime.getByRole("textbox", { name: "R (%)" }).fill("50");
  await lime.getByRole("textbox", { name: "R (%)" }).press("Enter");
  await expect.poll(() => saved().angles[1]!["crop"]).toEqual({ right: 0.5 });

  // L + R reaches the whole width: refused.
  await lime.getByRole("textbox", { name: "L (%)" }).fill("60");
  await lime.getByRole("textbox", { name: "L (%)" }).press("Enter");
  await expect(page.getByRole("group", { name: "Angles of program track P1" }).getByRole("status")).toBeVisible();
  await expect(lime.getByRole("textbox", { name: "L (%)" })).toHaveValue("0");
  expect(saved().angles[1]!["crop"]).toEqual({ right: 0.5 });
});

test("a screen angle and a pip shot: the toggle, the layout and the corner are saved through the daemon", async () => {
  const lime = page.getByRole("group", { name: "Angles of program track P1" }).locator('[data-angle="lime"]');
  await lime.getByRole("button", { name: "Screen" }).click();
  await expect.poll(() => saved().angles[1]!["screen"]).toBe(true);

  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  await page.mouse.click(rect.x + 1 * pxPerSecond, rect.y + PROGRAM_LANE_MIDDLE);
  await expect(lanes()).toHaveAttribute("data-selected", "c_shot");
  // Only a pip shot offers a corner.
  await expect(inspector().getByRole("radiogroup", { name: "Inset" })).toHaveCount(0);

  await inspector().getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: "Screen + inset" }).click();
  // The screen angle leads, the person fills the inset.
  await expect(shotItem()).toContainText("Screen + inset · lime, Ana");
  expect(saved().shot).toMatchObject({ shot: "pip", angles: ["lime", "red"] });
  expect(saved().shot).not.toHaveProperty("corner");

  await inspector().getByRole("radiogroup", { name: "Inset" }).getByRole("radio", { name: "Top left" }).click();
  await expect.poll(() => saved().shot["corner"]).toBe("top-left");

  await inspector().getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: "Solo" }).click();
  await expect.poll(() => saved().shot["shot"]).toBe("solo");
  expect(saved().shot).not.toHaveProperty("corner");
});
