import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";

// Black-box: runs the built CLI (`tsc -b` first) exactly as a user or agent would.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const IDLE_MS = 1500;

const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-cli-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-cli-${randomUUID().slice(0, 8)}.sock`);

function frameshell(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: String(IDLE_MS) },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "frameshell-cli-")));

// Probe by pid: connecting would itself reset the idle timer.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
}

const daemonPids = new Set<number>();

afterAll(async () => {
  // Spawned daemons exit by idle timeout; wait so no process outlives the run.
  for (const pid of daemonPids) await waitForExit(pid);
});

describe("frameshell CLI", () => {
  it("init scaffolds a project, then status --json auto-started daemon reports it", async () => {
    const root = tempDir();
    const init = frameshell(["init", "my-video", "--name", "Launch video"], root);
    expect(init.stderr).toBe("");
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("Launch video");
    const dir = join(root, "my-video");
    expect(existsSync(join(dir, "frameshell.json"))).toBe(true);
    expect(existsSync(join(dir, "timelines", "main.json"))).toBe(true);

    const status = frameshell(["status", "--json"], join(dir, "assets"));
    expect(status.code).toBe(0);
    const json = JSON.parse(status.stdout);
    expect(json.project).toEqual({ dir, name: "Launch video", schemaVersion: 1 });
    expect(json.daemon.protocolVersion).toBe(1);
    expect(json.daemon.pid).not.toBe(process.pid);
    daemonPids.add(json.daemon.pid);
  });

  it("status prints a human summary and points to init outside a project", () => {
    const status = frameshell(["status"], tempDir());
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/frameshelld .* protocol v1/);
    expect(status.stdout).toMatch(/frameshell init/);
  });

  it("reports daemon errors on stderr with a non-zero exit", () => {
    const root = tempDir();
    expect(frameshell(["init"], root).code).toBe(0);
    const again = frameshell(["init"], root);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  });

  it("rejects an unknown command with usage", () => {
    const result = frameshell(["frobnicate"], tempDir());
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Usage/);
  });

  it("the auto-started daemon exits after its idle timeout", async () => {
    const { pid } = JSON.parse(frameshell(["status", "--json"], tempDir()).stdout).daemon;
    daemonPids.add(pid);
    expect(isAlive(pid)).toBe(true);
    expect(await waitForExit(pid)).toBe(true);
    await expect(connectToDaemon(socketPath, { client: "test" })).rejects.toSatisfy(isDaemonUnavailable);
  });
});
