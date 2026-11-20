import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// "Connect your AI": opened from the welcome card and the project window's title bar, desktop apps first. The apps'
// settings live under FRAMESHELL_TEST_HOME, so nothing of the real user's Claude, ChatGPT or Codex setup is touched.
const box = sandbox("demo");
const home = join(box.dataDir, "ai-home");
/** Claude Desktop exists on macOS and Windows only. */
const claudeDesktop = process.platform !== "linux";
const claudeDir = process.platform === "win32" ? join(home, "AppData", "Roaming", "Claude") : join(home, "Library", "Application Support", "Claude");
const claudeConfig = join(claudeDir, "claude_desktop_config.json");
const codexConfig = join(home, ".codex", "config.toml");
const env = { FRAMESHELL_TEST_HOME: home };

const panel = (page: Page) => page.getByTestId("connect-ai");
const card = (page: Page, row: string) => panel(page).locator(`[data-row="${row}"]`);

test.beforeAll(() => {
  // The apps are installed (their settings folders exist) but not connected.
  if (claudeDesktop) mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
});

test("the welcome card connects Claude Desktop and the ChatGPT desktop app", async () => {
  const empty = join(box.projectDir, "..", "empty");
  mkdirSync(empty, { recursive: true });
  const { app, page } = await launch({ ...box, projectDir: empty }, { env });
  try {
    await page.getByTestId("welcome-connect").getByRole("button", { name: "Connect your AI" }).click();
    await expect(panel(page).getByRole("heading", { name: "Connect your AI" })).toBeVisible();

    // Desktop apps are the first cards, before the developer group.
    const rows = await panel(page).getByTestId("connect-ai-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-row")));
    expect(rows).toEqual(["claude-desktop", "chatgpt", "claude-code", "codex-cli", "gemini", "others"]);
    await expect(card(page, "chatgpt")).toContainText("ChatGPT on the web is not supported");
    await expect(card(page, "claude-code")).toHaveAttribute("data-state", "not-installed");

    if (claudeDesktop) {
      await card(page, "claude-desktop").getByRole("button", { name: "Connect" }).click();
      await expect(card(page, "claude-desktop")).toHaveAttribute("data-state", "connected");
      await expect(card(page, "claude-desktop").getByTestId("connect-ai-restart")).toHaveText("Done. Quit and reopen Claude Desktop to finish.");
      expect(JSON.parse(readFileSync(claudeConfig, "utf8")).mcpServers.frameshell.args).toContain("mcp");
    } else {
      await expect(card(page, "claude-desktop")).toHaveAttribute("data-state", "unavailable");
    }

    await card(page, "chatgpt").getByRole("button", { name: "Connect" }).click();
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "connected");
    // Codex CLI reads the same file: one state.
    await expect(card(page, "codex-cli")).toHaveAttribute("data-state", "connected");
    expect(readFileSync(codexConfig, "utf8")).toContain("[mcp_servers.frameshell]");

    await panel(page).getByRole("button", { name: "Close" }).click();
    await expect(panel(page)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("the title bar button opens the same panel in a project, where Disconnect removes the entries", async () => {
  const { app, page } = await launch(box, { env });
  try {
    await page.locator(".titlebar").getByRole("button", { name: "Connect your AI" }).click();
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "connected");
    await expect(panel(page).getByTestId("connect-ai-desktop")).toBeVisible();

    if (claudeDesktop) {
      await card(page, "claude-desktop").getByRole("button", { name: "Disconnect" }).click();
      await expect(card(page, "claude-desktop")).toHaveAttribute("data-state", "ready");
      expect(JSON.parse(readFileSync(claudeConfig, "utf8")).mcpServers?.frameshell).toBeUndefined();
    }
    await card(page, "codex-cli").getByRole("button", { name: "Disconnect" }).click();
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "ready");
    expect(readFileSync(codexConfig, "utf8")).not.toContain("frameshell");
    expect(existsSync(`${codexConfig}.frameshell-backup`)).toBe(true);

    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
  } finally {
    await app.close();
  }
});
