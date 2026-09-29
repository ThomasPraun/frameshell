import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ElectronApplication, type Page, _electron as electron, expect, test } from "@playwright/test";

// Smoke test of the built app: real daemon, real login shell, real file system.
const mainEntry = join(import.meta.dirname, "..", "out", "main", "index.js");
const fixture = join(import.meta.dirname, "fixtures", "demo");
const isWindows = process.platform === "win32";
const mod = process.platform === "darwin" ? "Meta" : "Control";

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "fs-e2e-")));
const projectDir = join(workDir, "demo");
const dataDir = join(workDir, "data");
const configDir = join(workDir, "config");
// Isolated daemon for this run; exits on idle after the app closes.
const socketPath = isWindows ? `\\\\.\\pipe\\frameshell-e2e-${randomUUID().slice(0, 8)}` : join(workDir, "d.sock");

test.describe.configure({ mode: "serial" });

let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  app = await electron.launch({
    // Ubuntu runners forbid the unprivileged user namespaces Chromium's sandbox needs.
    args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), mainEntry, "--project", projectDir],
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_DATA_DIR: dataDir,
      FRAMESHELL_CONFIG_DIR: configDir,
      FRAMESHELL_IDLE_TIMEOUT_MS: "3000",
    },
  });
  page = await app.firstWindow();
  // CI screens are smaller than the default window: pin a laptop-sized window so layout is deterministic.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[renderer] ${message.text()}`);
  });
}

/** Visible text of the active terminal's grid, rows joined so soft-wrapped output reads as one line. */
async function terminalText(): Promise<string> {
  const rows = await page.locator(".terminal-view:not([hidden]) .xterm-rows > div").allInnerTexts();
  return rows.join("");
}

async function runInTerminal(command: string): Promise<void> {
  await page.locator(".terminal-view:not([hidden])").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test.beforeAll(async () => {
  cpSync(fixture, projectDir, { recursive: true });
  await launch();
});

test.afterAll(async () => {
  await app?.close();
});

test("opens the fixture project and lists its files", async () => {
  await expect(page.locator(".titlebar-project")).toHaveText("Smoke demo");
  const tree = page.getByRole("tree", { name: "Project files" });
  await expect(tree.getByRole("treeitem", { name: "frameshell.json", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "scripts/intro.md", exact: true })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "timelines/main.json", exact: true })).toBeVisible();
});

test("explorer reflects files created on disk", async () => {
  writeFileSync(join(projectDir, "scripts", "outro.md"), "# Outro\n");
  await expect(page.getByRole("treeitem", { name: "scripts/outro.md", exact: true })).toBeVisible();
});

test("opens a file in the editor and saves an edit through the daemon", async () => {
  await page.getByRole("treeitem", { name: "scripts/intro.md", exact: true }).locator("button").first().click();
  await expect(page.getByRole("tab", { name: "scripts/intro.md" })).toBeVisible();
  const lines = page.locator(".editor-host .view-lines");
  await expect(lines).toContainText("Hook: one sentence");

  await lines.click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("Edited in Frameshell.");
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFileSync(join(projectDir, "scripts", "intro.md"), "utf8")).toContain("Edited in Frameshell.");
});

test("runs a command in a real terminal whose session is set", async () => {
  const sessionLabel = page.getByTestId("active-session");
  await expect(sessionLabel).toHaveText(/^term-[0-9a-f]{8}$/);
  const session = (await sessionLabel.textContent())!;

  await runInTerminal(isWindows ? 'echo "fs-session=$env:FRAMESHELL_SESSION"' : 'echo "fs-session=$FRAMESHELL_SESSION"');
  await expect.poll(terminalText).toContain(`fs-session=${session}`);

  await runInTerminal(isWindows ? 'echo "fs-project=$env:FRAMESHELL_PROJECT"' : 'echo "fs-project=$FRAMESHELL_PROJECT"');
  await expect.poll(terminalText).toContain(`fs-project=${projectDir}`);
});

test("a frameshell command run in the terminal is attributed to that session", async () => {
  const session = (await page.getByTestId("active-session").textContent())!;
  await runInTerminal(
    isWindows ? "frameshell status --json | Select-String caller -Context 0,3" : "frameshell status --json | grep -A3 caller",
  );
  await expect.poll(terminalText, { timeout: 30_000 }).toMatch(new RegExp(`"session": "${session}"`));
});

test("runs a full-screen TUI and gets the shell back", async () => {
  test.skip(isWindows, "vi is not on Windows runners");
  await runInTerminal("vi -u NONE -c 'set nocompatible'");
  // vi's empty-buffer filler lines on the alternate screen.
  await expect.poll(async () => (await terminalText()).split("~").length).toBeGreaterThan(5);
  await page.keyboard.type(":q!");
  await page.keyboard.press("Enter");
  await runInTerminal('echo "after-tui=$((40+2))"');
  await expect.poll(terminalText).toContain("after-tui=42");
});

test("the pty follows the terminal panel size", async () => {
  test.skip(isWindows, "tput is not on Windows runners");
  const colsNow = async () => [...(await terminalText()).matchAll(/cols=(\d+)/g)].map((match) => Number(match[1])).pop();
  await runInTerminal("clear");
  await runInTerminal('echo "cols=$(tput cols)"');
  await expect.poll(colsNow).toBeGreaterThan(20);
  const before = (await colsNow())!;

  const splitter = page.getByRole("separator", { name: "Resize terminal" });
  const box = (await splitter.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await runInTerminal("clear");
  await runInTerminal('echo "cols=$(tput cols)"');
  await expect.poll(colsNow).toBeLessThan(before - 10);
});

test("layout persists per project across restarts", async () => {
  await page.getByRole("button", { name: "Hide timeline" }).click();
  await expect(page.getByRole("button", { name: "Show timeline" })).toBeVisible();
  // Saves are debounced; give the write time to land before quitting.
  await page.waitForTimeout(800);
  await app.close();

  await launch();
  await expect(page.locator(".titlebar-project")).toHaveText("Smoke demo");
  await expect(page.getByRole("button", { name: "Show timeline" })).toBeVisible();
});
