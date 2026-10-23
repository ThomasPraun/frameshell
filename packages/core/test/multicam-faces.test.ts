import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Face, type FacePoint, angleFaceKeys, decodeYunet, faceFrameSize, mainFaceTrack, proposeReframeKeys, yunetWorkerScanner } from "../src/index.js";
import { makeMarkerClip, markerDetector } from "./face-fixture.js";
import { tempDir } from "./helpers.js";
import { mediaTools } from "./media-tools.js";

const MEDIA_TIMEOUT = 120_000;

/** Points every 0.5 s from `from` to `to` (exclusive) at one place. */
const still = (from: number, to: number, x: number, y = 0.4): FacePoint[] =>
  Array.from({ length: Math.round((to - from) * 2) }, (_, i) => ({ time: from + i / 2, x, y }));

const face = (x: number, y: number, size: number): Face => ({ x, y, width: size, height: size, score: 0.9 });

describe("proposeReframeKeys", () => {
  it("holds a face that stays put with one key, whatever its small jitter", () => {
    const jitter = still(0, 20, 0.3).map((point, i) => ({ ...point, x: point.x + (i % 3) * 0.01 }));
    const keys = proposeReframeKeys(jitter);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.time).toBe(0);
    expect(keys[0]!.x).toBeCloseTo(0.31, 2);
  });

  it("holds each stop and glides to the next within half a second", () => {
    const keys = proposeReframeKeys([...still(0, 6, 0.25), ...still(6, 12, 0.7)]);
    expect(keys).toEqual([
      { time: 5.5, x: 0.25, y: 0.4 },
      { time: 6, x: 0.7, y: 0.4 },
    ]);
  });

  it("glides over the frames where the face was seen moving, without trailing the move", () => {
    // The face slides from 0.25 at 5 s to 0.7 at 6 s; the frame at 5.5 s caught it halfway.
    const keys = proposeReframeKeys([...still(0, 5.5, 0.25), { time: 5.5, x: 0.475, y: 0.4 }, ...still(6, 12, 0.7)]);
    expect(keys).toEqual([
      { time: 5, x: 0.25, y: 0.4 },
      { time: 6, x: 0.7, y: 0.4 },
    ]);
  });

  it("starts the move half a second before the next stop when the face was lost between them", () => {
    const keys = proposeReframeKeys([...still(0, 4, 0.25), ...still(10, 14, 0.7)]);
    expect(keys).toEqual([
      { time: 3.5, x: 0.25, y: 0.4 },
      { time: 9.5, x: 0.25, y: 0.4 },
      { time: 10, x: 0.7, y: 0.4 },
    ]);
  });

  it("ignores a glance away shorter than the hold, and gives nothing without faces", () => {
    const glance = [...still(0, 8, 0.3), ...still(8, 9, 0.8), ...still(9, 16, 0.3)];
    expect(proposeReframeKeys(glance)).toEqual([{ time: 0, x: 0.3, y: 0.4 }]);
    expect(proposeReframeKeys([])).toEqual([]);
  });
});

describe("mainFaceTrack", () => {
  it("follows the largest face inside the crop, and keeps following a person nearly as large", () => {
    const samples = [
      { time: 0, faces: [face(0.3, 0.4, 0.2), face(0.7, 0.4, 0.18)] },
      // The other person leans in: a bit larger, not enough to switch.
      { time: 0.5, faces: [face(0.3, 0.4, 0.18), face(0.7, 0.4, 0.2)] },
      { time: 1, faces: [] },
      // A face outside the crop (left 0.5) does not count.
      { time: 1.5, faces: [face(0.2, 0.4, 0.4), face(0.75, 0.5, 0.1)] },
    ];
    expect(mainFaceTrack(samples.slice(0, 3))).toEqual([
      { time: 0, x: 0.3, y: 0.4 },
      { time: 0.5, x: 0.3, y: 0.4 },
    ]);
    expect(mainFaceTrack(samples, { left: 0.5 })).toEqual([
      { time: 0, x: 0.7, y: 0.4 },
      { time: 0.5, x: 0.7, y: 0.4 },
      { time: 1.5, x: 0.75, y: 0.5 },
    ]);
  });
});

describe("decodeYunet", () => {
  it("decodes the strongest cell into a face in fractions of the frame and drops overlapping candidates", () => {
    const width = 64;
    const height = 32;
    const outputs: Record<string, Float32Array> = {};
    for (const stride of [8, 16, 32]) {
      const cells = (width / stride) * (height / stride);
      outputs[`cls_${stride}`] = new Float32Array(cells);
      outputs[`obj_${stride}`] = new Float32Array(cells);
      outputs[`bbox_${stride}`] = new Float32Array(cells * 4);
    }
    // Stride 8, row 1, col 5: center (5.5, 1.5) cells = (44, 12) px, size exp(log 2) = 2 cells = 16 px.
    const i = 1 * 8 + 5;
    outputs["cls_8"]![i] = 0.9;
    outputs["obj_8"]![i] = 0.9;
    outputs["bbox_8"]!.set([0.5, 0.5, Math.log(2), Math.log(2)], i * 4);
    // Its neighbour sees the same face, a little weaker.
    outputs["cls_8"]![i + 1] = 0.8;
    outputs["obj_8"]![i + 1] = 0.8;
    outputs["bbox_8"]!.set([-0.4, 0.5, Math.log(2), Math.log(2)], (i + 1) * 4);
    const faces = decodeYunet((name) => outputs[name], width, height);
    expect(faces).toHaveLength(1);
    const [found] = faces;
    expect([found!.x, found!.y, found!.width, found!.height, found!.score].map((value) => Math.round(value * 1e4) / 1e4)).toEqual([
      44 / 64,
      12 / 32,
      16 / 64,
      16 / 32,
      0.9,
    ]);
  });
});

describe("angleFaceKeys", () => {
  it("scales frames to 512 wide, multiples of 32", () => {
    expect(faceFrameSize(1920, 1080)).toEqual({ width: 512, height: 288 });
    expect(faceFrameSize(1080, 1920)).toEqual({ width: 512, height: 896 });
    expect(faceFrameSize(640, 480)).toEqual({ width: 512, height: 384 });
  });

  it(
    "samples 2 frames per second of a real file and keys the marker where it stops",
    async () => {
      const { ffmpeg } = await mediaTools();
      const path = join(tempDir(), "marker.mp4");
      // Square center at 60 px (0.1875) for 4 s, then 260 px (0.8125).
      await makeMarkerClip(ffmpeg, path, { x: "if(lt(t,4),40,240)" });
      const progress: number[] = [];
      const found = await angleFaceKeys({ ffmpeg, path, width: 320, height: 180, duration: 8, detect: markerDetector, onProgress: (f) => progress.push(f) });
      expect(found).toMatchObject({ samples: 16, faces: 16 });
      expect(found.keys.map((key) => key.time)).toEqual([3.5, 4]);
      expect(found.keys[0]!.x).toBeCloseTo(0.1875, 2);
      expect(found.keys[1]!.x).toBeCloseTo(0.8125, 2);
      expect(found.keys[0]!.y).toBeCloseTo(0.5, 2);
      expect(progress.at(-1)).toBeCloseTo(7.5 / 8, 5);
    },
    MEDIA_TIMEOUT,
  );

  it("runs the real scan in a worker thread and passes its errors back", async () => {
    const { ffmpeg } = await mediaTools();
    const dir = tempDir();
    const scan = yunetWorkerScanner({ runtime: join(dir, "missing.mjs"), model: join(dir, "missing.onnx") });
    await expect(scan({ ffmpeg, path: join(dir, "none.mp4"), width: 320, height: 180 })).rejects.toThrow(/missing\.mjs/);
  });
});
