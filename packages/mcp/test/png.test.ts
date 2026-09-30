import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../core/test/helpers.js";
import { mediaTools, run } from "../../core/test/media-tools.js";
import { type RgbImage, contactSheet, decodePng, encodePng, fitWithin } from "../src/png.js";

/** Solid image of one colour. */
function solid(width: number, height: number, [r, g, b]: [number, number, number]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) data.set([r, g, b], i);
  return { width, height, data };
}

function pixel(image: RgbImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 3;
  return [...image.data.subarray(i, i + 3)];
}

describe("decodePng", () => {
  // Reference: ffmpeg decoding its own PNG to raw RGB, an independent decoder.
  it.each(["rgb24", "rgba", "gray"])("decodes a %s test pattern from the managed ffmpeg bit-exactly", async (pixFmt) => {
    const { ffmpeg } = await mediaTools();
    const dir = tempDir();
    const png = join(dir, "a.png");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=64x48", "-frames:v", "1", "-pix_fmt", pixFmt, png]);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", join(dir, "a.rgb")]);
    const decoded = decodePng(readFileSync(png));
    expect([decoded.width, decoded.height]).toEqual([64, 48]);
    expect(Buffer.from(decoded.data).equals(readFileSync(join(dir, "a.rgb")))).toBe(true);
  });

  it("round-trips what encodePng writes", () => {
    const image: RgbImage = { width: 2, height: 2, data: new Uint8Array([1, 2, 3, 250, 251, 252, 0, 0, 0, 255, 128, 7]) };
    expect(decodePng(encodePng(image))).toEqual(image);
  });

  it("refuses non-PNG bytes", () => {
    expect(() => decodePng(Buffer.from("hello world"))).toThrow(/not a PNG/);
  });
});

describe("fitWithin", () => {
  it("averages every source pixel into the smaller image", () => {
    const image = solid(4, 2, [0, 0, 0]);
    for (const y of [0, 1]) for (const x of [0, 1]) image.data.set([200, 100, 50], (y * 4 + x) * 3);
    const small = fitWithin(image, 2, 2);
    expect([small.width, small.height]).toEqual([2, 1]);
    expect(pixel(small, 0, 0)).toEqual([200, 100, 50]);
    expect(pixel(small, 1, 0)).toEqual([0, 0, 0]);
  });

  it("never upscales", () => {
    const image = solid(3, 3, [9, 9, 9]);
    expect(fitWithin(image, 100, 100)).toBe(image);
  });
});

describe("contactSheet", () => {
  it("tiles frames left to right in ceil(sqrt(n)) columns with a gray gap", () => {
    const frames = [solid(40, 20, [255, 0, 0]), solid(40, 20, [0, 255, 0]), solid(40, 20, [0, 0, 255])];
    const { image, columns, tiles } = contactSheet(frames, 1000);
    expect(columns).toBe(2);
    expect([image.width, image.height]).toEqual([84, 44]);
    expect(tiles.map(({ row, column, x, y }) => [row, column, x, y])).toEqual([
      [0, 0, 0, 0],
      [0, 1, 44, 0],
      [1, 0, 0, 24],
    ]);
    expect(pixel(image, 10, 10)).toEqual([255, 0, 0]);
    expect(pixel(image, 50, 10)).toEqual([0, 255, 0]);
    expect(pixel(image, 10, 30)).toEqual([0, 0, 255]);
    expect(pixel(image, 42, 10)).toEqual([64, 64, 64]);
  });

  it("shrinks cells so the sheet fits maxWidth", () => {
    const { image, tiles } = contactSheet([solid(400, 200, [1, 1, 1]), solid(400, 200, [2, 2, 2])], 204);
    expect(image.width).toBe(204);
    expect(tiles[0]).toMatchObject({ width: 100, height: 50 });
  });
});
