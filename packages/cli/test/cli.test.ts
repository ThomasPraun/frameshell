import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";

// Black-box: runs the built CLI (`tsc -b` first) exactly as a user or agent would.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const IDLE_MS = 1500;

const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-cli-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-cli-${randomUUID().slice(0, 8)}.sock`);

function frameshell(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: String(IDLE_MS), ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, elapsedMs: Date.now() - startedAt };
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
    expect(json.daemon.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(json.daemon.pid).not.toBe(process.pid);
    daemonPids.add(json.daemon.pid);
  });

  it("status prints a human summary and points to init outside a project", () => {
    const status = frameshell(["status"], tempDir());
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`frameshelld .* protocol v${PROTOCOL_VERSION}`));
    expect(status.stdout).toMatch(/frameshell init/);
  });

  it("attributes a call to the terminal session named by FRAMESHELL_SESSION", () => {
    const status = frameshell(["status", "--json"], tempDir(), { FRAMESHELL_SESSION: "term-4f2a" });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).caller).toEqual({ client: expect.stringMatching(/^cli\//), session: "term-4f2a" });
  });

  it("generates one session per shell when FRAMESHELL_SESSION is unset", () => {
    const session = (result: { stdout: string }) => JSON.parse(result.stdout).caller.session as string;
    const cwd = tempDir();
    // Calls spawned by this test process share a parent, as calls typed in one shell do.
    const first = session(frameshell(["status", "--json"], cwd, { FRAMESHELL_SESSION: "" }));
    expect(first).toMatch(/^sh-\d+(-[0-9a-f]{8})?$/);
    expect(session(frameshell(["status", "--json"], cwd, { FRAMESHELL_SESSION: "" }))).toBe(first);
    // A call from another parent process is another shell.
    const { FRAMESHELL_SESSION: _unset, ...env } = process.env;
    const relay =
      "const r = require('node:child_process').spawnSync(process.execPath, process.argv.slice(1), { encoding: 'utf8' });" +
      "process.stdout.write(r.stdout);";
    const nested = spawnSync(process.execPath, ["-e", relay, cliBin, "status", "--json"], {
      cwd,
      encoding: "utf8",
      env: { ...env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: String(IDLE_MS) },
    });
    expect(session(nested)).toMatch(/^sh-/);
    expect(session(nested)).not.toBe(first);
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

describe("daemon startup failures", () => {
  // A fresh endpoint per test: no live daemon may mask the spawn.
  const freshSocket = () =>
    process.platform === "win32"
      ? `\\\\.\\pipe\\frameshell-cli-test-${randomUUID().slice(0, 8)}`
      : join(realpathSync(tmpdir()), `fs-cli-${randomUUID().slice(0, 8)}.sock`);

  it("reports the daemon's own error instead of a generic start timeout", () => {
    const result = frameshell(["status"], tempDir(), {
      FRAMESHELL_SOCKET: freshSocket(),
      FRAMESHELL_IDLE_TIMEOUT_MS: "soon",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/FRAMESHELL_IDLE_TIMEOUT_MS.*soon/);
    expect(result.stderr).not.toMatch(/did not start listening/);
    expect(result.elapsedMs).toBeLessThan(8_000);
  });

  it.skipIf(process.platform === "win32")("reports a non-socket file blocking the socket path", () => {
    const blocker = join(tempDir(), "blocker.sock");
    writeFileSync(blocker, "keep me");
    const result = frameshell(["status"], tempDir(), { FRAMESHELL_SOCKET: blocker });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not a socket/);
    expect(result.elapsedMs).toBeLessThan(8_000);
  });

  it.skipIf(process.platform === "win32")("explains an over-long socket path instead of ENOENT", () => {
    const tooLong = join(tempDir(), `${"x".repeat(120)}.sock`);
    const result = frameshell(["status"], tempDir(), { FRAMESHELL_SOCKET: tooLong });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/too long/);
    expect(result.stderr).toMatch(/FRAMESHELL_SOCKET/);
    expect(result.stderr).not.toMatch(/ENOENT/);
  });
});

describe("frameshell doctor", () => {
  const freshSocket = () =>
    process.platform === "win32"
      ? `\\\\.\\pipe\\frameshell-cli-test-${randomUUID().slice(0, 8)}`
      : join(realpathSync(tmpdir()), `fs-cli-${randomUUID().slice(0, 8)}.sock`);
  /** Isolated daemon with its own data and config dirs. */
  const isolated = (configDir = tempDir()) => ({
    FRAMESHELL_SOCKET: freshSocket(),
    FRAMESHELL_DATA_DIR: tempDir(),
    FRAMESHELL_CONFIG_DIR: configDir,
  });

  it("--json lists managed ffmpeg, ffprobe and whisper-cli as not installed, without downloading, and exits 1", () => {
    const env = isolated();
    const result = frameshell(["doctor", "--json"], tempDir(), env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.dataDir).toBe(env.FRAMESHELL_DATA_DIR);
    expect(report.binaries.map((b: { name: string; source: string; installed: boolean }) => [b.name, b.source, b.installed])).toEqual([
      ["ffmpeg", "managed", false],
      ["ffprobe", "managed", false],
      ["whisper-cli", "managed", false],
    ]);
    expect(report.problems.join("\n")).toMatch(/doctor --install|No managed ffmpeg build/);
    // whisper.cpp installs on first transcription: never a problem here.
    expect(report.problems.join("\n")).not.toMatch(/whisper/);
  });

  // A shell-script ffmpeg needs a unix exec; Windows cannot run it without a shell.
  it.skipIf(process.platform === "win32")("reports versions and encoders of a system ffmpeg set in the global config", () => {
    const fixtures = fileURLToPath(new URL("../../core/test/fixtures/ffmpeg-9.0.2-darwin-arm64/", import.meta.url));
    const bin = tempDir();
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const script = join(bin, tool);
      writeFileSync(
        script,
        `#!/bin/sh
case "$*" in
  *-version*) echo "${tool} version 7.1-fake Copyright (c) the FFmpeg developers" ;;
  *-encoders*) cat "${fixtures}encoders.txt" ;;
  *-decoders*) cat "${fixtures}decoders.txt" ;;
esac
`,
      );
      chmodSync(script, 0o755);
    }
    const configDir = tempDir();
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ binaries: { ffmpeg: join(bin, "ffmpeg") } }));

    const result = frameshell(["doctor"], tempDir(), isolated(configDir));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ffmpeg\s+7\.1-fake · global/);
    expect(result.stdout).toMatch(/ffprobe\s+7\.1-fake · global/);
    expect(result.stdout).toMatch(/libvpx-vp9 decoder\s+VP9 with alpha \(libvpx\)\s+yes/);
    expect(result.stdout).toMatch(/h264_nvenc encoder\s+H\.264 \(NVENC\)\s+no/);
    expect(result.stdout).toContain("No problems found.");
  });
});
