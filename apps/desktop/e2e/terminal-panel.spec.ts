import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, runInTerminal, sandbox, terminalText } from "./harness.js";

// The terminal panel closes and reopens like any panel (ADR 0025 decision 8): from its header, the rail, Mod+\ and
// View > Terminal; closing keeps the shells running (ADR 0012); the choice is remembered per project.
const box = sandbox("ask");
const MOD: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";
const TICKER = `node -e "let i = 0; setInterval(() => console.log('tick ' + i++), 150)"`;
/** Layout is saved 300 ms after the last change. */
const SAVED_MS = 1_200;

let app: ElectronApplication;
let page: Page;

const panel = () => page.locator('[data-panel="terminal"]');
const rail = () => page.getByRole("button", { name: "Show terminal" });

async function lastTick(): Promise<number> {
  const ticks = [...(await terminalText(page)).matchAll(/tick (\d+)/g)].map((match) => Number(match[1]));
  return ticks.length > 0 ? Math.max(...ticks) : -1;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

test("closing the terminal panel keeps its shell running; the rail reopens it", async () => {
  await runInTerminal(page, TICKER);
  await expect.poll(lastTick, { timeout: 15_000 }).toBeGreaterThan(2);

  await page.getByRole("button", { name: "Hide terminal" }).click();
  await expect(panel()).toBeHidden();
  await expect(rail()).toBeVisible();

  await rail().click();
  await expect(panel()).toBeVisible();
  const before = await lastTick();
  await expect.poll(lastTick, { timeout: 15_000 }).toBeGreaterThan(before + 2);
});

test("Mod+\\ and View > Terminal close and reopen it", async () => {
  await page.keyboard.press(`${MOD}+\\`);
  await expect(panel()).toBeHidden();
  await page.keyboard.press(`${MOD}+\\`);
  await expect(panel()).toBeVisible();

  const viaMenu = () =>
    app.evaluate(({ BrowserWindow, Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("view-terminal")?.click(undefined, BrowserWindow.getAllWindows()[0]);
    });
  await viaMenu();
  await expect(panel()).toBeHidden();
  await viaMenu();
  await expect(panel()).toBeVisible();
});

test("a closed terminal panel stays closed when the project reopens", async () => {
  await page.getByRole("button", { name: "Hide terminal" }).click();
  await expect(panel()).toBeHidden();
  await page.waitForTimeout(SAVED_MS);
  await app.close();

  ({ app, page } = await launch(box));
  await expect(rail()).toBeVisible();
  await expect(panel()).toBeHidden();
  // No agent is connected: the status bar lists none.
  await expect(page.getByTestId("connected-agents")).toHaveCount(0);

  await rail().click();
  await expect(panel()).toBeVisible();
});

test("Ctrl+V pastes the clipboard's text into the terminal once; with no text the program gets its ^V (#743)", async () => {
  test.skip(process.platform === "darwin", "macOS pastes with Cmd+V");
  if (!(await panel().isVisible())) await rail().click();
  await runInTerminal(page, "clear");
  await app.evaluate(({ clipboard }) => clipboard.writeText("echo pasted-once"));
  await page.locator(".terminal-view:not([hidden])").click();
  await page.keyboard.press("Control+v");
  await page.keyboard.press("Enter");
  // The command line and its output: twice, never three or four times.
  await expect.poll(async () => (await terminalText(page)).split("pasted-once").length - 1).toBe(2);

  // The tty's own ^V (quote the next key) is turned off, so `cat -v` shows the one it gets.
  await runInTerminal(page, "stty lnext undef; cat -v");
  // No text on the clipboard, as with a screenshot copied for Claude Code.
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await page.keyboard.press("Control+v");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("^V");
  await page.keyboard.press("Control+c");
});
