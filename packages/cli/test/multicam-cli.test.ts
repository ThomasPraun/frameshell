import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GALLERY_FOUR, GALLERY_THREE, makeBurstAudio, makeBurstClip, makeGallery } from "../../core/test/media-fixtures.js";
import { testBinariesDir } from "../../core/test/media-tools.js";
import { UsageError, parseTimelineCommand } from "../src/timeline-commands.js";

// Black-box: built CLI against an auto-started daemon; two synthetic files that share tone bursts.
const cliBin = fileURLToPath(new URL("../dist/bin/frameshell.js", import.meta.url));
const socketPath =
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-multicam-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-mc-${randomUUID().slice(0, 8)}.sock`);

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
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-multicam-")));
  project = join(parent, "talk");
  expect(frameshell(["init", project], parent).code).toBe(0);
  const footage = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-footage-")));
  await makeBurstClip(join(footage, "ana.mp4"), { shiftS: 0 });
  await makeBurstClip(join(footage, "ben.mp4"), { shiftS: 1.5, durationS: 9 });
  await makeBurstAudio(join(footage, "rec.wav"), { shiftS: 3, durationS: 8 });
  await makeGallery(join(footage, "call.mp4"), [GALLERY_FOUR, GALLERY_THREE, GALLERY_THREE], 3);
  expect(frameshell(["import", join(footage, "ana.mp4"), join(footage, "ben.mp4"), join(footage, "rec.wav"), join(footage, "call.mp4")]).code).toBe(0);
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

describe("frameshell multicam", () => {
  it("creates the group from two files, reports the sync, and fixes an angle by hand", () => {
    const created = frameshell(["multicam", "create", "assets/ana.mp4", "assets/ben.mp4", "--name", "Ana", "--name", "Ben", "--group-name", "Podcast"]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/Multicam group g_[0-9a-f]{6} · program track t_[0-9a-f]{6} · shot c_[0-9a-f]{6}/);
    expect(created.stdout).toMatch(/ana {2}Ana {2}assets\/ana.mp4 {2}offset 0 s {2}reference/);
    expect(created.stdout).toMatch(/ben {2}Ben {2}assets\/ben.mp4 {2}offset 1\.5\d* s {2}confidence \d+%/);
    expect(created.stdout).not.toContain("warning:");

    const json = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    const group = json.groups[0] as { id: string; name: string };
    expect(group.name).toBe("Podcast");
    expect(json.tracks.at(-1)).toMatchObject({ kind: "program", name: "Podcast", group: group.id });

    const fixed = frameshell(["multicam", "offset", group.id, "ben", "0.25"]);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain("multicam.offset: updated");
    const wrong = frameshell(["multicam", "offset", group.id, "zoe", "0.25"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("Angles: ana, ben");

    const turns = frameshell(["multicam", "turns", group.id, "--json"]);
    expect(turns.code).toBe(0);
    const parsed = JSON.parse(turns.stdout) as { group: string; turns: { angle: string; start: number; end: number }[] };
    expect(parsed.group).toBe(group.id);
    expect(new Set(parsed.turns.map((turn) => turn.angle))).toEqual(new Set(["ana", "ben"]));
    const text = frameshell(["multicam", "turns", group.id]);
    expect(text.stdout).toMatch(/^Group g_[0-9a-f]{6} · \d+ turns? over [\d.]+ s\n {2}[\d.]+–[\d.]+ s {2}(ana|ben) {2}(Ana|Ben)/);
    const unknown = frameshell(["multicam", "turns", "g_nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(`groups: ${group.id}`);
  }, 120_000);

  it("changes a shot and an angle, each one undoable step", () => {
    const json = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    const group = json.groups[0].id as string;
    const shot = json.tracks.at(-1).clips[0].id as string;

    const solo = frameshell(["shot", "set", shot, "--layout", "solo", "--angles", "ben"]);
    expect(solo.stderr).toBe("");
    expect(solo.stdout).toContain("shot.set: updated");
    const angle = frameshell(["multicam", "angle", group, "ben", "--name", "Benito", "--crop-left", "0.1", "--gain=-3", "--muted"]);
    expect(angle.code).toBe(0);
    let after = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    expect(after.tracks.at(-1).clips[0]).toMatchObject({ shot: "solo", angles: ["ben"] });
    expect(after.groups[0].angles[1]).toMatchObject({ id: "ben", name: "Benito", crop: { left: 0.1 }, audio: { gain: -3, muted: true } });

    const history = JSON.parse(frameshell(["history", "--json"]).stdout) as { transactions: { tx: string; operations: { op: string; id: string }[] }[] };
    const op = (name: string) => history.transactions.flatMap((tx) => tx.operations).find((candidate) => candidate.op === name)!.id;
    expect(frameshell(["revert", op("multicam.angle")]).code).toBe(0);
    expect(frameshell(["revert", op("shot.set")]).code).toBe(0);
    after = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    expect(after.tracks.at(-1).clips[0]).toMatchObject({ shot: "grid", angles: ["ana", "ben"] });
    expect(after.groups[0].angles[1]).toEqual(json.groups[0].angles[1]);

    const wrong = frameshell(["shot", "set", shot, "--layout", "two-up", "--angles", "ana"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("a two-up shot takes exactly 2 angles; got 1");
  }, 120_000);

  it("reframes an angle with keys at timeline seconds, removes one and clears them", () => {
    const group = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout).groups[0].id as string;
    const first = frameshell(["multicam", "reframe", group, "ana", "--time", "1", "--x", "0.3"]);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("multicam.reframe: updated");
    expect(frameshell(["multicam", "reframe", group, "ana", "--at", "4", "--x", "0.7", "--y", "0.4"]).code).toBe(0);
    let angle = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout).groups[0].angles[0];
    // The grid shot plays group 0 at timeline 0: timeline 1 is group 1.
    expect(angle.reframe).toEqual([
      { at: 1, x: 0.3, y: 0.5 },
      { at: 4, x: 0.7, y: 0.4 },
    ]);
    expect(frameshell(["multicam", "reframe", group, "ana", "--at", "1", "--remove"]).code).toBe(0);
    angle = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout).groups[0].angles[0];
    expect(angle.reframe).toEqual([{ at: 4, x: 0.7, y: 0.4 }]);
    const missing = frameshell(["multicam", "reframe", group, "ana", "--at", "2", "--remove"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Keys at group seconds: 4");
    expect(frameshell(["multicam", "reframe", group, "ana", "--clear"]).code).toBe(0);
    angle = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout).groups[0].angles[0];
    expect(angle).not.toHaveProperty("reframe");
  }, 120_000);
});

describe("frameshell direct", () => {
  it("writes shots from the turns and reports them, then refuses an unknown template", () => {
    const json = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    const group = json.groups[0].id as string;
    const directed = frameshell(["direct", group, "--template", "panel-dynamic"]);
    expect(directed.stderr).toBe("");
    expect(directed.code).toBe(0);
    expect(directed.stdout).toMatch(new RegExp(`^Directed group ${group} on t_[0-9a-f]{6} \\(panel-dynamic\\): \\d+ shots?`));
    expect(directed.stdout).toContain("multicam.direct: added");
    const after = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    expect(after.tracks.at(-1).clips.every((shot: { confidence?: number; reason?: string }) => shot.confidence !== undefined && shot.reason)).toBe(true);
    const report = JSON.parse(frameshell(["direct", group, "--from", "1", "--to", "4", "--json"]).stdout) as { low: unknown[]; template: string };
    expect(report.template).toBe("interview");
    expect(Array.isArray(report.low)).toBe(true);
    const wrong = frameshell(["direct", group, "--template", "news"]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("template");
  }, 120_000);
});

describe("frameshell multicam with separate mics", () => {
  it("creates a group with a separate mic file, maps cameras to it, and fixes the mic by hand", () => {
    const created = frameshell([
      ...["multicam", "create", "assets/ana.mp4", "assets/ben.mp4"],
      ...["--name", "Ana", "--name", "Ben", "--mic-file", "assets/rec.wav", "--mic-name", "Recorder", "--sound", "1", "--sound", "none"],
    ]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/ {2}mic recorder {2}Recorder {2}assets\/rec.wav {2}offset \d+(\.\d+)? s {2}confidence \d+% with (ana|ben)/);
    const json = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout);
    const group = json.groups.at(-1) as { id: string; angles: { id: string; mic?: string | null }[]; mics: { id: string; offset: number }[] };
    expect(group.angles.map((angle) => [angle.id, angle.mic])).toEqual([["ana", "recorder"], ["ben", null]]);
    // The recorder started 3 s after Ana's file: it plays 3 s into the group clock.
    expect(group.mics[0]!.offset).toBeCloseTo(3, 1);

    const fixed = frameshell(["multicam", "mic", group.id, "recorder", "--offset", "0.25", "--gain=-2", "--name", "Lav"]);
    expect(fixed.stderr).toBe("");
    expect(fixed.code).toBe(0);
    const again = JSON.parse(frameshell(["timeline", "show", "--json"]).stdout).groups.at(-1);
    expect(again.mics[0]).toMatchObject({ name: "Lav", offset: 0.25, audio: { gain: -2 } });

    const back = frameshell(["multicam", "angle", group.id, "ben", "--mic", "camera"]);
    expect(back.code).toBe(0);
    expect(JSON.parse(frameshell(["timeline", "show", "--json"]).stdout).groups.at(-1).angles[1]).not.toHaveProperty("mic");
    const bad = frameshell(["multicam", "angle", group.id, "ana", "--gain", "3"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("takes its sound from mic recorder");
  }, 120_000);
});

describe("frameshell multicam gallery", () => {
  it("cuts a gallery recording into tiles, prints their crops and the layout change", () => {
    const made = frameshell(["multicam", "gallery", "assets/call.mp4", "--name", "Ana", "--name", "Ben", "--name", "Zoe"]);
    expect(made.stderr).toBe("");
    expect(made.code).toBe(0);
    expect(made.stdout).toMatch(/Multicam group g_[0-9a-f]{6} · program track t_[0-9a-f]{6} · shot c_[0-9a-f]{6} \(grid, whole length\) · 3 tiles from 9 frames/);
    expect(made.stdout).toMatch(/ {2}zoe {2}Zoe {2}crop left 0\.2\d* top 0\.51\d* right 0\.2\d* bottom 0\.0\d* {2}confidence \d+%/);
    expect(made.stdout).toContain("0–3 s  4 tiles\n  3–9 s  3 tiles  (used)");
    expect(made.stdout).toContain("warning: the call layout changes at 3 s: 4 tiles before, 3 tiles after.");
    const wrong = frameshell(["multicam", "gallery", "assets/call.mp4", "--name", "Ana"]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("1 name(s) for 3 tiles");
  }, 120_000);
});

describe("parsing multicam commands", () => {
  it("maps arguments to the methods and refuses a wrong name count, a bad number or conflicting flags", () => {
    expect(parseTimelineCommand(["multicam", "create", "a.mp4", "b.mp4"], { name: ["A", "B"] })).toMatchObject({
      method: "multicam.create",
      params: { assets: ["a.mp4", "b.mp4"], names: ["A", "B"] },
    });
    expect(() => parseTimelineCommand(["multicam", "create", "a.mp4", "b.mp4"], { name: ["A"] })).toThrow(UsageError);
    expect(() => parseTimelineCommand(["multicam", "create", "a.mp4"], {})).toThrow(/takes 2\+ argument/);
    expect(parseTimelineCommand(["multicam", "gallery", "call.mp4"], { name: ["A", "B"], "group-name": "Standup", at: "62.5" })).toMatchObject({
      method: "multicam.gallery",
      params: { asset: "call.mp4", names: ["A", "B"], name: "Standup", at: 62.5 },
    });
    expect(() => parseTimelineCommand(["multicam", "gallery", "a.mp4", "b.mp4"], {})).toThrow(/takes 1 argument/);
    expect(() => parseTimelineCommand(["multicam", "gallery", "a.mp4"], { at: "soon" })).toThrow(/--at: expected a number/);
    expect(parseTimelineCommand(["multicam", "offset", "g_1", "ben", "1.5"], {})).toMatchObject({
      method: "multicam.offset",
      params: { group: "g_1", angle: "ben", offset: 1.5 },
    });
    expect(
      parseTimelineCommand(["multicam", "create", "a.mp4", "b.mp4"], { "mic-file": ["m.wav"], "mic-name": ["M"], sound: ["none", "1"], "group-name": "Talk" }),
    ).toMatchObject({ method: "multicam.create", params: { assets: ["a.mp4", "b.mp4"], mics: ["m.wav"], micNames: ["M"], soundOf: ["none", "1"], name: "Talk" } });
    expect(() => parseTimelineCommand(["multicam", "create", "a.mp4", "b.mp4"], { "mic-name": ["M"] })).toThrow(/one per --mic-file/);
    expect(parseTimelineCommand(["multicam", "mic", "g_1", "lav"], { offset: "0.5", gain: "-3", muted: true })).toMatchObject({
      method: "multicam.mic",
      params: { group: "g_1", mic: "lav", offset: 0.5, gain: -3, muted: true },
    });
    expect(() => parseTimelineCommand(["multicam", "mic", "g_1", "lav"], { offset: "later" })).toThrow(/--offset: expected a number/);
    expect(() => parseTimelineCommand(["multicam", "mic", "g_1", "lav"], { muted: true, unmuted: true })).toThrow(/not both/);
    expect(parseTimelineCommand(["multicam", "angle", "g_1", "ben"], { mic: "none" })).toMatchObject({ params: { mic: "none" } });
    expect(parseTimelineCommand(["multicam", "turns", "g_1"], {})).toMatchObject({ method: "multicam.turns", params: { group: "g_1" } });
    expect(() => parseTimelineCommand(["multicam", "turns"], {})).toThrow(UsageError);
    expect(() => parseTimelineCommand(["multicam", "offset", "g_1", "ben", "soon"], {})).toThrow(/expected a number/);
    expect(() => parseTimelineCommand(["multicam", "offset", "g_1", "ben", "1"], { "group-name": "x" })).toThrow(/does not take --group-name/);
    expect(parseTimelineCommand(["shot", "set", "c_1"], { layout: "two-up", angles: "ana, ben" })).toMatchObject({
      method: "shot.set",
      params: { clip: "c_1", shot: "two-up", angles: ["ana", "ben"] },
    });
    expect(() => parseTimelineCommand(["shot", "set", "c_1"], { angles: " , " })).toThrow(/angle ids separated by commas/);
    expect(parseTimelineCommand(["multicam", "angle", "g_1", "ben"], { "crop-top": "0.2", unmuted: true })).toMatchObject({
      method: "multicam.angle",
      params: { group: "g_1", angle: "ben", crop: { top: 0.2 }, muted: false },
    });
    expect(parseTimelineCommand(["multicam", "angle", "g_1", "ben"], { "clear-crop": true })).toMatchObject({ params: { crop: null } });
    expect(() => parseTimelineCommand(["multicam", "angle", "g_1", "ben"], { "clear-crop": true, "crop-left": "0.1" })).toThrow(/not both/);
    expect(() => parseTimelineCommand(["multicam", "angle", "g_1", "ben"], { muted: true, unmuted: true })).toThrow(/not both/);
    expect(parseTimelineCommand(["direct", "g_1"], { template: "podcast-calm", rules: "r.json", from: "2", to: "9", "replace-human": true })).toMatchObject({
      method: "multicam.direct",
      params: { group: "g_1", template: "podcast-calm", rules: "r.json", from: 2, to: 9, replaceHuman: true },
    });
    expect(parseTimelineCommand(["direct", "g_1"], {})!.params).toEqual({ group: "g_1" });
    expect(() => parseTimelineCommand(["direct"], {})).toThrow(/takes 1 argument/);
    expect(() => parseTimelineCommand(["direct", "g_1"], { layout: "solo" })).toThrow(/does not take --layout/);
    expect(parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { time: "12.5", x: "0.3" })).toMatchObject({
      method: "multicam.reframe",
      params: { group: "g_1", angle: "ana", time: 12.5, x: 0.3 },
    });
    expect(parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { at: "3", remove: true })).toMatchObject({ params: { at: 3, remove: true } });
    expect(parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { clear: true })!.params).toEqual({ group: "g_1", angle: "ana", clear: true });
    expect(() => parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { x: "0.3" })).toThrow(/--time <timeline seconds> or --at/);
    expect(() => parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { at: "1", time: "1", x: "0.3" })).toThrow(/one of them/);
    expect(() => parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { at: "1" })).toThrow(/--x and\/or --y/);
    expect(() => parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { at: "1", remove: true, x: "0.2" })).toThrow(/without --x/);
    expect(() => parseTimelineCommand(["multicam", "reframe", "g_1", "ana"], { clear: true, at: "1" })).toThrow(/without --at/);
  });
});
