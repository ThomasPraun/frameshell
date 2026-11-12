import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickTrack, wavOf } from "../../core/test/beat-fixture.js";
import { testBinariesDir } from "../../core/test/media-tools.js";

// Black-box: built CLI, auto-started daemon, one imported synthetic click track (120 BPM, a click on every
// half second, the first at 0.2 s).
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-beats-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-beats-${randomUUID().slice(0, 8)}.sock`);
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
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-beats-cli-")));
  project = join(parent, "film");
  expect(frameshell(["init", project, "--no-skill"], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-clicks-")));
  writeFileSync(join(footage, "theme.wav"), wavOf(clickTrack({ bpm: 120, seconds: 16, offset: 0.2 }), 48_000));
  // --wait: the ingest writes the PCM sidecar the grid is measured from.
  expect(frameshell(["import", join(footage, "theme.wav"), "--wait"]).code).toBe(0);
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

describe("frameshell beats", () => {
  it("measures a track into beats/theme.beats.json and prints the tempo and confidence", () => {
    const result = frameshell(["beats", "measure", "assets/theme.wav"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^beats\/theme\.beats\.json {2}120 BPM, 32 beats, confidence 1\.00, within [0-9.]+ ms of the hits\n/);
    expect(result.stdout).not.toContain("LOW");
    const file = JSON.parse(readFileSync(join(project, "beats", "theme.beats.json"), "utf8")) as { detector: string; beats: number[] };
    expect(file.detector).toBe("onset-flux@1");
    expect(file.beats[0]).toBeCloseTo(0.2, 1);
  });

  it("shows the grid with the edits of the file applied, and as JSON", () => {
    const shown = frameshell(["beats", "show", "assets/theme.wav"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/beats: 0\.[12]\d* 0\.[67]\d* 1\.[12]\d* /);
    const data = JSON.parse(frameshell(["beats", "show", "assets/theme.wav", "--json"]).stdout) as { bpm: number; beats: number[]; downbeats: number[]; current: boolean };
    expect(data.bpm).toBeCloseTo(120, 0);
    expect(data.current).toBe(true);
    expect(data.downbeats.length).toBe(Math.ceil(data.beats.length / 4));
  });

  it("takes --bpm and --reset-edits, and says when there is nothing to show", () => {
    const again = frameshell(["beats", "measure", "assets/theme.wav", "--bpm", "120", "--reset-edits"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("onsets reused");
    expect(frameshell(["beats", "measure", "assets/theme.wav", "--bpm", "fast"]).code).toBe(2);
    expect(frameshell(["beats", "measure", "assets/theme.wav", "--lines", "a"]).stderr).toContain("does not take --lines");
    expect(frameshell(["beats", "show"]).code).toBe(2);
    const missing = frameshell(["beats", "show", "assets/other.wav"]);
    expect(missing.code).toBe(1);
  });
});
