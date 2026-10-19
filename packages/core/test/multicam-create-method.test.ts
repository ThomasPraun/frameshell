import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstAudio, makeBurstClip, makeClip } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `multicam.create` / `multicam.offset` through a real daemon: synthetic files that share tone bursts at known offsets
// (real managed ffmpeg), and files that share nothing.
const MEDIA_TIMEOUT = 180_000;
/** One frame at the 30 fps project default. */
const FRAME = 1 / 30;

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
  // Ben's recording started 2.34 s after Ana's, Zoe's 1.1 s before it (she hears the bursts later).
  await makeBurstClip(join(footage, "ana.mp4"), { shiftS: 0 });
  await makeBurstClip(join(footage, "ben.mp4"), { shiftS: 2.34, durationS: 9 });
  await makeBurstClip(join(footage, "zoe.mp4"), { shiftS: -1.1, durationS: 12 });
  // A constant tone has nothing to match; other bursts at other times share nothing with the pattern.
  await makeClip(join(footage, "hum.mp4"), { durationS: 8 });
  await makeBurstClip(join(footage, "other.mp4"), {
    bursts: [
      [0.4, 0.9, 300],
      [3.3, 0.2, 500],
      [4.1, 0.6, 350],
      [9.5, 0.3, 450],
    ],
  });
  await makeClip(join(footage, "mute.mp4"), { durationS: 8, silent: true });
  await makeClip(join(footage, "mute2.mp4"), { durationS: 8, silent: true });
  // A wide camera whose own sound is faint scratch audio, and two recorders that started at their own times.
  await makeBurstClip(join(footage, "wide.mp4"), { shiftS: 0 });
  await makeBurstAudio(join(footage, "ana-rec.wav"), { shiftS: 3, durationS: 10 });
  await makeBurstAudio(join(footage, "ben-rec.wav"), { shiftS: -0.7, durationS: 14 });
  await makeBurstClip(join(footage, "anacam.mp4"), { shiftS: 0.5, durationS: 11 });
  await makeBurstClip(join(footage, "bencam.mp4"), { shiftS: 1, durationS: 11 });
  await makeBurstClip(join(footage, "bencam2.mp4"), { shiftS: 1.4, durationS: 11 });
  const names = ["ana", "ben", "zoe", "hum", "other", "mute", "mute2", "wide", "anacam", "bencam", "bencam2"];
  const { imported } = await conn.request("asset.import", { cwd: project, files: names.map((name) => join(footage, `${name}.mp4`)) });
  for (const entry of imported) files[entry.asset.split("/").pop()!.replace(".mp4", "")] = entry.asset;
  const recorders = ["ana-rec", "ben-rec"];
  const { imported: recorded } = await conn.request("asset.import", { cwd: project, files: recorders.map((name) => join(footage, `${name}.wav`)) });
  for (const entry of recorded) files[entry.asset.split("/").pop()!.replace(".wav", "")] = entry.asset;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("multicam.create", () => {
  it("syncs files that share sound at different offsets to within one frame and builds the group, track and grid shot", async () => {
    const result = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["ana"]!, files["ben"]!, files["zoe"]!],
      names: ["Ana", "Ben", "Zoe"],
    });
    // Zoe's file starts earliest (1.1 s before Ana's), so she is at 0 and the others shift.
    const byName = Object.fromEntries(result.sync.map((angle) => [angle.name, angle]));
    expect(byName["Zoe"]!.offset).toBeLessThan(FRAME);
    expect(Math.abs(byName["Ana"]!.offset - 1.1)).toBeLessThan(FRAME);
    expect(Math.abs(byName["Ben"]!.offset - (1.1 + 2.34))).toBeLessThan(FRAME);
    expect(result.sync.map((angle) => angle.synced)).toEqual([true, true, true]);
    expect(result.sync[0]!.confidence).toBeNull();
    for (const angle of result.sync.slice(1)) expect(angle.confidence).toBeGreaterThan(0.6);
    expect(result.warnings).toEqual([]);

    const shown = await conn.request("timeline.show", { cwd: project });
    expect(shown.groups).toEqual([
      { id: result.group, angles: result.sync.map((angle) => ({ id: angle.angle, name: angle.name, asset: angle.asset, offset: angle.offset })) },
    ]);
    const program = shown.tracks.find((track) => track.id === result.track)!;
    expect(program).toMatchObject({ kind: "program", group: result.group });
    expect(program.clips).toEqual([expect.objectContaining({ id: result.clip, type: "shot", shot: "grid", start: 0, in: 0, angles: ["ana", "ben", "zoe"] })]);
    // The group ends with the latest file: Ana (12 s) starting at 1.1 s.
    expect(program.clips[0]!["out"]).toBeCloseTo(13.1, 1);

    const history = await conn.request("history", { cwd: project });
    expect(history.transactions.at(-1)!.operations.map((op) => op.op)).toEqual(["multicam.create"]);
  }, MEDIA_TIMEOUT);

  it("warns and keeps offset 0 for files with no shared audio", async () => {
    const result = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["ana"]!, files["hum"]!, files["other"]!],
      names: ["Ana", "Hum", "Other"],
      name: "Odd ones out",
    });
    expect(result.sync.map((angle) => [angle.name, angle.offset, angle.synced])).toEqual([
      ["Ana", 0, true],
      ["Hum", 0, false],
      ["Other", 0, false],
    ]);
    for (const angle of result.sync.slice(1)) expect(angle.confidence).toBeLessThan(0.5);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain(`frameshell multicam offset ${result.group} hum <seconds>`);
  }, MEDIA_TIMEOUT);

  it("keeps a file without sound as an unsynced angle with a warning, also as the first file", async () => {
    const result = await conn.request("multicam.create", { cwd: project, assets: [files["ana"]!, files["mute"]!], names: ["Ana", "Mute"] });
    expect(result.sync.map((angle) => [angle.name, angle.offset, angle.synced, angle.confidence])).toEqual([
      ["Ana", 0, true, null],
      ["Mute", 0, false, 0],
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`frameshell multicam offset ${result.group} mute <seconds>`);
    // The first file with sound sets the clock: a silent first camera starts with it.
    const silentFirst = await conn.request("multicam.create", { cwd: project, assets: [files["mute"]!, files["ben"]!], names: ["Mute", "Ben"] });
    expect(silentFirst.sync.map((angle) => [angle.name, angle.offset, angle.synced, angle.confidence])).toEqual([
      ["Mute", 0, false, 0],
      ["Ben", 0, true, null],
    ]);
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["mute"]!, files["mute2"]!] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("none of the files has sound"),
    });
  }, MEDIA_TIMEOUT);

  it("syncs cameras and separate mics against each other, maps mics to angles and shares one mic between two", async () => {
    const result = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["wide"]!, files["anacam"]!, files["bencam"]!, files["bencam2"]!],
      names: ["Wide", "Ana", "Ben", "Ben close"],
      mics: [files["ana-rec"]!, files["ben-rec"]!],
      micNames: ["Ana rec", "Ben rec"],
      soundOf: ["none", "1", "2", "2"],
    });
    // Absolute starts: wide 0, Ana cam 0.5, Ben cam 1, Ben close 1.4, Ana rec 3, Ben rec -0.7 (earliest, so the others shift by 0.7).
    const offsets = Object.fromEntries(result.sync.map((file) => [file.angle, file.offset]));
    const expected = { wide: 0.7, ana: 1.2, ben: 1.7, "ben-close": 2.1, "ana-rec": 3.7, "ben-rec": 0 };
    for (const [id, offset] of Object.entries(expected)) expect(Math.abs(offsets[id]! - offset)).toBeLessThan(FRAME);
    expect(result.sync.map((file) => file.kind)).toEqual(["camera", "camera", "camera", "camera", "mic", "mic"]);
    expect(result.sync.filter((file) => file.confidence === null)).toHaveLength(1);
    expect(result.sync.every((file) => file.synced)).toBe(true);
    expect(result.sync.find((file) => file.confidence !== null)!.against).not.toBeNull();
    expect(result.warnings).toEqual([]);

    const group = (await conn.request("timeline.show", { cwd: project })).groups!.find((candidate) => candidate.id === result.group)!;
    expect(group.angles.map((angle) => [angle.id, angle.mic])).toEqual([
      ["wide", null],
      ["ana", "ana-rec"],
      ["ben", "ben-rec"],
      ["ben-close", "ben-rec"],
    ]);
    expect(group.mics!.map((mic) => [mic.id, mic.asset])).toEqual([
      ["ana-rec", files["ana-rec"]],
      ["ben-rec", files["ben-rec"]],
    ]);
    // The cameras' longest end: Ben close at 2.1 + 11 s.
    const program = (await conn.request("timeline.show", { cwd: project })).tracks.find((track) => track.id === result.track)!;
    expect(program.clips[0]!["out"]).toBeCloseTo(13.1, 1);
  }, MEDIA_TIMEOUT);

  it("defaults to camera n with mic n, and refuses a bad soundOf and a mic that is not sound", async () => {
    const result = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["anacam"]!, files["bencam"]!, files["wide"]!],
      mics: [files["ana-rec"]!, files["ben-rec"]!],
    });
    const group = (await conn.request("timeline.show", { cwd: project })).groups!.find((candidate) => candidate.id === result.group)!;
    expect(group.angles.map((angle) => angle.mic)).toEqual(["ana-rec", "ben-rec", undefined]);
    await expect(
      conn.request("multicam.create", { cwd: project, assets: [files["anacam"]!, files["bencam"]!], mics: [files["ana-rec"]!], soundOf: ["1", "3"] }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining('soundOf "3"') });
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["anacam"]!, files["bencam"]!], soundOf: ["camera"] })).rejects.toMatchObject({
      message: expect.stringContaining("1 soundOf entries for 2 camera(s)"),
    });
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["anacam"]!, files["bencam"]!], mics: [files["mute"]!] })).rejects.toMatchObject({
      message: expect.stringContaining("has no sound; a mic needs an audio stream"),
    });
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["anacam"]!, files["bencam"]!], mics: [files["anacam"]!] })).rejects.toMatchObject({
      message: expect.stringContaining("a file is listed twice"),
    });
  }, MEDIA_TIMEOUT);

  it("syncs a recorder that only matches a camera other than the first, and warns with the mic command when it matches nothing", async () => {
    const result = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["mute"]!, files["anacam"]!],
      mics: [files["ana-rec"]!],
      soundOf: ["camera", "1"],
    });
    // The first camera is silent: the reference is the first file with sound, Ana cam, and the recorder lands against it.
    expect(result.sync.map((file) => [file.angle, file.synced, file.against])).toEqual([
      ["mute", false, null],
      ["anacam", true, null],
      ["ana-rec", true, "anacam"],
    ]);
    const lost = await conn.request("multicam.create", { cwd: project, assets: [files["anacam"]!, files["bencam"]!], mics: [files["hum"]!], soundOf: ["camera", "camera"] });
    expect(lost.sync.at(-1)).toMatchObject({ kind: "mic", angle: "hum", synced: false });
    expect(lost.warnings).toEqual([expect.stringContaining(`frameshell multicam mic ${lost.group} hum --offset <seconds>`)]);
  }, MEDIA_TIMEOUT);

  it("fixes a mic by hand with multicam.mic and moves an angle to another mic with multicam.angle, journaled and reverted", async () => {
    const created = await conn.request("multicam.create", {
      cwd: project,
      assets: [files["anacam"]!, files["bencam"]!],
      mics: [files["ana-rec"]!, files["ben-rec"]!],
    });
    const show = async () => (await conn.request("timeline.show", { cwd: project })).groups!.find((candidate) => candidate.id === created.group)!;
    const fixed = await conn.request("multicam.mic", { cwd: project, group: created.group, mic: "ana-rec", offset: 0.25, gain: -4 });
    expect(fixed.operation.op).toBe("multicam.mic");
    expect((await show()).mics![0]).toMatchObject({ offset: 0.25, audio: { gain: -4 } });
    const moved = await conn.request("multicam.angle", { cwd: project, group: created.group, angle: "bencam", mic: "ana-rec" });
    expect((await show()).angles[1]!.mic).toBe("ana-rec");
    await conn.request("revert", { cwd: project, target: moved.operation.id });
    expect((await show()).angles[1]!.mic).toBe("ben-rec");
    await conn.request("revert", { cwd: project, target: fixed.operation.id });
    expect((await show()).mics![0]).not.toHaveProperty("audio");
  }, MEDIA_TIMEOUT);

  it("fixes an angle by hand with multicam.offset, journaled and reverted", async () => {
    const created = await conn.request("multicam.create", { cwd: project, assets: [files["ana"]!, files["hum"]!] });
    const offsetOf = async () => (await conn.request("timeline.show", { cwd: project })).groups!.find((g) => g.id === created.group)!.angles[1]!.offset;
    const fixed = await conn.request("multicam.offset", { cwd: project, group: created.group, angle: "hum", offset: 0.5 });
    expect(fixed.operation.op).toBe("multicam.offset");
    expect(fixed.changes.updated).toEqual([created.group]);
    expect(await offsetOf()).toBe(0.5);
    await conn.request("revert", { cwd: project, target: fixed.operation.id });
    expect(await offsetOf()).toBe(0);
  }, MEDIA_TIMEOUT);

  it("refuses a missing file, a wrong name count, a file outside the project and a single file", async () => {
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["ana"]!, "assets/nope.mp4"] })).rejects.toMatchObject({
      code: ErrorCode.AssetNotFound,
    });
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["ana"]!, files["ben"]!], names: ["Ana"] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("1 name(s) for 2 file(s)"),
    });
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["ana"]!, join(tempDir(), "x.mp4")] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("outside the project"),
    });
    await expect(conn.request("multicam.create", { cwd: project, assets: [files["ana"]!] })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
