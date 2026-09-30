// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Transcript view (#21) in the built app: a real daemon, a synthetic take whose "words" are tone bursts with
// silent pauses between them (so energy snapping has pauses to find), and a hand-written transcript of it.
const box = sandbox("transcript");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const ASSET = "assets/talk.mp4";
const TRANSCRIPT = "transcripts/talk.words.json";

/** Word k (0-based) is a tone at source k + 0.2 to k + 0.7 s; the rest of each second is silence. */
const TEXTS = ["one", "two", "three", "four", "five", "six"];
const id = (k: number) => `w_${String(k + 1).padStart(6, "0")}`;

let app: ElectronApplication;
let page: Page;

/** The take cut around "four" (3.2–3.7 s): source 0–2.9, then 3.9–6 from 2.9 s. */
const CUT = [
  { id: "c_a", type: "media", asset: ASSET, start: 0, in: 0, out: 2.9 },
  { id: "c_b", type: "media", asset: ASSET, start: 2.9, in: 3.9, out: 6 },
];

async function writeTake(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  // Written elsewhere first: the daemon's asset watcher must never see a half-written file.
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "talk.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=6"],
    ...["-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*220*t)*between(mod(t\\,1)\\,0.2\\,0.7):s=48000:d=6"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", file],
  ]);
  const hash = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  mkdirSync(join(box.projectDir, "transcripts"), { recursive: true });
  writeFileSync(
    join(box.projectDir, TRANSCRIPT),
    JSON.stringify({
      schemaVersion: 1,
      asset: ASSET,
      assetHash: hash,
      provider: "whisper-cpp",
      model: "large-v3-turbo-q5_0",
      words: TEXTS.map((text, k) => ({ id: id(k), text, start: k + 0.2, end: k + 0.7 })),
      edits: {},
    }),
  );
  renameSync(file, join(box.projectDir, ASSET));
}

/** Media clips as saved in the timeline file. */
function savedClips(): { id: string; start: number; in: number; out: number }[] {
  return JSON.parse(readFileSync(mainFile, "utf8")).tracks[0].clips;
}

/** Journal lines: operation and author, oldest first. */
function journaled(): { op: string; author: string }[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ op, author }) => ({ op, author }));
}

const word = (k: number) => page.locator(`.tw[data-word="${id(k)}"]`);
const lanes = () => page.getByTestId("timeline-lanes");
const transcript = () => page.getByTestId("transcript");

/** Middle of a word, once laid out. */
async function middle(k: number): Promise<{ x: number; y: number }> {
  const { x, y, width, height } = await laidOutBox(word(k));
  return { x: x + width / 2, y: y + height / 2 };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await writeTake();
  ({ app, page } = await launch(box));
  await waitForIngest(page, ASSET);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  // Current revision: the daemon journals the edit as author `file` (SPEC §6.4).
  timeline.tracks[0].clips = CUT;
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(lanes()).toHaveAttribute("data-clips", "2");
});

test.afterAll(async () => {
  await app?.close();
});

test("the transcript tab strikes the word the cut removed and keeps the rest", async () => {
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
  await expect(word(3)).toHaveAttribute("data-state", "struck");
  for (const k of [0, 1, 2, 4, 5]) await expect(word(k)).toHaveAttribute("data-state", "kept");
  await expect(page.locator(".transcript-asset-head")).toContainText("5 of 6 words on the timeline");
});

test("clicking a word moves the playhead to it, and playback marks each word as it is heard", async () => {
  const one = await middle(0);
  await page.mouse.click(one.x, one.y);
  await expect(lanes()).toHaveAttribute("data-playhead", "0.2");
  await expect(transcript()).toHaveAttribute("data-current", `${TRANSCRIPT}#${id(0)}`);
  await page.getByRole("button", { name: "Play" }).click();
  // "five" plays at 3.2 s on the timeline: after the cut, straight after "three".
  await expect(transcript()).toHaveAttribute("data-current", `${TRANSCRIPT}#${id(4)}`, { timeout: 15_000 });
  await page.getByRole("button", { name: "Pause" }).click();
});

test("dragging across words selects them and their timeline range, skipping the cut word", async () => {
  const two = await middle(1);
  const five = await middle(4);
  await page.mouse.move(two.x, two.y);
  await page.mouse.down();
  await page.mouse.move(five.x, five.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".tw.is-selected")).toHaveCount(3);
  await expect(word(3)).not.toHaveClass(/is-selected/);
  // "two" starts at 1.2 s, "five" ends at 2.9 + (4.7 - 3.9) = 3.7 s.
  await expect(lanes()).toHaveAttribute("data-range", "1.2-3.7");
  await expect(lanes()).toHaveAttribute("data-playhead", "1.2");
});

test("clicking a struck word restores it as a ui operation, extending the clip into the pause and rippling", async () => {
  const before = journaled().length;
  const four = await middle(3);
  await page.mouse.click(four.x, four.y);
  await expect(word(3)).toHaveAttribute("data-state", "kept");
  expect(journaled().slice(before)).toEqual([{ op: "clip.trim", author: "ui" }]);
  const [a, b] = savedClips();
  // Out lands in the pause after "four" (3.7–4.2 s), never past where c_b's source starts.
  expect(a!.out).toBeGreaterThanOrEqual(3.7);
  expect(a!.out).toBeLessThanOrEqual(3.9);
  expect(b!.start).toBeCloseTo(a!.out - a!.in, 3);
  await expect(page.locator(".transcript-toolbar .timeline-status")).toContainText("Restored “four”");
  // The selection follows the ripple: "five" moved right with c_b.
  await expect(lanes()).not.toHaveAttribute("data-range", "1.2-3.7");
});

test("undo in the timeline strikes the word again", async () => {
  await page.locator(".timeline-scroller").focus();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`);
  await expect(word(3)).toHaveAttribute("data-state", "struck");
  expect(savedClips()).toEqual(CUT);
});
