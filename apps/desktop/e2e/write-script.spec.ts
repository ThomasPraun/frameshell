import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// #737: with no shoot script, the teleprompter offers a box to write or paste one. Saved through the daemon as
// `scripts/shoot.md` with `shoot: true`, it is on the teleprompter at once; the project's other script stays as it is.
const box = sandbox("demo");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

test("a script written in the empty teleprompter becomes the shoot script and is read at once", async () => {
  const intro = readFileSync(join(box.projectDir, "scripts", "intro.md"), "utf8");
  await page.getByRole("tab", { name: "Teleprompter" }).click();
  const write = page.getByTestId("write-script");
  await expect(write).toBeVisible();
  await expect(write.getByTestId("write-script-save")).toBeDisabled();
  await write.getByRole("textbox", { name: "Your script" }).fill("Welcome to the show.\n\nToday we build it.");
  await write.getByTestId("write-script-save").click();
  await expect(page.locator(".teleprompter-content .is-current")).toHaveText("Welcome");
  await expect(page.getByTestId("write-script")).toHaveCount(0);
  const saved = readFileSync(join(box.projectDir, "scripts", "shoot.md"), "utf8");
  expect(saved).toContain("shoot: true");
  expect(saved).toContain("## Script\nWelcome to the show.");
  expect(readFileSync(join(box.projectDir, "scripts", "intro.md"), "utf8")).toBe(intro);
});
