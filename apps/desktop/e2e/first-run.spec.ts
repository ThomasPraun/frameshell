import {
  type ElectronApplication,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// The first-run checklist (#787): "Getting started n/4" in the status bar of a video project, a popover of the four
// steps ticked from the project, closed for good per project.
const box = sandbox("demo");

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await app?.close();
});

test("the status bar offers the four steps of a new project, none ticked yet", async () => {
  ({ app, page } = await launch(box, { freshLayout: true }));
  const button = page.getByTestId("first-run");
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toContainText("Getting started");
  await button.click();
  const list = page.getByTestId("first-run-list");
  await expect(list).toBeVisible();
  await expect(list.locator("li")).toHaveCount(4);
  await expect(list.locator('li[data-step="footage"]')).toHaveAttribute(
    "data-done",
    "false",
  );
  await expect(list.locator('li[data-step="export"]')).toHaveAttribute(
    "data-done",
    "false",
  );
  await list
    .locator('li[data-step="connect"]')
    .getByRole("button", { name: "Connect…" })
    .click();
  await expect(page.getByTestId("connect-ai")).toBeVisible();
  await page.getByTestId("connect-ai-close").click();
});

test("closed, it stays closed in that project after a restart", async () => {
  await page.getByTestId("first-run").click();
  await page.getByTestId("first-run-close").click();
  await expect(page.getByTestId("first-run")).toHaveCount(0);
  await app.close();
  ({ app, page } = await launch(box, { freshLayout: true }));
  await expect(page.getByTestId("status-notice")).toBeAttached({
    timeout: 30_000,
  });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("first-run")).toHaveCount(0);
});
