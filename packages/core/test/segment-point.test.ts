import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, type SegmentEngine, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, testBinaryManager } from "./media-tools.js";
import { makeDiscPhoto } from "./segment-fixture.js";

// `inspect.point` with `segment` through a real daemon, managed ffmpeg and a stand-in model: nothing is downloaded.
const MEDIA_TIMEOUT = 180_000;
const decoded: { x: number; y: number }[] = [];
let daemon: Daemon;
let conn: DaemonConnection;
let images: string;
let video: string;

/** Every answer is the left half of the encoder's picture; the scores rise with the mask number. */
const engine: SegmentEngine = {
  async encode() {
    return new Float32Array(4);
  },
  async decode(_embedding, point, size) {
    decoded.push(point);
    const logits = new Float32Array(4 * size.width * size.height).fill(-1);
    for (let mask = 0; mask < 4; mask++) {
      for (let y = 0; y < size.height; y++) logits.fill(1, mask * size.width * size.height + y * size.width, mask * size.width * size.height + y * size.width + size.width / 2);
    }
    return { logits, scores: new Float32Array([0, 0.4, 0.6, 0.9]), width: size.width, height: size.height };
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
  const { ffmpeg } = await mediaTools();
  const files = tempDir();
  await makeDiscPhoto(ffmpeg, join(files, "disc.png"), 640, 360, { cx: 200, cy: 180, r: 80 });
  images = tempDir();
  await conn.request("project.init", { dir: images, kind: "image" });
  await conn.request("asset.import", { cwd: images, files: [join(files, "disc.png")] });
  const photoTrack = (await conn.request("track.add", { cwd: images, kind: "video" })).changes.added[0]!;
  // Half size, 100 px right, 50 px down: the photo fills 960x540 with its corner at (580, 320).
  await conn.request("clip.add", { cwd: images, track: photoTrack, asset: "assets/disc.png", start: 0, duration: 3, transform: { scale: 0.5, x: 100, y: 50 } });
  video = tempDir();
  await conn.request("project.init", { dir: video });
  await conn.request("asset.import", { cwd: video, files: [join(files, "disc.png")] });
  const videoTrack = (await conn.request("track.add", { cwd: video, kind: "video" })).changes.added[0]!;
  await conn.request("clip.add", { cwd: video, track: videoTrack, asset: "assets/disc.png", start: 0, duration: 3 });
}, MEDIA_TIMEOUT);

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("inspect.point segment", () => {
  it(
    "maps a preview pixel into the photo, writes three masks the model's answer fills, and gc sweeps them",
    async () => {
      // The photo fills 960x540 with its corner at (580, 320): pixel (760, 455) is asset pixel (120, 90).
      const point = await conn.request("inspect.point", { cwd: images, timeline: "main", at: 1, x: 760, y: 455, unit: "pixel", segment: true });
      expect(methods["inspect.point"].result.parse(point)).toEqual(point);
      // The decoder gets the click in the encoder's space: the photo is 640x360 and already fits 1024 px: x1.6.
      expect(decoded.at(-1)).toEqual({ x: 120 * 1.6, y: 90 * 1.6 });
      const segment = point.segment!;
      expect(segment).toMatchObject({ asset: "assets/disc.png", size: { width: 640, height: 360 }, chosen: 2 });
      expect(segment.model).toMatch(/^mobilesam@[0-9a-f]{8}$/);
      expect(segment.masks.map((mask) => mask.mask)).toEqual([1, 2, 3].map((k) => `.frameshell/context/m_0030_120_90_${k}.png`));
      expect(segment.masks[2]).toMatchObject({ bbox: [0, 0, 320, 360], area: 0.5 });
      for (const { mask } of segment.masks) expect(existsSync(join(images, mask))).toBe(true);
      expect(readFileSync(join(images, segment.masks[0]!.mask)).subarray(1, 4).toString()).toBe("PNG");

      const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
      for (const { mask } of segment.masks) utimesSync(join(images, mask), old, old);
      const swept = await conn.request("gc", { cwd: images });
      expect(swept.removed.filter((entry) => entry.kind === "context").map((entry) => entry.path).sort()).toEqual(segment.masks.map((mask) => mask.mask));
      expect(existsSync(join(images, segment.masks[0]!.mask))).toBe(false);
    },
    MEDIA_TIMEOUT,
  );

  it(
    "ignores `segment` in a video project and without the option",
    async () => {
      const before = decoded.length;
      const refused = await conn.request("inspect.point", { cwd: video, timeline: "main", at: 1, x: 0.5, y: 0.5, segment: true });
      expect(refused).toMatchObject({ target: expect.any(String), segmentUnavailable: "not an image project" });
      expect(refused.segment).toBeUndefined();
      const plain = await conn.request("inspect.point", { cwd: images, timeline: "main", at: 1, x: 0.5, y: 0.5 });
      expect(plain.segment).toBeUndefined();
      expect(plain.segmentUnavailable).toBeUndefined();
      expect(decoded).toHaveLength(before);
    },
    MEDIA_TIMEOUT,
  );
});
