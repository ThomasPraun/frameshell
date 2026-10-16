import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, runInTerminal, sandbox } from "./harness.js";

// Update check (#193): checking and installing need a packaged release and a real GitHub release (docs/release.md);
// this covers the opt-out, a user decision kept in configDir.
const box = sandbox("demo");

test("the automatic update check is on by default and its menu checkbox opts out", async () => {
  const { app, page } = await launch(box);
  try {
    await expect(page.locator(".update-banner")).toHaveCount(0);
    const item = () =>
      app.evaluate(({ Menu }) => {
        const found = Menu.getApplicationMenu()?.getMenuItemById("auto-updates");
        return found ? { checked: found.checked, check: Boolean(Menu.getApplicationMenu()?.getMenuItemById("check-updates")) } : null;
      });
    expect(await item()).toEqual({ checked: true, check: true });
    const file = join(box.configDir, "updates.json");
    expect(existsSync(file)).toBe(false);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("auto-updates")?.click());
    await expect.poll(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8"))).toEqual({ automatic: false });
    expect((await item())?.checked).toBe(false);
    // Close once the terminal's shell is up: a quit while it starts can hang the close.
    await runInTerminal(page, "echo ok");
  } finally {
    await app.close();
  }
});
