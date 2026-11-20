import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

/**
 * Save the layout a project had before the terminal started folded: terminal open at its default width. Written
 * where `LayoutStore` keeps it (`<dataDir>/desktop/layouts`), only when the project has none yet, so a relaunch
 * keeps what the app saved. Specs that drive the terminal rely on it; `freshLayout` skips it. The file name is
 * pinned to `LayoutStore` by `test/layout-store.test.ts`.
 */
function seedOpenTerminal(box: Sandbox): void {
  const dir = join(box.dataDir, "desktop", "layouts");
  const file = join(dir, `${createHash("sha256").update(box.projectDir).digest("hex").slice(0, 16)}.json`);
  if (existsSync(file)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ projectDir: box.projectDir, layout: { panels: { terminal: { size: 520, collapsed: false } } } }));
}

/**
 * Daemon cold start plus project open, bounded apart from assertion timeouts: on a starved machine the daemon took
 * 29 s to listen. Matches the app's own daemon start timeout.
 */
const OPEN_TIMEOUT_MS = 60_000;

/**
 * Start the app on the sandbox project, in a laptop-sized window. Resolves once the startup open settled (the boot
 * screen gave way to the project, or to the welcome screen), so a spec's first assertion measures what it tests, not
 * a cold daemon. `settled: false` returns while the boot screen may still show. `env` adds to or overrides the app's
 * environment (e.g. a longer `FRAMESHELL_IDLE_TIMEOUT_MS`). `paths` are passed as files to open, like Open with does,
 * instead of `--project`. `lang` is the OS language the app sees (`--lang`); English unless a spec asks, so text
 * selectors hold on any machine. `args` adds Chromium switches, e.g. `--use-fake-device-for-media-stream`.
 * `freshLayout` opens the project like a new one (terminal folded); by default it opens as one that had the terminal
 * open, which most specs need.
 */
export async function launch(
  box: Sandbox,
  {
    settled = true,
    env = {},
    paths,
    lang = "en",
    args = [],
    freshLayout = false,
  }: { settled?: boolean; env?: Record<string, string>; paths?: string[]; lang?: string; args?: string[]; freshLayout?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  if (!freshLayout && !paths) seedOpenTerminal(box);
  const app = await electron.launch({
    ...(packagedApp ? { executablePath: packagedApp } : {}),
    // Ubuntu runners forbid the unprivileged user namespaces Chromium's sandbox needs.
    args: [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--lang=${lang}`,
      ...args,
      ...(packagedApp ? [] : [mainEntry]),
      ...(paths ?? ["--project", box.projectDir]),
    ],
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: box.socketPath,
      FRAMESHELL_DATA_DIR: box.dataDir,
      FRAMESHELL_CONFIG_DIR: box.configDir,
      FRAMESHELL_IDLE_TIMEOUT_MS: "3000",
      // A packaged release under test must not reach GitHub for updates.
      FRAMESHELL_UPDATE_CHECK: "0",
      ...env,
    },
  });
  try {
    const page = await app.firstWindow();
    // CI screens are smaller than the default window: pin a laptop-sized window so layout is deterministic.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`[renderer] ${message.text()}`);
    });
    if (settled) await expect(page.locator(".boot")).toHaveCount(0, { timeout: OPEN_TIMEOUT_MS });
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

/**
 * Type a command into the active terminal and press Enter, once the shell drew its prompt (output non-empty and
 * unchanged for 300 ms). Keys typed while a login shell still starts are reordered or lost by its line editor.
 * On Windows the first PowerShell prompt can take about a minute on a loaded runner, so it is awaited first.
 * A folded terminal (a project made from the Welcome screen starts that way) is shown first.
 */
export async function runInTerminal(page: Page, command: string): Promise<void> {
  const rail = page.getByRole("button", { name: "Show terminal" });
  if (await rail.isVisible()) await rail.click();
  if (isWindows) {
    await expect.poll(async () => /PS .*>/.test(await terminalText(page)), { timeout: 60_000, message: "the shell printed no prompt" }).toBe(true);
  }
  let last = "";
  await expect
    .poll(
      async () => {
        const text = (await terminalText(page)).trim();
        const settled = text !== "" && text === last;
        last = text;
        return settled;
      },
      { timeout: 30_000, intervals: [300] },
    )
    .toBe(true);
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

/**
 * The window of a detached panel (ADR 0012), once it shows the panel: an
 * `about:blank` page the project window's renderer draws into. Waits for it,
 * so a call may start before the click that opens it.
 */
export async function panelWindow(app: ElectronApplication, panel: string, timeout = 20_000): Promise<Page> {
  const seen: { page: Page | null } = { page: null };
  await expect
    .poll(
      async () => {
        for (const candidate of app.windows()) {
          if (candidate.isClosed() || candidate.url() !== "about:blank") continue;
          if ((await candidate.locator(`[data-testid="panel-window-${panel}"]`).count().catch(() => 0)) > 0) {
            seen.page = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout },
    )
    .toBe(true);
  return seen.page!;
}
