import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBurstClip } from "../../core/test/media-fixtures.js";
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
  expect(frameshell(["import", join(footage, "ana.mp4"), join(footage, "ben.mp4")]).code).toBe(0);
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
});

describe("parsing multicam commands", () => {
  it("maps arguments to the methods and refuses a wrong name count, a bad number or conflicting flags", () => {
    expect(parseTimelineCommand(["multicam", "create", "a.mp4", "b.mp4"], { name: ["A", "B"] })).toMatchObject({
      method: "multicam.create",
      params: { assets: ["a.mp4", "b.mp4"], names: ["A", "B"] },
    });
    expect(() => parseTimelineCommand(["multicam", "create", "a.mp4", "b.mp4"], { name: ["A"] })).toThrow(UsageError);
    expect(() => parseTimelineCommand(["multicam", "create", "a.mp4"], {})).toThrow(/takes 2\+ argument/);
    expect(parseTimelineCommand(["multicam", "offset", "g_1", "ben", "1.5"], {})).toMatchObject({
      method: "multicam.offset",
      params: { group: "g_1", angle: "ben", offset: 1.5 },
    });
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
  });
});
