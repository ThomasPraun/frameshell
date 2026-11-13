import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBurstAudio, makeVoiceClip } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";
import { parseTimelineCommand } from "../src/timeline-commands.js";

// Black-box: built CLI against an auto-started daemon; a voice with one burst and a steady bed.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-duck-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-dk-${randomUUID().slice(0, 8)}.sock`);

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

beforeAll(async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-duck-")));
  project = join(parent, "reel");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-")));
  await makeVoiceClip(join(footage, "voice.mp4"), { own: [[2, 2, 440]], durationS: 8 });
  await makeBurstAudio(join(footage, "bed.wav"), { durationS: 8, bursts: [[0, 8, 1000]] });
  expect(frameshell(["import", join(footage, "voice.mp4"), join(footage, "bed.wav")]).code).toBe(0);
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

describe("frameshell duck", () => {
  it("parses its flags into track.duck params (attack and release in ms)", () => {
    expect(parseTimelineCommand(["duck", "t_m"], { under: ["t_v", "t_w"], depth: "8", attack: "30", release: "300", threshold: "-40", gap: "1" })).toMatchObject({
      method: "track.duck",
      params: { track: "t_m", under: ["t_v", "t_w"], depth: 8, attackMs: 30, releaseMs: 300, threshold: -40, gap: 1 },
    });
    expect(parseTimelineCommand(["duck", "t_m"], { under: ["t_v"], level: "12" })).toMatchObject({ params: { track: "t_m", under: ["t_v"], level: 12 } });
    expect(parseTimelineCommand(["duck", "t_m"], { under: ["t_v"] })!.params).toEqual({ track: "t_m", under: ["t_v"] });
    expect(() => parseTimelineCommand(["duck", "t_m"], { under: ["t_v"], level: "low" })).toThrow(/expected a number/);
    expect(() => parseTimelineCommand(["duck", "t_m"], {})).toThrow(/needs --under/);
    expect(() => parseTimelineCommand(["duck"], { under: ["t_v"] })).toThrow(/takes 1 argument/);
    expect(() => parseTimelineCommand(["duck", "t_m"], { under: ["t_v"], layout: "solo" })).toThrow(/does not take --layout/);
    expect(() => parseTimelineCommand(["duck", "t_m"], { under: ["t_v"], depth: "loud" })).toThrow(/expected a number/);
  });

  it("ducks the bed under the voice, and says what it heard", () => {
    const voice = frameshell(["track", "add", "video"]).stdout.match(/t_[0-9a-f]{6}/)![0];
    const bed = frameshell(["track", "add", "audio"]).stdout.match(/t_[0-9a-f]{6}/)![0];
    expect(frameshell(["clip", "add", voice, "assets/voice.mp4", "--start", "0", "--in", "0", "--out", "8"]).code).toBe(0);
    expect(frameshell(["clip", "add", bed, "assets/bed.wav", "--start", "0", "--in", "0", "--out", "8"]).code).toBe(0);

    const ducked = frameshell(["duck", bed, "--under", voice, "--depth", "9"]);
    expect(ducked.stderr).toBe("");
    expect(ducked.code).toBe(0);
    expect(ducked.stdout).toMatch(new RegExp(`^Ducked ${bed} under 1 stretch of speech \\(\\d+(\\.\\d+)? s\\) on ${voice}: 1 clip changed`));
    expect(ducked.stdout).toContain("track.duck: updated");

    const json = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout) as { tracks: { id: string; clips: { keys?: { gain?: { value: number; auto?: string }[] } }[] }[] };
    const keys = json.tracks.find((track) => track.id === bed)!.clips[0]!.keys!.gain!;
    expect(Math.min(...keys.map((key) => key.value))).toBe(-9);
    expect(keys.every((key) => key.auto === "duck")).toBe(true);

    const wrong = frameshell(["duck", voice, "--under", bed]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("audio track");

    const levelled = frameshell(["duck", bed, "--under", voice, "--level", "12"]);
    expect(levelled.stderr).toBe("");
    expect(levelled.code).toBe(0);
    expect(levelled.stdout).toMatch(/\nLevel: voice -?\d+(\.\d)? LUFS, music set to -?\d+(\.\d)? LUFS \(12 dB under\): c_[0-9a-f]{6} [+-]?\d+(\.\d)? dB/);
  }, 60_000);
});
