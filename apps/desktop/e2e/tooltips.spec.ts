import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";

// The app's one tooltip (#409): hover or keyboard focus shows what a control does and its shortcut, Escape hides it,
// and a detached panel (ADR 0012) shows it in its own window.
const box = sandbox("ask");
const SIDEBAR_KEY = process.platform === "darwin" ? "⌘B" : "Ctrl+B";

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "0");
});

test.afterAll(async () => {
  await app?.close();
});

test("hovering a control shows its tooltip with the shortcut, leaving hides it", async () => {
  const tooltip = page.getByRole("tooltip").and(page.getByTestId("tooltip"));
  const hide = page.getByRole("button", { name: "Hide sidebar" });
  await hide.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Hide sidebar");
  await expect(tooltip.locator("kbd")).toHaveText(SIDEBAR_KEY);

  await page.getByTestId("timeline-lanes").hover();
  await expect(tooltip).toHaveCount(0);
});

test("keyboard focus shows the tooltip at once, Escape hides it and keeps the focus", async () => {
  const tooltip = page.getByTestId("tooltip");
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  await zoomIn.focus();
  await expect(tooltip).toHaveText("Zoom in (+)");
  await expect(zoomIn).toHaveAttribute("aria-describedby", "frameshell-tooltip");

  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(zoomIn).toBeFocused();
  await expect(zoomIn).not.toHaveAttribute("aria-describedby", "frameshell-tooltip");
});

test("a detached panel shows tooltips in its own window", async () => {
  const opened = panelWindow(app, "timeline");
  await page.getByTestId("timeline-detach").click();
  const child = await opened;
  const zoomOut = child.getByRole("button", { name: "Zoom out", exact: true });
  await expect(zoomOut).toBeVisible();

  await zoomOut.hover();
  await expect(child.getByTestId("tooltip")).toHaveText("Zoom out (-)");
  await expect(page.getByTestId("tooltip")).toHaveCount(0);

  await child.getByTestId("timeline-lanes").hover();
  await expect(child.getByTestId("tooltip")).toHaveCount(0);

  const zoomFit = child.getByRole("button", { name: "Zoom to fit", exact: true });
  await zoomFit.focus();
  await expect(child.getByTestId("tooltip")).toHaveText("Zoom to fit (0)");
  await child.keyboard.press("Escape");
  await expect(child.getByTestId("tooltip")).toHaveCount(0);

  const closed = child.waitForEvent("close");
  await child.getByRole("button", { name: "Dock timeline back" }).click();
  await closed;
});
