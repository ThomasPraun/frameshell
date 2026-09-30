// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { connectToDaemon } from "@frameshell/protocol";
import { launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Subtitle tracks (#22): the words of the followed clips, drawn over the preview exactly where and when export burns
// them, updated by cuts with no extra edit, created and styled from the app as `ui` operations.
const box = sandbox("subtitles");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const ASSET = "assets/talk.mp4";
/** `frameshell.json` resolution: the preview canvas (540 px short side) and the captured frame are the same size. */
const W = 960;
const H = 540;

/**
 * "uno" 0.5-0.9 s, "dos" 1.0-1.4 s, "tres" 1.5-2.0 s of the take, played from 0: frames 15-27, 30-42, 45-60, one
 * big-keyword cue "UNO DOS TRES" from frame 15 to 60; "UNO" is highlighted until frame 29, "DOS" from frame 30.
 */
const WORDS: [string, number, number][] = [
  ["uno", 0.5, 0.9],
  ["dos", 1.0, 1.4],
  ["tres", 1.5, 2.0],
];

let app: ElectronApplication;
let page: Page;

/** A dark 4 s take with a tone, straight into `assets/`: white and yellow text stand out on it. */
async function addTake(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x303a48:s=${W}x${H}:r=30:d=4`],
    ...["-f", "lavfi", "-i", "sine=f=220:r=48000:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    ...["-c:a", "aac", "-shortest", join(staging, "talk.mp4")],
  ]);
  renameSync(join(staging, "talk.mp4"), join(box.projectDir, ASSET));
}

function writeTranscript(): void {
  mkdirSync(join(box.projectDir, "transcripts"), { recursive: true });
  const transcript = {
    schemaVersion: 1,
    asset: ASSET,
    assetHash: `sha256:${"0".repeat(64)}`,
    provider: "e2e",
    model: "e2e",
    words: WORDS.map(([text, start, end], i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text, start, end })),
    edits: {},
  };
  writeFileSync(join(box.projectDir, "transcripts", "talk.words.json"), JSON.stringify(transcript, null, 2));
}

/** RGB bytes of what the preview shows, `W`x`H`: the picture with the subtitle canvas over it. */
async function previewPixels(): Promise<Buffer> {
  const base64 = await page.evaluate(
    ([width, height]) => {
      const copy = document.createElement("canvas");
      copy.width = width!;
      copy.height = height!;
      const context = copy.getContext("2d")!;
      context.drawImage(document.querySelector<HTMLCanvasElement>(".preview-canvas")!, 0, 0);
      context.drawImage(document.querySelector<HTMLCanvasElement>(".preview-subtitles")!, 0, 0);
      const rgba = context.getImageData(0, 0, width!, height!).data;
      let binary = "";
      for (let i = 0; i < rgba.length; i += 4) binary += String.fromCharCode(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      return btoa(binary);
    },
    [W, H],
  );
  return Buffer.from(base64, "base64");
}

/** RGB bytes of the frame `frameshell frame` captures at `at` (daemon `frame`, the export compiler's path). */
async function exportedPixels(at: number): Promise<Buffer> {
  const connection = await connectToDaemon(box.socketPath, { client: "e2e/subtitles" });
  const out = join(box.dataDir, `frame-${at}.png`);
  try {
    await connection.request("frame", { cwd: box.projectDir, at, out });
  } finally {
    connection.close();
  }
  const raw = join(box.dataDir, `frame-${at}.rgb`);
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  return readFileSync(raw);
}

type Box = { left: number; top: number; right: number; bottom: number } | null;

/** Bounding box of the pixels `match` picks. */
function bounds(pixels: Buffer, match: (r: number, g: number, b: number) => boolean): Box {
  let found: Box = null;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (!match(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)) continue;
      found = found
        ? { left: Math.min(found.left, x), top: Math.min(found.top, y), right: Math.max(found.right, x), bottom: Math.max(found.bottom, y) }
        : { left: x, top: y, right: x, bottom: y };
    }
  }
  return found;
}
const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
const yellow = (r: number, g: number, b: number) => r > 200 && g > 160 && b < 110;

/**
 * Worst and mean difference of 16 px block means between two `W`x`H` RGB
 * frames, after removing their colour offset on the plain background (the
 * top-left 64 px): software decoders on CI convert YUV to RGB a few levels
 * apart, which says nothing about the text.
 */
function blockDiff(a: Buffer, b: Buffer): { mean: number; worst: number; at: string } {
  const offset = [0, 1, 2].map((c) => {
    let sum = 0;
    for (let row = 0; row < 64; row++) for (let col = 0; col < 64; col++) sum += a[(row * W + col) * 3 + c]! - b[(row * W + col) * 3 + c]!;
    return sum / (64 * 64);
  });
  let worst = 0;
  let at = "";
  let total = 0;
  let blocks = 0;
  for (let y = 0; y + 16 <= H; y += 16) {
    for (let x = 0; x + 16 <= W; x += 16) {
      const sums = [0, 0, 0, 0, 0, 0];
      for (let row = y; row < y + 16; row++) {
        for (let col = x; col < x + 16; col++) {
          for (let c = 0; c < 3; c++) {
            sums[c]! += a[(row * W + col) * 3 + c]!;
            sums[c + 3]! += b[(row * W + col) * 3 + c]!;
          }
        }
      }
      const diff = Math.max(...[0, 1, 2].map((c) => Math.abs((sums[c]! - sums[c + 3]!) / 256 - offset[c]!)));
      total += diff;
      blocks++;
      if (diff > worst) [worst, at] = [diff, `${x},${y}`];
    }
  }
  return { mean: total / blocks, worst, at };
}

function journaled(): { op: string; author: string }[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ op, author }) => ({ op, author }));
}

const overlay = () => page.getByTestId("preview-subtitles");
const playhead = () => page.getByTestId("playhead");
const cues = () => page.locator("li[data-cue]");

/** Move the playhead to program frame `frame` with the keyboard, and wait until picture and subtitles show it. */
async function showFrame(frame: number): Promise<void> {
  await page.getByRole("button", { name: "Go to start" }).click();
  await expect(playhead()).toHaveText("00:00:00:00");
  for (let i = 0; i < frame; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-shown", String(frame));
  await expect(overlay()).toHaveAttribute("data-frame", String(frame));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await addTake();
  writeTranscript();
  ({ app, page } = await launch(box));
  await waitForIngest(page, ASSET);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_take", type: "media", asset: ASSET, start: 0, in: 0, out: 3 }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "1");
});

test.afterAll(async () => {
  await app?.close();
});

test("draws the followed clip's words over the picture where and when export burns them", async () => {
  await expect(cues()).toHaveText(['S1: "UNO DOS TRES", 00:00:00:15 to 00:00:02:00']);
  for (const [frame, active] of [
    [29, "UNO"],
    [30, "DOS"],
  ] as const) {
    await showFrame(frame);
    await expect(overlay()).toHaveAttribute("data-text", "UNO DOS TRES");
    await expect(overlay()).toHaveAttribute("data-active", active);

    const preview = await previewPixels();
    const exported = await exportedPixels(Math.round((frame / 30) * 1000) / 1000);
    expect(exported.length).toBe(W * H * 3);
    for (const [name, pixels] of [[`preview-${frame}.rgb`, preview], [`export-${frame}.rgb`, exported]] as const) {
      writeFileSync(test.info().outputPath(name), pixels);
    }
    const diff = blockDiff(preview, exported);
    test.info().annotations.push({ type: `frame ${frame}`, description: `mean block diff ${diff.mean.toFixed(2)}, worst ${diff.worst.toFixed(1)} at ${diff.at}` });
    // Text rasterizers (Skia, libass) differ only in anti-aliasing; a line a few px off or another face fails.
    expect(diff.mean).toBeLessThan(6);
    expect(diff.worst, `worst 16 px block at ${diff.at}`).toBeLessThan(48);

    // Same line box and the same word highlighted, within 3 px.
    const [text, lit] = [bounds(preview, white), bounds(preview, yellow)];
    const [burnedText, burnedLit] = [bounds(exported, white), bounds(exported, yellow)];
    expect(text && burnedText && lit && burnedLit, "text and highlight found in both").toBeTruthy();
    for (const side of ["left", "top", "right", "bottom"] as const) {
      expect(Math.abs(text![side] - burnedText![side]), `text ${side}`).toBeLessThanOrEqual(3);
      expect(Math.abs(lit![side] - burnedLit![side]), `highlight ${side}`).toBeLessThanOrEqual(3);
    }
    // Low in the frame (big-keyword, bottom), the highlight on the spoken word: left of center for UNO, around it for DOS.
    expect(text!.bottom).toBeGreaterThan(H * 0.75);
    expect(text!.bottom).toBeLessThan(H * 0.9);
    if (active === "UNO") expect(lit!.right).toBeLessThan(W / 2);
    else expect(lit!.left < W / 2 && lit!.right > W / 2).toBe(true);
  }
});

test("a cut removes its words from the subtitles, with no extra edit", async () => {
  const before = journaled().length;
  const connection = await connectToDaemon(box.socketPath, { client: "e2e/subtitles" });
  try {
    // "dos" (1.0-1.4 s) goes; "tres" moves 0.5 s earlier.
    await connection.request("cut", { cwd: box.projectDir, from: 0.95, to: 1.45, snap: false });
  } finally {
    connection.close();
  }
  await expect(cues()).toHaveText(['S1: "UNO TRES", 00:00:00:15 to 00:00:01:15']);
  expect(journaled().slice(before).map(({ op }) => op)).toEqual(["cut"]);
  await showFrame(30);
  await expect(overlay()).toHaveAttribute("data-text", "UNO TRES");
  await expect(overlay()).toHaveAttribute("data-active", "TRES");
});

test("a subtitle track is added from the timeline and styled from the inspector, each change one ui operation", async () => {
  const before = journaled().length;
  await page.getByRole("button", { name: "Add subtitle track" }).click();
  const inspector = page.getByRole("group", { name: "Settings of subtitle track S2" });
  await expect(inspector).toBeVisible();
  await expect(cues()).toHaveCount(2);
  const added = () => JSON.parse(readFileSync(mainFile, "utf8")).tracks.find((track: { id: string }) => !["v1", "s1"].includes(track.id));
  expect(added()).toMatchObject({ kind: "subtitles", follows: "v1", style: { preset: "big-keyword" } });

  await inspector.getByRole("radio", { name: "Plain" }).click();
  await inspector.getByRole("radio", { name: "Top" }).click();
  await expect.poll(() => added().style).toEqual({ preset: "plain", position: "top" });
  await expect(inspector.getByRole("radio", { name: "Top" })).toHaveAttribute("aria-checked", "true");
  expect(journaled().slice(before)).toEqual([
    { op: "track.add", author: "ui" },
    { op: "track.set", author: "ui" },
    { op: "track.set", author: "ui" },
  ]);
  // Both tracks show: plain keeps the case and has no highlight.
  await expect(overlay()).toHaveAttribute("data-text", "UNO TRES\nuno tres");
  await expect(overlay()).toHaveAttribute("data-active", "TRES\n");

  // The first track's lane head selects it for the inspector.
  await page.locator('button.track-head[data-track="s1"]').click();
  await expect(page.getByRole("group", { name: "Settings of subtitle track S1" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Settings of subtitle track S1" }).getByRole("radio", { name: "Big keyword" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
