import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// Recent projects on the welcome screen (#418): right-click offers Open, Reveal and Remove from Recent. Reveal is
// stubbed in main and only takes folders of the recent list; Remove leaves the folder on disk.
const box = sandbox("demo");
const recentFile = join(box.dataDir, "desktop", "recent.json");
const gone = join(box.projectDir, "..", "old-cut");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  mkdirSync(join(box.dataDir, "desktop"), { recursive: true });
  writeFileSync(recentFile, JSON.stringify([gone, box.projectDir]));
  // A folder with no project: the window shows the welcome screen.
  const empty = join(box.projectDir, "..", "empty");
  mkdirSync(empty, { recursive: true });
  ({ app, page } = await launch({ ...box, projectDir: empty }));
  await app.evaluate(({ shell }) => {
    const revealed: string[] = [];
    (globalThis as { revealed?: string[] }).revealed = revealed;
    shell.showItemInFolder = (path: string) => void revealed.push(path);
  });
});

test.afterAll(async () => {
  await app?.close();
});

const recent = () => page.getByRole("region", { name: "Recent projects" }).getByRole("button");
const menu = () => page.getByRole("menu");

test("a recent project's menu reveals its folder and removes it from the list", async () => {
  await expect(recent()).toHaveCount(2);
  await recent().filter({ hasText: "old-cut" }).click({ button: "right" });
  await expect(menu().getByRole("menuitem")).toHaveText(["Open", /Finder|File Explorer|file manager/, "Remove from Recent"]);
  await expect(menu().getByRole("separator")).toHaveCount(2);

  await menu().getByRole("menuitem", { name: /Finder|File Explorer|file manager/ }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { revealed?: string[] }).revealed)).toEqual([gone]);

  await recent().filter({ hasText: "old-cut" }).click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Remove from Recent" }).click();
  await expect(recent()).toHaveCount(1);
  expect(JSON.parse(readFileSync(recentFile, "utf8"))).toEqual([box.projectDir]);
});

test("Open from the menu opens the project", async () => {
  await recent().first().click({ button: "right" });
  await menu().getByRole("menuitem", { name: "Open" }).click();
  await expect(page.getByTestId("timeline-lanes")).toBeVisible({ timeout: 30_000 });
});
