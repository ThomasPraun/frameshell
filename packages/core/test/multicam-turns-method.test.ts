import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip, makeVoiceClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `multicam.turns` through a real daemon: three synthetic mics with alternating tones, the others bleeding in at -20 dB.
const MEDIA_TIMEOUT = 180_000;
const TOLERANCE = 0.12;

type Burst = readonly [number, number, number];
// Ana pauses 0.2 s inside her first turn; Zoe's 0.15 s cough is no turn; Ana and Ben overlap at 9.8-10.5.
const ANA: Burst[] = [
  [1.0, 1.0, 440],
  [2.2, 1.8, 440],
  [9.5, 1.0, 440],
];
const BEN: Burst[] = [
  [4.5, 3.0, 550],
  [9.8, 1.2, 550],
];
const ZOE: Burst[] = [
  [7.8, 1.0, 660],
  [12.0, 0.15, 660],
];
const others = (own: Burst[]) => [ANA, BEN, ZOE].filter((list) => list !== own).flat();

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
const files: Record<string, string> = {};

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "cli/test", session: "term-1" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const footage = tempDir();
  await makeVoiceClip(join(footage, "ana.mp4"), { own: ANA, bleed: others(ANA) });
  // Ben's recording started 1.5 s after the others'.
  await makeVoiceClip(join(footage, "ben.mp4"), { own: BEN, bleed: others(BEN), shiftS: 1.5, durationS: 12.5 });
  await makeVoiceClip(join(footage, "zoe.mp4"), { own: ZOE, bleed: others(ZOE) });
  await makeClip(join(footage, "mute.mp4"), { durationS: 8, silent: true });
  // Silent cameras: the picture of people whose sound is recorded on separate mics.
  for (const name of ["cam1", "cam2", "cam3", "cam4", "cam5"]) await makeClip(join(footage, `${name}.mp4`), { durationS: 8, silent: true });
  const names = ["ana", "ben", "zoe", "mute", "cam1", "cam2", "cam3", "cam4", "cam5"];
  const { imported } = await conn.request("asset.import", { cwd: project, files: names.map((name) => join(footage, `${name}.mp4`)) });
  for (const entry of imported) files[entry.asset.split("/").pop()!.replace(".mp4", "")] = entry.asset;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("multicam.turns", () => {
  it("finds each person's turns on the group clock, ignoring bleed, keeping overlaps and dropping a cough", async () => {
    const created = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["ana"]!, files["ben"]!, files["zoe"]!],
      names: ["Ana", "Ben", "Zoe"],
    });
    // Set by hand so the test does not depend on the audio sync: Ben's file plays from 1.5 s on the group clock.
    for (const [angle, offset] of [["ana", 0], ["ben", 1.5], ["zoe", 0]] as const) {
      await conn.request("multicam.offset", { cwd: project, group: created.group, angle, offset });
    }

    const result = await conn.request("multicam.turns", { cwd: project, group: created.group });
    expect(result.group).toBe(created.group);
    expect(result.warnings).toEqual([]);
    expect(result.duration).toBeCloseTo(14, 0);
    const expected = [
      ["ana", "Ana", 1.0, 4.0],
      ["ben", "Ben", 4.5, 7.5],
      ["zoe", "Zoe", 7.8, 8.8],
      ["ana", "Ana", 9.5, 10.5],
      ["ben", "Ben", 9.8, 11.0],
    ] as const;
    expect(result.turns).toHaveLength(expected.length);
    result.turns.forEach((turn, i) => {
      const [angle, name, start, end] = expected[i]!;
      expect([turn.angle, turn.name]).toEqual([angle, name]);
      expect(Math.abs(turn.start - start)).toBeLessThan(TOLERANCE);
      expect(Math.abs(turn.end - end)).toBeLessThan(TOLERANCE);
    });
  }, MEDIA_TIMEOUT);

  it("warns about an angle without sound and refuses an unknown group", async () => {
    const created = await conn.request("multicam.create", { cwd: project, assets: [files["ana"]!, files["mute"]!], names: ["Ana", "Mute"] });
    const result = await conn.request("multicam.turns", { cwd: project, group: created.group });
    expect(result.turns.length).toBeGreaterThan(0);
    expect(result.turns.every((turn) => turn.angle === "ana")).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining("Mute (assets/mute.mp4) has no sound")]);
    await expect(conn.request("multicam.turns", { cwd: project, group: "g_nope" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining(created.group),
      data: expect.objectContaining({ groups: expect.arrayContaining([created.group]) }),
    });
  }, MEDIA_TIMEOUT);

  it("takes turns from each angle's mic: a separate file with its own offset, shared by two angles, none for a wide camera", async () => {
    const created = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["cam1"]!, files["cam2"]!, files["cam3"]!, files["cam4"]!, files["cam5"]!],
      names: ["Ana", "Ben", "Ana 2", "Wide", "Zoe"],
      mics: [files["ana"]!, files["ben"]!, files["zoe"]!],
      micNames: ["Ana mic", "Ben mic", "Zoe mic"],
      soundOf: ["1", "2", "1", "none", "3"],
    });
    // The mics are voice clips with video; their sync is not under test here, so Ben's mic is set to 1.5 s by hand.
    for (const [mic, offset] of [["ana-mic", 0], ["ben-mic", 1.5], ["zoe-mic", 0]] as const) {
      await conn.request("multicam.mic", { cwd: project, group: created.group, mic, offset });
    }
    const result = await conn.request("multicam.turns", { cwd: project, group: created.group });
    expect(result.warnings).toEqual([]);
    const spans = (angle: string) => result.turns.filter((turn) => turn.angle === angle).map((turn) => [turn.start, turn.end]);
    const near = (actual: number[][], expected: number[][]) => {
      expect(actual).toHaveLength(expected.length);
      actual.forEach(([start, end], i) => {
        expect(Math.abs(start! - expected[i]![0]!)).toBeLessThan(TOLERANCE);
        expect(Math.abs(end! - expected[i]![1]!)).toBeLessThan(TOLERANCE);
      });
    };
    near(spans("ana"), [[1.0, 4.0], [9.5, 10.5]]);
    near(spans("ben"), [[4.5, 7.5], [9.8, 11.0]]);
    near(spans("zoe"), [[7.8, 8.8]]);
    // Ana's second camera hears the same mic: the same turns. The wide camera has none.
    near(spans("ana-2"), [[1.0, 4.0], [9.5, 10.5]]);
    expect(spans("wide")).toEqual([]);
  }, MEDIA_TIMEOUT);
});
