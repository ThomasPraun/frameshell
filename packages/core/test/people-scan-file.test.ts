import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PEOPLE_DIR, type PeopleScanRequest, type PeopleScanResult, readFaceScan, scanFileFaces } from "../src/index.js";
import { tempDir } from "./helpers.js";

// `scanFileFaces`, the one scan step of `people.scan` and `analyze`, with a stand-in scanner: no decoding, no models.
const HASH = `sha256:${"ab".repeat(32)}`;
const found: PeopleScanResult = {
  width: 320,
  height: 180,
  samples: 8,
  tracks: [{ id: "t1", start: 0, end: 4, boxes: [{ time: 0, x: 0.5, y: 0.5, width: 0.3, height: 0.4, score: 0.9 }], embeddings: [{ time: 0, vector: new Float32Array(128).fill(0.5) }] }],
};

function countingScanner(result: PeopleScanResult = found) {
  const requests: PeopleScanRequest[] = [];
  return {
    requests,
    scanner: async (request: PeopleScanRequest) => {
      requests.push(request);
      request.onProgress?.(0.5);
      return result;
    },
  };
}

describe("scanFileFaces", () => {
  it("scans a file anywhere on disk, caches it by content, and reads the cache the second time", async () => {
    const root = tempDir();
    const outside = join(tempDir(), "reference.mp4");
    const { requests, scanner } = countingScanner();
    const progress: number[] = [];
    const deps = { scanner: async () => scanner, ffmpeg: async () => "ffmpeg-path" };
    const input = { path: outside, hash: HASH, width: 320, height: 180, duration: 4, onProgress: (fraction: number) => progress.push(fraction) };

    const first = await scanFileFaces(root, input, deps);
    expect(first).toMatchObject({ cached: false, samples: 8 });
    expect(first.tracks.map((track) => track.id)).toEqual(["t1"]);
    expect(requests).toMatchObject([{ ffmpeg: "ffmpeg-path", path: outside, width: 320, height: 180, duration: 4 }]);
    expect(progress).toEqual([0.5]);
    expect(existsSync(join(root, ...PEOPLE_DIR.split("/")))).toBe(true);
    expect((await readFaceScan(root, HASH))?.tracks[0]?.embeddings).toHaveLength(1);

    const second = await scanFileFaces(root, input, deps);
    expect(second).toMatchObject({ cached: true, samples: 8 });
    expect(second.tracks.map((track) => track.id)).toEqual(["t1"]);
    expect(requests).toHaveLength(1);
  });

  it("scans again with force, and builds the scanner only when it decodes", async () => {
    const root = tempDir();
    const { requests, scanner } = countingScanner();
    let built = 0;
    const deps = {
      scanner: async () => {
        built++;
        return scanner;
      },
      ffmpeg: async () => "ffmpeg-path",
    };
    const input = { path: "/x/a.mp4", hash: HASH, width: 320, height: 180 };
    await scanFileFaces(root, input, deps);
    await scanFileFaces(root, input, deps);
    expect(built).toBe(1);
    await scanFileFaces(root, { ...input, force: true }, deps);
    expect(built).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("caches nothing when the scanner fails", async () => {
    const root = tempDir();
    const failing = async (): Promise<PeopleScanResult> => {
      throw new Error("no model");
    };
    await expect(scanFileFaces(root, { path: "/x/a.mp4", hash: HASH, width: 320, height: 180 }, { scanner: async () => failing, ffmpeg: async () => "ffmpeg" })).rejects.toThrow("no model");
    expect(await readFaceScan(root, HASH)).toBeNull();
  });
});
