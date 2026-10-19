// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Multicam shots in the preview (#238, ADR 0016): a program track's shots are laid out by `shotLayers` (as export
// lays them out), one decoder per visible angle, every angle's sound under every shot. Each angle is a flat colour, so
// the layout on the canvas reads as a few letters: R(ed), G(reen), B(lue), Y(ellow), K (black).
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
/** `frameshell.json` resolution = the preview canvas (540 px short side). */
const SIZE = { width: 960, height: 540 };
const COLOURS = { red: "R", lime: "G", blue: "B", yellow: "Y" } as const;
type Colour = keyof typeof COLOURS;
const asset = (colour: Colour) => `assets/${colour}.mp4`;

let app: ElectronApplication;
let page: Page;

/** A 4 s flat `colour` clip with a tone, straight into `assets/` (written elsewhere first: the watcher never sees half a file). */
async function addColour(colour: Colour, hz: number): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, `${colour}.mp4`);
  await ffmpegRun(await testFfmpeg(), [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=${colour}:s=${SIZE.width}x${SIZE.height}:r=30:d=4`],
    ...["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=48000:duration=4`],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(file, join(box.projectDir, asset(colour)));
}

/** Replace the main timeline with one program track of `shots` over a group of `colours` (a direct edit, SPEC §6.4). */
function setShots(colours: Colour[], shots: { start: number; shot: string; angles: Colour[]; seconds?: number }[]): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.groups = [{ id: "g_talk", angles: colours.map((colour) => ({ id: colour, name: colour, asset: asset(colour), offset: 0 })) }];
  timeline.tracks = [
    {
      id: "t_program",
      kind: "program",
      name: "Program",
      group: "g_talk",
      clips: shots.map((shot, i) => ({
        id: `c_s${i + 1}`,
        type: "shot",
        start: shot.start,
        in: shot.start,
        out: shot.start + (shot.seconds ?? 1),
        shot: shot.shot,
        angles: shot.angles,
      })),
    },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/**
 * Install `window.readLayout(points)`: the colour letter of an 8 px block at
 * each canvas point, `?` for anything else (a frame of two layouts, a blend).
 */
async function installLayoutReader(): Promise<void> {
  await page.evaluate(() => {
    const copy = document.createElement("canvas");
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    const letter = (r: number, g: number, b: number) => {
      const hi = (v: number) => v > 170;
      const lo = (v: number) => v < 70;
      if (hi(r) && lo(g) && lo(b)) return "R";
      if (lo(r) && hi(g) && lo(b)) return "G";
      if (lo(r) && lo(g) && hi(b)) return "B";
      if (hi(r) && hi(g) && lo(b)) return "Y";
      if (lo(r) && lo(g) && lo(b)) return "K";
      return "?";
    };
    (window as unknown as { readLayout: (points: [number, number][]) => string }).readLayout = (points) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas");
      if (!canvas || canvas.width === 0) return "";
      copy.width = canvas.width;
      copy.height = canvas.height;
      context.drawImage(canvas, 0, 0);
      return points
        .map(([x, y]) => {
          const data = context.getImageData(x - 4, y - 4, 8, 8).data;
          const mean = [0, 1, 2].map((c) => {
            let sum = 0;
            for (let i = c; i < data.length; i += 4) sum += data[i]!;
            return sum / 64;
          });
          return letter(mean[0]!, mean[1]!, mean[2]!);
        })
        .join("");
    };
  });
}

/** Grid of three in a 16:9 frame: two on top, the third centered below (corner black). */
const POINTS: [number, number][] = [
  [240, 135],
  [720, 135],
  [488, 405],
  [60, 405],
];
const SOLO_RED = "RRRR";
const TWO_UP = "GBBG";
const GRID_3 = "RGBK";
/** Red, lime, yellow, blue in a 2x2 grid, at the same points: top left, top right, bottom right, bottom left. */
const GRID_4 = "RGBY";

const readLayout = () => page.evaluate((points) => (window as unknown as { readLayout: (p: [number, number][]) => string }).readLayout(points), POINTS);

const engineStats = () =>
  page.evaluate(() => (window as unknown as { frameshellPreviewProbe: { stats: () => Record<string, number> | null } }).frameshellPreviewProbe.stats());

/** Layouts on the canvas on every display frame until playback stops (at most `ms`). */
async function sampleWhilePlaying(ms: number): Promise<string[]> {
  return page.evaluate(
    async ([limit, points]) => {
      const read = (window as unknown as { readLayout: (p: [number, number][]) => string }).readLayout;
      const seen: string[] = [];
      const until = performance.now() + (limit as number);
      while (performance.now() < until) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        seen.push(read(points as [number, number][]));
        if (!document.querySelector('[data-testid="preview-frame"]')?.hasAttribute("data-playing")) break;
      }
      return seen;
    },
    [ms, POINTS] as const,
  );
}

/** Focus the preview on its stage padding (a click on the picture would select a layer), then press `key`. */
async function press(key: string): Promise<void> {
  const stage = await laidOutBox(page.locator(".preview-stage"));
  await page.mouse.click(stage.x + 4, stage.y + 4);
  await page.keyboard.press(key);
}

/** Wait for program frame `frame` to be drawn, and return the layout it shows. */
async function layoutAt(frame: number): Promise<string> {
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", String(frame));
  return readLayout();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await Promise.all([addColour("red", 220), addColour("lime", 330), addColour("blue", 440), addColour("yellow", 550)]);
  const ffmpeg = await testFfmpeg();
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  ({ app, page } = await launch(box, { env: { FRAMESHELL_PREVIEW_PROBE: "1" } }));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  for (const colour of Object.keys(COLOURS) as Colour[]) await waitForIngest(page, asset(colour));
  await installLayoutReader();
});

test.afterAll(async () => {
  await app?.close();
});

test("a 3-angle group shows each shot's layout, and the frame at a shot boundary shows the new one", async () => {
  test.setTimeout(120_000);
  setShots(
    ["red", "lime", "blue"],
    [
      { start: 0, shot: "solo", angles: ["red"] },
      { start: 1, shot: "two-up", angles: ["lime", "blue"] },
      { start: 2, shot: "grid", angles: ["red", "lime", "blue"] },
    ],
  );
  await expect(page.locator(".preview-duration")).toHaveText("00:00:03:00");
  await expect(page.getByTestId("preview-placeholder")).toHaveCount(0);
  await press("Home");
  await expect.poll(() => layoutAt(0)).toBe(SOLO_RED);
  await press("Shift+ArrowRight");
  await expect.poll(() => layoutAt(30)).toBe(TWO_UP);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => layoutAt(29)).toBe(SOLO_RED);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => layoutAt(30)).toBe(TWO_UP);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => layoutAt(60)).toBe(GRID_3);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => layoutAt(59)).toBe(TWO_UP);
});

test("plays across shot changes: only whole layouts, in order, one decoder per visible angle", async () => {
  test.setTimeout(120_000);
  await press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  const seen = await sampleWhilePlaying(15_000);
  await expect(page.getByTestId("playhead")).toHaveText("00:00:03:00");

  const order = [SOLO_RED, TWO_UP, GRID_3];
  const wrong = seen.filter((layout) => !order.includes(layout));
  expect(wrong, `frames of no shot's layout: ${wrong.join(",")}`).toEqual([]);
  const steps = seen.map((layout) => order.indexOf(layout));
  expect(steps.every((step, i) => i === 0 || step >= steps[i - 1]!), "shots show in program order").toBe(true);
  expect(new Set(seen)).toEqual(new Set(order));

  // Stats are posted once a second.
  await page.waitForTimeout(1_200);
  const stats = await engineStats();
  test.info().annotations.push({ type: "3 angles", description: JSON.stringify(stats) });
  expect(stats?.["decoders"]).toBe(3);
  expect(stats?.["audioChunks"]).toBeGreaterThan(0);
});

test("a 4-angle grid plays with four decoders", async () => {
  test.setTimeout(120_000);
  setShots(["red", "lime", "blue", "yellow"], [{ start: 0, shot: "grid", angles: ["red", "lime", "yellow", "blue"], seconds: 3 }]);
  await press("Home");
  await expect.poll(() => layoutAt(0)).toBe(GRID_4);
  const before = await engineStats();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-playing", "true");
  const seen = await sampleWhilePlaying(15_000);
  await expect(page.getByTestId("playhead")).toHaveText("00:00:03:00");
  expect(seen.filter((layout) => layout !== GRID_4)).toEqual([]);

  await page.waitForTimeout(1_200);
  const after = await engineStats();
  const delta = Object.fromEntries(Object.entries(after ?? {}).map(([key, value]) => [key, key === "decoders" ? value : value - (before?.[key] ?? 0)]));
  test.info().annotations.push({ type: "4 angles", description: JSON.stringify(delta) });
  expect(after?.["decoders"]).toBe(4);
});
