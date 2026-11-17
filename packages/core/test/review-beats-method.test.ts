import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, run, testBinaryManager } from "./media-tools.js";

// `review` (#457) beats sheet and `cropAt` on a 2 s project (one black-then-white clip on a 1920x1080 film), real ffmpeg.
const MEDIA_TIMEOUT = 180_000;

let daemon: Daemon;
let conn: DaemonConnection;
let project: string;
let footage: string;
let clip: string;

beforeAll(async () => {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  conn = await connectToDaemon(daemon.socketPath, { client: "test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  footage = join(tempDir(), "steps.mp4");
  const { ffmpeg } = await mediaTools();
  const second = (color: string) => ["-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=30:d=1`];
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...second("black"),
    ...second("white"),
    ...["-filter_complex", "concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", footage],
  ]);
  const { imported } = await conn.request("asset.import", { cwd: project, files: [footage] });
  const video = (await conn.request("track.add", { cwd: project, kind: "video" })).changes.added[0]!;
  clip = (await conn.request("clip.add", { cwd: project, track: video, asset: imported[0]!.asset, start: 0, in: 0, out: 2 })).changes.added[0]!;
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("review: beats sheet", () => {
  it(
    "is left out with a warning without a tempo, and is never among the default sheets",
    async () => {
      const result = await conn.request("review", { cwd: project, sheets: ["beats"] });
      expect(result.sheets).toEqual([]);
      expect(result.warnings.some((warning) => warning.startsWith("beats: no beats sheet: the timeline has no tempo."))).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "shows one frame per beat of a 120 BPM tempo, a quarter beat after the hit, named bar and beat",
    async () => {
      await conn.request("tempo.set", { cwd: project, timeline: "main", bpm: 120 });
      const result = await conn.request("review", { cwd: project, sheets: ["beats"] });
      expect(result.sheets.map((sheet) => sheet.kind)).toEqual(["beats"]);
      const tiles = result.sheets[0]!.tiles;
      expect(tiles.map((tile) => tile.frame)).toEqual([3, 18, 33, 48]);
      expect(tiles.every((tile) => tile.tag === "beat")).toBe(true);
      expect(tiles.map((tile) => tile.label)).toEqual(["0.10 bar 1", "0.60 beat 2", "1.10 beat 3", "1.60 beat 4"]);
      const defaults = await conn.request("review", { cwd: project, sheets: undefined });
      expect(defaults.sheets.some((sheet) => sheet.kind === "beats")).toBe(false);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "warns instead of failing for a file",
    async () => {
      const result = await conn.request("review", { cwd: project, file: footage, sheets: ["beats"] });
      expect(result.sheets).toEqual([]);
      expect(result.warnings).toContain("beats: a file has no tempo grid: review the timeline for the beats sheet.");
    },
    MEDIA_TIMEOUT,
  );
});

describe("review: cropAt", () => {
  it(
    "crops every tile around a point of the frame and says which part each tile shows",
    async () => {
      const result = await conn.request("review", { cwd: project, sheets: ["phone"], cropAt: { x: 0.5, y: 0.5 } });
      const tiles = result.sheets[0]!.tiles;
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) expect(tile.crop).toEqual({ x: 720, y: 405, width: 480, height: 270 });
      const plain = await conn.request("review", { cwd: project, sheets: ["phone"] });
      expect(plain.sheets[0]!.tiles.every((tile) => tile.crop === undefined)).toBe(true);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "follows a point of a clip through its keyed move",
    async () => {
      await conn.request("clip.key", { cwd: project, timeline: "main", clip, prop: "x", time: 0, value: 0 });
      await conn.request("clip.key", { cwd: project, timeline: "main", clip, prop: "x", time: 2, value: 480 });
      const result = await conn.request("review", { cwd: project, sheets: ["phone"], cropAt: { x: 0.5, y: 0.5, size: 0.2, clip } });
      const [first, second] = result.sheets[0]!.tiles;
      expect(first!.frame).toBe(0);
      expect(second!.frame).toBe(30);
      expect(first!.crop!.width).toBe(384);
      // The clip moves 480 project px in 2 s: 240 px between the two frames a second apart.
      expect(Math.abs(second!.crop!.x - first!.crop!.x - 240)).toBeLessThanOrEqual(3);
      expect(second!.crop!.y).toBe(first!.crop!.y);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses a clip for a file and a clip the timeline does not have",
    async () => {
      const refused = (params: object) =>
        conn.request("review", params as never).then(
          () => null,
          (error: unknown) => error,
        );
      const file = await refused({ cwd: project, file: footage, sheets: ["phone"], cropAt: { x: 0.5, y: 0.5, clip } });
      expect(file).toBeInstanceOf(RpcError);
      expect((file as RpcError).code).toBe(ErrorCode.InvalidOperation);
      const missing = await refused({ cwd: project, sheets: ["phone"], cropAt: { x: 0.5, y: 0.5, clip: "c_nope" } });
      expect((missing as RpcError).code).toBe(ErrorCode.InvalidOperation);
      expect((missing as RpcError).message).toContain("c_nope");
    },
    MEDIA_TIMEOUT,
  );
});
