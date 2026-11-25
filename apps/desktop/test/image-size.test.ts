import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { imageFileSize, imageSizeOf } from "../src/main/image-size.js";

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) => new Uint8Array([0x89, ...text("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...text("IHDR"), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => new Uint8Array([...text("GIF89a"), ...u16le(w), ...u16le(h), 0, 0, 0]);
const riff = (chunk: string, body: number[]) => new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(chunk), ...u32be(0).reverse(), ...body, ...new Array(16).fill(0)]);
const webpX = (w: number, h: number) => riff("VP8X", [0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
const webpLossless = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webpLossy = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)]);
const jpeg = (w: number, h: number, exif = 0) =>
  new Uint8Array([
    0xff, 0xd8,
    // APP1 holding `exif` bytes, as a camera's EXIF block would.
    0xff, 0xe1, ...u16be(exif + 2), ...new Array(exif).fill(0),
    0xff, 0xdb, ...u16be(4), 0, 0,
    0xff, 0xc4, ...u16be(4), 0, 0,
    0xff, 0xc2, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);

describe("imageSizeOf", () => {
  it("reads PNG, GIF, every WebP kind and JPEG (progressive, after other markers)", () => {
    expect(imageSizeOf(png(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(imageSizeOf(gif(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSizeOf(webpX(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageSizeOf(webpLossless(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSizeOf(webpLossy(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(imageSizeOf(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("says nothing of other or cut bytes", () => {
    expect(imageSizeOf(new TextEncoder().encode("hello, world, not a picture"))).toBeNull();
    expect(imageSizeOf(png(10, 10).subarray(0, 20))).toBeNull();
    expect(imageSizeOf(jpeg(10, 10).subarray(0, 12))).toBeNull();
    expect(imageSizeOf(png(0, 10))).toBeNull();
  });
});

describe("imageFileSize", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  it("reads the file, on past a large EXIF block of a JPEG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "image-size-"));
    dirs.push(dir);
    await writeFile(join(dir, "a.webp"), webpX(800, 600));
    await writeFile(join(dir, "b.jpg"), jpeg(3000, 2000, 65_500));
    await writeFile(join(dir, "c.txt"), "plain");
    expect(await imageFileSize(join(dir, "a.webp"))).toEqual({ width: 800, height: 600 });
    expect(await imageFileSize(join(dir, "b.jpg"))).toEqual({ width: 3000, height: 2000 });
    expect(await imageFileSize(join(dir, "c.txt"))).toBeNull();
    expect(await imageFileSize(join(dir, "missing.png"))).toBeNull();
  });
});
