import { type ElectronApplication, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// #740: File > New Video from an Idea… and Help > Welcome Screen reach the welcome screen from a project window,
// in a new window, the idea form already open for the first.
const box = sandbox("demo");

let app: ElectronApplication;

test.afterAll(async () => {
  await app?.close();
});

const click = (id: string) => app.evaluate(({ Menu }, item) => Menu.getApplicationMenu()?.getMenuItemById(item)?.click(), id);

test("File > New Video from an Idea… opens the idea form in a new window; Help > Welcome Screen reuses it", async () => {
  let page;
  ({ app, page } = await launch(box));
  await expect(page.getByRole("tab", { name: "Explorer" })).toBeVisible();

  const opened = app.waitForEvent("window");
  await click("new-from-idea");
  const welcome = await opened;
  await expect(welcome.getByRole("form", { name: "New video from an idea" })).toBeVisible();

  // A welcome window with nothing pending is reused.
  await welcome.getByRole("button", { name: "Cancel" }).click();
  await click("help-welcome");
  await welcome.waitForTimeout(300);
  expect(app.windows().length).toBe(2);
  await expect(welcome.getByRole("button", { name: "New from video, audio or image…" })).toBeVisible();
});
