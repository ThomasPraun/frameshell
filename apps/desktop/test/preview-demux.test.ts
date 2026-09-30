import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyArgs } from "@frameshell/core";
import { beforeAll, describe, expect, it } from "vitest";
import { ffmpegRun, makeSource, testFfmpeg } from "../e2e/media.js";
import { openProxy, readSamples } from "../src/renderer/src/preview/demux.js";

// Seam under test: the preview's MP4 demux over byte ranges (what the engine worker fetches through frameshell-media://),
// against a proxy built by the real ingest recipe.

let file: Buffer;

beforeAll(async () => {
  const ffmpeg = await testFfmpeg();
  const dir = mkdtempSync(join(tmpdir(), "frameshell-demux-"));
  await makeSource(ffmpeg, join(dir, "source.mp4"), { seconds: 2 });
  await ffmpegRun(ffmpeg, proxyArgs(join(dir, "source.mp4"), join(dir, "proxy.mp4"), 30));
  file = readFileSync(join(dir, "proxy.mp4"));
}, 120_000);

function reader() {
  const reads: [number, number][] = [];
  const read = async (start: number, end: number) => {
    reads.push([start, end]);
    return new Uint8Array(file.subarray(start, Math.min(end, file.length)));
  };
  return { read, reads };
}

describe("openProxy", () => {
  it("indexes every frame of a proxy: one sample per frame, a keyframe every 15, an H.264 decoder config", async () => {
    const { read } = reader();
    const proxy = await openProxy(read);
    expect(proxy.samples).toHaveLength(60);
    expect(proxy.table.count).toBe(60);
    expect([...Array(60).keys()].filter((i) => proxy.table.isSync(i))).toEqual([0, 15, 30, 45]);
    expect(proxy.config.codec).toMatch(/^avc1\.[0-9a-f]{6}$/i);
    expect(proxy.config.codedWidth).toBe(960);
    expect(proxy.config.codedHeight).toBe(540);
    // avcC record: configurationVersion 1, then the profile the codec string names.
    expect(proxy.config.description[0]).toBe(1);
    expect(proxy.config.description.length).toBeGreaterThan(8);
  });

  it("reads only the head of a faststart proxy to index it", async () => {
    const { read, reads } = reader();
    await openProxy(read);
    expect(reads).toEqual([[0, 1 << 20]]);
  });

  it("fails clearly when the file has no movie header", async () => {
    await expect(openProxy(async () => new Uint8Array(0))).rejects.toThrow(/not a readable MP4/);
  });
});

describe("readSamples", () => {
  it("returns the bytes of a run of samples with one ranged read", async () => {
    const proxy = await openProxy(reader().read);
    const { read, reads } = reader();
    const chunks = await readSamples(proxy, 15, 20, read);
    expect(chunks).toHaveLength(5);
    chunks.forEach((bytes, k) => {
      const sample = proxy.samples[15 + k]!;
      expect(Buffer.from(bytes)).toEqual(file.subarray(sample.offset, sample.offset + sample.size));
    });
    expect(reads).toHaveLength(1);
  });
});
