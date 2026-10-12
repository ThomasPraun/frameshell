import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { launch, panelWindow, sandbox } from "./harness.js";

// Detachable panels (ADR 0012), part 3: the timeline, the editor (with every open file, unsaved edits included) and
// each sidebar view move to their own window and back; Cmd/Ctrl+Shift+Enter maximizes the focused panel in place.
const box = sandbox("ask");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  writeFileSync(join(box.projectDir, "notes.md"), "# Notes\n");
  ({ app, page } = await launch(box));
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "0");
});

test.afterAll(async () => {
  await app?.close();
});

test("the timeline moves to its own window, draws there, and docks back", async () => {
  const opened = panelWindow(app, "timeline");
  await page.getByTestId("timeline-detach").click();
  const child = await opened;
  await expect(child.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "0");
  await expect(child.locator("[data-media-drawn]")).toHaveCount(1);
  await expect(page.getByTestId("timeline-lanes")).toHaveCount(0);
  await expect(page.getByTestId("panel-docked-elsewhere")).toContainText("Timeline");
  await expect(child).toHaveTitle(/^Timeline — /);

  const closed = child.waitForEvent("close");
  await child.getByRole("button", { name: "Dock timeline back" }).click();
  await closed;
  await expect(page.getByTestId("timeline-lanes")).toHaveAttribute("data-clips", "0");
  await expect(page.getByTestId("panel-docked-elsewhere")).toHaveCount(0);
});

test("the editor moves with its files, unsaved edits and all, edits and saves there", async () => {
  await page.getByRole("treeitem", { name: "notes.md" }).getByRole("button").click();
  const editor = page.locator(".editor-host .monaco-editor");
  await expect(editor).toBeVisible();
  await editor.locator(".view-lines").click();
  await page.keyboard.type("alpha");
  await expect(page.getByRole("button", { name: "Close notes.md (unsaved)" })).toBeVisible();

  const opened = panelWindow(app, "editor");
  await page.getByTestId("editor-detach").click();
  const child = await opened;
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await expect(page.getByTestId("panel-docked-elsewhere")).toContainText("Editor");
  // Same model: still dirty in the new window.
  await expect(child.getByRole("button", { name: "Close notes.md (unsaved)" })).toBeVisible();
  const moved = child.locator(".editor-host .monaco-editor");
  await expect(moved).toBeVisible();

  // Typing and saving work in the editor's own window.
  await moved.locator(".view-lines").click();
  await child.keyboard.type("beta");
  await child.keyboard.press(`${MOD}+s`);
  await expect(child.getByRole("button", { name: "Close notes.md", exact: true })).toBeVisible();
  const saved = () => readFileSync(join(box.projectDir, "notes.md"), "utf8");
  await expect.poll(saved).toContain("alpha");
  expect(saved()).toContain("beta");

  await child.close();
  await expect(page.locator(".editor-host .monaco-editor")).toBeVisible();
  await expect(page.getByRole("tab", { name: "notes.md" })).toHaveAttribute("aria-selected", "true");
});

test("a sidebar view moves alone; the others stay docked", async () => {
  await page.getByRole("tab", { name: "Explorer" }).click();
  const opened = panelWindow(app, "explorer");
  await page.getByTestId("sidebar-detach").click();
  const child = await opened;
  await expect(page.getByTestId("panel-docked-elsewhere")).toContainText("Explorer");
  await expect(page.getByRole("tab", { name: "Explorer" })).toHaveClass(/is-detached/);
  // History still shows in the sidebar.
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByTestId("panel-docked-elsewhere")).toHaveCount(0);

  // A file opened from the explorer's window opens in the project window's editor.
  await child.getByRole("treeitem", { name: "timelines/main.json" }).getByRole("button").click();
  await expect(page.getByRole("tab", { name: "timelines/main.json" })).toHaveAttribute("aria-selected", "true");

  await child.close();
  await page.getByRole("tab", { name: "Explorer" }).click();
  await expect(page.getByRole("treeitem", { name: "frameshell.json" })).toBeVisible();
});

test("Cmd/Ctrl+Shift+Enter maximizes the focused panel in place, and restores", async () => {
  const workspace = page.locator(".workspace");
  await page.getByTestId("timeline-lanes").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await expect(workspace).toHaveAttribute("data-maximized", "timeline");
  await expect(page.locator(".terminal-panel")).toBeHidden();
  await expect(page.locator(".panel.preview")).toBeHidden();
  // Hidden, not unmounted: the shell keeps running.
  await expect(page.getByTestId("terminal-view")).toHaveCount(1);
  const height = (await page.locator(".panel.timeline").boundingBox())?.height ?? 0;
  expect(height).toBeGreaterThan(500);

  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await expect(workspace).not.toHaveAttribute("data-maximized");
  await expect(page.locator(".terminal-panel")).toBeVisible();

  await page.getByTestId("terminal-view").click();
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await expect(workspace).toHaveAttribute("data-maximized", "terminal");
  await expect(page.locator(".panel.timeline")).toBeHidden();
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await expect(workspace).not.toHaveAttribute("data-maximized");
});

test("a project reopens with its detached views in their windows", async () => {
  await page.getByRole("tab", { name: "History" }).click();
  const opened = panelWindow(app, "history");
  await page.getByTestId("sidebar-detach").click();
  await opened;
  await expect.poll(() => readFileSync(join(box.configDir, "panel-windows.json"), "utf8")).toContain('"history"');
  await app.close();

  ({ app, page } = await launch(box));
  const child = await panelWindow(app, "history");
  await expect(child.getByText("History", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "History" })).toHaveClass(/is-detached/);
});
