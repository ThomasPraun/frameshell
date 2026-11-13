import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
let other: string;
let daemonPid: number | undefined;

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-analyze-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  reference = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-reference-"))), "Ref.mp4");
  await makeClip(reference, { durationS: 2 });
  other = join(dirname(reference), "Other.mp4");
  await makeClip(other, { durationS: 3 });
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
      expect(result.stdout).toMatch(/Shots \(start s, length s, palette, ink peak\):\n {2}#1 {2}0 {2}2 {2}#/);
      expect(result.stdout).toMatch(/\[MEASURED\] Curve: mean change [\d.]+, peak [\d.]+ at [\d.]+ s, \d+ moves/);
      expect(result.stdout).toMatch(/\[ESTIMATED\] Ink: \d+% of the picture on average/);
      expect(result.stdout).toMatch(/\[MEASURED\] Sync: skipped, /);
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
    expect(frameshell(["analyze", reference, "--lag", "1"]).stderr).toContain("does not take --lag: they belong to `analyze diff`");
  });
});

describe("frameshell analyze diff", () => {
  it(
    "compares two videos and prints the alignment, the energy, the SSIM and where the sheet is",
    () => {
      const result = frameshell(["analyze", "diff", reference, other, "--snapshots", "2"]);
      expect(result.code, result.stderr).toBe(0);
      const dir = join(project, ".frameshell", "analysis", "ref-vs-other");
      expect(result.stdout).toContain(`Comparison ref-vs-other: ${reference} (2 s, 320x240) against ${other} (3 s, 320x240) -> ${dir}`);
      expect(result.stdout).toMatch(/\[ESTIMATED\] Alignment: the reference is (later|earlier) by [\d.]+ s \((activity|none|forced)/);
      expect(result.stdout).toMatch(/\[MEASURED\] Energy: film [\d.]+ \(p95 [\d.]+\), reference [\d.]+/);
      expect(result.stdout).toMatch(/\[MEASURED\] SSIM every 0\.5 s: mean -?[\d.]+, lowest -?[\d.]+ at [\d.]+ s, \d+% of readings under 0\.5/);
      expect(result.stdout).toContain(`${join(dir, "diff.png")}  `);
      expect(existsSync(join(dir, "diff.json"))).toBe(true);
    },
    120_000,
  );

  it(
    "takes a name and a lag, and prints JSON with --json",
    () => {
      const result = frameshell(["analyze", "diff", reference, other, "--name", "mine", "--lag", "0.5", "--every", "1", "--snapshots", "1", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      const diff = JSON.parse(result.stdout) as { name: string; alignment: { lag: number; source: string }; diff: { every: number }; labels: Record<string, string> };
      expect(diff).toMatchObject({ name: "mine", alignment: { lag: 0.5, source: "forced" }, diff: { every: 1 } });
      expect(diff.labels["alignment.lag"]).toBe("ESTIMATED");
    },
    120_000,
  );

  it("rejects a bad shape of arguments and flag values before talking to the daemon", () => {
    expect(frameshell(["analyze", "diff", reference]).code).toBe(2);
    expect(frameshell(["analyze", "diff", reference, other, "extra"]).code).toBe(2);
    expect(frameshell(["analyze", "diff", reference, other, "--threshold", "0.3"]).stderr).toContain("does not take --threshold");
    expect(frameshell(["analyze", "diff", reference, other, "--lag", "soon"]).stderr).toContain("--lag takes seconds");
    expect(frameshell(["analyze", "diff", reference, other, "--max-lag", "100"]).stderr).toContain("--max-lag takes seconds from 0.5 to 30");
    expect(frameshell(["analyze", "diff", reference, other, "--every", "0"]).stderr).toContain("--every takes seconds from 0.1 to 30");
    expect(frameshell(["analyze", "diff", reference, other, "--snapshots", "1.5"]).stderr).toContain("--snapshots takes a whole number from 1 to 24");
    expect(frameshell(["analyze", "diff", reference, other, "--name", "../x"]).stderr).toContain("--name takes letters, digits");
  });
});
