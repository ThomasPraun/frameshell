import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Black-box: built CLI and auto-started daemon on a project whose review switch is on (ADR 0019).
// Only the app may accept or reject, so the outcomes reachable here are none and pending.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-proposal-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-pr-${randomUUID().slice(0, 8)}.sock`);
let project: string;
let userDirs: string;
let daemonPid: number | undefined;

function frameshell(args: string[], session = "agent-a", cwd = project) {
  const { FRAMESHELL_SESSION: _inherited, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...inherited,
      FRAMESHELL_SESSION: session,
      FRAMESHELL_SOCKET: socketPath,
      FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
      FRAMESHELL_DATA_DIR: userDirs,
      FRAMESHELL_CONFIG_DIR: userDirs,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-proposal-")));
  userDirs = join(parent, "user");
  project = join(parent, "promo");
  mkdirSync(userDirs, { recursive: true });
  // The daemon reads the switch once and only the app writes it, so put the file in place before it starts.
  writeFileSync(join(userDirs, "review.json"), JSON.stringify({ version: 1, projects: { [project]: { enabled: true, since: new Date().toISOString() } } }));
  expect(frameshell(["init", project], "setup", parent).code).toBe(0);
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

describe("frameshell proposal", () => {
  it("rejects bad arguments with exit 2", () => {
    expect(frameshell(["proposal"]).code).toBe(2);
    expect(frameshell(["proposal", "accept"]).code).toBe(2);
    expect(frameshell(["proposal", "status", "--timeout", "5"]).code).toBe(2);
    expect(frameshell(["proposal", "wait", "--timeout", "0"]).code).toBe(2);
    expect(frameshell(["proposal", "wait", "--timeout", "9999"]).code).toBe(2);
  });

  it("with nothing proposed: review on, nothing to wait for, no diff", () => {
    const status = frameshell(["proposal", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("Review mode: on");
    const wait = frameshell(["proposal", "wait", "--timeout", "1"]);
    expect(wait.code).toBe(0);
    expect(wait.stdout).toContain("No proposal: none");
    expect(frameshell(["proposal", "diff"]).stdout).toBe("No proposal is open.\n");
  });

  it("holds a transaction as a proposal, refuses other changes with the hint, and shows both", () => {
    expect(frameshell(["tx", "begin", "add a track"]).code).toBe(0);
    expect(frameshell(["track", "add", "video"]).code).toBe(0);
    expect(frameshell(["tx", "commit"]).code).toBe(0);

    const other = frameshell(["track", "add", "audio"], "agent-b");
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("A proposal is waiting for review");
    expect(other.stderr).toContain("frameshell proposal wait");

    const status = frameshell(["proposal", "status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/Review mode: on · proposal tx_\w+ "add a track" by .* ready/);
    expect(frameshell(["status"]).stdout).toContain("Review mode: on");

    const asJson = JSON.parse(frameshell(["proposal", "status", "--json"]).stdout) as { enabled: boolean; proposal: { state: string } | null };
    expect(asJson).toMatchObject({ enabled: true, proposal: { state: "ready" } });

    const diff = frameshell(["proposal", "diff"]);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toMatch(/^Proposal tx_\w+:\nTimeline main · 0 clips\n$/);

    const wait = frameshell(["proposal", "wait", "--timeout", "1"]);
    expect(wait.code).toBe(6);
    expect(wait.stdout).toContain("pending");
    expect(wait.stdout).toContain("proposal wait");
    expect(JSON.parse(frameshell(["proposal", "wait", "--timeout", "1", "--json"]).stdout)).toMatchObject({ outcome: "pending" });
  }, 60_000);
});
