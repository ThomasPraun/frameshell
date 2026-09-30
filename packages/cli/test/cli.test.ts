import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";
import { runCli } from "../src/index.js";

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

  it("init installs the agent skill when no one can be asked, and --no-skill leaves it out", () => {
    const withSkill = tempDir();
    const init = frameshell(["init"], withSkill);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("Agent skill: .claude/skills/frameshell/");
    expect(existsSync(join(withSkill, ".claude", "skills", "frameshell", "SKILL.md"))).toBe(true);

    const without = tempDir();
    const bare = frameshell(["init", "--no-skill"], without);
    expect(bare.code).toBe(0);
    expect(bare.stdout).not.toContain("Agent skill");
    expect(existsSync(join(without, ".claude"))).toBe(false);
  });

  it("init offers the agent skill when someone can answer, installing it unless declined", async () => {
    const ask = async (answer: string) => {
      const dir = tempDir();
      const questions: string[] = [];
      let stdout = "";
      const code = await runCli(["init"], {
        stdout: (text) => (stdout += text),
        stderr: () => {},
        cwd: dir,
        env: { ...process.env, FRAMESHELL_SOCKET: socketPath, FRAMESHELL_IDLE_TIMEOUT_MS: String(IDLE_MS) },
        prompt: async (question) => {
          questions.push(question);
          return answer;
        },
      });
      return { code, stdout, questions, installed: existsSync(join(dir, ".claude", "skills", "frameshell", "SKILL.md")) };
    };
    const declined = await ask("n");
    expect(declined.code).toBe(0);
    expect(declined.questions).toEqual([expect.stringContaining(".claude/skills/frameshell")]);
    expect(declined.installed).toBe(false);

    const accepted = await ask("");
    expect(accepted.installed).toBe(true);
    expect(accepted.stdout).toContain("Agent skill: .claude/skills/frameshell/");
  });

  it("status and status --json show rejected edits on disk and open transactions", () => {
    const dir = join(tempDir(), "talk");
    expect(frameshell(["init", dir], tempDir()).code).toBe(0);
    const rejected = join(dir, ".frameshell", "rejected");
    mkdirSync(rejected, { recursive: true });
    // Kept by an earlier daemon run: one with recorded details, one without.
    const recorded = {
      timeline: "main",
      reason: "stale",
      message: "timelines/main.json was edited at revision 0, but timeline main is at revision 3.",
      preserved: ".frameshell/rejected/2026-02-01T10-00-00-000Z-main.json",
      revision: 0,
      current: 3,
      at: "2026-02-01T10:00:00.000Z",
    };
    writeFileSync(join(dir, recorded.preserved), '{"revision":0}');
    writeFileSync(join(dir, ".frameshell", "rejected.jsonl"), `${JSON.stringify(recorded)}\n`);
    writeFileSync(join(rejected, "2026-01-01T09-00-00-000Z-main.json"), '{"revision":1}');
    const begun = frameshell(["tx", "begin", "rough cut"], dir, { FRAMESHELL_SESSION: "sh-42-closed" });
    expect(begun.code).toBe(0);

    const json = JSON.parse(frameshell(["status", "--json"], dir).stdout);
    daemonPids.add(json.daemon.pid);
    expect(json.rejections).toEqual([
      recorded,
      expect.objectContaining({ reason: "unknown", revision: 1, current: null, at: "2026-01-01T09:00:00.000Z" }),
    ]);
    expect(json.transactions).toEqual([
      expect.objectContaining({ label: "rough cut", author: "cli:sh-42-closed", session: "sh-42-closed", operations: 0, timelines: [] }),
    ]);

    const text = frameshell(["status"], dir).stdout;
    expect(text).toMatch(/Rejected direct edits \(2\):/);
    expect(text).toMatch(/main: stale \(revision 0, current 3\), kept at \.frameshell\/rejected\/2026-02-01T10-00-00-000Z-main\.json/);
    expect(text).toMatch(/main: unknown reason \(revision 1\), kept at \.frameshell\/rejected\/2026-01-01T09-00-00-000Z-main\.json/);
    expect(text).toMatch(/Open transactions \(1\):/);
    expect(text).toMatch(/tx_[0-9a-f]{8} "rough cut" · cli:sh-42-closed · 0 operations · open \d+s/);
    expect(text).toMatch(/FRAMESHELL_SESSION=<session> frameshell tx commit/);
    expect(frameshell(["tx", "abort"], dir, { FRAMESHELL_SESSION: "sh-42-closed" }).code).toBe(0);
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
    expect(JSON.parse(status.stdout).caller).toEqual({ client: expect.stringMatching(/^cli\//), session: "term-4f2a", agent: null });
  });

  it("names the agent FRAMESHELL_AGENT gives", () => {
    const status = frameshell(["status", "--json"], tempDir(), { FRAMESHELL_SESSION: "term-4f2a", FRAMESHELL_AGENT: "Claude" });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).caller).toMatchObject({ session: "term-4f2a", agent: "claude" });
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

  it("--json lists managed ffmpeg, ffprobe, whisper-cli and headless Chrome as not installed, without downloading, and exits 1", () => {
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
      ["chrome-headless-shell", "managed", false],
    ]);
    expect(report.problems.join("\n")).toMatch(/doctor --install|No managed ffmpeg build/);
    // whisper.cpp installs on first transcription, headless Chrome on first HyperFrames render: never a problem here.
    expect(report.problems.join("\n")).not.toMatch(/whisper|chrome/);
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
