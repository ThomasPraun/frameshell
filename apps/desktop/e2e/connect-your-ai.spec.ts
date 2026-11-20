import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { launch, sandbox } from "./harness.js";

// "Connect your AI": opened from the welcome card and the project window's title bar, desktop apps first. This spec
// writes the system clipboard, so do not copy anything you need while it runs. The apps'
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

// Open the desktop AI app: the launch is recorded in a file (FRAMESHELL_OPEN_APP_STAND_IN), never started.
const launchLog = join(box.dataDir, "launches.jsonl");
const launches = () =>
  existsSync(launchLog)
    ? readFileSync(launchLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
const chatgptLaunch = process.platform === "win32" ? { file: "powershell.exe" } : process.platform === "darwin" ? { file: "/bin/sh" } : null;
const settingsDir = (root: string) => (process.platform === "win32" ? join(root, "AppData", "Roaming", "Claude") : join(root, "Library", "Application Support", "Claude"));

// The ChatGPT desktop app has no Linux build: Open finds nothing there, which the last test covers.
test("Open starts the connected desktop apps and copies a starter phrase naming the project", async () => {
  test.skip(process.platform === "linux", "no ChatGPT desktop app on Linux");
  const connected = join(box.dataDir, "ai-home-open");
  if (claudeDesktop) mkdirSync(settingsDir(connected), { recursive: true });
  mkdirSync(join(connected, ".codex"), { recursive: true });
  const { app, page } = await launch(box, { env: { FRAMESHELL_TEST_HOME: connected, FRAMESHELL_OPEN_APP_STAND_IN: launchLog } });
  try {
    const project = (await page.locator(".titlebar-project").textContent()) ?? "";
    await page.locator(".titlebar").getByRole("button", { name: "Connect your AI" }).click();

    // Installed but not connected: Connect first, no Open yet.
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "ready");
    await expect(card(page, "chatgpt").getByTestId("connect-ai-launch")).toHaveCount(0);
    await card(page, "chatgpt").getByRole("button", { name: "Connect" }).click();
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "connected");

    await card(page, "chatgpt").getByRole("button", { name: "Open ChatGPT" }).click();
    await expect(card(page, "chatgpt").getByTestId("connect-ai-copied")).toHaveText("Copied: paste it in ChatGPT.");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`Work on my open Frameshell project: ${project}.`);
    expect(launches().at(-1)).toMatchObject({ kind: "command", ...chatgptLaunch });

    if (claudeDesktop) {
      await card(page, "claude-desktop").getByRole("button", { name: "Connect" }).click();
      await expect(card(page, "claude-desktop")).toHaveAttribute("data-state", "connected");
      await card(page, "claude-desktop").getByRole("button", { name: "Open Claude Desktop" }).click();
      await expect(card(page, "claude-desktop").getByTestId("connect-ai-copied")).toHaveText("Copied: paste it in Claude.");
      expect(launches().at(-1)).toEqual({ kind: "url", url: "claude://" });
    }
    // The developer tools have no Open.
    await expect(card(page, "codex-cli").getByTestId("connect-ai-launch")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("an app that looks not installed offers Download to the official page and Open, with a general phrase on the welcome screen", async () => {
  test.skip(process.platform === "linux", "no ChatGPT desktop app on Linux");
  const bare = join(box.dataDir, "ai-home-bare");
  mkdirSync(bare, { recursive: true });
  const empty = join(box.projectDir, "..", "empty-open");
  mkdirSync(empty, { recursive: true });
  const { app, page } = await launch({ ...box, projectDir: empty }, { env: { FRAMESHELL_TEST_HOME: bare, FRAMESHELL_OPEN_APP_STAND_IN: launchLog } });
  try {
    await page.getByTestId("welcome-connect").getByRole("button", { name: "Connect your AI" }).click();
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "not-installed");
    await expect(card(page, "chatgpt").getByTestId("connect-ai-download")).toHaveAttribute("href", "https://chatgpt.com/download");
    if (claudeDesktop) await expect(card(page, "claude-desktop").getByTestId("connect-ai-download")).toHaveAttribute("href", "https://claude.ai/download");

    await card(page, "chatgpt").getByRole("button", { name: "Open ChatGPT" }).click();
    await expect(card(page, "chatgpt").getByTestId("connect-ai-copied")).toBeVisible();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Use Frameshell to help me edit a video.");
  } finally {
    await app.close();
  }
});

test("Open on an app that is not there says so, offers Download and leaves the clipboard alone", async () => {
  const connected = join(box.dataDir, "ai-home-missing");
  mkdirSync(join(connected, ".codex"), { recursive: true });
  const { app, page } = await launch(box, {
    env: { FRAMESHELL_TEST_HOME: connected, FRAMESHELL_OPEN_APP_STAND_IN: launchLog, FRAMESHELL_OPEN_APP_STAND_IN_MISSING: "1" },
  });
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText("untouched"));
    await page.locator(".titlebar").getByRole("button", { name: "Connect your AI" }).click();
    await card(page, "chatgpt").getByRole("button", { name: "Connect" }).click();
    await expect(card(page, "chatgpt")).toHaveAttribute("data-state", "connected");
    await card(page, "chatgpt").getByRole("button", { name: "Open ChatGPT" }).click();
    await expect(card(page, "chatgpt").getByTestId("connect-ai-not-found")).toContainText("was not found on this computer");
    await expect(card(page, "chatgpt").getByTestId("connect-ai-download")).toHaveAttribute("href", "https://chatgpt.com/download");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("untouched");
  } finally {
    await app.close();
  }
});
