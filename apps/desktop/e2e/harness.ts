import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, type Locator, type Page, _electron as electron, expect } from "@playwright/test";

// Launches the built app (or a packaged one) against an isolated project, daemon and user dirs.
// FRAMESHELL_E2E_APP: run against a packaged app executable instead (release pipeline).
const packagedApp = process.env["FRAMESHELL_E2E_APP"];
const mainEntry = join(import.meta.dirname, "..", "out", "main", "index.js");

/** True on Windows runners, where the terminal is PowerShell. */
export const isWindows = process.platform === "win32";

/** One test file's sandbox: a copy of a fixture project plus its own daemon socket and user dirs. */
export interface Sandbox {
  projectDir: string;
  socketPath: string;
  dataDir: string;
  configDir: string;
}

/** Copy `e2e/fixtures/<fixture>` into a fresh temp dir with isolated daemon and user dirs. */
export function sandbox(fixture: string): Sandbox {
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "fs-e2e-")));
  const projectDir = join(workDir, fixture);
  cpSync(join(import.meta.dirname, "fixtures", fixture), projectDir, { recursive: true });
  return {
    projectDir,
    // Isolated daemon for this run; exits on idle after the app closes.
    socketPath: isWindows ? `\\\\.\\pipe\\frameshell-e2e-${randomUUID().slice(0, 8)}` : join(workDir, "d.sock"),
    dataDir: join(workDir, "data"),
    configDir: join(workDir, "config"),
  };
}

/** Start the app on the sandbox project, in a laptop-sized window. */
export async function launch(box: Sandbox): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    ...(packagedApp ? { executablePath: packagedApp } : {}),
    // Ubuntu runners forbid the unprivileged user namespaces Chromium's sandbox needs.
    args: [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ...(packagedApp ? [] : [mainEntry]),
      "--project",
      box.projectDir,
    ],
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: box.socketPath,
      FRAMESHELL_DATA_DIR: box.dataDir,
      FRAMESHELL_CONFIG_DIR: box.configDir,
      FRAMESHELL_IDLE_TIMEOUT_MS: "3000",
    },
  });
  try {
    const page = await app.firstWindow();
    // CI screens are smaller than the default window: pin a laptop-sized window so layout is deterministic.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`[renderer] ${message.text()}`);
    });
    return { app, page };
  } catch (error) {
    // The caller never gets `app` to close: a leaked app stalls worker teardown and loads the next spec's machine.
    await app.close().catch(() => undefined);
    throw error;
  }
}

/** Visible text of the active terminal's grid, rows joined so soft-wrapped output reads as one line. */
export async function terminalText(page: Page): Promise<string> {
  const rows = await page.locator(".terminal-view:not([hidden]) .xterm-rows > div").allInnerTexts();
  return rows.join("");
}

/** Type a command into the active terminal and press Enter. */
export async function runInTerminal(page: Page, command: string): Promise<void> {
  await page.locator(".terminal-view:not([hidden])").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/**
 * Bounding box of `locator` once it is laid out. Never read a box once with a
 * non-null assertion: on slow runners (packaged-app CI) layout may not have
 * happened yet and the box is null or empty.
 */
export async function laidOutBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const seen: { box: { x: number; y: number; width: number; height: number } | null } = { box: null };
  await expect
    .poll(async () => {
      seen.box = await locator.boundingBox();
      return seen.box !== null && seen.box.width > 0 && seen.box.height > 0;
    })
    .toBe(true);
  if (!seen.box) throw new Error("unreachable: polled until laid out");
  return seen.box;
}
