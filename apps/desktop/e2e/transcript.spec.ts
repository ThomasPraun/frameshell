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
// silent pauses between them (so energy snapping has pauses to find), then three words of continuous speech
// (80 ms gaps, shorter than a pause), and a hand-written transcript of it.
const box = sandbox("transcript");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const ASSET = "assets/talk.mp4";
const TRANSCRIPT = "transcripts/talk.words.json";

/** Word k (0-based, k < 6) is a tone at source k + 0.2 to k + 0.7 s; the rest of each second is silence. */
const TEXTS = ["one", "two", "three", "four", "five", "six"];
/** Continuous speech after 6 s: 80 ms gaps; silence from 7.3 s to the end (8 s). */
const RUN: [string, number, number][] = [
  ["seven", 6.2, 6.5],
  ["eight", 6.58, 6.9],
  ["nine", 6.98, 7.3],
];
const WORDS = [...TEXTS.map((text, k): [string, number, number] => [text, k + 0.2, k + 0.7]), ...RUN];
const id = (k: number) => `w_${String(k + 1).padStart(6, "0")}`;

let app: ElectronApplication;
let page: Page;

/**
 * The take cut around "four" (3.2–3.7 s): source 0–2.9, then 3.9–6 from 2.9 s. Then "eight" (6.58–6.9) is cut
 * out of the continuous run: source 6–6.533 ("seven"), then 6.933–7.9 ("nine").
 */
const CUT = [
  { id: "c_a", type: "media", asset: ASSET, start: 0, in: 0, out: 2.9 },
  { id: "c_b", type: "media", asset: ASSET, start: 2.9, in: 3.9, out: 6 },
  { id: "c_c", type: "media", asset: ASSET, start: 5, in: 6, out: 6.533 },
  { id: "c_d", type: "media", asset: ASSET, start: 5.533, in: 6.933, out: 7.9 },
];

async function writeTake(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  const between = (from: number, to: number) => `between(t\\,${from}\\,${to})`;
  const voiced = [`between(mod(t\\,1)\\,0.2\\,0.7)*lt(t\\,6)`, ...RUN.map(([, from, to]) => between(from, to))].join("+");
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  // Written elsewhere first: the daemon's asset watcher must never see a half-written file.
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "talk.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=8"],
    ...["-f", "lavfi", "-i", `aevalsrc=0.5*sin(2*PI*220*t)*(${voiced}):s=48000:d=8`],
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
      words: WORDS.map(([text, start, end], k) => ({ id: id(k), text, start, end })),
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
  await expect(lanes()).toHaveAttribute("data-clips", "4");
});

test.afterAll(async () => {
  await app?.close();
});

test("the transcript tab strikes the word the cut removed and keeps the rest", async () => {
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
  for (const k of [3, 7]) await expect(word(k)).toHaveAttribute("data-state", "struck");
  for (const k of [0, 1, 2, 4, 5, 6, 8]) await expect(word(k)).toHaveAttribute("data-state", "kept");
  await expect(page.locator(".transcript-asset-head")).toContainText("7 of 9 words on the timeline");
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

test("clicking a word while playing seeks to it and plays on", async () => {
  const playhead = async () => Number(await lanes().getAttribute("data-playhead"));
  await page.getByRole("button", { name: "Go to start" }).click();
  await expect(lanes()).toHaveAttribute("data-playhead", "0");
  await page.getByRole("button", { name: "Play" }).click();
  // Well past "one" (0.2–0.7 s), with 4 s of the 6.5 s program still to play.
  await expect.poll(playhead, { timeout: 15_000 }).toBeGreaterThan(2.5);
  const one = await middle(0);
  await page.mouse.click(one.x, one.y);
  // Playing on from 2.5 s never brings the playhead back below 2 s: only the seek to 0.2 s does.
  await expect.poll(playhead, { timeout: 5_000 }).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(word(0)).toHaveClass(/is-selected/);
  const seeked = await playhead();
  await expect.poll(playhead, { timeout: 15_000 }).toBeGreaterThan(seeked);
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

test("restoring a word in continuous speech brings back that word only, with no pause in reach inside its gap", async () => {
  const before = journaled().length;
  const eight = await middle(7);
  await page.mouse.click(eight.x, eight.y);
  await expect(word(7)).toHaveAttribute("data-state", "kept");
  await expect(page.locator(".transcript-toolbar .timeline-status")).toContainText("Restored “eight”");
  expect(journaled().slice(before)).toEqual([{ op: "clip.trim", author: "ui" }]);
  const clips = savedClips();
  const c = clips.find((clip) => clip.id === "c_c")!;
  const d = clips.find((clip) => clip.id === "c_d")!;
  // Out stays in the 80 ms gap after "eight": the nearest pause (after "nine", 7.3 s) would play "nine" twice.
  expect(c.out).toBeGreaterThanOrEqual(6.9);
  expect(c.out).toBeLessThanOrEqual(6.933);
  expect(d.in).toBe(6.933);
  expect(d.start).toBeCloseTo(c.start + (c.out - c.in), 3);
  for (const k of [6, 8]) await expect(word(k)).toHaveAttribute("data-state", "kept");
});

// #118: whole passages, other tracks, word corrections, opening the view.
const MUSIC = "assets/music.wav";

/** Replace the picture track's clips and the music track (null: no music track) at the current revision. */
function writeTimeline(clips: object[], music: object[] | null): void {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks = [{ ...timeline.tracks[0], clips }, ...(music ? [{ id: "a_music", kind: "audio", name: "Music", clips: music }] : [])];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
}

/** Clips of track `track` as saved. */
function savedTrack(track: string): { id: string; start: number; in: number; out: number }[] {
  return JSON.parse(readFileSync(mainFile, "utf8")).tracks.find((candidate: { id: string }) => candidate.id === track).clips;
}

/** "two" and "three" (1.2–2.7) cut as one passage: source 0–1, then 2.9–7.9 from 1 s. The music bed changes at 1 s. */
const PASSAGE = [
  { id: "c_p1", type: "media", asset: ASSET, start: 0, in: 0, out: 1 },
  { id: "c_p2", type: "media", asset: ASSET, start: 1, in: 2.9, out: 7.9 },
];
const BEDS = [
  { id: "m_1", type: "media", asset: MUSIC, start: 0, in: 0, out: 1 },
  { id: "m_2", type: "media", asset: MUSIC, start: 1, in: 1, out: 7 },
];
const mod = process.platform === "darwin" ? "Meta" : "Control";
const status = () => page.locator(".transcript-toolbar .timeline-status");

test("a cut passage comes back in one step and leaves the music track without a gap", async () => {
  const ffmpeg = await testFfmpeg();
  const staging = join(box.dataDir, "staging", "music.wav");
  await ffmpegRun(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", staging]);
  renameSync(staging, join(box.projectDir, MUSIC));
  await waitForIngest(page, MUSIC);
  writeTimeline(PASSAGE, BEDS);
  for (const k of [1, 2]) await expect(word(k)).toHaveAttribute("data-state", "struck");
  const before = journaled().length;
  await page.getByRole("button", { name: "Restore 2 cut words" }).click();
  for (const k of [1, 2]) await expect(word(k)).toHaveAttribute("data-state", "kept");
  expect(journaled().slice(before)).toEqual([{ op: "clip.trim", author: "ui" }]);
  const [p1, p2] = savedTrack("v1");
  expect(p1!.out).toBeGreaterThanOrEqual(2.7);
  expect(p2!.start).toBeCloseTo(p1!.out - p1!.in, 3);
  // The bed changing at 1 s stays put: moving m_2 would leave silence after m_1.
  expect(savedTrack("a_music")).toEqual(BEDS);
  await expect(status()).toContainText("Restored 2 words");
  await expect(status()).toContainText("A1 (Music) kept in place");
});

test("struck words inside a drag selection restore with the toolbar button, as one undo step", async () => {
  await page.locator(".timeline-scroller").focus();
  await page.keyboard.press(`${mod}+z`);
  for (const k of [1, 2]) await expect(word(k)).toHaveAttribute("data-state", "struck");
  const one = await middle(0);
  const four = await middle(3);
  await page.mouse.move(one.x, one.y);
  await page.mouse.down();
  await page.mouse.move(four.x, four.y, { steps: 8 });
  await page.mouse.up();
  const restore = page.locator(".transcript-restore-marked");
  await expect(restore).toHaveText("Restore 2 cut words");
  const before = journaled().length;
  await restore.click();
  for (const k of [1, 2]) await expect(word(k)).toHaveAttribute("data-state", "kept");
  expect(journaled().slice(before)).toEqual([{ op: "clip.trim", author: "ui" }]);
  await expect(restore).toHaveCount(0);
});

test("double-clicking a word corrects its text as a transcript edit", async () => {
  await word(4).dblclick();
  const field = page.getByRole("textbox", { name: "Text of “five”" });
  await field.fill("fyve");
  await field.press("Enter");
  await expect(word(4)).toHaveText("fyve");
  const saved = JSON.parse(readFileSync(join(box.projectDir, TRANSCRIPT), "utf8"));
  expect(saved.edits).toEqual({ [id(4)]: { text: "fyve" } });
  expect(saved.words[4].text).toBe("five");
  await expect(status()).toContainText("Corrected “five” to “fyve”");
});

test("the transcript opens from the keyboard shortcut and from the timeline header", async () => {
  const tab = page.getByRole("tab", { name: "Transcript" });
  await page.getByRole("button", { name: "Close Transcript" }).click();
  await expect(tab).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+T`);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close Transcript" }).click();
  await expect(tab).toHaveCount(0);
  await page.getByRole("button", { name: "Show transcript" }).click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
});
