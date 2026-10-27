// page.evaluate bodies run in the renderer, app.evaluate bodies in main.
/// <reference lib="dom" />
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";

// Live following (#393, ADR 0024): the stand-in recognizer (FRAMESHELL_SHOOT_STAND_IN=1) hears what the test says in
// main, and the detached teleprompter follows it: steps, a skipped sentence struck through, a FREE slot that waits
// for a pause, keys that resync, and a hold that makes it wait.
const box = sandbox("teleprompter");

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ app, page } = await launch(box, { args: ["--use-fake-device-for-media-stream"], env: { FRAMESHELL_SHOOT_STAND_IN: "1" } }));
});

test.afterAll(async () => {
  await app?.close();
});

/** Have the stand-in recognizer hear `text`, then `silence` seconds of nothing. */
async function hear(text: string, silence = 0): Promise<void> {
  await app.evaluate((_, [words, pause]) => (globalThis as { frameshellLiveHear?: (text: string, silence: number) => void }).frameshellLiveHear!(words, pause), [text, silence] as const);
}

test("the teleprompter follows the voice it hears, strikes a skipped sentence, waits in a FREE slot", async () => {
  await page.getByRole("tab", { name: "Shoot" }).click();
  await expect(page.getByTestId("shoot-panel")).toBeVisible();
  const opened = panelWindow(app, "teleprompter");
  await page.getByTestId("shoot-teleprompter").click();
  const child = await opened;
  const current = child.locator(".teleprompter-content .is-current");
  await expect(current).toHaveText("Welcome");
  await expect(child.getByTestId("teleprompter-follow")).toHaveAttribute("data-live", "ready");

  await hear("Welcome to the show");
  await expect(current).toHaveText("Today");

  // "And it never jumps": the rest of the first line was skipped.
  await hear("show and it never jumps");
  await expect(current).toHaveText("Freehow we met");
  await expect(child.locator(".teleprompter-content .is-skipped").first()).toHaveText("Today");
  await expect(child.locator(".teleprompter-content .is-skipped").last()).toHaveText("travel.");

  // Free speech, even one touching the script, keeps it on the slot until a pause.
  await hear("we met at school and the rest is history");
  await expect(current).toHaveText("Freehow we met");
  // A thinking pause (2 s) does not end it, and neither does silence before 4 s of speech in the slot.
  await hear("", 2);
  await child.waitForTimeout(300);
  await expect(current).toHaveText("Freehow we met");
  for (let window = 0; window < 8; window++) await hear("", 3);
  await expect(current).toHaveText("The");
  await hear("the rest of the story");
  await expect(current).toHaveText("goes");

  // Keys move it and the follower goes on from there.
  const view = child.getByTestId("teleprompter-view");
  await view.click();
  await child.keyboard.press("ArrowUp");
  await expect(current).toHaveText("The");
  await hear("the rest of the story goes here");
  await expect(current).toHaveText("one");

  // Held, it waits; keys back over the struck sentence take its marks away.
  await child.keyboard.press(" ");
  await expect(child.getByTestId("teleprompter")).toHaveAttribute("data-held", "true");
  await hear("one word after another");
  // Nothing comes to wait for: give the words time to arrive, then check they moved nothing.
  await child.waitForTimeout(300);
  await expect(current).toHaveText("one");
  await child.keyboard.press(" ");
  for (let press = 0; press < 4; press++) await child.keyboard.press("ArrowUp");
  await expect(current).toHaveText("Welcome");
  await expect(child.locator(".teleprompter-content .is-skipped")).toHaveCount(0);

  // Follow off: heard words do nothing.
  await child.getByRole("checkbox", { name: "Follow voice" }).uncheck();
  await hear("Welcome to the show");
  await child.waitForTimeout(300);
  await expect(current).toHaveText("Welcome");
  await child.close();
});
