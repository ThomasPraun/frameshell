// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Reframing for 9:16 (#251, ADR 0016): the preview's 9:16 frame cuts a solo shot as a vertical export does, and
// the shot inspector's X field sets a reframe key at the playhead through `multicam.reframe`. The angle's
// picture is red on its left half and lime on its right, so the cut reads as two letters.
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const ASSET = "assets/split.mp4";
const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Content px of the program lane's middle: under the 22 px ruler, the only (44 px) lane. */
const PROGRAM_LANE_MIDDLE = 22 + 22;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

let app: ElectronApplication;
let page: Page;

const inspector = () => page.getByRole("group", { name: /^Settings of shot / });
const reframeRow = () => inspector().getByRole("group", { name: "Reframe split" });
const xField = () => reframeRow().getByRole("textbox", { name: "X (%)" });

/** Colour letters at a quarter and three quarters across the preview canvas: R(ed), G(reen), ? otherwise. */
function quarters(): Promise<string> {
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

const canvasShape = () =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview-canvas");
    return canvas ? (canvas.height > canvas.width ? "portrait" : "landscape") : "";
  });

function savedAngle(): Record<string, unknown> {
  return JSON.parse(readFileSync(mainFile, "utf8")).groups[0].angles[0];
}

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
    ...["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=3"],
    ...["-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]", "-map", "2:a"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(file, join(box.projectDir, ASSET));
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.groups = [{ id: "g_talk", angles: [{ id: "split", name: "split", asset: ASSET, offset: 0 }] }];
  timeline.tracks = [
    {
      id: "t_program",
      kind: "program",
      name: "Program",
      group: "g_talk",
      clips: [{ id: "c_shot", type: "shot", start: 0, in: 0, out: 2, shot: "solo", angles: ["split"] }],
    },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, ASSET);
});

test.afterAll(async () => {
  await app?.close();
});

test("the 9:16 frame cuts the solo around the reframe key the inspector sets, undoably", async () => {
  test.setTimeout(120_000);
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  await page.mouse.click(rect.x + 1 * pxPerSecond, rect.y + PROGRAM_LANE_MIDDLE);
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-selected", "c_shot");
  // The click moved the playhead to 1 s; back to the shot's first frame, where the key will go.
  await page.keyboard.press("Home");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", "0");
  await expect.poll(quarters).toBe("RG");
  await expect(reframeRow().getByTestId("reframe-keys")).toHaveText("centered");

  await page.getByTestId("preview-vertical").click();
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-vertical", "true");
  await expect.poll(canvasShape).toBe("portrait");
  // Centered: the middle strip of the picture, red left of the centre and lime right of it.
  await expect.poll(quarters).toBe("RG");

  await xField().fill("25");
  await xField().press("Enter");
  await expect.poll(() => savedAngle()["reframe"]).toEqual([{ at: 0, x: 0.25, y: 0.5 }]);
  await expect.poll(quarters).toBe("RR");
  await expect(reframeRow().getByTestId("reframe-keys")).toHaveText("1 key");

  // The key in the playhead's frame is replaced, not doubled.
  await xField().fill("75");
  await xField().press("Enter");
  await expect.poll(() => savedAngle()["reframe"]).toEqual([{ at: 0, x: 0.75, y: 0.5 }]);
  await expect.poll(quarters).toBe("GG");

  await reframeRow().getByRole("button", { name: "Center" }).click();
  await expect.poll(() => savedAngle()).not.toHaveProperty("reframe");
  await expect.poll(quarters).toBe("RG");
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => savedAngle()["reframe"]).toEqual([{ at: 0, x: 0.75, y: 0.5 }]);
  await expect.poll(quarters).toBe("GG");

  // The project frame does not cut a 16:9 picture: the key changes nothing there.
  await page.getByTestId("preview-vertical").click();
  await expect.poll(canvasShape).toBe("landscape");
  await expect.poll(quarters).toBe("RG");
});
