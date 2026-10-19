import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Timeline, groupSounds } from "@frameshell/schema";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { GALLERY_FOUR, GALLERY_THREE, makeClip, makeGallery } from "./media-fixtures.js";
import { testBinaryManager } from "./media-tools.js";

// `multicam.gallery` through a real daemon and managed ffmpeg: synthetic gallery recordings (moving test patterns
// on a dark gray background) whose layout changes from four tiles to three halfway.
const MEDIA_TIMEOUT = 180_000;
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
  await makeGallery(join(footage, "call.mp4"), [GALLERY_FOUR, GALLERY_THREE, GALLERY_THREE], 4);
  await makeGallery(join(footage, "steady.mp4"), [GALLERY_FOUR], 6);
  await makeClip(join(footage, "camera.mp4"), { width: 320, height: 180, durationS: 4 });
  const { imported } = await conn.request("asset.import", { cwd: project, files: ["call", "steady", "camera"].map((name) => join(footage, `${name}.mp4`)) });
  for (const entry of imported) files[entry.asset.split("/").pop()!.replace(".mp4", "")] = entry.asset;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("multicam.gallery", () => {
  it(
    "cuts one angle per tile of the layout held longest, warns where the layout changes, and plays the sound once",
    async () => {
      const result = await conn.request("multicam.gallery", { cwd: project, asset: files["call"]!, names: ["Ana", "Ben", "Zoe"], name: "Standup" });
      expect(methods["multicam.gallery"].result.parse(result)).toEqual(result);
      expect(result.samples).toBe(12);
      expect(result.layouts).toEqual([
        { start: 0, end: 4, tiles: 4, used: false },
        { start: 4, end: 12, tiles: 3, used: true },
      ]);
      expect(result.tiles.map((tile) => [tile.angle, tile.name])).toEqual([
        ["ana", "Ana"],
        ["ben", "Ben"],
        ["zoe", "Zoe"],
      ]);
      // Tiles sit at whole pixels of a 640×360 frame; compression may blur an edge by a pixel or two.
      const expected = GALLERY_THREE.map(([x, y]) => ({ left: x / 640, top: y / 360, right: (640 - x - 308) / 640, bottom: (360 - y - 168) / 360 }));
      result.tiles.forEach((tile, i) => {
        for (const side of ["left", "top", "right", "bottom"] as const) expect(Math.abs((tile.crop[side] ?? 0) - expected[i]![side])).toBeLessThan(0.01);
      });
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.mic).toBe("call");
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          "the call layout changes at 4 s: 4 tiles before, 3 tiles after.",
          expect.stringContaining("the tiles follow the layout of 4–12 s (3 tiles)"),
          expect.stringContaining(`frameshell transcribe --speakers ${files["call"]} --people 3`),
        ]),
      );

      const timeline = JSON.parse(readFileSync(join(project, "timelines", "main.json"), "utf8")) as Timeline;
      const group = timeline.groups!.find((candidate) => candidate.id === result.group)!;
      expect(group.angles.every((angle) => angle.asset === files["call"] && angle.offset === 0 && angle.mic === "call")).toBe(true);
      expect(new Set(group.angles.map((angle) => JSON.stringify(angle.crop))).size).toBe(3);
      expect(groupSounds(group).map((sound) => sound.asset)).toEqual([files["call"]]);
      const program = timeline.tracks.find((track) => track.id === result.track)!;
      expect(program).toMatchObject({ kind: "program", name: "Standup", group: result.group, clips: [{ shot: "grid", start: 0, in: 0, out: 12 }] });

      // Without speakers on the call's transcript every tile hears the same mixed track.
      const turns = await conn.request("multicam.turns", { cwd: project, group: result.group });
      const spans = (angle: string) => turns.turns.filter((turn) => turn.angle === angle).map(({ start, end }) => [start, end]);
      expect(spans("ana").length).toBeGreaterThan(0);
      expect(spans("ben")).toEqual(spans("ana"));
      expect(spans("zoe")).toEqual(spans("ana"));

      const history = await conn.request("history", { cwd: project });
      expect(history.transactions.at(-1)!.operations.map((op) => op.op)).toEqual(["multicam.gallery"]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "takes the layout playing at `at`, and a steady gallery gives no layout warning",
    async () => {
      const early = await conn.request("multicam.gallery", { cwd: project, asset: files["call"]!, at: 1 });
      expect(early.tiles.map((tile) => tile.name)).toEqual(["Tile 1", "Tile 2", "Tile 3", "Tile 4"]);
      expect(early.layouts.map((layout) => layout.used)).toEqual([true, false]);

      const steady = await conn.request("multicam.gallery", { cwd: project, asset: files["steady"]! });
      expect(steady.layouts).toEqual([{ start: 0, end: 6, tiles: 4, used: true }]);
      expect(steady.warnings.filter((warning) => warning.includes("layout"))).toEqual([]);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a file without a tile grid, wrong names and a file outside the project",
    async () => {
      await expect(conn.request("multicam.gallery", { cwd: project, asset: files["camera"]! })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringContaining("found no tile grid"),
      });
      await expect(conn.request("multicam.gallery", { cwd: project, asset: files["steady"]!, names: ["Ana", "Ben"] })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        data: expect.objectContaining({ field: "names", tiles: 4 }),
      });
      await expect(conn.request("multicam.gallery", { cwd: project, asset: join(tempDir(), "x.mp4") })).rejects.toMatchObject({
        code: ErrorCode.InvalidOperation,
        message: expect.stringContaining("outside the project"),
      });
    },
    MEDIA_TIMEOUT,
  );
});
