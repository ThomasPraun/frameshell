// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// Correcting who speaks by hand (#247, ADR 0016 decision 3): a turn lane per angle under the program track, painted
// with the mouse into the group's `painted` turns by `multicam.paint` ops of author `ui`; one stroke is one undo step;
// the angle panel picks an angle's transcript speaker. One file shared by two angles, with a hand-written transcript
// where Ana says seconds 1-3 and Ben 4-6, so the turns come from words and need no audio levels.
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const ASSET = "assets/talk.mp4";
const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Content px under the 22 px ruler: the program lane is 44 px, then 16 px per angle lane. */
const LANE_TOP = 22 + 44;
const LANE_HEIGHT = 16;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;

let app: ElectronApplication;
let page: Page;

async function writeTalk(): Promise<void> {
  const ffmpeg = await testFfmpeg();
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  mkdirSync(join(box.projectDir, "transcripts"), { recursive: true });
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "talk.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=8"],
    ...["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=8"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", file],
  ]);
  const assetHash = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  const say = (n: number, text: string, start: number, speaker: string) => ({ id: `w_${String(n).padStart(6, "0")}`, text, start, end: start + 0.4, speaker });
  const words = [
    ...[1, 1.5, 2, 2.5].map((start, i) => say(i + 1, "hola", start, "s1")),
    ...[4, 4.5, 5, 5.5].map((start, i) => say(i + 5, "hola", start, "s2")),
  ];
  writeFileSync(
    join(box.projectDir, "transcripts", "talk.words.json"),
    JSON.stringify({
      schemaVersion: 1,
      asset: ASSET,
      assetHash,
      provider: "whisper-cpp",
      model: "large-v3-turbo-q5_0",
      words,
      edits: {},
      speakers: [
        { id: "s1", name: "Ana" },
        { id: "s2", name: "Ben" },
      ],
      nextSpeakerId: 3,
    }),
  );
  renameSync(file, join(box.projectDir, ASSET));
}

/** The group as the timeline file holds it. */
function savedGroup(): { painted?: { angle: string; start: number; end: number; speaking: boolean }[]; angles: { id: string; speaker?: string }[] } {
  return JSON.parse(readFileSync(mainFile, "utf8")).groups[0];
}

/** Journal lines of painted turns: author, oldest first. */
function paintOps(): string[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; author: string })
    .filter(({ op }) => op === "multicam.paint")
    .map(({ author }) => author);
}

const toggle = () => page.getByTestId("turn-lanes-toggle");
const laneHead = (angle: string) => page.locator(`[data-testid="turn-lane-head"][data-angle="${angle}"]`);
const lanes = () => page.getByTestId("timeline-lanes");

/** Press at timeline second `from` on an angle's lane (0 = first angle), drag to `to` and release; `keys` held. */
async function stroke(lane: number, from: number, to: number, keys: ("Shift" | "Alt")[] = []): Promise<void> {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  const y = rect.y + LANE_TOP + lane * LANE_HEIGHT + LANE_HEIGHT / 2;
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.move(rect.x + from * pxPerSecond, y);
  await page.mouse.down();
  await page.mouse.move(rect.x + ((from + to) / 2) * pxPerSecond, y, { steps: 4 });
  await page.mouse.move(rect.x + to * pxPerSecond, y, { steps: 4 });
  await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}

/** Painted stretches rounded to half a second: a drag lands on frames, and a pixel is about a tenth of a second. */
const rounded = () => (savedGroup().painted ?? []).map(({ angle, start, end, speaking }) => [angle, Math.round(start * 2) / 2, Math.round(end * 2) / 2, speaking]);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await writeTalk();
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, ASSET);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.groups = [
    {
      id: "g_talk",
      angles: [
        { id: "ana", name: "Ana", asset: ASSET, offset: 0, speaker: "s1" },
        { id: "ben", name: "Ben", asset: ASSET, offset: 0, speaker: "s2" },
      ],
    },
  ];
  timeline.tracks = [
    {
      id: "t_program",
      kind: "program",
      name: "Program",
      group: "g_talk",
      clips: [{ id: "c_shot", type: "shot", start: 0, in: 0, out: 8, shot: "solo", angles: ["ana"] }],
    },
  ];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(lanes()).toHaveAttribute("data-clips", "1");
});

test.afterAll(async () => {
  await app?.close();
});

test("the lanes open from the program track's head, one per angle, and close again", async () => {
  await expect(laneHead("ana")).toHaveCount(0);
  await toggle().click();
  await expect(toggle()).toHaveAttribute("aria-pressed", "true");
  await expect(laneHead("ana")).toHaveText("Ana");
  await expect(laneHead("ben")).toHaveText("Ben");
  // Measured from the transcript's speakers: Ana says 1-2.9 s, Ben 4-5.9 s, one turn each.
  await expect(laneHead("ana")).toHaveAttribute("data-turns", "1");
  await expect(laneHead("ben")).toHaveAttribute("data-turns", "1");
  await toggle().click();
  await expect(laneHead("ana")).toHaveCount(0);
  await toggle().click();
  await expect(laneHead("ben")).toBeVisible();
});

test("a stroke on Ben's lane makes him speak where Ana did, and is one undo step", async () => {
  test.setTimeout(120_000);
  await stroke(1, 1.5, 2.5);
  await expect.poll(rounded).toEqual([
    ["ana", 1.5, 2.5, false],
    ["ben", 1.5, 2.5, true],
  ]);
  expect(paintOps()).toEqual(["ui"]);
  await expect(page.locator(".timeline-status")).toContainText("Painted turns saved");

  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => savedGroup().painted).toBeUndefined();
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect.poll(rounded).toHaveLength(2);
});

test("Shift keeps the others and Alt marks the angle silent", async () => {
  test.setTimeout(120_000);
  await stroke(0, 5, 6, ["Shift"]);
  await expect.poll(rounded).toContainEqual(["ana", 5, 6, true]);
  expect(rounded()).not.toContainEqual(["ben", 5, 6, false]);
  await stroke(1, 4, 5, ["Alt"]);
  await expect.poll(rounded).toContainEqual(["ben", 4, 5, false]);
});

test("right-click takes the painted stretch back to the measured turns", async () => {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  const before = rounded().length;
  await page.mouse.click(rect.x + 2 * pxPerSecond, rect.y + LANE_TOP + LANE_HEIGHT + LANE_HEIGHT / 2, { button: "right" });
  await page.getByRole("menuitem", { name: "Back to measured here" }).click();
  await expect.poll(() => rounded().length).toBe(before - 1);
  expect(rounded()).not.toContainEqual(["ben", 1.5, 2.5, true]);

  await page.mouse.click(rect.x + 2 * pxPerSecond, rect.y + LANE_TOP + LANE_HEIGHT / 2, { button: "right" });
  await page.getByRole("menuitem", { name: "Clear every painted turn" }).click();
  await expect.poll(() => savedGroup().painted).toBeUndefined();
  expect(paintOps().every((author) => author === "ui")).toBe(true);
});

test("the angle panel picks the transcript speaker an angle's turns come from", async () => {
  await page.locator('.track-head[data-track="t_program"]').click();
  const speaker = page.getByRole("combobox", { name: "Speaker of Ana" });
  await expect(speaker).toBeEnabled();
  await expect(speaker).toHaveValue("s1");
  await speaker.selectOption("s2");
  await expect.poll(() => savedGroup().angles[0]!.speaker).toBe("s2");
  await speaker.selectOption({ label: "Speaker: Automatic" });
  await expect.poll(() => savedGroup().angles[0]!.speaker).toBeUndefined();
});
