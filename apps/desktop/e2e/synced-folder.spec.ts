import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { isWindows, launch, sandbox } from "./harness.js";

// A project inside a synced folder (#187): Dropbox's info.json under a fake home says the sandbox is Dropbox. Windows
// reads it from APPDATA, which the app needs for itself: detection there is covered by core's unit tests.
const box = sandbox("demo");
const home = join(dirname(box.projectDir), "home");
mkdirSync(join(home, ".dropbox"), { recursive: true });
writeFileSync(join(home, ".dropbox", "info.json"), JSON.stringify({ personal: { path: dirname(box.projectDir) } }));

test("a project in a synced folder warns until dismissed for good", async () => {
  test.skip(isWindows, "Dropbox's info.json lives under APPDATA on Windows");
  const env = { HOME: home };
  const first = await launch(box, { env });
  try {
    const warning = first.page.locator(".sync-warning");
    await expect(warning).toContainText("This project is in your Dropbox folder.");
    await warning.getByRole("button", { name: "Don't show again for this project" }).click();
    await expect(warning).toHaveCount(0);
    expect(JSON.parse(readFileSync(join(box.configDir, "sync-warnings-dismissed.json"), "utf8"))).toEqual([box.projectDir]);
  } finally {
    await first.app.close();
  }
  const second = await launch(box, { env });
  try {
    await expect(second.page.locator(".titlebar-project")).toHaveText("Smoke demo");
    await expect(second.page.locator(".sync-warning")).toHaveCount(0);
  } finally {
    await second.app.close();
  }
});
