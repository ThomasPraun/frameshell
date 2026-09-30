import { deflateSync, inflateSync } from "node:zlib";

/** Decoded 8-bit RGB image, rows top to bottom, 3 bytes per pixel. */
export interface RgbImage {
  width: number;
  height: number;
  /** `width * height * 3` bytes. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel by PNG colour type (8-bit only): gray, RGB, gray+alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decode a non-interlaced 8-bit PNG (gray, RGB, gray+alpha or RGBA; what
 * ffmpeg's png encoder writes) to RGB. Alpha is dropped: frames are opaque.
 * Throws on other bit depths, palettes or interlacing.
 */
export function decodePng(png: Uint8Array): RgbImage {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = CHANNELS[colour!] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (channels === 0) throw new Error("PNG has no IHDR chunk");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = unfilter(raw, stride, height, channels);
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; i < rows.length; i += channels, o += 3) {
    const gray = channels < 3;
    data[o] = rows[i]!;
    data[o + 1] = gray ? rows[i]! : rows[i + 1]!;
    data[o + 2] = gray ? rows[i]! : rows[i + 2]!;
  }
  return { width, height, data };
}

/** Undo per-row PNG filters (None, Sub, Up, Average, Paeth). */
function unfilter(raw: Buffer, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y > 0 ? out[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp]! : 0;
      const value = raw[src + x]!;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = a;
          break;
        case 2:
          predicted = b;
          break;
        case 3:
          predicted = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`corrupt PNG: row filter ${filter}`);
      }
      out[row + x] = (value + predicted) & 0xff;
    }
  }
  return out;
}

/** Encode an RGB image as an 8-bit RGB PNG (Up filter: cheap and good on video frames). */
export function encodePng(image: RgbImage): Buffer {
  const { width, height, data } = image;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 2;
    for (let x = 0; x < stride; x++) {
      const above = y > 0 ? data[(y - 1) * stride + x]! : 0;
      raw[at + 1 + x] = (data[y * stride + x]! - above) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Downscale by area averaging (every source pixel counts, so thin lines and
 * captions survive). Never upscales: returns `image` when it already fits.
 */
export function fitWithin(image: RgbImage, maxWidth: number, maxHeight: number): RgbImage {
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8Array(width * height * 3);
  const xs = image.width / width;
  const ys = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * ys);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ys));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xs);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xs));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 3;
          r += image.data[i]!;
          g += image.data[i + 1]!;
          b += image.data[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 3;
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
    }
  }
  return { width, height, data };
}

/** Where one frame landed on a {@link contactSheet}. */
export interface SheetTile {
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Gap between tiles, pixels; dark gray so black frames stay distinguishable from it. */
const GAP = 4;
const GAP_COLOUR = 64;

/**
 * Tile `frames` left to right, top to bottom, into one image at most
 * `maxWidth` wide: `ceil(sqrt(n))` columns, each frame scaled to the column
 * width. Frames may differ in size; each is fitted into the cell of the first.
 */
export function contactSheet(frames: readonly RgbImage[], maxWidth: number): { image: RgbImage; columns: number; tiles: SheetTile[] } {
  const first = frames[0];
  if (!first) throw new Error("contact sheet needs at least one frame");
  const columns = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / columns);
  const cellWidth = Math.min(first.width, Math.floor((maxWidth - GAP * (columns - 1)) / columns));
  const cellHeight = Math.max(1, Math.round((first.height * cellWidth) / first.width));
  const width = columns * cellWidth + GAP * (columns - 1);
  const height = rows * cellHeight + GAP * (rows - 1);
  const data = new Uint8Array(width * height * 3).fill(GAP_COLOUR);
  const tiles = frames.map((frame, index) => {
    const tile = fitWithin(frame, cellWidth, cellHeight);
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = column * (cellWidth + GAP);
    const y = row * (cellHeight + GAP);
    for (let ty = 0; ty < tile.height; ty++) {
      const src = ty * tile.width * 3;
      data.set(tile.data.subarray(src, src + tile.width * 3), ((y + ty) * width + x) * 3);
    }
    return { row, column, x, y, width: tile.width, height: tile.height };
  });
  return { image: { width, height, data }, columns, tiles };
}
