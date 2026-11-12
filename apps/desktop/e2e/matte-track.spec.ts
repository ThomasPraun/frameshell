// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { ffmpegRun, testFfmpeg } from "./media.js";
import { addBarcodeAsset, waitForIngest } from "./preview-probe.js";

// Track header menu and matte status of a track behind a person (ADR 0032 slice 4): "Put behind the person on V1" sets
// `behind`, the header shows the matte's state until the stand-in matte (FRAMESHELL_MATTE_STAND_IN) is ready, and
// "Stop going behind the person" clears it. Real daemon, real ingest.
const box = sandbox("overlays");
const mainFile = join(box.projectDir, "timelines", "main.json");
const TAKE = "assets/take.mp4";
const WORD = "assets/word.png";

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

/** A flat red 960x540 picture into `assets/`. */
async function addWord(): Promise<void> {
  const staging = join(box.dataDir, "staging");
  mkdirSync(staging, { recursive: true });
  const file = join(staging, "word.png");
  await ffmpegRun(await testFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=960x540", "-frames:v", "1", file]);
  renameSync(file, join(box.projectDir, WORD));
}

const head = (track: string) => page.locator(`.track-head[data-track="${track}"]`);
const menu = () => page.getByRole("menu");
const savedTrack = (id: string) => JSON.parse(readFileSync(mainFile, "utf8")).tracks.find((track: { id: string }) => track.id === id);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await addBarcodeAsset(box, "take.mp4", 4);
  await addWord();
  ({ app, page } = await launch(box, { env: { FRAMESHELL_MATTE_STAND_IN: "1" } }));
  await waitForIngest(page, TAKE);
  await waitForIngest(page, WORD);
  const timeline = JSON.parse(readFileSync(mainFile, "utf8"));
  timeline.tracks[0].clips = [{ id: "c_take", type: "media", asset: TAKE, start: 0, in: 0, out: 4 }];
  timeline.tracks[1].clips = [{ id: "c_word", type: "media", asset: WORD, start: 1, in: 0, out: 2, transform: { scale: 0.5 } }];
  writeFileSync(mainFile, JSON.stringify(timeline, null, 2));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "2");
});

test.afterAll(async () => {
  await app?.close();
});

test("a track's menu offers the lower video tracks that hold media, and none on the bottom track", async () => {
  await head("v1").click({ button: "right" });
  await expect(menu().getByRole("menuitem", { name: /behind the person/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await head("v3").click({ button: "right" });
  await expect(menu().getByRole("menuitem", { name: /behind the person/ })).toHaveText(["Put behind the person on V2", "Put behind the person on V1"]);
  await page.keyboard.press("Escape");
});

test("Put behind the person sets `behind`, the header shows the matte until it is ready, and Stop clears it", async () => {
  test.setTimeout(240_000);
  await head("v2").click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Put behind the person on V1" }).click();
  await expect.poll(() => savedTrack("v2")?.behind).toBe("v1");

  const chip = head("v2").getByTestId("track-matte");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-plate", "V1");
  // The stand-in matte is made in seconds; the real one takes minutes and shows its percentage meanwhile.
  await expect(chip).toHaveAttribute("data-state", "ready", { timeout: 180_000 });
  await expect(chip).toHaveAccessibleName("Behind the person on V1: matte ready");

  await head("v2").click({ button: "right" });
  await expect(menu().getByRole("menuitem", { name: /behind the person/ })).toHaveText(["Stop going behind the person"]);
  await menu().getByRole("menuitem", { name: "Stop going behind the person" }).click();
  await expect.poll(() => savedTrack("v2")).not.toHaveProperty("behind");
  await expect(head("v2").getByTestId("track-matte")).toHaveCount(0);
});
