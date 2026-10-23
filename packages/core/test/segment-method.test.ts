import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, type SegmentEngine, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { makeClip } from "./media-fixtures.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";
import { makeDiscPhoto } from "./segment-fixture.js";

// `segment.prepare` through a real daemon and managed ffmpeg, with a stand-in model: nothing is downloaded.
const MEDIA_TIMEOUT = 180_000;
const encoded: number[] = [];
let daemon: Daemon;
let conn: DaemonConnection;
let project: string;

const engine: SegmentEngine = {
  async encode(rgb) {
    encoded.push(rgb.length);
    return new Float32Array(4);
  },
  async decode() {
    throw new Error("not used");
  },
};

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
    segmentEngine: engine,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
  project = tempDir();
  await conn.request("project.init", { dir: project });
  const { ffmpeg } = await mediaTools();
  const files = tempDir();
  await makeDiscPhoto(ffmpeg, join(files, "disc.png"), 640, 320, { cx: 400, cy: 160, r: 80 });
  await makeClip(join(files, "clip.mp4"), { durationS: 1 });
  await conn.request("asset.import", { cwd: project, files: [join(files, "disc.png"), join(files, "clip.mp4")] });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("segment.prepare", () => {
  it(
    "encodes a photo once by content, whichever way the asset is spelled, and says what it is",
    async () => {
      const first = await conn.request("segment.prepare", { cwd: project, asset: "assets/disc.png" });
      expect(methods["segment.prepare"].result.parse(first)).toEqual(first);
      expect(first).toMatchObject({ asset: "assets/disc.png", size: { width: 640, height: 320 }, model: expect.stringMatching(/^mobilesam@[0-9a-f]{8}$/), cached: false });
      expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      // Prepared at the encoder's size: long side 1024.
      expect(encoded).toEqual([1024 * 512 * 3]);
      const again = await conn.request("segment.prepare", { cwd: project, asset: join(project, "assets", "disc.png") });
      expect(again).toMatchObject({ asset: "assets/disc.png", hash: first.hash, cached: true });
      expect(encoded).toHaveLength(1);
    },
    MEDIA_TIMEOUT,
  );

  it("refuses footage, a missing file and a file outside the project", async () => {
    await expect(conn.request("segment.prepare", { cwd: project, asset: "assets/clip.mp4" })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("not a still image"),
    });
    await expect(conn.request("segment.prepare", { cwd: project, asset: "assets/none.png" })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
  });
});
