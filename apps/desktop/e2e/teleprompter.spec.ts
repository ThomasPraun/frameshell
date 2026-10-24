// page.evaluate bodies run in the renderer.
/// <reference lib="dom" />
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";

// The teleprompter (#392, ADR 0024): a shoot script on a fixed focus line, moved by keys in its own window.
const box = sandbox("teleprompter");

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

/** The focus line's y, the current stop's text and vertical center, and one line height of the text, px. */
function geometry(view: Page) {
  return view.evaluate(() => {
    const focus = document.querySelector('[data-testid="teleprompter-focus"]')!.getBoundingClientRect().top;
    const current = document.querySelector(".teleprompter-content .is-current");
    const rect = current?.getBoundingClientRect();
    const content = document.querySelector<HTMLElement>(".teleprompter-content")!;
    return {
      focus,
      text: current?.textContent ?? null,
      center: rect ? rect.top + rect.height / 2 : null,
      line: parseFloat(getComputedStyle(content).lineHeight),
      settled: content.dataset["settled"] === "true",
    };
  });
}

/**
 * Wait until `word` is the current stop and the glide has put it on the focus line, returning the line's y. Within
 * one line height: a word moves half a row along its row, and a long sentence is kept whole on screen.
 */
async function onFocusLine(view: Page, word: string): Promise<number> {
  let seen = await geometry(view);
  await expect
    .poll(async () => {
      seen = await geometry(view);
      return seen.text === word && seen.settled && seen.center !== null && Math.abs(seen.center - seen.focus) <= seen.line;
    })
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`"${word}" not on the focus line; last seen ${JSON.stringify(seen)}\n${error.message}`);
    });
  return seen.focus;
}

test("starts at the shoot's next scene, follows keys in its own window, and keeps the word on the focus line", async () => {
  await page.getByRole("tab", { name: "Teleprompter" }).click();
  await expect(page.getByTestId("teleprompter-view")).toBeVisible();
  // No take yet: `shoot.status` says the first scene is next.
  await expect(page.getByTestId("teleprompter-scene")).toHaveValue("hook");
  await expect(page.locator(".teleprompter-content .is-current")).toHaveText("Welcome");

  const opened = panelWindow(app, "teleprompter");
  await page.getByTestId("sidebar-detach").click();
  const child = await opened;
  await expect(page.getByTestId("panel-docked-elsewhere")).toContainText("Teleprompter");
  await expect(child).toHaveTitle(/^Teleprompter — /);
  const view = child.getByTestId("teleprompter-view");
  await expect(view).toBeFocused();
  const focus = await onFocusLine(child, "Welcome");

  for (let press = 0; press < 3; press++) await child.keyboard.press("ArrowRight");
  expect(await onFocusLine(child, "show.")).toBe(focus);
  // The sentence so far is dimmed; the speaker heads the line.
  await expect(child.locator(".teleprompter-content .is-said")).toHaveText(["Welcome", "to", "the"]);
  await expect(child.locator(".teleprompter-line").first().locator(".teleprompter-speaker")).toHaveText("Ana");

  // Far along a line that wraps: the text has scrolled, the focus line has not moved.
  for (let press = 0; press < 15; press++) await child.keyboard.press("ArrowRight");
  expect(await onFocusLine(child, "line,")).toBe(focus);

  await child.keyboard.press("ArrowDown");
  expect(await onFocusLine(child, "And")).toBe(focus);
  await child.keyboard.press("ArrowDown");
  // A FREE slot is a stop of its own, with its note.
  await expect(child.getByTestId("teleprompter-scene")).toHaveValue("story");
  expect(await onFocusLine(child, "Freehow we met")).toBe(focus);
  await child.keyboard.press("ArrowUp");
  expect(await onFocusLine(child, "And")).toBe(focus);
  await child.keyboard.press("ArrowLeft");
  expect(await onFocusLine(child, "travel.")).toBe(focus);

  // Larger text and mirroring keep the word on the same focus line.
  await child.getByRole("button", { name: "Larger text" }).click();
  await child.getByRole("checkbox", { name: "Mirror" }).check();
  await expect(child.locator(".teleprompter-page")).toHaveClass(/is-mirrored/);
  await view.click();
  expect(await onFocusLine(child, "travel.")).toBe(focus);

  // Space holds; the person's keys still move it.
  await child.keyboard.press(" ");
  await expect(child.getByTestId("teleprompter")).toHaveAttribute("data-held", "true");
  await child.keyboard.press("ArrowRight");
  expect(await onFocusLine(child, "And")).toBe(focus);
  await child.keyboard.press(" ");
  await expect(child.getByTestId("teleprompter")).not.toHaveAttribute("data-held");

  // Docked back, it is still where it was: one position for every window.
  const closed = child.waitForEvent("close");
  await child.getByRole("button", { name: "Dock teleprompter back" }).click();
  await closed;
  await expect(page.locator(".teleprompter-content .is-current")).toHaveText("And");
});

test("the Shoot view opens the teleprompter in its own window", async () => {
  await page.getByRole("tab", { name: "Shoot" }).click();
  // Voice recognition is not installed in this sandbox: it waits for the person's go-ahead before downloading.
  await expect(page.getByTestId("shoot-live-download")).toContainText(/downloads ~\d+ MB once/);
  const opened = panelWindow(app, "teleprompter");
  await page.getByTestId("shoot-teleprompter").click();
  const child = await opened;
  await expect(child.locator(".teleprompter-content .is-current")).toHaveText("And");
  await child.close();
});
