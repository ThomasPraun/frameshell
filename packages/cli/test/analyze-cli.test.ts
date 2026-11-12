import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// `frameshell analyze`, black-box: built CLI, auto-started daemon, managed ffmpeg, a 2 s synthetic clip outside the project.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-analyze-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-ana-${randomUUID().slice(0, 8)}.sock`);

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

let project: string;
let reference: string;
let daemonPid: number | undefined;

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-analyze-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  reference = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-reference-"))), "Ref.mp4");
  await makeClip(reference, { durationS: 2 });
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

describe("frameshell analyze", () => {
  it(
    "measures a video outside the project and prints the cutting, palette, loudness and where the files are",
    () => {
      const result = frameshell(["analyze", reference]);
      expect(result.code, result.stderr).toBe(0);
      const dir = join(project, ".frameshell", "analysis", "ref");
      expect(result.stdout).toContain(`Analysis ref of ${reference}: 2 s, 320x240 at 30 fps -> ${dir}`);
      expect(result.stdout).toMatch(/Cutting: 1 shots, 0 cuts a minute; length average 2 s, median 2 s, shortest 2 s, longest 2 s/);
      expect(result.stdout).toMatch(/Palette: #[0-9a-f]{6} \d+%/);
      expect(result.stdout).toMatch(/Loudness: -?\d+(\.\d)? LUFS, range /);
      expect(result.stdout).toContain(`${join(dir, "contact.png")}  `);
      expect(result.stdout).toContain(`${join(dir, "shots.png")}  `);
      expect(result.stdout).toMatch(/Shots \(start s, length s\):\n {2}#1 {2}0 {2}2 {2}#/);
      expect(existsSync(join(dir, "analysis.json"))).toBe(true);
      expect(existsSync(join(dir, "frames", "shot-001.jpg"))).toBe(true);
    },
    120_000,
  );

  it(
    "takes a name and a threshold, and prints JSON with --json",
    () => {
      const result = frameshell(["analyze", reference, "--name", "first", "--threshold", "0.6", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      const analysis = JSON.parse(result.stdout) as { name: string; threshold: number; shots: unknown[] };
      expect(analysis).toMatchObject({ name: "first", threshold: 0.6 });
      expect(analysis.shots).toHaveLength(1);
    },
    120_000,
  );

  it("rejects a missing video, a bad name or threshold, and a foreign flag before talking to the daemon", () => {
    expect(frameshell(["analyze"]).code).toBe(2);
    expect(frameshell(["analyze", reference, "extra"]).code).toBe(2);
    expect(frameshell(["analyze", reference, "--threshold", "2"]).stderr).toContain("--threshold takes a scene score from 0.05 to 0.95");
    expect(frameshell(["analyze", reference, "--threshold", "soft"]).code).toBe(2);
    expect(frameshell(["analyze", reference, "--name", "../out"]).stderr).toContain("--name takes letters, digits");
    expect(frameshell(["analyze", reference, "--at", "1"]).stderr).toContain("`frameshell analyze` does not take --at");
  });
});
