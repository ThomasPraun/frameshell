import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBinariesDir } from "../../core/test/media-tools.js";

// Black-box: built CLI, auto-started daemon. Only refusals run here (no network in tests): the capture itself is
// covered against a local fixture site in packages/core/test/brand-capture.test.ts.
const CLI_TIMEOUT = 60_000;
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-brand-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-brand-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let daemonPid: number | undefined;

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: testBinariesDir(),
      FRAMESHELL_CONFIG_DIR: testBinariesDir(),
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-brand-cli-")));
  project = join(parent, "film");
  expect(frameshell(["init", project, "--no-skill"], parent).code).toBe(0);
  daemonPid = (JSON.parse(frameshell(["status", "--json"]).stdout) as { daemon: { pid: number } }).daemon.pid;
}, 120_000);

afterAll(async () => {
  for (let i = 0; daemonPid && i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

describe("frameshell brand capture", () => {
  it("refuses a file URL with the reason in --json", () => {
    const result = frameshell(["brand", "capture", "file:///etc/hosts", "--json"]);
    expect(result.code).not.toBe(0);
    const error = (JSON.parse(result.stdout || result.stderr) as { error: { code: string; message: string; data: { reason: string } } }).error;
    expect(error.data.reason).toBe("scheme");
    expect(error.message).toMatch(/only http and https/);
  }, CLI_TIMEOUT);

  it("refuses a loopback address before anything loads", () => {
    const result = frameshell(["brand", "capture", "http://127.0.0.1/"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-public address 127\.0\.0\.1/);
  }, CLI_TIMEOUT);

  it("documents the command and rejects a wrong shape", () => {
    expect(frameshell(["--help"]).stdout).toMatch(/brand capture <url>/);
    expect(frameshell(["brand", "capture"]).code).not.toBe(0);
  }, CLI_TIMEOUT);
});

describe("frameshell brand import-figma and brand show", () => {
  it("shows no brand, imports a folder of frames, then shows them with scale and positions", () => {
    const empty = frameshell(["brand", "show"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/No brand\.json .*no brand captured or imported yet/);

    const figma = join(project, "..", "Figma export");
    mkdirSync(figma);
    writeFileSync(join(figma, "Home.svg"), '<svg width="1440" height="900" viewBox="0 0 1440 900" xmlns="http://www.w3.org/2000/svg"><script>x()</script><rect width="1440" height="900"/></svg>');
    const imported = frameshell(["brand", "import-figma", "../Figma export"]);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toMatch(/Imported 1 Figma frame into brand\.json/);
    expect(imported.stdout).toMatch(/scale 1\.333 \(widest frame 1440 px\), centred/);
    expect(imported.stdout).toMatch(/frame assets\/brand\/figma-export\/home\.svg {2}1440x900 at 0,-60 {2}from Home\.svg {2}removed: 1 script element/);

    const shown = JSON.parse(frameshell(["brand", "show", "--json"]).stdout) as { exists: boolean; imports: { id: string; frames: { path: string }[] }[] };
    expect(shown.exists).toBe(true);
    expect(shown.imports.map((entry) => entry.id)).toEqual(["figma-export"]);
    expect(frameshell(["brand", "show"]).stdout).toMatch(/Figma import figma-export: .*Figma export/);
  }, CLI_TIMEOUT);

  it("rejects a wrong shape", () => {
    expect(frameshell(["brand", "import-figma"]).code).not.toBe(0);
    expect(frameshell(["brand", "show", "extra"]).code).not.toBe(0);
  }, CLI_TIMEOUT);
});
