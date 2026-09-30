import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ElectronApplication, type Page, _electron as electron, expect, test } from "@playwright/test";

// Scene <-> clip linking (SPEC §5.5) in the built app: real daemon, fixture timeline with scriptRefs.
const packagedApp = process.env["FRAMESHELL_E2E_APP"];
const mainEntry = join(import.meta.dirname, "..", "out", "main", "index.js");
const fixture = join(import.meta.dirname, "fixtures", "scripted");
const isWindows = process.platform === "win32";

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "fs-e2e-script-")));
const projectDir = join(workDir, "scripted");
const socketPath = isWindows ? `\\\\.\\pipe\\frameshell-e2e-${randomUUID().slice(0, 8)}` : join(workDir, "d.sock");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  cpSync(fixture, projectDir, { recursive: true });
  app = await electron.launch({
    ...(packagedApp ? { executablePath: packagedApp } : {}),
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), ...(packagedApp ? [] : [mainEntry]), "--project", projectDir],
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_DATA_DIR: join(workDir, "data"),
      FRAMESHELL_CONFIG_DIR: join(workDir, "config"),
      FRAMESHELL_IDLE_TIMEOUT_MS: "3000",
    },
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[renderer] ${message.text()}`);
  });
});

test.afterAll(async () => {
  await app?.close();
});

const clip = (id: string) => page.getByRole("button", { name: `Clip ${id}`, exact: true });
const line = (text: string) => page.locator(".editor-host .view-line", { hasText: text });

test("opens the script with scenes without clips flagged in the gutter", async () => {
  await expect(clip("c_intro")).toBeVisible();
  await page.getByRole("treeitem", { name: "scripts/launch.md", exact: true }).locator("button").first().click();
  await expect(line("## Outro")).toBeVisible();
  await expect(page.locator(".editor-host .scene-glyph-linked")).toHaveCount(2);
  await expect(page.locator(".editor-host .scene-glyph-unlinked")).toHaveCount(1);
  const flag = (await page.locator(".editor-host .scene-glyph-unlinked").boundingBox())!;
  const outro = (await line("## Outro").boundingBox())!;
  expect(Math.abs(flag.y - outro.y)).toBeLessThan(2);
});

test("selecting a clip highlights its scene in the open script", async () => {
  await clip("c_intro").click();
  await expect(clip("c_intro")).toHaveAttribute("aria-pressed", "true");
  const heading = page.locator(".editor-host .scene-heading-selected");
  await expect(heading).toHaveCount(1);
  const intro = (await line("## Intro").boundingBox())!;
  expect(Math.abs((await heading.boundingBox())!.y - intro.y)).toBeLessThan(2);});

test("clicking a scene heading selects its clips", async () => {
  await line("## Demo").click();
  await expect(clip("c_demo")).toHaveAttribute("aria-pressed", "true");
  await expect(clip("c_intro")).toHaveAttribute("aria-pressed", "false");
  const demo = (await line("## Demo").boundingBox())!;
  await expect.poll(async () => Math.abs((await page.locator(".editor-host .scene-heading-selected").boundingBox())!.y - demo.y)).toBeLessThan(2);
});

test("linking a clip on disk clears the scene's flag live", async () => {
  const path = join(projectDir, "timelines", "main.json");
  const timeline = JSON.parse(readFileSync(path, "utf8"));
  timeline.tracks[0].clips[2].scriptRef = "scripts/launch.md#outro";
  timeline.revision += 1;
  writeFileSync(path, JSON.stringify(timeline, null, 2));
  await expect(page.locator(".editor-host .scene-glyph-unlinked")).toHaveCount(0);
  await expect(page.locator(".editor-host .scene-glyph-linked")).toHaveCount(3);
  await line("## Outro").click();
  await expect(clip("c_spare")).toHaveAttribute("aria-pressed", "true");
});
