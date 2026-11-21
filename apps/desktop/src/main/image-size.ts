// Pixel size of a picture from its header bytes (#751): PNG, JPEG, GIF and WebP alike, where Electron's
// `nativeImage` reads PNG and JPEG only. Pure parsing; `imageFileSize` reads the file.
import { open } from "node:fs/promises";
import type { Size } from "@frameshell/schema/composite";

/** Bytes read from the start of a file: enough for every header but a JPEG's, which reads on to its frame marker. */
const HEAD = 64 * 1024;
/** Most of a JPEG read looking for its frame marker (EXIF thumbnails come first). */
const JPEG_LIMIT = 16 * 1024 * 1024;

/** The picture size `bytes` (the start of the file) state; null when they are not a PNG, JPEG, GIF or WebP header, or are cut short. */
export function imageSizeOf(bytes: Uint8Array): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  const size = (width: number, height: number): Size | null => (width > 0 && height > 0 ? { width, height } : null);
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return size(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return size(view.getUint16(6, true), view.getUint16(8, true));
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    // Lossy: the frame header after the start code 9d 01 2a holds 14-bit sizes.
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    // Lossless: after the signature byte 0x2f, 14 bits each of width - 1 and height - 1.
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    // Extended: 24-bit canvas width - 1 and height - 1.
    if (chunk === "VP8X") return size(1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)));
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      // Fill bytes, and markers without a length.
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      // A start-of-frame marker (not DHT c4, JPG c8, DAC cc): height then width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(view.getUint16(at + 7), view.getUint16(at + 5));
      at += 2 + view.getUint16(at + 2);
    }
    return null;
  }
  return null;
}

/** The pixel size of the picture at `path`; null when it cannot be read or is not a PNG, JPEG, GIF or WebP. */
export async function imageFileSize(path: string): Promise<Size | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;
  try {
    let bytes = new Uint8Array(HEAD);
    let { bytesRead } = await file.read(bytes, 0, HEAD, 0);
    let found = imageSizeOf(bytes.subarray(0, bytesRead));
    // A JPEG whose frame marker lies past the first read (a large EXIF block): read the whole of it, bounded.
    if (!found && bytes[0] === 0xff && bytes[1] === 0xd8 && bytesRead === HEAD) {
      const { size } = await file.stat();
      bytes = new Uint8Array(Math.min(size, JPEG_LIMIT));
      ({ bytesRead } = await file.read(bytes, 0, bytes.length, 0));
      found = imageSizeOf(bytes.subarray(0, bytesRead));
    }
    return found;
  } finally {
    await file.close();
  }
}
