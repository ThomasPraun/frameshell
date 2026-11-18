import { deflateSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, tail]);
}

/** An 8-bit PNG of `channels` bytes per pixel (1 grey, 3 RGB), rows top to bottom. */
function encodePng(pixels: Uint8Array, width: number, height: number, channels: 1 | 3, name: string): Buffer {
  const stride = width * channels;
  if (pixels.length !== stride * height) throw new Error(`${name}: ${pixels.length} bytes for ${width}x${height}`);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = channels === 1 ? 0 : 2; // grayscale or truecolour
  // Each row starts with filter type 0 (none): masks and charts are flat runs that deflate well as they are.
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array(0))]);
}

/** An 8-bit grayscale PNG of `width * height` bytes, rows top to bottom. */
export function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Buffer {
  return encodePng(pixels, width, height, 1, "encodeGrayPng");
}

/** An 8-bit RGB PNG of `width * height * 3` bytes (R, G, B per pixel), rows top to bottom. */
export function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Buffer {
  return encodePng(pixels, width, height, 3, "encodeRgbPng");
}
