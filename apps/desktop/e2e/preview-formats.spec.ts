// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Format switcher (ADR 0027 slice 2): with formats in `frameshell.json` the preview shows the frame as each format
// exports it. The clip is red on its left half and lime on its right; in 9:16 its centre covers the whole frame, so
// the top of the canvas is picture, not a letterbox bar.
const box = sandbox("multicam");
const configFile = join(box.projectDir, "frameshell.json");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/split.mp4";
/** Seconds a fitted timeline shows across its lanes at least (`span` in `renderer/src/timeline/layout.ts`). */
const FIT_SPAN_S = 60;

let app: ElectronApplication;
let page: Page;

/** Colour letters across the canvas at height `fy`, at a quarter and three quarters: R(ed), G(reen), K (black), ? otherwise. */
function colours(fy: number): Promise<string> {
  return page.evaluate((y) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas");
    if (!canvas || canvas.width === 0) return "";
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(canvas, 0, 0);
    return [0.25, 0.75]
      .map((fx) => {
        const [r, g, b] = context.getImageData(Math.round(canvas.width * fx), Math.round(canvas.height * y), 1, 1).data;
        if (r! > 170 && g! < 70 && b! < 70) return "R";
        if (r! < 70 && g! > 170 && b! < 70) return "G";
        if (r! < 30 && g! < 30 && b! < 30) return "K";
        return "?";
      })
      .join("");
  }, fy);
}

const canvasShape = () =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas");
    return canvas ? (canvas.height > canvas.width ? "portrait" : "landscape") : "";
  });

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const ffmpeg = await testFfmpeg();
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "split.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "color=c=red:s=480x540:r=30:d=3", "-f", "lavfi", "-i", "color=c=lime:s=480x540:r=30:d=3"],
    ...["-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file],
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(file, join(box.projectDir, ASSET));
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_split", type: "media", asset: ASSET, start: 0, in: 0, out: 2 }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, ASSET);
});

test.afterAll(async () => {
  await app?.close();
});

test("the switcher shows the declared formats; 9:16 covers the frame with the clip's centre, as export cuts it", async () => {
  test.setTimeout(120_000);
  const frame = page.getByTestId("preview-frame");
  await expect(frame).toHaveAttribute("data-shown", "0");
  // One format (the resolution): no switcher.
  await expect(page.getByTestId("preview-format")).toHaveCount(0);
  await expect.poll(() => colours(0.5)).toBe("RG");

  // Declared by hand while the project is open: the switcher follows `frameshell.json`.
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.formats = [
    { id: "landscape", width: 960, height: 540 },
    { id: "9x16", width: 1080, height: 1920 },
  ];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const switcher = page.getByTestId("preview-format");
  await expect(switcher).toBeVisible();
  await expect(switcher.locator("option")).toHaveText(["landscape · 960×540", "9x16 · 1080×1920"]);
  await expect(frame).toHaveAttribute("data-format", "landscape");

  await switcher.selectOption("9x16");
  await expect(frame).toHaveAttribute("data-format", "9x16");
  await expect(frame).toHaveAttribute("data-variant", "true");
  await expect.poll(canvasShape).toBe("portrait");
  // Covered, not letterboxed: picture at the top too, red left of the centre and lime right of it.
  await expect.poll(() => colours(0.5)).toBe("RG");
  await expect.poll(() => colours(0.05)).toBe("RG");
  // Picking works in the primary format only.
  await expect(page.getByRole("button", { name: "Pick" })).toBeDisabled();

  await switcher.selectOption("landscape");
  await expect(frame).not.toHaveAttribute("data-variant");
  await expect.poll(canvasShape).toBe("landscape");
  await expect.poll(() => colours(0.5)).toBe("RG");
  await expect(page.getByRole("button", { name: "Pick" })).toBeEnabled();
});

// Editing in a format (ADR 0027 slice 4): what the handles and the inspector change in 9:16 lands in the clip's
// `formats["9x16"]` override; the clip itself, and so the primary format, stays as it was.
test("in 9:16 the handles and the inspector edit the clip there only", async () => {
  test.setTimeout(120_000);
  const frame = page.getByTestId("preview-frame");
  const stored = () => JSON.parse(readFileSync(mainFile, "utf8")).tracks[0].clips[0];
  await page.getByTestId("preview-format").selectOption("9x16");
  await expect(frame).toHaveAttribute("data-variant", "true");
  await expect.poll(() => colours(0.05)).toBe("RG");

  const area = (await frame.boundingBox())!;
  const centre = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByTestId("layer-handles")).toHaveAttribute("data-clip", "c_split");
  await expect(page.getByTestId("inspector-format")).toHaveText("In 9x16");

  // A move of the covering clip keeps its size: the drag stores the placement that fills the frame, moved. The
  // inspector that opened with the selection resized the frame: measured again.
  const resized = (await frame.boundingBox())!;
  const from = { x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + resized.width * 0.25, from.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => stored().formats?.["9x16"]?.transform?.x ?? 0).toBeGreaterThan(100);
  expect(stored().formats["9x16"].transform.scale).toBeCloseTo(3.16, 1);
  expect(stored().transform).toBeUndefined();

  await page.getByTestId("inspector-hide-in-format").click();
  await expect.poll(() => stored().formats?.["9x16"]?.hidden).toBe(true);
  await expect.poll(() => colours(0.5)).toBe("KK");

  // The timeline marks a clip adjusted in a format; its tooltip names the format. Over the ruler first, so the
  // tooltip is read again from the clip as it is now. The pointer goes to the clip's middle second on the first
  // track's row (its head sits level with it): the 2 s clip is only lanes width / 30 px wide.
  const hoverClip = async () => {
    const scroller = page.locator(".timeline-scroller");
    const lanes = await laidOutBox(scroller);
    const head = await laidOutBox(page.locator(".track-head").first());
    const x = lanes.x + (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
    await page.mouse.move(x, lanes.y + 8);
    await expect(page.locator(".clip-tooltip")).toHaveCount(0);
    await page.mouse.move(x, head.y + head.height / 2);
    await expect(page.locator(".clip-tooltip")).toBeVisible();
  };
  await hoverClip();
  await expect(page.getByTestId("clip-tooltip-formats")).toHaveText("Adjusted in 9x16");

  await page.getByTestId("inspector-use-primary").click();
  await expect.poll(() => stored().formats).toBeUndefined();
  await expect.poll(() => colours(0.05)).toBe("RG");
  await hoverClip();
  await expect(page.getByTestId("clip-tooltip-formats")).toHaveCount(0);

  await page.getByTestId("preview-format").selectOption("landscape");
  await expect.poll(() => colours(0.5)).toBe("RG");
});
