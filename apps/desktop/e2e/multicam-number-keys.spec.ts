// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Switching angles with the number keys (#242, ADR 0016 decision 5): a key cuts the shot under the playhead there and
// sets the new part to that angle, also while playing; the presses of one playback are one undo step.
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const SIZE = { width: 960, height: 540 };
const FPS = 30;
const asset = (colour: string) => `assets/${colour}.mp4`;
const modifier = process.platform === "darwin" ? "Meta" : "Control";

let app: ElectronApplication;
let page: Page;

async function addColour(colour: string, hz: number): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, `${colour}.mp4`);
  await ffmpegRun(await testFfmpeg(), [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=${colour}:s=${SIZE.width}x${SIZE.height}:r=${FPS}:d=8`],
    ...["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=8`],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(file, join(box.projectDir, asset(colour)));
}

/** Shots as the timeline file holds them: start, end, layout, angles. */
function shots(): [number, number, string, string][] {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  return timeline.tracks[0].clips.map((clip: { start: number; out: number; in: number; shot: string; angles: string[] }) => [
    clip.start,
    Math.round((clip.start + clip.out - clip.in) * 1000) / 1000,
    clip.shot,
    clip.angles.join("+"),
  ]);
}

/** The playhead's timecode as seconds. */
async function playhead(): Promise<number> {
  const [, , , seconds, frames] = /^(\d+):(\d+):(\d+):(\d+)$/.exec((await page.getByTestId("playhead").textContent()) ?? "")!.map(Number) as number[];
  return seconds! + frames! / FPS;
}

/** Press `key`; the playhead's time before and after, around the moment the cut was made. */
async function pressAt(key: string): Promise<[number, number]> {
  const before = await playhead();
  await page.keyboard.press(key);
  return [before, await playhead()];
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await Promise.all([addColour("red", 220), addColour("lime", 330)]);
  const ffmpeg = await testFfmpeg();
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.groups = [{ id: "g_talk", angles: ["red", "lime"].map((colour) => ({ id: colour, name: colour, asset: asset(colour), offset: 0 })) }];
  timeline.tracks = [
    {
      id: "t_program",
      kind: "program",
      name: "Program",
      group: "g_talk",
      clips: [{ id: "c_shot", type: "shot", start: 0, in: 0, out: 8, shot: "solo", angles: ["red"] }],
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

test("2 then 1 while playing: two new shots at the press times, one undo removes both", async () => {
  test.setTimeout(120_000);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  await expect.poll(playhead).toBeGreaterThan(0.5);
  const first = await pressAt("2");
  await expect.poll(() => shots().length).toBe(2);
  await expect.poll(playhead).toBeGreaterThan(first[1] + 0.8);
  const second = await pressAt("1");
  await expect.poll(() => shots().length).toBe(3);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByTestId("preview-frame")).not.toHaveAttribute("data-playing", "true");

  const saved = shots();
  expect(saved.map(([, , layout, angles]) => `${layout} ${angles}`)).toEqual(["solo red", "solo lime", "solo red"]);
  const frame = 1 / FPS;
  expect(saved[1]![0]).toBeGreaterThanOrEqual(first[0] - frame - 1e-6);
  expect(saved[1]![0]).toBeLessThanOrEqual(first[1] + frame + 1e-6);
  expect(saved[2]![0]).toBeGreaterThanOrEqual(second[0] - frame - 1e-6);
  expect(saved[2]![0]).toBeLessThanOrEqual(second[1] + frame + 1e-6);
  expect(saved[0]![1]).toBe(saved[1]![0]);
  expect(saved[1]![1]).toBe(saved[2]![0]);

  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => shots()).toEqual([[0, 8, "solo", "red"]]);
});

test("a press while paused cuts at the playhead; Shift adds the angle", async () => {
  // A click on the ruler gives the timeline the focus; its keys then put the playhead a few frames in.
  const rect = await laidOutBox(page.locator(".timeline-scroller"));
  await page.mouse.click(rect.x + 120, rect.y + 10);
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  const at = Math.round((await playhead()) * FPS) / FPS;
  expect(at).toBeGreaterThan(0);
  await page.keyboard.press("Shift+2");
  await expect.poll(() => shots().length).toBe(2);
  expect(shots()).toEqual([
    [0, at, "solo", "red"],
    [at, 8, "two-up", "red+lime"],
  ]);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => shots()).toEqual([[0, 8, "solo", "red"]]);
});
