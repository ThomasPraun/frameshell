// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";
import { testFfmpeg } from "./media.js";

// What T and C did, said where the person looks (ADR 0024): the Shoot view and the teleprompter's strip show the take
// being recorded, then its result once analyzed (stand-in transcriber: it hears the scene without one word).
const box = sandbox("multicam");
const SCRIPT = [
  ...["---", "shoot: true", "---", ""],
  ...["## Hook", "", "Hola a todos y bienvenidos al canal de hoy", "Hoy hablamos de cámaras", ""],
  ...["## Problem", "", "Nadie lee el manual de su cámara nueva", ""],
].join("\n");

let app: ElectronApplication;
let page: Page;

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

/** Save a screenshot of `view` for the record, when `FRAMESHELL_E2E_SHOTS` names a folder. */
async function shot(view: Page, name: string): Promise<void> {
  const dir = process.env["FRAMESHELL_E2E_SHOTS"];
  if (dir) await view.screenshot({ path: join(dir, `${name}.png`) });
}

test("the Shoot view and the teleprompter say what T and C did, and each take's result as it arrives", async () => {
  test.setTimeout(120_000);
  await page.getByRole("tab", { name: "Shoot" }).click();
  await expect(page.getByTestId("take-status-hint")).toContainText("T starts a take of the current scene and C cuts it");
  await shot(page, "1-before-start");

  await page.getByTestId("shoot-teleprompter").click();
  const prompter = await panelWindow(app, "teleprompter");
  // Before Start the teleprompter shows no strip.
  await expect(prompter.getByTestId("teleprompter-view")).toBeVisible();
  await expect(prompter.getByTestId("take-status")).toHaveCount(0);

  await page.getByTestId("shoot-start").click();
  await expect(page.getByTestId("shoot-elapsed")).toBeVisible();
  const strip = prompter.getByTestId("take-status");
  await expect(strip).toHaveAttribute("data-state", "ready");
  await expect(strip).toHaveText("Recording · press T to start a take of “Hook”");
  await shot(prompter, "2-teleprompter-ready");

  await page.keyboard.press("t");
  await expect(strip).toHaveAttribute("data-state", "open");
  await expect(prompter.getByTestId("take-status-open")).toContainText("Take 1 · Hook");
  await expect(strip).toContainText("C to cut");
  await expect(prompter.getByTestId("take-status-time")).toHaveText("0:02", { timeout: 5_000 });
  await expect(page.getByTestId("take-status-open")).toContainText("Take 1 · Hook");
  await shot(prompter, "3-teleprompter-take-open");
  await shot(page, "3-shoot-take-open");

  await page.keyboard.press("c");
  await expect(prompter.getByTestId("take-status-outcome")).toHaveText("Take 1 cut · analyzing…");
  await shot(prompter, "4-teleprompter-analyzing");
  await expect(prompter.getByTestId("take-status-outcome")).toHaveText("Take 1: 1 difference, review in the Shoot view", { timeout: 15_000 });
  await expect(page.getByTestId("take-status-outcome")).toHaveText("Take 1: 1 difference, review below");
  await expect(strip).toContainText("T: new take of “Hook”");
  await shot(prompter, "5-teleprompter-result");
  await shot(page, "5-shoot-result");

  // A cut right after T keeps nothing, and says so.
  await page.keyboard.press("t");
  await expect(prompter.getByTestId("take-status-open")).toContainText("Take 2 · Hook");
  await page.keyboard.press("c");
  await expect(prompter.getByTestId("take-status-outcome")).toHaveText("Take 2 was under half a second: not kept");

  // Mirrored, the strip flips with the text.
  await prompter.getByLabel("Mirror").check();
  await expect(strip).toHaveClass(/is-mirrored/);
  await prompter.getByLabel("Mirror").uncheck();

  // A take cut by End is analyzed too, and its result shows once the session is saved.
  await page.keyboard.press("t");
  await expect(page.getByTestId("take-status-open")).toContainText("Take 2 · Hook");
  await page.waitForTimeout(2500);
  await page.getByTestId("shoot-end").click();
  await expect(page.getByTestId("shoot-finished")).toBeVisible({ timeout: 60_000 });
  await expect(strip).toHaveCount(0);
  await expect(page.getByTestId("take-status-outcome")).toHaveText("Take 2: 1 difference, review below", { timeout: 15_000 });
  await shot(page, "6-shoot-after-end");
});
