import { mediaTools, runBuffer } from "./media-tools.js";

/** Whether an RGB pixel is the default cover colour (#ffd426), within a tolerance for chroma subsampling. */
function isCoverColour(rgb: Buffer, offset: number): boolean {
  return Math.abs(rgb[offset]! - 0xff) < 24 && Math.abs(rgb[offset + 1]! - 0xd4) < 24 && Math.abs(rgb[offset + 2]! - 0x26) < 40;
}

/** Pixels of the default cover colour in an RGB24 buffer. */
export function coverPixels(rgb: Buffer): number {
  let count = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) if (isCoverColour(rgb, i)) count++;
  return count;
}

/** Columns that hold fewer cover-coloured pixels than this share of the fullest one are noise, not word. */
const BOX_MIN_SHARE = 0.1;

/**
 * Size of the word in a `width`-wide RGB24 buffer: the cover-coloured pixels that are not cover-coloured in
 * `without` (the same picture without the word, as the footage has such pixels itself). The word is the
 * longest run of rows that have any; stray pixels elsewhere in the picture are left out. Null when there are none.
 */
export function coverBox(rgb: Buffer, width: number, without: Buffer): { width: number; height: number } | null {
  const height = rgb.length / 3 / width;
  const rows = new Array<number>(height).fill(0);
  const word = (i: number) => isCoverColour(rgb, i) && !isCoverColour(without, i);
  for (let i = 0; i + 2 < rgb.length; i += 3) if (word(i)) rows[Math.floor(i / 3 / width)]!++;
  let best = { first: 0, length: 0 };
  for (let y = 0, first = -1; y <= height; y++) {
    if (y < height && rows[y]! > 0) {
      if (first < 0) first = y;
    } else if (first >= 0) {
      if (y - first > best.length) best = { first, length: y - first };
      first = -1;
    }
  }
  if (best.length === 0) return null;
  const columns = new Array<number>(width).fill(0);
  for (let y = best.first; y < best.first + best.length; y++) {
    for (let x = 0; x < width; x++) if (word((y * width + x) * 3)) columns[x]!++;
  }
  const floor = Math.max(1, Math.max(...columns) * BOX_MIN_SHARE);
  const left = columns.findIndex((count) => count >= floor);
  const right = columns.findLastIndex((count) => count >= floor);
  return { width: right - left + 1, height: best.length };
}

/** First frame of `file` after the video filter `filter`, as RGB24 bytes. */
export async function decode(file: string, filter: string): Promise<Buffer> {
  const { ffmpeg } = await mediaTools();
  return runBuffer(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/** Number of video frames of `file`, counted by decoding. */
export async function countFrames(file: string): Promise<number> {
  const { ffprobe } = await mediaTools();
  const counted = await runBuffer(ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]);
  return Number(counted.toString().trim());
}
