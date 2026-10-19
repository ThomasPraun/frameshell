// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, panelWindow, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// The multicam viewer (#243, ADR 0016 decision 5): every angle in a grid at the playhead; a click cuts to the angle as
// its number key does, Shift+click adds it; the panel works in its own window too.
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const SIZE = { width: 960, height: 540 };
const FPS = 30;
const COLOURS = ["red", "lime", "blue"];
const asset = (colour: string) => `assets/${colour}.mp4`;

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

async function playhead(): Promise<number> {
  const [, , , seconds, frames] = /^(\d+):(\d+):(\d+):(\d+)$/.exec((await page.getByTestId("playhead").textContent()) ?? "")!.map(Number) as number[];
  return seconds! + frames! / FPS;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await Promise.all(COLOURS.map((colour, i) => addColour(colour, 220 + i * 110)));
  const ffmpeg = await testFfmpeg();
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  // Lime is cut like a tile of a gallery recording: the viewer shows only its crop.
  const crop = (colour: string) => (colour === "lime" ? { crop: { left: 0.5 } } : {});
  timeline.groups = [{ id: "g_talk", angles: COLOURS.map((colour) => ({ id: colour, name: colour, asset: asset(colour), offset: 0, ...crop(colour) })) }];
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
  for (const colour of COLOURS) await waitForIngest(page, asset(colour));
});

test.afterAll(async () => {
  await app?.close();
});

test("the viewer shows every angle, outlines the shot's, and a click cuts to an angle at the playhead", async () => {
  test.setTimeout(120_000);
  // A click on the ruler gives the timeline the focus; its keys then put the playhead a few frames in.
  const rect = await laidOutBox(page.locator(".timeline-scroller"));
  await page.mouse.click(rect.x + 120, rect.y + 10);
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  const at = Math.round((await playhead()) * FPS) / FPS;
  expect(at).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Angles" }).click();
  const viewer = page.getByTestId("angle-viewer");
  await expect(viewer.getByTestId("angle-tile")).toHaveCount(3);
  await expect(viewer).toHaveAttribute("data-decoders", "3");
  await expect(viewer.locator('[data-angle="lime"] video')).toHaveCSS("object-view-box", "inset(0% 0% 0% 50%)");
  await expect(viewer.locator('[data-angle="red"]')).toHaveAttribute("data-in-shot", "true");
  await expect(viewer.locator('[data-angle="blue"]')).toHaveAttribute("data-in-shot", "false");

  // The tab button holds the focus after its click and Space skips buttons: park the focus on the page first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await viewer.locator('[data-angle="blue"]').click();
  await expect.poll(() => shots().length).toBe(2);
  expect(shots()).toEqual([
    [0, at, "solo", "red"],
    [at, 8, "solo", "blue"],
  ]);
  await expect(viewer.locator('[data-angle="blue"]')).toHaveAttribute("data-in-shot", "true");
  await expect(viewer.locator('[data-angle="red"]')).toHaveAttribute("data-in-shot", "false");

  await viewer.locator('[data-angle="lime"]').click({ modifiers: ["Shift"] });
  await expect.poll(() => shots()[1]![3]).toBe("blue+lime");
  expect(shots()[1]![2]).toBe("two-up");

  // A click leaves the focus where it was: Space then plays instead of re-activating the tile and cutting again.
  await page.keyboard.press("Space");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("preview-frame")).not.toHaveAttribute("data-playing", "true");
  expect(shots()[1]![3]).toBe("blue+lime");
  expect(shots()).toHaveLength(2);

  // Back to the frame the next test cuts at.
  await page.mouse.click(rect.x + 120, rect.y + 10);
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  expect(Math.round((await playhead()) * FPS) / FPS).toBe(at);
});

test("the viewer works in its own window", async () => {
  const opened = panelWindow(app, "angles");
  await page.getByTestId("sidebar-detach").click();
  const child = await opened;
  await expect(page.getByTestId("angle-viewer")).toHaveCount(0);
  await expect(child.getByTestId("angle-tile")).toHaveCount(3);
  await expect(child.getByTestId("angle-viewer")).toHaveAttribute("data-decoders", "3");
  await child.locator('[data-angle="red"]').click();
  await expect.poll(() => shots()[1]!.slice(2)).toEqual(["solo", "red"]);
  await expect(child.locator('[data-angle="red"]')).toHaveAttribute("data-in-shot", "true");

  const closed = child.waitForEvent("close");
  await child.getByRole("button", { name: "Dock angles back" }).click();
  await closed;
  await expect(page.getByTestId("angle-viewer").getByTestId("angle-tile")).toHaveCount(3);
});

test("while playing, every angle's video follows the playhead (decoder and frame measurement)", async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  const probe = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLVideoElement>('[data-testid="angle-tile"] video')].map((video) => ({
        time: video.currentTime,
        paused: video.paused,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
        dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
      })),
    );
  const before = await probe();
  const started = Date.now();
  await page.waitForTimeout(2000);
  const after = await probe();
  const seconds = (Date.now() - started) / 1000;
  await page.getByRole("button", { name: "Pause" }).click();

  expect(after).toHaveLength(3);
  const measurement = after.map((video, i) => ({
    framesPerSecond: Math.round((video.frames - before[i]!.frames) / seconds),
    dropped: video.dropped - before[i]!.dropped,
  }));
  const summary = `decoders=${after.length} ${JSON.stringify(measurement)}`;
  testInfo.annotations.push({ type: "measurement", description: summary });
  console.log(`multicam viewer: ${summary}`);
  for (const video of after) expect(video.frames).toBeGreaterThan(0);
  // Videos play along: each moved on by about the time that passed (the playhead may have stopped at the end).
  for (let i = 0; i < after.length; i++) expect(after[i]!.time).toBeGreaterThan(before[i]!.time + 0.5);
});
