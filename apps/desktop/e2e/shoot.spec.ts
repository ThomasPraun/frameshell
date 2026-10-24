// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";
import { testFfmpeg } from "./media.js";

// The Shoot view's recorder (#390, ADR 0024): Chromium's fake camera and microphone, and a stand-in screen that
// captures the app's own page through the real getDisplayMedia path (never `--use-fake-ui-for-media-stream`, which
// breaks screen capture). One session ends with End; the next is killed while recording and recovered on relaunch.
const box = sandbox("multicam");
const mainFile = join(box.projectDir, "timelines", "main.json");
const shootDir = join(box.projectDir, "assets", "shoot");
const options = {
  args: ["--use-fake-device-for-media-stream"],
  env: { FRAMESHELL_SHOOT_STAND_IN: "1", FRAMESHELL_IDLE_TIMEOUT_MS: "60000" },
};

let app: ElectronApplication;
let page: Page;

interface Group {
  id: string;
  name?: string;
  angles: { name: string; asset: string; offset: number; screen?: boolean; mic?: string | null }[];
  mics?: { id: string; name: string; asset: string; offset: number }[];
}

function groups(): Group[] {
  return (JSON.parse(readFileSync(mainFile, "utf8")) as { groups?: Group[] }).groups ?? [];
}

/** Open the Shoot view with the fake camera, the fake mic and the stand-in screen picked. */
async function setUp(): Promise<void> {
  await page.getByRole("tab", { name: "Shoot" }).click();
  const panel = page.getByTestId("shoot-panel");
  await expect(panel).toBeVisible();
  const allow = panel.getByRole("button", { name: "Allow camera and microphone" });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await expect(page.getByTestId("shoot-mic")).not.toHaveValue("");
  // Chromium's fake microphone beeps: the meter moves.
  await expect.poll(async () => Number(await page.getByTestId("shoot-mic-level").getAttribute("data-db")), { timeout: 15_000 }).toBeGreaterThan(-60);
  const camera = page.getByTestId("shoot-camera");
  const first = await camera.locator("option").nth(1).getAttribute("value");
  await camera.selectOption(first!);
  await expect.poll(() => page.getByTestId("shoot-camera-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByTestId("shoot-screen-choose").click();
  await page.getByTestId("shoot-screen-option").filter({ hasText: "Stand-in screen" }).click();
  await expect.poll(() => page.getByTestId("shoot-screen-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Recovery remuxes with the managed ffmpeg; the shared test copy spares a download.
  mkdirSync(box.configDir, { recursive: true });
  writeFileSync(join(box.configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg: await testFfmpeg() } }));
  ({ app, page } = await launch(box, options));
});

test.afterAll(async () => {
  await app?.close();
});

test("records camera, screen and mic into one session, then makes it a multicam group with the screen marked", async () => {
  test.setTimeout(120_000);
  await setUp();
  await page.getByTestId("shoot-start").click();
  await expect(page.getByTestId("shoot-elapsed")).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isContentProtected())).toBe(true);
  // While recording the sources are locked.
  await expect(page.getByTestId("shoot-camera")).toBeDisabled();
  await page.waitForTimeout(5000);
  await page.getByTestId("shoot-end").click();
  const finished = page.getByTestId("shoot-finished");
  await expect(finished).toContainText("Saved 3 files to assets/shoot/", { timeout: 60_000 });
  await expect(finished).toContainText("multicam group");
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isContentProtected())).toBe(false);

  const [session] = readdirSync(shootDir);
  const files = readdirSync(join(shootDir, session!)).sort();
  expect(files.filter((file) => /\.(mp4|m4a|webm)$/.test(file))).toHaveLength(3);
  expect(files.some((file) => file.endsWith(".part"))).toBe(false);
  expect(existsSync(join(box.projectDir, ".frameshell", "shoot", "sessions", `${session}.json`))).toBe(false);

  const [group] = groups();
  expect(group!.name).toBe(`Shoot ${session}`);
  expect(group!.angles.map((angle) => angle.screen === true)).toEqual([false, true]);
  expect(group!.angles[1]!.name).toBe("Stand-in screen");
  expect(group!.mics).toHaveLength(1);
  for (const angle of group!.angles) {
    expect(angle.mic).toBe(group!.mics![0]!.id);
    // Started in one tick: well under a frame apart.
    expect(angle.offset).toBeLessThan(0.03);
  }
  await expect(page.getByRole("tab", { name: "Shoot" })).toBeVisible();
});

test("finishes a session the app was killed in on the next open", async () => {
  test.setTimeout(180_000);
  await page.getByTestId("shoot-start").click();
  await expect(page.getByTestId("shoot-elapsed")).toBeVisible();
  // Kill once every video file holds frames, not only its header: fragments follow the 1 s keyframes.
  const sessions = join(box.projectDir, ".frameshell", "shoot", "sessions");
  await expect
    .poll(
      () => {
        const id = readdirSync(sessions)[0]?.replace(/\.json$/, "");
        if (!id) return 0;
        return Math.min(...["camera.mp4.part", "screen.mp4.part"].map((file) => (existsSync(join(shootDir, id, file)) ? statSync(join(shootDir, id, file)).size : 0)));
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(20_000);
  await page.waitForTimeout(1500);
  const killed = app.process();
  const exited = new Promise((resolve) => killed.once("exit", resolve));
  killed.kill("SIGKILL");
  await exited;
  const unfinished = readdirSync(join(box.projectDir, ".frameshell", "shoot", "sessions"));
  expect(unfinished).toHaveLength(1);

  ({ app, page } = await launch(box, options));
  await page.getByRole("tab", { name: "Shoot" }).click();
  await expect(page.getByTestId("shoot-finished")).toContainText("Recovered a shoot that was interrupted", { timeout: 60_000 });
  await expect.poll(() => groups().length, { timeout: 30_000 }).toBe(2);
  const recovered = groups()[1]!;
  expect(recovered.angles).toHaveLength(2);
  expect(readdirSync(join(box.projectDir, ".frameshell", "shoot", "sessions"))).toEqual([]);
  const session = unfinished[0]!.replace(/\.json$/, "");
  expect(readdirSync(join(shootDir, session)).some((file) => file.endsWith(".part") || file.endsWith(".tmp"))).toBe(false);
});
