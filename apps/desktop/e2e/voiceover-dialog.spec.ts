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
  await expect(progress).toContainText("Saying hook-1");
  // Close is not offered while it runs.
  await expect(page.getByTestId("voiceover-close")).toBeDisabled();
  // Modal: Tab never leaves the dialog for the timeline or the preview behind it.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=voiceover-dialog]") !== null)).toBe(true);
  }
  await expect(progress).toContainText("Saying fix-1");
  await page.getByTestId("voiceover-stop").click();
  await expect(page.getByTestId("voiceover-stopped")).toHaveText("Stopped. 1 take was saved and is kept.");
  expect(existsSync(take("hook-1"))).toBe(true);
  expect(existsSync(take("fix-1"))).toBe(false);
  await page.getByTestId("voiceover-close").click();
  await expect(dialog()).toHaveCount(0);
});

test("the next run reuses the kept take, and the report says what was checked and what was not", async () => {
  await menu(SCRIPT, "Generate voiceover…");
  const report = page.getByTestId("voiceover-report");
  await expect(report).toContainText("2 lines were generated and 1 was already there.", { timeout: 20_000 });
  // The demo project has no transcription plugin: the app does not install or download one by itself.
  await expect(page.getByTestId("voiceover-check-note")).toContainText("Not checked against the script");
  await expect(page.getByTestId("voiceover-line-hook-1")).toContainText("already there");
  await expect(page.getByTestId("voiceover-line-fix-1")).toContainText("generated");
  await expect(page.getByTestId("voiceover-line-end-1")).toHaveAttribute("data-status", "none");
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
  await expect(page.getByTestId("voiceover-place-error")).toContainText("Could not place the voiceover");
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
  await expect(page.getByTestId("voiceover-place-error")).toContainText("Could not place the voiceover");
  expect(voiceStarts()[0]).toBe(4);
  await page.getByTestId("voiceover-start").fill("2");
  await page.getByTestId("voiceover-place-go").click();
  await expect(page.getByTestId("voiceover-placed")).toContainText("Placed", { timeout: 90_000 });
  await expect.poll(() => voiceStarts()[0]).toBe(2);
  // Escape closes it too.
  await page.keyboard.press("Escape");
  await expect(dialog()).toHaveCount(0);
});
