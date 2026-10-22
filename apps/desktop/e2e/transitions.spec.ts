import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { blockMean, previewPixels } from "./frames.js";
import { ffmpegRun, testFfmpeg, useTestBinaries } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Transitions and keys in the preview (ADR 0018, #302): a bottom-track dissolve mixes the two clips by the shared
// weights, and a keyed overlay moves frame by frame. Solid colours make the expected pixels exact.
const box = sandbox("transitions");
const mainFile = join(box.projectDir, "timelines", "main.json");
/** `frameshell.json` resolution, the preview canvas size. */
const SIZE = { width: 960, height: 540 };

let app: ElectronApplication;
let page: Page;

/** A 4 s solid `colour` source with a tone, straight into `assets/`. */
async function addColour(name: string, colour: string): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  const file = join(staging, name);
  await ffmpegRun(await testFfmpeg(), [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=${colour}:s=960x540:r=30:d=4`, "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=4"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
  ]);
  renameSync(file, join(box.projectDir, "assets", name));
}

/**
 * V1: red 0-2 s, blue 2-4 s coming in by a 1 s dissolve (both have a second of handle). V2: a quarter-size lime
 * picture from 3 s to 4 s whose `x` moves from -200 to 200 project px over its own clock.
 */
function writeTimeline(): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  const media = (id: string, asset: string, start: number, inS: number, out: number, extra: object = {}) => ({ id, type: "media", asset, start, in: inS, out, ...extra });
  timeline.tracks[0].clips = [media("c_red", "assets/red.mp4", 0, 1, 3), media("c_blue", "assets/blue.mp4", 2, 1, 3, { dissolve: 1 })];
  timeline.tracks[1].clips = [
    media("c_lime", "assets/lime.mp4", 3, 1, 2, {
      transform: { scale: 0.25 },
      keys: {
        x: [
          { at: 1, value: -200 },
          { at: 2, value: 200 },
        ],
      },
    }),
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

const frame = () => page.getByTestId("preview-frame");
const centre = async () => blockMean(await previewPixels(page, SIZE), SIZE, 472, 262, 16);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await useTestBinaries(box.configDir);
  await addColour("red.mp4", "red");
  await addColour("blue.mp4", "blue");
  await addColour("lime.mp4", "lime");
  ({ app, page } = await launch(box));
  for (const name of ["red", "blue", "lime"]) await waitForIngest(page, `assets/${name}.mp4`);
  writeTimeline();
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "3");
  // Stage padding, not the picture: a click on the picture would select a layer.
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
});

test.afterAll(async () => {
  await app?.close();
});

test("mixes a bottom-track dissolve by its progress: the incoming clip over the outgoing one", async () => {
  // Frame 54 = 1.8 s: 30 % of the way from 1.5 s to 2.5 s.
  await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowRight");
  await expect(frame()).toHaveAttribute("data-shown", "54");
  const [r1, g1, b1] = await centre();
  expect(Math.abs(r1 - 0.7 * 255), `red ${r1}`).toBeLessThan(14);
  expect(g1).toBeLessThan(14);
  expect(Math.abs(b1 - 0.3 * 255), `blue ${b1}`).toBeLessThan(14);

  // Frame 60, the cut: halfway.
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await expect(frame()).toHaveAttribute("data-shown", "60");
  const [r2, , b2] = await centre();
  expect(Math.abs(r2 - 127.5), `red ${r2}`).toBeLessThan(14);
  expect(Math.abs(b2 - 127.5), `blue ${b2}`).toBeLessThan(14);
});

test("moves a keyed overlay frame by frame", async () => {
  // Frame 105 = 3.5 s: the lime picture's own clock at 1.5 s, x = 0, centred over the blue clip.
  await page.keyboard.press("Shift+ArrowRight");
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await expect(frame()).toHaveAttribute("data-shown", "105");
  const pixels = await previewPixels(page, SIZE);
  const [r, g, b] = blockMean(pixels, SIZE, 472, 262, 16);
  expect(g, `lime over the centre: ${r},${g},${b}`).toBeGreaterThan(200);
  expect(Math.max(r, b)).toBeLessThan(40);
  // Where it was at its first key (x = -200, centred at 280 px): blue now.
  const [r0, g0, b0] = blockMean(pixels, SIZE, 272, 262, 16);
  expect(b0, `blue left of it: ${r0},${g0},${b0}`).toBeGreaterThan(200);
  expect(g0).toBeLessThan(40);
});
