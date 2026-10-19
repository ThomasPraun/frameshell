import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeBurstClip, makeClip } from "./media-fixtures.js";
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
  const names = ["ana", "ben", "zoe", "hum", "other"];
  const { imported } = await conn.request("asset.import", { cwd: project, files: names.map((name) => join(footage, `${name}.mp4`)) });
  for (const entry of imported) files[entry.asset.split("/").pop()!.replace(".mp4", "")] = entry.asset;
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
