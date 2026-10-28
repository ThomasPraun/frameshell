// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { testFfmpeg } from "./media.js";

// Takes in a shoot session (#391, ADR 0024): T and C mark takes while recording, each take is checked against the
// shoot script seconds after C (stand-in transcriber, FRAMESHELL_SHOOT_STAND_IN: it hears the scene without the
// middle word of its longest line), accepted or recorded again, and the session's end makes the takes shots.
const box = sandbox("multicam");
const SCRIPT = [
  ...["---", "shoot: true", "---", ""],
  ...["## Hook", "", "Hola a todos y bienvenidos al canal de hoy", "Hoy hablamos de cámaras", ""],
  ...["## Problem", "", "Nadie lee el manual de su cámara nueva", ""],
].join("\n");

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  mkdirSync(join(box.projectDir, "scripts"), { recursive: true });
  writeFileSync(join(box.projectDir, "scripts", "launch.md"), SCRIPT);
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg: await testFfmpeg() } }));
  ({ app, page } = await launch(box, {
    args: ["--use-fake-device-for-media-stream"],
    env: { FRAMESHELL_SHOOT_STAND_IN: "1", FRAMESHELL_IDLE_TIMEOUT_MS: "60000" },
  }));
});

test.afterAll(async () => {
  await app?.close();
});

const scene = (slug: string) => page.locator(`[data-testid="shoot-scene"][data-scene="${slug}"]`);

/** T, a few seconds of recording, then C. */
async function recordTake(): Promise<void> {
  await page.keyboard.press("t");
  await expect(page.getByTestId("take-status-open")).toBeVisible();
  await page.waitForTimeout(2500);
  await page.keyboard.press("c");
  await expect(page.getByTestId("take-status-open")).toHaveCount(0);
}

test("T and C record takes that are checked against the script; accept, record again and end make the first cut", async () => {
  test.setTimeout(150_000);
  await page.getByRole("tab", { name: "Shoot" }).click();
  await expect(page.getByTestId("shoot-script")).toHaveValue("scripts/launch.md");
  await expect(scene("hook")).toHaveAttribute("data-state", "none");
  await expect(page.getByTestId("shoot-current")).toHaveAttribute("data-scene", "hook");
  await expect(page.getByTestId("shoot-mic")).not.toHaveValue("");
  const camera = page.getByTestId("shoot-camera");
  await camera.selectOption((await camera.locator("option").nth(1).getAttribute("value"))!);
  await expect.poll(() => page.getByTestId("shoot-camera-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);

  await page.getByTestId("shoot-start").click();
  await expect(page.getByTestId("shoot-elapsed")).toBeVisible();
  await page.waitForTimeout(1000);

  // A take's deviations show within seconds of C.
  await recordTake();
  const deviation = page.locator('[data-testid="shoot-current"] [data-testid="shoot-deviation"]');
  await expect(deviation).toHaveCount(1, { timeout: 15_000 });
  await expect(deviation).toHaveAttribute("data-kind", "missing");
  await expect(page.locator(".shoot-missing")).toHaveText("bienvenidos");
  await expect(scene("hook")).toHaveAttribute("data-state", "deviations");

  // Record it again: the newest take is the one in the cut.
  await recordTake();
  await expect(page.getByTestId("shoot-chosen").locator("option")).toHaveCount(3, { timeout: 15_000 });
  await expect(deviation).toHaveCount(1, { timeout: 15_000 });
  await expect(deviation).toHaveAttribute("data-accepted", "false");

  await page.getByTestId("shoot-accept").click();
  await expect(deviation).toHaveAttribute("data-accepted", "true");
  await expect(scene("hook")).toHaveAttribute("data-state", "done");

  await page.getByTestId("shoot-next").click();
  await expect(page.getByTestId("shoot-current")).toHaveAttribute("data-scene", "problem");
  await recordTake();
  await expect(scene("problem")).toHaveAttribute("data-state", "deviations", { timeout: 15_000 });

  await page.getByTestId("shoot-end").click();
  await expect(page.getByTestId("shoot-finished")).toContainText("multicam group", { timeout: 60_000 });

  const shoot = JSON.parse(readFileSync(join(box.projectDir, "shoots", "launch.json"), "utf8"));
  expect(shoot.takes).toHaveLength(3);
  const [session] = readdirSync(join(box.projectDir, "assets", "shoot"));
  for (const take of shoot.takes) expect(take.session).toMatchObject({ id: session, group: expect.stringMatching(/^g_/) });
  expect(existsSync(join(box.projectDir, "transcripts", "shoot", session!, "mic.words.json"))).toBe(true);
  // The chosen takes are shots of the session's program track on the shoot's timeline: the newer hook, then problem.
  await expect
    .poll(() => {
      const timeline = JSON.parse(readFileSync(join(box.projectDir, "timelines", "launch.json"), "utf8"));
      const program = timeline.tracks.find((track: { kind: string }) => track.kind === "program");
      return program?.clips.map((clip: { take: string; scriptRef: string }) => [clip.take, clip.scriptRef]);
    })
    .toEqual([
      [shoot.takes[1].id, "scripts/launch.md#hook"],
      [shoot.takes[2].id, "scripts/launch.md#problem"],
    ]);
});
