import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { useTestBinaries } from "./media.js";

// The voiceover dialog (ADR 0034 decision 22): progress and Stop while a take is being said, the report of the
// finished run, and placing the takes on the timeline from it and from the script's menu. The daemon runs with
// `FRAMESHELL_SPEECH_STAND_IN=slow`: `stand-in-slow` takes 1.5 s a line and stops at once when canceled.
const box = sandbox("demo");
const SCRIPT = "scripts/slow.md";
const script = ["---", "voiceover: true", "language: en", "provider: stand-in-slow", "---", "## Hook", "Stop.", "## Fix", "Close it.", "## End", "Ship."].join("\n");

let app: ElectronApplication;
let page: Page;

const row = (path: string) => page.getByRole("treeitem", { name: path, exact: true }).getByRole("button").first();
const dialog = () => page.getByTestId("voiceover-dialog");
const take = (id: string) => join(box.projectDir, "assets", "voiceover", "slow", `${id}.wav`);

/** The Voiceover track of the main timeline as the daemon wrote it: clip starts in order. */
function voiceStarts(): number[] {
  const timeline = JSON.parse(readFileSync(join(box.projectDir, "timelines", "main.json"), "utf8")) as { tracks: { name?: string; clips: { start: number }[] }[] };
  return (timeline.tracks.find((track) => track.name === "Voiceover")?.clips ?? []).map((clip) => clip.start);
}

async function menu(path: string, item: string): Promise<void> {
  await row(path).click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

test.beforeAll(async () => {
  mkdirSync(join(box.projectDir, "scripts"), { recursive: true });
  writeFileSync(join(box.projectDir, SCRIPT), script);
  // Takes are ingested and placed with ffmpeg: the shared test copy, not a download of its own.
  await useTestBinaries(box.configDir);
  ({ app, page } = await launch(box, { env: { FRAMESHELL_SPEECH_STAND_IN: "slow" } }));
});

test.afterAll(async () => {
  await app?.close();
});

test("shows what is being said, and Stop keeps the takes finished before it", async () => {
  await menu(SCRIPT, "Generate voiceover…");
  const progress = page.getByTestId("voiceover-progress");
  // Lines by number, never by id (#756).
  await expect(progress).toContainText("Saying line 1 of 3");
  // Close is not offered while it runs.
  await expect(page.getByTestId("voiceover-close")).toBeDisabled();
  // Modal: Tab never leaves the dialog for the timeline or the preview behind it.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=voiceover-dialog]") !== null)).toBe(true);
  }
  await expect(progress).toContainText("Saying line 2 of 3");
  await page.getByTestId("voiceover-stop").click();
  await expect(page.getByTestId("voiceover-stopped")).toHaveText("Stopped. 1 take was saved and is kept.");
  expect(existsSync(take("hook-1"))).toBe(true);
  expect(existsSync(take("fix-1"))).toBe(false);
  await expect(page.getByTestId("voiceover-continue")).toBeVisible();
  await page.getByTestId("voiceover-close").click();
  await expect(dialog()).toHaveCount(0);
});

test("the next run reuses the kept take, and the report says what was checked and what was not", async () => {
  await menu(SCRIPT, "Generate voiceover…");
  // Stop, then Continue: the run goes on from the take already made.
  await expect(page.getByTestId("voiceover-progress")).toContainText("Saying line 1 of 2");
  await page.getByTestId("voiceover-stop").click();
  await page.getByTestId("voiceover-continue").click();
  const report = page.getByTestId("voiceover-report");
  await expect(report).toContainText(/lines? (was|were) generated and \d (was|were) already there\./, { timeout: 20_000 });
  // The demo project has no transcription plugin: the app does not install or download one by itself.
  await expect(page.getByTestId("voiceover-check-note")).toContainText("Not checked against the script");
  await expect(page.getByTestId("voiceover-line-hook-1")).toContainText("already there");
  await expect(page.getByTestId("voiceover-line-end-1")).toContainText("generated");
  await expect(page.getByTestId("voiceover-line-end-1")).toHaveAttribute("data-status", "none");
  // Each line can be heard from the report, and the take is served to the page.
  await expect(page.getByTestId("voiceover-line-play")).toHaveCount(3);
  await expect(page.getByTestId("voiceover-line-play").first()).toHaveAttribute("aria-label", "Play line 1");
});

test("places the takes from the report at the typed start, in one step the second try refuses unless it replaces", async () => {
  test.setTimeout(240_000);
  await page.getByTestId("voiceover-start").fill("1.5");
  await page.getByTestId("voiceover-place-go").click();
  await expect(page.getByTestId("voiceover-placed")).toContainText("Placed", { timeout: 90_000 });
  await expect.poll(() => voiceStarts()[0]).toBe(1.5);
  const placed = voiceStarts().length;
  expect(placed).toBeGreaterThanOrEqual(3);

  await page.getByTestId("voiceover-place-go").click();
  // Said in the dialog's words, pointing at the Replace box (#756).
  await expect(page.getByTestId("voiceover-place-refused")).toHaveAttribute("data-reason", "replace");
  await expect(page.getByTestId("voiceover-place-refused")).toContainText("Tick “Replace clips already placed”");
  await expect(page.getByTestId("voiceover-replace-label")).toHaveClass(/is-asked/);
  expect(voiceStarts()).toHaveLength(placed);

  await page.getByTestId("voiceover-start").fill("4");
  await page.getByTestId("voiceover-replace").check();
  await page.getByTestId("voiceover-place-go").click();
  await expect(page.getByTestId("voiceover-placed")).toContainText("Placed", { timeout: 90_000 });
  await expect.poll(() => voiceStarts()[0]).toBe(4);
  expect(voiceStarts()).toHaveLength(placed);
  await page.getByTestId("voiceover-close").click();
  await expect(dialog()).toHaveCount(0);
});

test("Place voiceover… from the script's menu asks only where to start, and a bad start says so", async () => {
  test.setTimeout(240_000);
  await menu(SCRIPT, "Place voiceover…");
  await expect(dialog()).toContainText("Place on the timeline");
  await expect(page.getByTestId("voiceover-report")).toHaveCount(0);
  await page.getByTestId("voiceover-start").fill("nowhere");
  await page.getByTestId("voiceover-replace").check();
  await page.getByTestId("voiceover-place-go").click();
  await expect(page.getByTestId("voiceover-place-refused")).toContainText("“nowhere” is not a time or a marker of this timeline");
  expect(voiceStarts()[0]).toBe(4);
  // A decimal comma is a decimal point.
  await page.getByTestId("voiceover-start").fill("2,5");
  await page.getByTestId("voiceover-place-go").click();
  await expect(page.getByTestId("voiceover-placed")).toContainText("Placed", { timeout: 90_000 });
  await expect.poll(() => voiceStarts()[0]).toBe(2.5);
  // Escape closes it too.
  await page.keyboard.press("Escape");
  await expect(dialog()).toHaveCount(0);
});

test("a script that names no voice offers the voices there are, and generates with the one picked", async () => {
  test.setTimeout(120_000);
  const plain = "scripts/novoice.md";
  writeFileSync(join(box.projectDir, plain), ["---", "voiceover: true", "language: en", "---", "## Hook", "Go."].join("\n"));
  await expect(page.getByRole("treeitem", { name: plain, exact: true })).toBeVisible();
  await menu(plain, "Generate voiceover…");
  const voice = page.getByTestId("voiceover-voice");
  await expect(voice).toContainText("No voice yet");
  await expect(voice).not.toContainText("--provider");
  await page.getByTestId("voiceover-voice-pick").selectOption("stand-in-slow");
  await page.getByTestId("voiceover-voice-generate").click();
  await expect(page.getByTestId("voiceover-report")).toContainText("1 line was generated", { timeout: 20_000 });
  expect(existsSync(join(box.projectDir, "assets", "voiceover", "novoice", "hook-1.wav"))).toBe(true);
  await page.getByTestId("voiceover-close").click();
});
