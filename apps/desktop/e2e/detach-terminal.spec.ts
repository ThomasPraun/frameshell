import { join } from "node:path";
import { type ElectronApplication, type Locator, type Page, expect, test } from "@playwright/test";
import { isWindows, launch, panelWindow, runInTerminal, sandbox, terminalText } from "./harness.js";

// Detachable panels (ADR 0012), part 2: a terminal tab moves to its own window and back with its shell still
// running and its screen intact (main replays the pty's recent output), and "Ask agent" types into the last focused
// terminal running an agent, in whatever window it is, and flashes its tab.
const box = sandbox("ask");
const FILE = "frameshell.json";
const FAKE_AGENT = join(import.meta.dirname, "fake-agent.mjs");
const MOD: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";
/** Prints `tick <n>` every 150 ms until interrupted. */
const TICKER = `node -e "let i = 0; setInterval(() => console.log('tick ' + i++), 150)"`;

let app: ElectronApplication;
let page: Page;
let agentWindow: Page;

/** Highest `tick <n>` a terminal shows; -1 before the first. */
async function lastTick(target: Page): Promise<number> {
  const ticks = [...(await terminalText(target)).matchAll(/tick (\d+)/g)].map((match) => Number(match[1]));
  return ticks.length > 0 ? Math.max(...ticks) : -1;
}

/** Docked terminal tabs of the project window. */
const tabs = (): Locator => page.getByRole("tablist", { name: "Terminals" }).getByRole("tab");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // The stand-in agent counts as an agent, so the terminal running it is tagged (no detection on Windows).
  ({ app, page } = await launch(box, { env: { FRAMESHELL_AGENT_COMMANDS: "fake-agent=fake" } }));
});

test.afterAll(async () => {
  await app?.close();
});

test("a terminal tab moves to its own window still running, with its screen, and docks back", async () => {
  await runInTerminal(page, `node -e "console.log('mark' + 'er-' + 42)"`);
  await expect.poll(() => terminalText(page)).toContain("marker-42");
  await runInTerminal(page, TICKER);
  await expect.poll(() => lastTick(page), { timeout: 15_000 }).toBeGreaterThan(2);

  const opened = panelWindow(app, "terminal");
  await page.getByTestId("terminal-detach").click();
  const child = await opened;
  await expect(page.getByTestId("panel-docked-elsewhere")).toContainText("Terminal");
  await expect(page.getByTestId("terminal-view")).toHaveCount(0);
  await expect(tabs()).toHaveClass(/is-detached/);
  await expect(child).toHaveTitle(/ 1 — Ask$/);
  // The screen before the move came along, and the shell kept running: ticks go on.
  await expect.poll(() => terminalText(child)).toContain("marker-42");
  const moved = await lastTick(child);
  await expect.poll(() => lastTick(child), { timeout: 10_000 }).toBeGreaterThan(moved + 3);

  // Keys typed in the window reach the shell.
  await child.locator(".terminal-view").click();
  await child.keyboard.press("Control+c");
  await runInTerminal(child, `node -e "console.log('in-' + 'window')"`);
  await expect.poll(() => terminalText(child)).toContain("in-window");

  // Closing the window docks the tab back, screen intact.
  await child.close();
  await expect(page.getByTestId("panel-docked-elsewhere")).toHaveCount(0);
  await expect.poll(() => terminalText(page)).toContain("in-window");
  expect(await terminalText(page)).toContain("marker-42");
  await expect(tabs()).not.toHaveClass(/is-detached/);
});

test("Ask agent from the detached preview types into the last focused terminal, in its own window, and flashes its tab", async () => {
  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(tabs()).toHaveCount(2);
  await runInTerminal(page, `node "${FAKE_AGENT}"`);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("fake-agent ready");
  const opened = panelWindow(app, "terminal");
  await page.getByTestId("terminal-detach").click();
  agentWindow = await opened;
  await expect.poll(() => terminalText(agentWindow)).toContain("fake-agent ready");
  await agentWindow.locator(".terminal-view").click();

  // Pick a file without opening it, then ask from the preview's own window.
  await page.getByRole("treeitem", { name: FILE }).getByRole("button").click({ modifiers: [MOD] });
  await expect(page.getByRole("treeitem", { name: FILE }).getByRole("button")).toHaveAttribute("data-picked", "true");
  const previewOpened = panelWindow(app, "preview");
  await page.getByTestId("preview-detach").click();
  const preview = await previewOpened;
  await preview.locator(".preview-stage").click({ position: { x: 4, y: 4 } });
  await preview.keyboard.press(`${MOD}+l`);

  await expect.poll(() => terminalText(agentWindow)).toContain(FILE);
  expect(await terminalText(agentWindow)).not.toContain("SUBMITTED");
  await expect(agentWindow.locator(".terminal-window-title")).toHaveAttribute("data-flashing", "true");
  await expect(tabs().nth(1)).toHaveAttribute("data-flashing", "true");
  // The docked shell got nothing.
  await tabs().first().click();
  expect(await terminalText(page)).not.toContain(FILE);
  await preview.close();
});

test("Ask agent prefers the terminal running an agent over a shell focused later", async () => {
  test.skip(isWindows, "Agents are not detected on Windows: the target is the last focused terminal");
  await expect(tabs().nth(1)).toHaveAttribute("data-agent", "fake", { timeout: 15_000 });
  const before = (await terminalText(agentWindow)).split(FILE).length;
  // The docked shell has the focus now; the selection is still the file.
  await page.locator(".terminal-view:not([hidden])").click();
  await page.getByRole("treeitem", { name: FILE }).getByRole("button").focus();
  await page.keyboard.press(`${MOD}+l`);
  await expect.poll(async () => (await terminalText(agentWindow)).split(FILE).length).toBeGreaterThan(before);
  expect(await terminalText(page)).not.toContain(FILE);
});

test("closing a detached tab from the tab strip closes its window and its shell", async () => {
  const closed = agentWindow.waitForEvent("close");
  await tabs().nth(1).getByRole("button", { name: "Close terminal" }).click();
  await closed;
  await expect(tabs()).toHaveCount(1);
  await expect(page.getByTestId("terminal-view")).toHaveCount(1);
});
