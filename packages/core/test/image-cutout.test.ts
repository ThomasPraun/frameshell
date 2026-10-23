import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, connectToDaemon, methods } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { encodeGrayPng } from "../src/segment/png.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { mediaTools, runBuffer, testBinaryManager } from "./media-tools.js";
import { makeDiscPhoto } from "./segment-fixture.js";

// `image.cutout` through a real daemon and the managed ffmpeg, on a synthetic photo and masks.
const MEDIA_TIMEOUT = 180_000;
const WIDTH = 64;
const HEIGHT = 36;
let daemon: Daemon;
let conn: DaemonConnection;
let ffmpeg: string;
let images: string;
let video: string;
let photoClip: string;
let photoTrack: string;

/** Left half white, right half black. */
function writeLeftHalfMask(dir: string, name: string): string {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) pixels.fill(255, y * WIDTH, y * WIDTH + WIDTH / 2);
  writeFileSync(join(dir, name), encodeGrayPng(pixels, WIDTH, HEIGHT));
  return name;
}

/** RGBA of every pixel of a PNG, row by row. */
async function rgba(path: string): Promise<Uint8Array> {
  return runBuffer(ffmpeg, ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
}

beforeAll(async () => {
  daemon = await startDaemon({
    socketPath: uniqueSocketPath(),
    dirs: { dataDir: tempDir(), configDir: tempDir() },
    binaries: testBinaryManager(),
    idleTimeoutMs: Infinity,
  });
  conn = await connectToDaemon(daemon.socketPath, { client: "desktop/test" });
  ({ ffmpeg } = await mediaTools());
  const files = tempDir();
  await makeDiscPhoto(ffmpeg, join(files, "disc.png"), WIDTH, HEIGHT, { cx: 16, cy: 18, r: 10 });
  images = tempDir();
  await conn.request("project.init", { dir: images, kind: "image" });
  await conn.request("asset.import", { cwd: images, files: [join(files, "disc.png")] });
  photoTrack = (await conn.request("track.add", { cwd: images, kind: "video" })).changes.added[0]!;
  const added = await conn.request("clip.add", {
    cwd: images,
    track: photoTrack,
    asset: "assets/disc.png",
    start: 0,
    duration: 3,
    transform: { scale: 0.5, x: 100, y: 50, opacity: 0.8 },
  });
  photoClip = added.changes.added[0]!;
  video = tempDir();
  await conn.request("project.init", { dir: video });
  await conn.request("asset.import", { cwd: video, files: [join(files, "disc.png")] });
  const videoTrack = (await conn.request("track.add", { cwd: video, kind: "video" })).changes.added[0]!;
  const videoAdded = await conn.request("clip.add", { cwd: video, track: videoTrack, asset: "assets/disc.png", start: 0, duration: 3 });
  writeLeftHalfMask(video, "mask.png");
  writeLeftHalfMask(images, "mask.png");
  videoClip = videoAdded.changes.added[0]!;
}, MEDIA_TIMEOUT);

let videoClip: string;

afterAll(async () => {
  conn.close();
  await daemon.close();
});

describe("image.cutout", () => {
  it(
    "writes the photo with the mask as alpha as a new asset and adds it as a layer exactly over the photo, in one transaction",
    async () => {
      const result = await conn.request("image.cutout", { cwd: images, timeline: "main", clip: photoClip, mask: "mask.png" });
      expect(methods["image.cutout"].result.parse(result)).toEqual(result);
      expect(result.asset).toBe("assets/disc-cutout-1.png");

      // The PNG: the photo's colours, opaque in the left half, transparent in the right half.
      const photo = await rgba(join(images, "assets", "disc.png"));
      const cutout = await rgba(join(images, result.asset));
      expect(cutout).toHaveLength(WIDTH * HEIGHT * 4);
      for (const [x, y] of [[2, 2], [30, 20], [10, 33]] as const) {
        const at = (y * WIDTH + x) * 4;
        expect(Array.from(cutout.subarray(at, at + 4))).toEqual([...photo.subarray(at, at + 3), 255]);
      }
      for (const [x, y] of [[33, 2], [50, 20], [63, 35]] as const) expect(cutout[(y * WIDTH + x) * 4 + 3]).toBe(0);

      // The layer: directly above the photo's track, same start, length and placement.
      const shown = await conn.request("timeline.show", { cwd: images, timeline: "main" });
      const tracks = shown.tracks;
      expect(tracks.map((track) => track.id)).toEqual([photoTrack, result.track]);
      const layer = tracks[1]!.clips.find((clip) => clip.id === result.clip)!;
      expect(layer).toMatchObject({ asset: result.asset, start: 0, in: 0, out: 3, transform: { scale: 0.5, x: 100, y: 50, opacity: 0.8 } });
      expect(tracks[0]!.clips).toHaveLength(1);

      // The original photo is untouched and the new asset is read-only like any import.
      expect(existsSync(join(images, "assets", "disc.png"))).toBe(true);

      // One transaction labelled after the photo; reverting it takes the layer off and keeps the PNG.
      const history = await conn.request("history", { cwd: images, timeline: "main" });
      const tx = history.transactions.at(-1)!;
      expect(tx.label).toBe("Cut out disc");
      expect(tx.operations.map((op) => op.op)).toEqual(["track.add", "clip.add"]);
      await conn.request("revert", { cwd: images, timeline: "main", target: tx.tx });
      const after = await conn.request("timeline.show", { cwd: images, timeline: "main" });
      expect(after.tracks.map((track) => track.id)).toEqual([photoTrack]);
      expect(existsSync(join(images, result.asset))).toBe(true);

      // A second cut-out takes the next free name.
      const again = await conn.request("image.cutout", { cwd: images, timeline: "main", clip: photoClip, mask: "mask.png" });
      expect(again.asset).toBe("assets/disc-cutout-2.png");
    },
    MEDIA_TIMEOUT,
  );

  it(
    "refuses video projects, wrong masks and clips that are not photos",
    async () => {
      const code = async (request: Promise<unknown>) => ((await request.catch((error: { code: string }) => error)) as { code: string }).code;
      expect(await code(conn.request("image.cutout", { cwd: video, timeline: "main", clip: videoClip, mask: "mask.png" }))).toBe(ErrorCode.InvalidOperation);
      expect(await code(conn.request("image.cutout", { cwd: images, timeline: "main", clip: "c_nope", mask: "mask.png" }))).toBe(ErrorCode.ClipNotFound);
      expect(await code(conn.request("image.cutout", { cwd: images, timeline: "main", clip: photoClip, mask: "missing.png" }))).toBe(ErrorCode.AssetNotFound);

      writeFileSync(join(images, "wrong-size.png"), encodeGrayPng(new Uint8Array(4 * 4).fill(255), 4, 4));
      writeFileSync(join(images, "black.png"), encodeGrayPng(new Uint8Array(WIDTH * HEIGHT), WIDTH, HEIGHT));
      for (const mask of ["wrong-size.png", "black.png", "assets/disc.png"]) {
        expect(await code(conn.request("image.cutout", { cwd: images, timeline: "main", clip: photoClip, mask }))).toBe(ErrorCode.InvalidOperation);
      }
      const shown = await conn.request("timeline.show", { cwd: images, timeline: "main" });
      expect(shown.tracks).toHaveLength(2);
    },
    MEDIA_TIMEOUT,
  );
});
