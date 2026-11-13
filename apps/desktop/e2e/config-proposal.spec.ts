import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { laidOutBox, launch, sandbox } from "./harness.js";

// Project-config changes in review mode (ADR 0036) in the built app: an agent's format change and a hand edit of
// style.json wait behind the proposal bar as text lines; Accept writes them, History lists them with the project
// mark, and Revert there undoes the format. The agent is the CLI the test runs; real daemon.
const box = sandbox("history");
const configFile = join(box.projectDir, "frameshell.json");
const styleFile = join(box.projectDir, "style.json");
const cliBin = join(import.meta.dirname, "..", "..", "..", "packages", "cli", "dist", "bin", "frameshell.js");
const run = promisify(execFile);

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launch(box));
});

test.afterAll(async () => {
  await app?.close();
});

/** One `frameshell` command as the agent session `claude`. */
async function agent(...args: string[]): Promise<void> {
  await run(process.execPath, [cliBin, ...args], {
    cwd: box.projectDir,
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: box.socketPath,
      FRAMESHELL_DATA_DIR: box.dataDir,
      FRAMESHELL_CONFIG_DIR: box.configDir,
      FRAMESHELL_SESSION: "config-agent",
      FRAMESHELL_AGENT: "claude",
    },
    timeout: 60_000,
  });
}

const bar = () => page.getByRole("region", { name: "Agent proposal" });
const rows = () => page.locator(".history > .history-item");
const row = (title: string) => rows().filter({ has: page.locator(".history-title", { hasText: title }) });
const formatIds = (): string[] => ((JSON.parse(readFileSync(configFile, "utf8")) as { formats?: { id: string }[] }).formats ?? []).map((format) => format.id);

/** style.json as written now; empty when there is no file. */
const styleText = (): string => (existsSync(styleFile) ? readFileSync(styleFile, "utf8") : "");

async function click(locator: ReturnType<Page["locator"]>): Promise<void> {
  const target = await laidOutBox(locator);
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
}

test("review mode on: an agent's format change waits as a text line in the bar", async () => {
  await click(page.getByRole("tab", { name: "History" }));
  await page.getByLabel("Review agent changes before applying").check();
  await expect(page.getByLabel("Review agent changes before applying")).toBeChecked();

  await agent("tx", "begin", "Vertical cut");
  await agent("format", "add", "9x16");
  await agent("tx", "commit");
  await expect(bar()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(bar()).toContainText("Vertical cut");
  await expect(bar()).toContainText("Formats: + 9x16 (1080x1920)");
  // Nothing reached the file.
  expect(formatIds()).toEqual([]);
});

test("Accept writes the format; History lists it with the project mark", async () => {
  await bar().getByRole("button", { name: "Accept" }).click();
  await expect(bar()).toHaveCount(0);
  await expect.poll(formatIds).toEqual(["16x9", "9x16"]);
  const vertical = row("Vertical cut");
  await expect(vertical).toHaveCount(1, { timeout: 30_000 });
  await expect(vertical.locator(".history-config")).toHaveText("project");
  await expect(vertical.locator(".history-count")).toHaveText("1 op");
});

test("a hand edit of style.json waits as a proposal of File, with its value in the bar; Reject puts the file back", async () => {
  writeFileSync(styleFile, `${JSON.stringify({ schemaVersion: 1, platforms: ["tiktok"] })}\n`);
  await expect(bar()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(bar()).toContainText("Style: platforms none → tiktok");
  await expect(bar()).toContainText("Edit style.json");
  // The proposal holds it: the file is back to no style.
  await expect.poll(styleText, { timeout: 30_000 }).toBe("");

  await bar().getByRole("button", { name: "Reject" }).click();
  await expect(bar()).toHaveCount(0);
  expect(styleText()).toBe("");
});

test("a hand edit that removes the format waits too; Accept lists it by its label, and Revert from History brings the format back", async () => {
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  const { formats: _formats, ...rest } = config;
  writeFileSync(configFile, `${JSON.stringify(rest, null, 2)}\n`);
  await expect(bar()).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(bar()).toContainText("Formats: − 9x16");
  await expect.poll(formatIds).toEqual(["16x9", "9x16"]);

  await bar().getByRole("button", { name: "Accept" }).click();
  await expect(bar()).toHaveCount(0);
  await expect.poll(formatIds).toEqual([]);
  const edit = row("Edit frameshell.json");
  await expect(edit).toHaveCount(1, { timeout: 30_000 });
  await expect(edit.locator(".history-author")).toHaveText("File");
  await expect(edit.locator(".history-config")).toHaveText("project");

  // Your own revert applies at once, even in review mode.
  await edit.getByRole("button", { name: /^Revert tx_/ }).click();
  await expect.poll(formatIds, { timeout: 30_000 }).toEqual(["16x9", "9x16"]);
  await expect(bar()).toHaveCount(0);
});
