import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and a daemon it auto-starts.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-sound-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-snd-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let userDirs: string;
let daemonPid: number | undefined;

function frameshell(args: string[], cwd = project) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: "1500", FRAMESHELL_DATA_DIR: userDirs, FRAMESHELL_CONFIG_DIR: userDirs },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-sound-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  expect(frameshell(["init", project, "--no-skill"], parent).code).toBe(0);
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
}, 30_000);

describe("frameshell sound sfx", () => {
  it("writes the take and prints where its anchor is", () => {
    const result = frameshell(["sound", "sfx", "whoosh", "--variant", "2", "--seed", "5", "--length", "1"]);
    expect(result.code).toBe(0);
    const [head, size, anchor] = result.stdout.trimEnd().split("\n");
    expect(head).toMatch(/^assets\/sound\/whoosh-[0-9a-f]{8}\.wav {2}generated {2}whoosh 2, seed 5, pitch \d\.\d\d$/);
    expect(size).toMatch(/^ {2}1\.00 s, stereo, peak -\d\.\d dBFS, rms -\d+\.\d dBFS$/);
    expect(anchor).toBe("  peakAt 0.450 s: put this instant of the take on the cue");
    expect(existsSync(join(project, head!.split(" ")[0]!))).toBe(true);
  });

  it("reports a take that is current as cached, as JSON", () => {
    const result = frameshell(["sound", "sfx", "click", "--seed", "2", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "click", variant: 1, seed: 2, state: "generated", channels: 1 });
    const again = JSON.parse(frameshell(["sound", "sfx", "click", "--seed", "2", "--json"]).stdout) as { state: string; imported: unknown[] };
    expect(again).toMatchObject({ state: "cached", imported: [] });
  });

  it("rejects an unknown kind or a bad flag value with a usage error", () => {
    expect(frameshell(["sound", "sfx", "gong"])).toMatchObject({ code: 2, stderr: expect.stringContaining("expected click, tick, pop") });
    expect(frameshell(["sound", "sfx", "pop", "--variant", "4"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--variant") });
    expect(frameshell(["sound", "sfx", "pop", "--seed", "-1"]).code).toBe(2);
    expect(frameshell(["sound", "sfx", "pop", "--pitch", "fast"]).code).toBe(2);
    expect(frameshell(["sound", "sfx", "pop", "--length", "0"]).code).toBe(2);
    expect(frameshell(["sound", "sfx"]).code).toBe(2);
    expect(frameshell(["sound", "sfx", "pop", "--lines", "a"]).code).toBe(2);
  });

  it("fails with the daemon's message for a length the kind does not take", () => {
    const result = frameshell(["sound", "sfx", "click", "--length", "1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("fixed length");
  });
});
