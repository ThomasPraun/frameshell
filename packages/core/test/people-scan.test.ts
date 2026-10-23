import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BgrFrame,
  FACE_EMBEDDING_DIMS,
  type Face,
  type FaceDetector,
  FaceTracker,
  PEOPLE_DIR,
  alignFace,
  classifyFaceScan,
  cosine,
  faceScanKey,
  readFaceScan,
  readProjectFaceScans,
  scanFrameSize,
  scanPeopleFaces,
  shrinkFrame,
  similarityTransform,
  writeFaceScan,
} from "../src/index.js";
import { makeMarkerClip } from "./face-fixture.js";
import { tempDir } from "./helpers.js";
import { mediaTools } from "./media-tools.js";

const MEDIA_TIMEOUT = 120_000;

/** The five landmark positions `alignFace` maps to (ArcFace template), in pixels of a 112×112 crop. */
const TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** A face with five landmarks in the usual places, `size` wide and tall, centered on (`x`, `y`). */
const faceAt = (x: number, y: number, size = 0.2): Face => ({
  x,
  y,
  width: size,
  height: size,
  score: 0.9,
  landmarks: [
    [x - size * 0.2, y - size * 0.1],
    [x + size * 0.2, y - size * 0.1],
    [x, y + size * 0.05],
    [x - size * 0.15, y + size * 0.25],
    [x + size * 0.15, y + size * 0.25],
  ],
});

/** A unit vector along axis `axis` with `tilt` of another axis mixed in. */
function unit(axis: number, tilt = 0): Float32Array {
  const vector = new Float32Array(FACE_EMBEDDING_DIMS);
  vector[axis] = 1;
  vector[(axis + 1) % FACE_EMBEDDING_DIMS] = tilt;
  const length = Math.hypot(1, tilt);
  return vector.map((value) => value / length);
}

describe("similarityTransform and alignFace", () => {
  it("recovers a known rotation, scale and shift", () => {
    const [angle, scale, shiftX, shiftY] = [0.3, 1.7, 40, -12];
    const [a, b] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
    const detected = TEMPLATE.map(([x, y]): [number, number] => [(a * x - b * y + shiftX), (b * x + a * y + shiftY)]);
    const { a: ra, b: rb, tx, ty } = similarityTransform(detected, TEMPLATE);
    // Detected -> template is the inverse of the transform that made `detected`.
    const scaleSquared = a * a + b * b;
    expect(ra).toBeCloseTo(a / scaleSquared, 6);
    expect(rb).toBeCloseTo(-b / scaleSquared, 6);
    const [bx, by] = [ra * shiftX - rb * shiftY, rb * shiftX + ra * shiftY];
    expect(tx).toBeCloseTo(-bx, 4);
    expect(ty).toBeCloseTo(-by, 4);
  });

  it("is the identity for landmarks already at the template", () => {
    const { a, b, tx, ty } = similarityTransform(TEMPLATE, TEMPLATE);
    expect([a, b, tx, ty].map((value) => Math.round(value * 1e6) / 1e6)).toEqual([1, 0, 0, 0]);
  });

  it("copies a 112×112 face as RGB planes and cuts a face anywhere in a bigger picture the same way", () => {
    // Left half of the 112 crop blue (BGR 255,0,0), right half red (0,0,255).
    const crop: BgrFrame = { width: 112, height: 112, data: new Uint8Array(112 * 112 * 3) };
    for (let y = 0; y < 112; y++) {
      for (let x = 0; x < 112; x++) crop.data.set(x < 56 ? [255, 0, 0] : [0, 0, 255], (y * 112 + x) * 3);
    }
    const aligned = alignFace(crop, TEMPLATE);
    const plane = 112 * 112;
    expect(aligned).toHaveLength(3 * plane);
    // Planes are R, G, B: the red half is on the right of plane 0, the blue half on the left of plane 2.
    expect([aligned[10]!, aligned[100]!]).toEqual([0, 255]);
    expect([aligned[2 * plane + 10]!, aligned[2 * plane + 100]!]).toEqual([255, 0]);
    expect(aligned[plane + 10]).toBe(0);

    // The same crop drawn at 2x inside a 400×300 picture, landmarks scaled and shifted with it.
    const big: BgrFrame = { width: 400, height: 300, data: new Uint8Array(400 * 300 * 3) };
    const [dx, dy] = [90, 40];
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 400; x++) {
        const [cx, cy] = [(x - dx) / 2, (y - dy) / 2];
        const inside = cx >= 0 && cx < 112 && cy >= 0 && cy < 112;
        big.data.set(inside ? (cx < 56 ? [255, 0, 0] : [0, 0, 255]) : [10, 200, 10], (y * 400 + x) * 3);
      }
    }
    const again = alignFace(big, TEMPLATE.map(([x, y]): [number, number] => [x * 2 + dx, y * 2 + dy]));
    let worst = 0;
    // Edges of the halves blend differently; compare away from them and from the crop's border.
    for (const x of [8, 20, 40, 70, 90, 104]) for (const y of [8, 30, 56, 80, 104]) worst = Math.max(worst, Math.abs(again[y * 112 + x]! - aligned[y * 112 + x]!));
    expect(worst).toBeLessThan(2);
  });

  it("refuses landmarks that collapse to a point", () => {
    const frame: BgrFrame = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 3) };
    expect(() => alignFace(frame, Array.from({ length: 5 }, (): [number, number] => [4, 4]))).toThrow(/collapsed/);
  });
});

describe("shrinkFrame and scanFrameSize", () => {
  it("averages the pixels each target pixel covers and never scales up", () => {
    const frame: BgrFrame = { width: 4, height: 2, data: Uint8Array.from([0, 0, 0, 100, 100, 100, 200, 200, 200, 40, 40, 40, 0, 0, 0, 100, 100, 100, 200, 200, 200, 40, 40, 40]) };
    const small = shrinkFrame(frame, 2, 1);
    expect([small.width, small.height, ...small.data]).toEqual([2, 1, 50, 50, 50, 120, 120, 120]);
    expect(shrinkFrame(frame, 8, 4)).toBe(frame);
  });

  it("decodes at most 1280 wide with even sides, rounding to the nearest", () => {
    expect(scanFrameSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(scanFrameSize(320, 180)).toEqual({ width: 320, height: 180 });
    expect(scanFrameSize(1081, 1919)).toEqual({ width: 1082, height: 1920 });
  });
});

describe("FaceTracker", () => {
  const tracker = () => new FaceTracker();
  /** Embeddings by the face's `x`: a person on the left is axis 0, on the right axis 1; a tiny face has none. */
  const byPlace = async (face: Face) => (face.width < 0.05 ? null : face.x < 0.5 ? unit(0) : unit(1));

  it("follows a face that moves a little between samples and embeds it once a second", async () => {
    const t = tracker();
    for (let i = 0; i < 6; i++) await t.add(i / 2, [faceAt(0.3 + i * 0.01, 0.4)], byPlace);
    const [track, ...rest] = t.finish();
    expect(rest).toEqual([]);
    expect(track).toMatchObject({ id: "t1", start: 0, end: 2.5 });
    expect(track!.boxes).toHaveLength(6);
    expect(track!.embeddings.map((embedding) => embedding.time)).toEqual([0, 1, 2]);
  });

  it("asks for an embedding only when the track has none for this second", async () => {
    const t = tracker();
    let asked = 0;
    for (let i = 0; i < 8; i++) {
      await t.add(i / 2, [faceAt(0.3, 0.4)], async () => {
        asked++;
        return unit(0);
      });
    }
    expect(asked).toBe(4);
  });

  it("keeps two people on their own tracks as they cross", async () => {
    const t = tracker();
    // Ana on the left, Ben on the right; then they pass each other and their boxes overlap.
    await t.add(0, [faceAt(0.3, 0.4, 0.3), faceAt(0.7, 0.4, 0.3)], byPlace);
    await t.add(0.5, [faceAt(0.4, 0.4, 0.3), faceAt(0.6, 0.4, 0.3)], byPlace);
    await t.add(1, [faceAt(0.5, 0.4, 0.3), faceAt(0.52, 0.4, 0.3)], async (face) => (face.x < 0.51 ? unit(0) : unit(1)));
    const tracks = t.finish();
    expect(tracks).toHaveLength(2);
    expect(tracks.map((track) => track.boxes.length)).toEqual([3, 3]);
  });

  it("starts a new track when the embedding says the overlapping face is someone else", async () => {
    const t = tracker();
    await t.add(0, [faceAt(0.5, 0.4)], async () => unit(0));
    // Someone else sits where Ana was one second later: the box overlaps, the embedding does not.
    await t.add(1, [faceAt(0.5, 0.4)], async () => unit(7));
    const tracks = t.finish();
    expect(tracks.map((track) => [track.id, track.start, track.end])).toEqual([
      ["t1", 0, 0],
      ["t2", 1, 1],
    ]);
  });

  it("ends a track after a second without the face and starts another when it comes back", async () => {
    const t = tracker();
    await t.add(0, [faceAt(0.3, 0.4)], byPlace);
    await t.add(0.5, [faceAt(0.3, 0.4)], byPlace);
    await t.add(1, [], byPlace);
    await t.add(1.5, [], byPlace);
    await t.add(2, [], byPlace);
    await t.add(2.5, [faceAt(0.3, 0.4)], byPlace);
    expect(t.finish().map((track) => [track.start, track.end])).toEqual([
      [0, 0.5],
      [2.5, 2.5],
    ]);
  });

  it("keeps a track across a one-sample miss", async () => {
    const t = tracker();
    await t.add(0, [faceAt(0.3, 0.4)], byPlace);
    await t.add(0.5, [], byPlace);
    await t.add(1, [faceAt(0.31, 0.4)], byPlace);
    expect(t.finish()).toHaveLength(1);
  });

  it("tracks faces that cannot be embedded without a print", async () => {
    const t = tracker();
    for (let i = 0; i < 4; i++) await t.add(i / 2, [faceAt(0.3, 0.4, 0.03)], byPlace);
    const [track] = t.finish();
    expect(track!.boxes).toHaveLength(4);
    expect(track!.embeddings).toEqual([]);
  });

  it("calls the embedder once per face even when several tracks could take it", async () => {
    const t = tracker();
    await t.add(0, [faceAt(0.45, 0.4, 0.3), faceAt(0.55, 0.4, 0.3)], byPlace);
    let asked = 0;
    await t.add(1, [faceAt(0.5, 0.4, 0.3)], async () => {
      asked++;
      return unit(0);
    });
    expect(asked).toBe(1);
  });
});

describe("cosine", () => {
  it("is 1 for equal directions, 0 for orthogonal ones, and 0 for a zero vector", () => {
    expect(cosine(unit(0), unit(0))).toBeCloseTo(1);
    expect(cosine(unit(0), unit(1))).toBeCloseTo(0);
    expect(cosine(unit(0), new Float32Array(FACE_EMBEDDING_DIMS))).toBe(0);
  });
});

describe("scanPeopleFaces", () => {
  it(
    "decodes, detects on a small copy, embeds big faces from the full picture and tracks them, with injected models",
    async () => {
      const { ffmpeg } = await mediaTools();
      const path = join(tempDir(), "marker.mp4");
      // 320×180, 8 s: a 40 px white square (a face) that sits left for 4 s, then right.
      await makeMarkerClip(ffmpeg, path, { x: "if(lt(t,4),40,240)" });
      const seen: number[] = [];
      const detect: FaceDetector = async ({ width, height, data }) => {
        seen.push(width);
        let [sumX, sumY, count] = [0, 0, 0];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 3]! < 200) continue;
            sumX += x + 0.5;
            sumY += y + 0.5;
            count++;
          }
        }
        if (count === 0) return [];
        return [{ ...faceAt(sumX / count / width, sumY / count / height), width: Math.sqrt(count) / width, height: Math.sqrt(count) / height }];
      };
      const embedded: number[] = [];
      const progress: number[] = [];
      const result = await scanPeopleFaces({
        ffmpeg,
        path,
        width: 320,
        height: 180,
        duration: 8,
        detect,
        embed: async (aligned) => {
          embedded.push(aligned.length);
          return unit(0);
        },
        onProgress: (fraction) => progress.push(fraction),
      });
      expect(result).toMatchObject({ width: 320, height: 180, samples: 16 });
      // The square jumps by half the picture: one track while it sits, a new one after.
      expect(result.tracks.map((track) => [track.start, track.end, track.boxes.length])).toEqual([
        [0, 3.5, 8],
        [4, 7.5, 8],
      ]);
      // One embedding per track per second.
      expect(result.tracks.map((track) => track.embeddings.length)).toEqual([4, 4]);
      expect(new Set(embedded)).toEqual(new Set([3 * 112 * 112]));
      expect(Math.max(...seen)).toBeLessThanOrEqual(512);
      expect(progress.at(-1)).toBeCloseTo(7.5 / 8);
    },
    MEDIA_TIMEOUT,
  );

  it("stops when the signal aborts", async () => {
    const { ffmpeg } = await mediaTools();
    const path = join(tempDir(), "marker.mp4");
    await makeMarkerClip(ffmpeg, path, { x: "40" });
    const controller = new AbortController();
    await expect(
      scanPeopleFaces({
        ffmpeg,
        path,
        width: 320,
        height: 180,
        detect: async () => {
          controller.abort(new Error("stop"));
          return [];
        },
        embed: async () => unit(0),
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop");
  }, MEDIA_TIMEOUT);
});

describe("face scan cache", () => {
  const hash = `sha256:${"ab".repeat(32)}`;
  const scan = {
    width: 1280,
    height: 720,
    samples: 20,
    tracks: [
      {
        id: "t1",
        start: 0,
        end: 1,
        boxes: [
          { time: 0, x: 0.41, y: 0.33, width: 0.12, height: 0.2, score: 0.93 },
          { time: 0.5, x: 0.42, y: 0.33, width: 0.12, height: 0.2, score: 0.91 },
        ],
        embeddings: [{ time: 0, vector: unit(3, 0.5) }],
      },
      { id: "t2", start: 0, end: 0, boxes: [{ time: 0, x: 0.8, y: 0.5, width: 0.03, height: 0.04, score: 0.7 }], embeddings: [] },
    ],
  };

  it("round-trips a scan through .frameshell/people/ and reads nothing else", async () => {
    const root = tempDir();
    expect(await readFaceScan(root, hash)).toBeNull();
    await writeFaceScan(root, hash, scan);
    const files = await readdir(join(root, ...PEOPLE_DIR.split("/")));
    expect(files.sort()).toEqual([`${faceScanKey(hash)}.f32`, `${faceScanKey(hash)}.json`]);
    const read = (await readFaceScan(root, hash))!;
    expect(read).toMatchObject({ hash, hz: 2, width: 1280, height: 720, samples: 20, models: { detector: "yunet-2026may", recognizer: "sface-2021dec" } });
    expect(read.tracks.map((track) => track.id)).toEqual(["t1", "t2"]);
    expect(read.tracks[0]!.boxes[1]).toEqual({ time: 0.5, x: 0.42, y: 0.33, width: 0.12, height: 0.2, score: 0.91 });
    expect(read.tracks[0]!.embeddings[0]!.time).toBe(0);
    expect(Array.from(read.tracks[0]!.embeddings[0]!.vector)).toEqual(Array.from(unit(3, 0.5)));
    expect(read.tracks[1]!.embeddings).toEqual([]);
    expect(await readFaceScan(root, `sha256:${"cd".repeat(32)}`)).toBeNull();
  });

  it("reads cached scans by content, and hashes no file while nothing was ever scanned", async () => {
    const root = tempDir();
    const hashed: string[] = [];
    const hashOf = async (_root: string, rel: string) => {
      hashed.push(rel);
      return hash;
    };
    expect(await readProjectFaceScans(root, ["assets/a.mp4"], hashOf)).toEqual([]);
    expect(hashed).toEqual([]);
    await writeFaceScan(root, hash, scan);
    const found = await readProjectFaceScans(root, ["assets/a.mp4"], hashOf);
    expect(found.map((entry) => [entry.asset, entry.scan.tracks.length])).toEqual([["assets/a.mp4", 2]]);
    expect(hashed).toEqual(["assets/a.mp4"]);
  });

  it("treats a damaged or truncated cache as missing", async () => {
    const root = tempDir();
    await writeFaceScan(root, hash, scan);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, ...PEOPLE_DIR.split("/"), `${faceScanKey(hash)}.f32`), Buffer.alloc(8));
    expect(await readFaceScan(root, hash)).toBeNull();
  });

  it("keys by content, and gc sees its files and temps but nothing else", () => {
    const key = faceScanKey(hash);
    expect(key).toMatch(/^[0-9a-f]{20}-f1-[0-9a-f]{6}$/);
    expect(faceScanKey(`sha256:${"cd".repeat(32)}`)).not.toBe(key);
    expect(classifyFaceScan(`${key}.json`, false)).toEqual({ kind: "people", key });
    expect(classifyFaceScan(`${key}.f32`, false)).toEqual({ kind: "people", key });
    expect(classifyFaceScan(`${key}.json.123.abcd.tmp`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyFaceScan("voices.json", false)).toBeNull();
    expect(classifyFaceScan(key, true)).toBeNull();
  });
});
