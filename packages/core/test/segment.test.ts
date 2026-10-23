import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DecoderOutput,
  type PhotoInput,
  type SegmentEngine,
  SegmentService,
  Segmenter,
  clickInPreparedSpace,
  encoderInput,
  loadMobileSam,
  masksOfAnswer,
  preparedSize,
  upscaleMask,
  workerSegmentEngine,
} from "../src/index.js";
import { tempDir } from "./helpers.js";
import { mediaTools } from "./media-tools.js";
import { fakeRuntimeSource, makeDiscPhoto, writeFakeModel } from "./segment-fixture.js";

const MEDIA_TIMEOUT = 120_000;

describe("preprocessing math", () => {
  it("scales a photo so its long side is 1024, keeping the aspect, up or down", () => {
    expect(preparedSize(4032, 3024)).toEqual({ width: 1024, height: 768 });
    expect(preparedSize(3024, 4032)).toEqual({ width: 768, height: 1024 });
    expect(preparedSize(512, 256)).toEqual({ width: 1024, height: 512 });
    expect(preparedSize(1024, 683)).toEqual({ width: 1024, height: 683 });
    expect(preparedSize(10_000, 1)).toEqual({ width: 1024, height: 1 });
  });

  it("feeds the encoder RGB bytes as float32 in 0..255, unnormalized", () => {
    expect(encoderInput(Uint8Array.of(0, 128, 255, 7, 8, 9))).toEqual(Float32Array.of(0, 128, 255, 7, 8, 9));
  });

  it("maps a click from photo pixels into the encoder's pixel space, clamped to the picture", () => {
    const photo = { width: 4000, height: 3000 };
    const prepared = preparedSize(photo.width, photo.height);
    expect(clickInPreparedSpace({ x: 2000, y: 1500 }, photo, prepared)).toEqual({ x: 512, y: 384 });
    expect(clickInPreparedSpace({ x: 0, y: 3000 }, photo, prepared)).toEqual({ x: 0, y: 768 });
    expect(clickInPreparedSpace({ x: -5, y: 9999 }, photo, prepared)).toEqual({ x: 0, y: 768 });
  });
});

describe("mask post-processing", () => {
  /** 4×4 logits, positive in the top-left 2×2. */
  const quarter = Float32Array.from({ length: 16 }, (_, i) => (i % 4 < 2 && i < 8 ? 3 : -3));

  it("thresholds at 0 and upscales to the photo's pixels with the box and share of the photo", () => {
    const mask = upscaleMask(quarter, { width: 4, height: 4 }, { width: 8, height: 8 }, 0.8);
    expect(mask.mask).toHaveLength(64);
    expect(mask.bbox).toEqual([0, 0, 4, 4]);
    expect(mask.area).toBeCloseTo(0.25, 5);
    expect(mask.score).toBe(0.8);
    expect([mask.mask[0], mask.mask[3], mask.mask[4], mask.mask[4 * 8]]).toEqual([255, 255, 0, 0]);
  });

  it("follows the soft boundary between logits instead of blocky pixels", () => {
    // A ramp from -1 to +1 across 2 pixels crosses 0 halfway: the edge lands between output pixels 3 and 4 of 8.
    const ramp = upscaleMask(Float32Array.of(-1, 1, -1, 1), { width: 2, height: 2 }, { width: 8, height: 2 }, 1);
    expect(Array.from(ramp.mask.subarray(0, 8))).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it("gives an empty mask a zero box, keeps the score within 0..1, and passes the same size through", () => {
    const empty = upscaleMask(new Float32Array(4).fill(-1), { width: 2, height: 2 }, { width: 2, height: 2 }, 7);
    expect(empty).toMatchObject({ bbox: [0, 0, 0, 0], area: 0, score: 1 });
    const same = upscaleMask(Float32Array.of(1, -1, -1, 1), { width: 2, height: 2 }, { width: 2, height: 2 }, -3);
    expect(Array.from(same.mask)).toEqual([255, 0, 0, 255]);
    expect(same.score).toBe(0);
  });

  it("takes masks 1 to 3 of the decoder's four, smallest first, and names the best score", () => {
    const plane = 4;
    const logits = new Float32Array(4 * plane).fill(-1);
    // Mask 0 (ignored) is full; mask 1 covers 3 pixels, mask 2 one, mask 3 two.
    logits.fill(1, 0, plane);
    logits.fill(1, plane, plane + 3);
    logits.fill(1, 2 * plane, 2 * plane + 1);
    logits.fill(1, 3 * plane, 3 * plane + 2);
    const answer: DecoderOutput = { logits, scores: Float32Array.of(0.99, 0.6, 0.3, 0.9), width: 2, height: 2 };
    const result = masksOfAnswer(answer, { width: 2, height: 2 });
    expect(result.masks.map((mask) => mask.area)).toEqual([0.25, 0.5, 0.75]);
    expect(result.masks.map((mask) => mask.score)).toEqual(Array.from(Float32Array.of(0.3, 0.9, 0.6)));
    expect(result.chosen).toBe(1);
    expect(result).toMatchObject({ width: 2, height: 2 });
  });
});

/** Engine that counts its calls; the embedding's first float names the photo. */
function countingEngine(options: { failEncodes?: number } = {}) {
  const calls = { encode: [] as number[], decode: 0 };
  let failures = options.failEncodes ?? 0;
  const engine: SegmentEngine = {
    async encode(rgb) {
      calls.encode.push(rgb[0]!);
      if (failures-- > 0) throw new Error("encode failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Float32Array(8).fill(rgb[0]!);
    },
    async decode(embedding, point, size) {
      calls.decode++;
      const plane = size.width * size.height;
      const logits = new Float32Array(4 * plane).fill(-1);
      for (let k = 1; k <= 3; k++) logits.fill(1, k * plane, k * plane + k);
      return { logits, scores: Float32Array.of(0, 0.2, embedding[0]! / 255, 0.1), width: size.width, height: size.height };
    },
  };
  return { engine, calls };
}

const photo = (key: string, first: number): PhotoInput => ({
  key,
  width: 2,
  height: 2,
  readRgb: async () => Uint8Array.from({ length: 12 }, (_, i) => (i === 0 ? first : 0)),
});

describe("Segmenter cache", () => {
  it("encodes a photo once and decodes every click from the cached embedding", async () => {
    const { engine, calls } = countingEngine();
    const segmenter = new Segmenter(engine);
    expect(await segmenter.prepare(photo("a", 10))).toEqual({ cached: false });
    const first = await segmenter.segment(photo("a", 10), { x: 0, y: 0 });
    const second = await segmenter.segment(photo("a", 10), { x: 1, y: 1 });
    expect([first.cached, second.cached]).toEqual([true, true]);
    expect(calls).toEqual({ encode: [10], decode: 2 });
    expect(first.masks).toHaveLength(3);
  });

  it("joins a click that arrives while the photo is still being encoded", async () => {
    const { engine, calls } = countingEngine();
    const segmenter = new Segmenter(engine);
    const [prepared, segmented] = await Promise.all([segmenter.prepare(photo("a", 10)), segmenter.segment(photo("a", 10), { x: 0, y: 0 })]);
    expect(prepared.cached).toBe(false);
    expect(segmented.masks).toHaveLength(3);
    expect(calls.encode).toEqual([10]);
  });

  it("drops the least recently used photo past its capacity", async () => {
    const { engine, calls } = countingEngine();
    const segmenter = new Segmenter(engine, 2);
    await segmenter.prepare(photo("a", 1));
    await segmenter.prepare(photo("b", 2));
    await segmenter.prepare(photo("a", 1)); // a is now more recent than b
    await segmenter.prepare(photo("c", 3)); // evicts b
    expect(segmenter.cached).toBe(2);
    expect(await segmenter.prepare(photo("a", 1))).toEqual({ cached: true });
    expect(await segmenter.prepare(photo("b", 2))).toEqual({ cached: false });
    expect(calls.encode).toEqual([1, 2, 3, 2]);
  });

  it("does not keep a failed encode: the next call tries again", async () => {
    const { engine, calls } = countingEngine({ failEncodes: 1 });
    const segmenter = new Segmenter(engine);
    await expect(segmenter.prepare(photo("a", 5))).rejects.toThrow("encode failed");
    expect(segmenter.cached).toBe(0);
    expect(await segmenter.prepare(photo("a", 5))).toEqual({ cached: false });
    expect(calls.encode).toEqual([5, 5]);
  });
});

describe("MobileSAM session plumbing (fake ONNX Runtime)", () => {
  it("feeds the encoder an [H, W, 3] image and the decoder the click, padding point, empty prior and photo size", async () => {
    const files = await writeFakeModel(tempDir());
    const engine = await loadMobileSam(files.runtime, files.encoder, files.decoder);
    const size = { width: 20, height: 10 };
    const embedding = await engine.encode(Uint8Array.from({ length: 600 }, (_, i) => (i === 0 ? 200 : 0)), size);
    expect(embedding).toHaveLength(256 * 64 * 64);
    expect(embedding[0]).toBe(200);
    const answer = await engine.decode(embedding, { x: 5, y: 4 }, size);
    expect(answer).toMatchObject({ width: 20, height: 10 });
    expect(answer.logits).toHaveLength(4 * 200);
    expect(answer.scores[1]).toBeCloseTo(200 / 255, 5);
    // Mask 1 is the pixels left of x = 5 + 10: all but the last 5 columns of the row.
    expect(answer.logits[200 + 14]).toBe(1);
    expect(answer.logits[200 + 15]).toBe(-1);
  });

  it("names the pinned model when an output is missing", async () => {
    const dir = tempDir();
    const files = await writeFakeModel(dir);
    await writeFile(files.runtime, fakeRuntimeSource().replace("masks: { data: logits }", "other: { data: logits }"));
    const engine = await loadMobileSam(files.runtime, files.encoder, files.decoder);
    await expect(engine.decode(new Float32Array(256 * 64 * 64), { x: 1, y: 1 }, { width: 8, height: 8 })).rejects.toThrow(/not the pinned model/);
  });

  it("runs the same plumbing in a worker thread, many requests at once, and a new worker after close", async () => {
    const files = await writeFakeModel(tempDir());
    const engine = workerSegmentEngine(files);
    try {
      const size = { width: 16, height: 8 };
      const [a, b] = await Promise.all([
        engine.encode(Uint8Array.from({ length: 384 }, (_, i) => (i === 0 ? 51 : 0)), size),
        engine.encode(Uint8Array.from({ length: 384 }, (_, i) => (i === 0 ? 102 : 0)), size),
      ]);
      expect([a[0], b[0]]).toEqual([51, 102]);
      const [first, second] = await Promise.all([engine.decode(a, { x: 2, y: 2 }, size), engine.decode(b, { x: 2, y: 2 }, size)]);
      expect([first.scores[1], second.scores[1]]).toEqual([Math.fround(51 / 255), Math.fround(102 / 255)]);
      // The embedding stays usable for the next click: it was copied to the worker, not transferred away.
      expect((await engine.decode(a, { x: 3, y: 3 }, size)).logits).toHaveLength(4 * 128);
      await engine.close();
      expect((await engine.encode(new Uint8Array(384), size))[0]).toBe(0);
    } finally {
      await engine.close();
    }
  });

  it("fails each request, then retries with a new worker, when the runtime cannot load", async () => {
    const dir = tempDir();
    const files = await writeFakeModel(dir);
    const engine = workerSegmentEngine({ ...files, runtime: join(dir, "missing.mjs") });
    try {
      await expect(engine.encode(new Uint8Array(12), { width: 2, height: 2 })).rejects.toThrow(/missing\.mjs/);
      await expect(engine.encode(new Uint8Array(12), { width: 2, height: 2 })).rejects.toThrow(/missing\.mjs/);
    } finally {
      await engine.close();
    }
  });
});

describe("SegmentService", () => {
  it(
    "reads a still image through ffmpeg at the encoder's size, prepares it once by content hash, and maps the click to photo pixels",
    async () => {
      const { ffmpeg } = await mediaTools();
      const dir = tempDir();
      const photoPath = join(dir, "disc.png");
      await makeDiscPhoto(ffmpeg, photoPath, 2048, 1024, { cx: 1500, cy: 500, r: 200 });
      const seen: { size: unknown; first: number; click?: unknown }[] = [];
      const engine: SegmentEngine = {
        async encode(rgb, size) {
          seen.push({ size, first: rgb[0]! });
          expect(rgb).toHaveLength(size.width * size.height * 3);
          return new Float32Array(4);
        },
        async decode(_embedding, point, size) {
          seen.at(-1)!.click = point;
          const plane = size.width * size.height;
          return { logits: new Float32Array(4 * plane).fill(-1), scores: new Float32Array(4), width: size.width, height: size.height };
        },
      };
      const service = new SegmentService({
        probe: async () => ({ video: { width: 2048, height: 1024, still: true } }),
        hash: async () => "sha256:disc",
        ffmpeg: async () => ffmpeg,
        engine: async () => engine,
      });
      const prepared = await service.prepare(dir, "disc.png");
      expect(prepared).toEqual({ asset: "disc.png", hash: "sha256:disc", width: 2048, height: 1024, cached: false });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.size).toEqual({ width: 1024, height: 512 });
      // Background pixel of the PNG: rgb(40, 50, 70).
      expect(seen[0]!.first).toBe(40);
      const result = await service.segment(dir, "disc.png", { x: 1500, y: 500 });
      expect(result).toMatchObject({ width: 2048, height: 1024, hash: "sha256:disc", cached: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.click).toEqual({ x: 750, y: 250 });
      await service.close();
    },
    MEDIA_TIMEOUT,
  );

  it("refuses an asset that is not a still image", async () => {
    const service = new SegmentService({
      probe: async () => ({ video: { width: 10, height: 10, still: false } }),
      hash: async () => "sha256:x",
      ffmpeg: async () => "ffmpeg",
      engine: async () => countingEngine().engine,
    });
    await expect(service.prepare("/p", "assets/clip.mp4")).rejects.toMatchObject({ message: expect.stringContaining("not a still image") });
    await expect(service.segment("/p", "assets/audio.wav", { x: 1, y: 1 })).rejects.toMatchObject({ message: expect.stringContaining("not a still image") });
  });

  it(
    "closes an idle engine but keeps the embeddings",
    async () => {
      const { ffmpeg } = await mediaTools();
      const dir = tempDir();
      await makeDiscPhoto(ffmpeg, join(dir, "a.png"), 16, 16, { cx: 8, cy: 8, r: 4 });
      const { engine, calls } = countingEngine();
      let closed = 0;
      const service = new SegmentService({
        probe: async () => ({ video: { width: 16, height: 16, still: true } }),
        hash: async () => "sha256:a",
        ffmpeg: async () => ffmpeg,
        engine: async () => ({ ...engine, close: async () => void closed++ }),
        idleMs: 20,
      });
      await service.segment(dir, "a.png", { x: 8, y: 8 });
      expect(closed).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closed).toBe(1);
      expect((await service.segment(dir, "a.png", { x: 8, y: 8 })).cached).toBe(true);
      expect(calls.encode).toHaveLength(1);
      await service.close();
    },
    MEDIA_TIMEOUT,
  );

  it("starts the model once, and again after an install that failed", async () => {
    let starts = 0;
    const service = new SegmentService({
      probe: async () => ({ video: { width: 2, height: 2, still: true } }),
      hash: async () => "sha256:x",
      ffmpeg: async () => join(tempDir(), "no-ffmpeg"),
      engine: async () => {
        if (++starts === 1) throw new Error("download failed");
        return countingEngine().engine;
      },
    });
    // With the engine up, the missing ffmpeg fails the photo read instead: a different error.
    await expect(service.prepare("/p", "a.png")).rejects.toThrow("download failed");
    await expect(service.prepare("/p", "a.png")).rejects.toThrow(/ENOENT/);
    await expect(service.prepare("/p", "a.png")).rejects.toThrow(/ENOENT/);
    expect(starts).toBe(2);
  });
});
