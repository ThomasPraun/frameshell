import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// #737: the Shoot view keeps the picked microphone and screen when another view shows for a while (the devices are
// freed, the choices kept), and View > Shoot / View > Teleprompter reach those views from a hidden sidebar.
const box = sandbox("multicam");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ app, page } = await launch(box, { args: ["--use-fake-device-for-media-stream"], env: { FRAMESHELL_SHOOT_STAND_IN: "1" } }));
  await expect(page.getByRole("tab", { name: "Explorer" })).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

const menu = (id: string) =>
  app.evaluate(({ BrowserWindow, Menu }, item) => Menu.getApplicationMenu()?.getMenuItemById(item)?.click(undefined, BrowserWindow.getAllWindows()[0]), id);

test("View > Shoot opens the Shoot view from a hidden sidebar", async () => {
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await menu("view-shoot");
  await expect(page.getByTestId("shoot-panel")).toBeVisible();
  await menu("view-teleprompter");
  await expect(page.getByTestId("teleprompter")).toBeVisible();
});

test("the picked microphone and screen survive another view showing for a while", async () => {
  await menu("view-shoot");
  const panel = page.getByTestId("shoot-panel");
  const allow = panel.getByRole("button", { name: "Allow camera and microphone" });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  const mic = page.getByTestId("shoot-mic");
  await expect(mic).not.toHaveValue("");
  const picked = await mic.locator("option").last().getAttribute("value");
  await mic.selectOption(picked!);
  await page.getByTestId("shoot-screen-choose").click();
  await page.getByTestId("shoot-screen-option").filter({ hasText: "Stand-in screen" }).click();
  await expect.poll(() => page.getByTestId("shoot-screen-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);

  // Long enough for the devices to be freed (a second after the last view goes).
  await page.getByRole("tab", { name: "History" }).click();
  await page.waitForTimeout(1_800);
  await menu("view-shoot");
  await expect(mic).toHaveValue(picked!);
  await expect.poll(() => page.getByTestId("shoot-screen-preview").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId("shoot-start")).toBeEnabled();
});
