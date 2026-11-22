import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, runInTerminal, sandbox, terminalText } from "./harness.js";

// The terminal is an optional extra: a new project opens with it folded behind a labelled rail, no shell runs until
// it is first shown, and anything that needs a terminal shows it. A project that had it open keeps it open.
const box = sandbox("demo");
const other = sandbox("demo");
const FILE = "scripts/intro.md";
/** Layout is saved 300 ms after the last change. */
const SAVED_MS = 1_200;

let app: ElectronApplication;
let page: Page;

const panel = () => page.locator('[data-panel="terminal"]');
const rail = () => page.getByRole("button", { name: "Show terminal" });

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await app?.close();
});

test("a new project folds the terminal behind a rail that names it, and starts no shell", async () => {
  ({ app, page } = await launch(box, { freshLayout: true }));
  await expect(panel()).toBeHidden();
  await expect(rail()).toBeVisible();
  await expect(rail()).toContainText("Terminal");
  await expect(rail().locator("svg.terminal-mark")).toBeVisible();
  await expect(page.locator(".terminal-view")).toHaveCount(0);
  await expect(page.getByTestId("agent-guide")).toHaveCount(0);
  await expect(page.getByTestId("active-session")).toHaveCount(0);
});

test("one click on the rail opens it and a shell starts; folding it again keeps the shell", async () => {
  await rail().click();
  await expect(panel()).toBeVisible();
  await expect(page.getByTestId("active-session")).toBeVisible({ timeout: 30_000 });
  const session = await page.getByTestId("active-session").innerText();
  await runInTerminal(page, "echo opened-once");
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain("opened-once");

  await page.getByRole("button", { name: "Hide terminal" }).click();
  await expect(panel()).toBeHidden();
  await rail().click();
  await expect(page.getByTestId("active-session")).toHaveText(session);
  expect(await terminalText(page)).toContain("opened-once");
});

test("a project whose terminal was opened keeps it open on the next start", async () => {
  await page.waitForTimeout(SAVED_MS);
  await app.close();
  ({ app, page } = await launch(box, { freshLayout: true }));
  await expect(panel()).toBeVisible();
  await expect(rail()).toHaveCount(0);
  await app.close();
});

test("Chat about this with no agent and the terminal folded copies the reference and opens Connect your AI (#791)", async () => {
  ({ app, page } = await launch(other, { freshLayout: true }));
  await expect(panel()).toBeHidden();
  const file = page.getByRole("treeitem", { name: FILE, exact: true });
  const folder = page.getByRole("treeitem", { name: "scripts", exact: true }).getByRole("button").first();
  await expect(folder).toBeVisible();
  if ((await file.count()) === 0) await folder.click();
  await file.getByRole("button").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Chat about this/ }).click();
  await expect(page.getByTestId("connect-ai")).toBeVisible();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`[frameshell] file ${FILE}`);
  await expect(panel()).toBeHidden();
  await expect(page.locator(".terminal-view")).toHaveCount(0);
});

test("with the terminal shown, Chat about this with no agent copies the reference and says to start one (ADR 0048)", async () => {
  await page.getByTestId("connect-ai-close").click();
  await expect(page.getByTestId("connect-ai")).toBeHidden();
  await rail().click();
  await expect(panel()).toBeVisible();
  await expect(page.getByTestId("active-session")).toBeVisible({ timeout: 30_000 });
  await app.evaluate(({ clipboard }) => clipboard.writeText(""));
  const file = page.getByRole("treeitem", { name: FILE, exact: true });
  await file.getByRole("button").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Chat about this/ }).click();
  await expect(page.getByTestId("status-notice")).toHaveText("No agent is running: the reference is on the clipboard. Start one in the terminal, then paste it.");
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain(`[frameshell] file ${FILE}`);
  await expect(page.getByTestId("connect-ai")).toBeHidden();
  // Never typed at a bare shell prompt, where Enter would run it.
  expect(await terminalText(page)).not.toContain("[frameshell]");
});
