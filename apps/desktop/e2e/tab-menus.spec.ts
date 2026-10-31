import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Right-click menus on editor and terminal tabs (#419): close one, the others or all; rename, detach, add or close a
// terminal.
const box = sandbox("demo");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

const menu = () => page.getByRole("menu");
const fileTabs = () => page.getByRole("tablist", { name: "Open files" }).getByRole("tab");
const terminalTabs = () => page.getByRole("tablist", { name: "Terminals" }).getByRole("tab");

test("an editor tab's menu closes the other tabs and offers the file commands", async () => {
  await page.getByRole("treeitem", { name: "scripts/intro.md" }).getByRole("button").click();
  await page.getByRole("treeitem", { name: "frameshell.json" }).getByRole("button").click();
  await expect(fileTabs()).toHaveCount(2);
  await fileTabs().filter({ hasText: "intro.md" }).click({ button: "right" });
  await expect(menu().getByRole("menuitem")).toHaveText(["Close", "Close others", "Close all", /Finder|File Explorer|file manager/, "Copy path"]);
  await menu().getByRole("menuitem", { name: "Close others" }).click();
  await expect(fileTabs()).toHaveText(["intro.md"]);

  await fileTabs().first().click({ button: "right" });
  await expect(menu().getByRole("menuitem", { name: "Close others" })).toBeDisabled();
  await menu().getByRole("menuitem", { name: "Close all" }).click();
  await expect(fileTabs()).toHaveCount(0);
});

test("a terminal tab's menu renames it, adds a terminal and closes one", async () => {
  await expect(terminalTabs()).toHaveCount(1);
  await terminalTabs().first().click({ button: "right" });
  await expect(menu().getByRole("menuitem")).toHaveText(["Rename terminal", "Open terminal in its own window", "New terminal", "Close terminal"]);
  await menu().getByRole("menuitem", { name: "Rename terminal" }).click();
  const input = page.getByTestId("terminal-rename-input");
  await expect(input).toBeFocused();
  await input.fill("Editing agent");
  await input.press("Enter");
  await expect(terminalTabs().first()).toHaveText("Editing agent");

  await terminalTabs().first().click({ button: "right" });
  await menu().getByRole("menuitem", { name: "New terminal" }).click();
  await expect(terminalTabs()).toHaveCount(2);
  await terminalTabs().nth(1).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Close terminal" }).click();
  await expect(terminalTabs()).toHaveText(["Editing agent"]);
});
