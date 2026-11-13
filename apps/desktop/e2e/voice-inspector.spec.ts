// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { waitForIngest } from "./preview-probe.js";

// The Voice section of the clip inspector (#464, ADR 0031): the voice chain of a media clip is switched on from the
// style, edited number by number, reordered, bypassed and brought back, every change one `ui` clip.set that undo
// reverts; the preview then asks for the bake of the chain, which lands in `.frameshell/audio-fx/`.
const box = sandbox("voice-inspector");
const mainFile = join(box.projectDir, "timelines", "main.json");
const journal = join(box.projectDir, ".frameshell", "history", "main.jsonl");
const bakes = join(box.projectDir, ".frameshell", "audio-fx");
const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Content px of the only (44 px) lane's middle, under the 22 px ruler. */
const LANE_MIDDLE = 22 + 22;
/** Timeline span the fitted zoom shows while the timeline is under 48 s (`layout.ts`). */
const FIT_SPAN_S = 60;
const ASSET = "assets/talk.mp4";

const VOICE = [
  { kind: "highpass", frequency: 85 },
  { kind: "denoise", floor: -30, reduction: 8 },
  { kind: "compressor", threshold: -20, ratio: 2.5, attack: 8, release: 140, makeup: 2 },
];

let app: ElectronApplication;
let page: Page;

const lanes = () => page.getByTestId("timeline-lanes");
const inspector = () => page.getByRole("group", { name: "Settings of clip talk.mp4" });
const voice = () => inspector().getByRole("group", { name: "Voice" });
const effect = (kind: string) => voice().locator(`[data-effect="${kind}"]`);

/** The saved clip's `audio.effects`; undefined when it has none. */
function saved(): unknown {
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  return timeline.tracks[0].clips[0].audio?.effects;
}

/** Journal lines: operation and author, oldest first. */
function journaled(): { op: string; author: string }[] {
  return readFileSync(journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; author: string })
    .map(({ op, author }) => ({ op, author }));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const ffmpeg = await testFfmpeg();
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "talk.mp4");
  await ffmpegRun(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=3"],
    ...["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=3"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
  ]);
  mkdirSync(join(box.projectDir, "assets"), { recursive: true });
  renameSync(file, join(box.projectDir, ASSET));
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg } }));
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_talk", type: "media", asset: ASSET, start: 0, in: 0, out: 3 }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await waitForIngest(page, ASSET);
});

test.afterAll(async () => {
  await app?.close();
});

test("the Voice switch writes the style's voice chain, and the sound is baked for the preview", async () => {
  const scroller = page.locator(".timeline-scroller");
  const rect = await laidOutBox(scroller);
  const pxPerSecond = (await scroller.evaluate((element) => element.scrollWidth)) / FIT_SPAN_S;
  await page.mouse.click(rect.x + 1.5 * pxPerSecond, rect.y + LANE_MIDDLE);
  await expect(lanes()).toHaveAttribute("data-selected", "c_talk");
  await expect(voice().getByRole("button", { name: "Voice", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(saved()).toBeUndefined();

  await voice().getByRole("button", { name: "Voice", exact: true }).click();
  await expect.poll(saved).toEqual(VOICE);
  expect(journaled().at(-1)).toEqual({ op: "clip.set", author: "ui" });
  await expect(effect("highpass").getByRole("textbox", { name: "Cutoff (Hz)" })).toHaveValue("85");
  await expect(effect("denoise").getByRole("textbox", { name: "Reduction (dB)" })).toHaveValue("8");
  await expect(effect("compressor").getByRole("textbox", { name: "Ratio (:1)" })).toHaveValue("2.5");

  await expect.poll(() => readdirSync(bakes).filter((name) => name.endsWith(".pcm")).length, { timeout: 120_000 }).toBeGreaterThan(0);
});

test("a number is edited in place; one outside the effect's range is refused in the field", async () => {
  const ratio = effect("compressor").getByRole("textbox", { name: "Ratio (:1)" });
  await ratio.fill("4");
  await ratio.press("Enter");
  await expect.poll(saved).toEqual([VOICE[0], VOICE[1], { ...VOICE[2], ratio: 4 }]);

  const cutoff = effect("highpass").getByRole("textbox", { name: "Cutoff (Hz)" });
  await cutoff.fill("5000");
  await cutoff.press("Enter");
  await expect(effect("highpass").locator(".clip-field.is-invalid")).toHaveCount(1);
  expect((saved() as { frequency: number }[])[0]!.frequency).toBe(85);
  await cutoff.press("Escape");
  await expect(cutoff).toHaveValue("85");
});

test("an effect is removed, added back at the end and moved earlier", async () => {
  await effect("denoise").getByRole("button", { name: "Remove Denoise from the chain" }).click();
  await expect.poll(() => (saved() as { kind: string }[]).map((entry) => entry.kind)).toEqual(["highpass", "compressor"]);

  await voice().getByRole("combobox", { name: "Add an effect" }).selectOption("denoise");
  await expect.poll(() => (saved() as { kind: string }[]).map((entry) => entry.kind)).toEqual(["highpass", "compressor", "denoise"]);
  await expect(voice().getByRole("combobox", { name: "Add an effect" })).toHaveCount(0);

  await effect("denoise").getByRole("button", { name: "Process Denoise before the effect above it" }).click();
  await expect.poll(saved).toEqual([VOICE[0], VOICE[1], { ...VOICE[2], ratio: 4 }]);
});

test("bypass removes the chain and switching on again brings the same chain back", async () => {
  await voice().getByRole("button", { name: "Voice", exact: true }).click();
  await expect.poll(saved).toBeUndefined();
  await expect(voice().locator("[data-effect]")).toHaveCount(0);

  await voice().getByRole("button", { name: "Voice", exact: true }).click();
  await expect.poll(saved).toEqual([VOICE[0], VOICE[1], { ...VOICE[2], ratio: 4 }]);

  // The preset replaces the edited chain by the style's.
  await voice().getByRole("button", { name: "Voice preset" }).click();
  await expect.poll(saved).toEqual(VOICE);
});

test("every edit is one undoable step", async () => {
  expect(new Set(journaled().map((entry) => `${entry.op}:${entry.author}`))).toEqual(new Set(["clip.set:ui"]));
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(saved).toEqual([VOICE[0], VOICE[1], { ...VOICE[2], ratio: 4 }]);
  await expect(effect("compressor").getByRole("textbox", { name: "Ratio (:1)" })).toHaveValue("4");
});
