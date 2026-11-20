import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// #736: at the default sidebar width not every view tab fits. The strip says there are more and a menu reaches them;
// the active tab stays in sight; the sidebar keeps its width when hidden and shown again.
const box = sandbox("demo");
const MOD: "Meta" | "Control" = process.platform === "darwin" ? "Meta" : "Control";

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

test("a narrow tab strip offers the views out of sight in a menu, and the active tab scrolls into view", async () => {
  const more = page.getByTestId("sidebar-more-views");
  await expect(more).toBeVisible();
  await more.click();
  const item = page.getByRole("menuitem", { name: "Teleprompter" });
  await expect(item).toBeVisible();
  await item.click();
  const tab = page.getByRole("tab", { name: "Teleprompter" });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toBeInViewport({ ratio: 0.9 });
  // Now the first tabs are the ones out of sight, and the menu offers them.
  await more.click();
  await page.getByRole("menuitem", { name: "Explorer" }).click();
  await expect(page.getByRole("tab", { name: "Explorer" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Explorer" })).toBeInViewport({ ratio: 0.9 });
});

test("the sidebar keeps its width when hidden and shown again", async () => {
  const sidebar = page.locator('[data-panel="sidebar"]');
  const splitter = page.getByRole("separator", { name: "Resize sidebar" });
  const box = (await splitter.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const wide = (await sidebar.boundingBox())!.width;
  expect(wide).toBeGreaterThan(350);
  await page.keyboard.press(`${MOD}+B`);
  await expect(sidebar).toBeHidden();
  await page.keyboard.press(`${MOD}+B`);
  await expect(sidebar).toBeVisible();
  expect(Math.abs((await sidebar.boundingBox())!.width - wide)).toBeLessThan(2);
});
