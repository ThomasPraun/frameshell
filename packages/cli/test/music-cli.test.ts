import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wavOf } from "../../core/test/beat-fixture.js";
import { testBinariesDir } from "../../core/test/media-tools.js";
import { kicks, music } from "../../core/test/music-fixture.js";
import { parseTimelineCommand } from "../src/timeline-commands.js";

// Black-box: built CLI against an auto-started daemon; a 26 s song of kicks with a crash at 20.345 s.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-music-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-mu-${randomUUID().slice(0, 8)}.sock`);

function frameshell(args: string[], cwd = project) {
  const { FRAMESHELL_SESSION: _inherited, ...inherited } = process.env;
  const env = {
    ...inherited,
    FRAMESHELL_SOCKET: socketPath,
    FRAMESHELL_IDLE_TIMEOUT_MS: "1500",
    FRAMESHELL_DATA_DIR: testBinariesDir(),
    FRAMESHELL_CONFIG_DIR: testBinariesDir(),
  };
  const result = spawnSync(process.execPath, [cliBin, ...args], { cwd, encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

let project: string;
let daemonPid: number | undefined;

beforeAll(() => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-music-")));
  project = join(parent, "film");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-")));
  writeFileSync(join(footage, "song.wav"), wavOf(music(26, [...kicks(19.5), { at: 20.345, amplitude: 0.9, decay: 2.5 }], { rate: 16_000 }), 16_000));
  expect(frameshell(["import", join(footage, "song.wav")]).code).toBe(0);
  daemonPid = JSON.parse(frameshell(["status", "--json"]).stdout).daemon.pid;
}, 120_000);

afterAll(async () => {
  // The daemon exits by itself after its idle timeout.
  for (let i = 0; daemonPid && i < 100; i++) {
    try {
      process.kill(daemonPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

describe("frameshell music fit", () => {
  it("parses its flags into music.fit params, times as seconds or names", () => {
    expect(parseTimelineCommand(["music", "fit", "c_m"], { end: "end-card", from: "2", hit: "20.34", exact: true, skip: ["duck"], "dry-run": true })).toMatchObject({
      method: "music.fit",
      params: { clip: "c_m", end: "end-card", from: 2, hit: 20.34, exact: true, skip: ["duck"], dryRun: true },
    });
    expect(parseTimelineCommand(["music", "fit", "c_m"], { end: "30" })!.params).toEqual({ clip: "c_m", end: 30 });
    expect(() => parseTimelineCommand(["music", "fit", "c_m"], {})).toThrow(/needs --end/);
    expect(() => parseTimelineCommand(["music", "fit"], { end: "30" })).toThrow(/takes 1 argument/);
    expect(() => parseTimelineCommand(["music", "fit", "c_m"], { end: "30", layout: "solo" })).toThrow(/does not take --layout/);
    expect(() => parseTimelineCommand(["music", "fit", "c_m"], { end: "30", hit: "late" })).toThrow(/expected a number/);
    expect(parseTimelineCommand(["music", "pick", "c_m"], { end: "30" })).toBeNull();
  });

  it("plans, applies and reports where the music starts", () => {
    const track = frameshell(["track", "add", "audio"]).stdout.match(/t_[0-9a-f]{6}/)![0];
    const added = frameshell(["clip", "add", track, "assets/song.wav", "--start", "0", "--in", "0", "--out", "26"]);
    const clip = added.stdout.match(/c_[0-9a-f]{6}/)![0];
    expect(frameshell(["marker", "add", "--at", "11", "--label", "end-card"]).code).toBe(0);

    const dry = frameshell(["music", "fit", clip, "--end", "end-card", "--dry-run"]);
    expect(dry.stderr).toBe("");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("dry run");
    expect(dry.stdout).toMatch(/final hit at 20\.3\d s of the file \(found, confidence \d+ %/);
    expect(dry.stdout).toContain("music starts at 0.00 s");
    expect(dry.stdout).toContain("intro dropped: 9.");
    expect(dry.stdout).toMatch(/intro\s+drop 9\.\d+ s of the intro/);

    const applied = frameshell(["music", "fit", clip, "--end", "11"]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toMatch(/tx tx_[0-9a-f]{8}/);
    const json = JSON.parse(frameshell(["music", "fit", clip, "--end", "11", "--json"]).stdout) as { applied: boolean; warnings: string[] };
    expect(json.applied).toBe(false);
    expect(json.warnings.join(" ")).toContain("nothing to change");

    const refused = frameshell(["music", "fit", clip, "--end", "24", "--exact"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("limit is ±1.7 %");
  }, 120_000);
});
