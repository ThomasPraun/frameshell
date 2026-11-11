import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and auto-started daemon on a project with a hand-written style.json.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-style-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-st-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let userDirs: string;
let daemonPid: number | undefined;

function frameshell(args: string[]) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: userDirs,
      FRAMESHELL_CONFIG_DIR: userDirs,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-style-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  const init = spawnSync(process.execPath, [cliBin, "init", project, "--no-skill"], {
    cwd: parent,
    encoding: "utf8",
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: "1500", FRAMESHELL_DATA_DIR: userDirs, FRAMESHELL_CONFIG_DIR: userDirs },
  });
  expect(init.status, init.stderr).toBe(0);
  const status = JSON.parse(frameshell(["status", "--json"]).stdout) as { daemon: { pid: number } };
  daemonPid = status.daemon.pid;
});

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

describe("frameshell style show", () => {
  it("says there is no style.json, and prints null with --json", () => {
    rmSync(join(project, "style.json"), { force: true });
    const result = frameshell(["style", "show"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^No style\.json in .*promo: none is required\./);
    expect(JSON.parse(frameshell(["style", "show", "--json"]).stdout)).toMatchObject({ path: "style.json", style: null, safeZones: [] });
  });

  it("prints every value with its source unless written in the file, and the safe zones", () => {
    writeFileSync(
      join(project, "style.json"),
      JSON.stringify({ schemaVersion: 1, brand: { hook: "?" }, colors: { accent: "#ff3300" }, motion: { personality: "premium", stagger: 0.1 }, platforms: ["instagram-reels"] }),
    );
    const result = frameshell(["style", "show"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Style guide style\.json\. Times in seconds/);
    expect(result.stdout).toMatch(/^ {2}brand\.hook +\? \(ask the person\)$/m);
    expect(result.stdout).toMatch(/^ {2}colors\.accent +#ff3300$/m);
    expect(result.stdout).toMatch(/^ {2}colors\.bg +not set {2}\(default\)$/m);
    expect(result.stdout).toMatch(/^ {2}motion\.personality +premium$/m);
    expect(result.stdout).toMatch(/^ {2}motion\.duration\.slow +0\.8 {2}\(personality\)$/m);
    expect(result.stdout).toMatch(/^ {2}motion\.stagger +0\.1$/m);
    expect(result.stdout).toMatch(/^ {2}instagram-reels 1080x1920: top 220, right 140, bottom 380, left 0 \(measured\)$/m);
    const json = JSON.parse(frameshell(["style", "show", "--json"]).stdout);
    expect(json.style.motion.duration.slow).toEqual({ value: 0.8, source: "personality" });
  });

  it("fails on an invalid file and exits 2 on bad usage", () => {
    writeFileSync(join(project, "style.json"), JSON.stringify({ schemaVersion: 1, colors: { accent: "orange" } }));
    const invalid = frameshell(["style", "show"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/colors\.accent: must be a hex colour/);
    expect(frameshell(["style"]).code).toBe(2);
    expect(frameshell(["style", "show", "--timeline", "main"]).code).toBe(2);
  });
});
