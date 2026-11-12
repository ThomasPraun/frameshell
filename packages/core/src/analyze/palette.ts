// Dominant colours of sampled frames. Pure: `service.ts` feeds it the RGB pixels ffmpeg decodes.

/** Colours a palette holds at most. */
export const PALETTE_SIZE = 5;
/** Bits kept of each channel when counting colours: 16 levels a channel, 4096 bins. */
const BIN_BITS = 4;
/** Two palette colours are at least this far apart (RGB distance, 0 to 441): nearer shades are one colour. */
const MIN_COLOR_DISTANCE = 56;
/** A colour holding less of the pixels than this is left out. */
const MIN_SHARE = 0.01;

/** One colour of a palette. */
export interface PaletteColor {
  /** `#rrggbb`. */
  hex: string;
  /** Fraction of the pixels that are this colour or the shades merged into it, 0 to 1. */
  share: number;
}

interface Bin {
  count: number;
  r: number;
  g: number;
  b: number;
}

/** Counts the colours of the pixels it is given, then reports the dominant ones; frames of a shot are added one after another. */
export class PaletteBuilder {
  readonly #bins = new Map<number, Bin>();
  #pixels = 0;

  /** Count the pixels of `rgb`, interleaved 8-bit red, green, blue. */
  add(rgb: Uint8Array): void {
    const shift = 8 - BIN_BITS;
    for (let i = 0; i + 2 < rgb.length; i += 3) {
      const r = rgb[i]!;
      const g = rgb[i + 1]!;
      const b = rgb[i + 2]!;
      const key = ((r >> shift) << (2 * BIN_BITS)) | ((g >> shift) << BIN_BITS) | (b >> shift);
      const bin = this.#bins.get(key);
      if (bin) {
        bin.count++;
        bin.r += r;
        bin.g += g;
        bin.b += b;
      } else this.#bins.set(key, { count: 1, r, g, b });
      this.#pixels++;
    }
  }

  /** Count what `other` counted too. */
  merge(other: PaletteBuilder): void {
    for (const [key, bin] of other.#bins) {
      const own = this.#bins.get(key);
      if (own) {
        own.count += bin.count;
        own.r += bin.r;
        own.g += bin.g;
        own.b += bin.b;
      } else this.#bins.set(key, { ...bin });
    }
    this.#pixels += other.#pixels;
  }

  /** Pixels counted. */
  get pixels(): number {
    return this.#pixels;
  }

  /**
   * The dominant colours, biggest share first: the most common shades, each a centre when it is at least
   * {@link MIN_COLOR_DISTANCE} from the centres taken, every shade then joining its nearest centre. A colour's value
   * is the mean of its pixels. Empty without pixels.
   */
  colors(size = PALETTE_SIZE): PaletteColor[] {
    if (this.#pixels === 0) return [];
    const bins = [...this.#bins.values()].map((bin) => ({ ...bin, mean: [bin.r / bin.count, bin.g / bin.count, bin.b / bin.count] as const }));
    bins.sort((a, b) => b.count - a.count);
    const centres: (readonly [number, number, number])[] = [];
    for (const bin of bins) {
      if (centres.length === size) break;
      if (centres.every((centre) => distance(centre, bin.mean) >= MIN_COLOR_DISTANCE)) centres.push(bin.mean);
    }
    const groups = centres.map(() => ({ count: 0, r: 0, g: 0, b: 0 }));
    for (const bin of bins) {
      let best = 0;
      let nearest = Infinity;
      for (const [i, centre] of centres.entries()) {
        const d = distance(centre, bin.mean);
        if (d < nearest) {
          nearest = d;
          best = i;
        }
      }
      const group = groups[best]!;
      group.count += bin.count;
      group.r += bin.r;
      group.g += bin.g;
      group.b += bin.b;
    }
    return groups
      .map((group) => ({ hex: hexOf(group.r / group.count, group.g / group.count, group.b / group.count), share: Math.round((group.count / this.#pixels) * 1000) / 1000 }))
      .filter((color) => color.share >= MIN_SHARE)
      .sort((a, b) => b.share - a.share || (a.hex < b.hex ? -1 : 1));
  }
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}
