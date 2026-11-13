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

describe("frameshell sound place", () => {
  it("places a sound on a marker and on seconds, and prints where each peak falls", () => {
    expect(frameshell(["marker", "add", "--at", "4", "--label", "hook"]).code).toBe(0);
    const result = frameshell(["sound", "place", "click", "--at", "hook,hook+1.5", "--seed", "9"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^c_\w+ {2}t_\w+ {2}click {2}start \d\.\d{3} s, peak -11 ms from 4\.000 s \(at 4\.000 s\), gain -20 dB {2}assets\/sound\/click-[0-9a-f]{8}\.wav$/);
    expect(lines[1]).toContain("peak -11 ms from 5.500 s");
    expect(result.stdout).toContain("new audio track");
    expect(result.stdout).toMatch(/transaction tx_\w+/);
  });

  it("places a run of keys as JSON, and fails with the daemon's message for an unknown track", () => {
    const keys = JSON.parse(frameshell(["sound", "place", "tick", "--typing", "--from", "10", "--to", "11", "--rate", "6", "--json"]).stdout) as { placed: { from: string; tier: string }[] };
    expect(keys.placed.length).toBeGreaterThanOrEqual(5);
    expect(keys.placed.every((sound) => sound.from === "typing" && sound.tier === "texture")).toBe(true);
    const cuts = frameshell(["sound", "place", "whoosh", "--cuts", "t_none"]);
    expect(cuts.code).toBe(1);
    expect(cuts.stderr).toContain('no track "t_none"');
  });

  it("rejects a call that does not say where, or says it twice, and bad values", () => {
    expect(frameshell(["sound", "place", "click"])).toMatchObject({ code: 2, stderr: expect.stringContaining("needs one of --at") });
    expect(frameshell(["sound", "place", "click", "--at", "1", "--cuts", "v1"]).code).toBe(2);
    expect(frameshell(["sound", "place", "click", "--at", "1", "--role", "boom"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--role: expected tap, knock") });
    expect(frameshell(["sound", "place", "click", "--at", "1", "--tier", "loud"]).code).toBe(2);
    expect(frameshell(["sound", "place", "click", "--at", "1", "--offset", "5000"]).code).toBe(2);
    expect(frameshell(["sound", "place", "whoosh", "--typing", "--from", "1", "--to", "2"])).toMatchObject({ code: 2, stderr: expect.stringContaining("use the kind tick or click") });
    expect(frameshell(["sound", "place", "tick", "--typing", "--from", "1"]).code).toBe(2);
    expect(frameshell(["sound", "place", "tick", "--at", "1", "--rate", "5"]).code).toBe(2);
    expect(frameshell(["sound", "place", "tick", "--at", "1", "--which", "1"]).code).toBe(2);
    expect(frameshell(["sound", "place", "click", "--at", "1", "--lines", "a"]).code).toBe(2);
  });

  it("fails with the daemon's message for an unknown marker", () => {
    const result = frameshell(["sound", "place", "click", "--at", "nowhere"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cues[0].at");
  });
});

describe("frameshell sound music", () => {
  it("writes a bed with its beat grid, places it from a marker with a part on another, and prints both", () => {
    expect(frameshell(["marker", "add", "--at", "20", "--label", "music-in"]).code).toBe(0);
    expect(frameshell(["marker", "add", "--at", "24", "--label", "reveal"]).code).toBe(0);
    const result = frameshell(["sound", "music", "minimal", "--bpm", "120", "--bars", "4", "--at", "music-in", "--sections", "intro,drop@reveal", "--accents", "reveal+1"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^assets\/sound\/music-minimal-[0-9a-f]{8}\.wav {2}generated {2}minimal 120 BPM, 4 beats a bar, 4 bars, seed 0$/);
    expect(lines[1]).toMatch(/^ {2}10\.50 s, final hit at 8\.000 s, -1[34](\.\d+)? LUFS, peak -1(\.\d+)? dBFS$/);
    expect(lines[2]).toBe("  parts: intro 2 (0.00 s), drop 2 (4.00 s); chords Am7 Fmaj7 C G");
    expect(lines[3]).toMatch(/^ {2}beats\/sound\/music-minimal-[0-9a-f]{8}\.beats\.json written: exact grid, 17 beats$/);
    expect(lines[4]).toMatch(/^c_\w+ {2}t_\w+ \(new audio track Music\) {2}start 20\.000 s, gain -12 dB$/);
    expect(result.stdout).toContain("the timeline's tempo now follows this clip");
    expect(result.stdout).toMatch(/transaction tx_\w+/);
  });

  it("only writes the take with --no-place, as JSON", () => {
    const result = JSON.parse(frameshell(["sound", "music", "lofi", "--length", "6", "--chords", "Dm9,G13", "--seed", "3", "--no-place", "--json"]).stdout) as { bars: number; bpm: number; clip: string | null; chords: string[] };
    expect(result).toMatchObject({ bpm: 78, bars: 2, clip: null, chords: ["Dm9", "G13"] });
  });

  it("rejects an unknown preset, bad parts, chords and flags with a usage error", () => {
    expect(frameshell(["sound", "music", "polka"])).toMatchObject({ code: 2, stderr: expect.stringContaining("expected synthwave, lofi, minimal") });
    expect(frameshell(["sound", "music", "lofi", "--bars", "2", "--length", "4"])).toMatchObject({ code: 2, stderr: expect.stringContaining("not both") });
    expect(frameshell(["sound", "music", "lofi", "--sections", "chorus:2"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--sections") });
    expect(frameshell(["sound", "music", "lofi", "--sections", "intro:0"]).code).toBe(2);
    expect(frameshell(["sound", "music", "lofi", "--chords", "Am,X7"])).toMatchObject({ code: 2, stderr: expect.stringContaining('"X7"') });
    expect(frameshell(["sound", "music", "lofi", "--bpm", "300"]).code).toBe(2);
    expect(frameshell(["sound", "music", "lofi", "--no-place", "--gain", "-6"]).code).toBe(2);
    expect(frameshell(["sound", "music", "lofi", "--variant", "2"]).code).toBe(2);
  });
});
