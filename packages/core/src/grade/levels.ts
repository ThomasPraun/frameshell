// Levels of one frame as ffmpeg `signalstats` prints them, normalized, and the mean of several (`grade.analyze`, ADR 0031).

/** Video levels of 8-bit Rec.709: luma 16 to 235, chroma 16 to 240 centred on 128. */
const LUMA_BLACK = 16;
const LUMA_SPAN = 219;
const CHROMA_NEUTRAL = 128;
const CHROMA_SPAN = 224;

/** Rec.709 weights of the colour differences: R = Y + 1.5748 Cr, B = Y + 1.8556 Cb, G = Y - 0.1873 Cb - 0.4681 Cr. */
const R_CR = 1.5748;
const B_CB = 1.8556;
/** G minus the mean of R and B in terms of Cb and Cr (the Y terms cancel). */
const TINT_CB = -(0.1873 + B_CB / 2);
const TINT_CR = -(0.4681 + R_CR / 2);

/** What one frame measures, every number 0 to 1 except the signed `warmth` and `tint`. */
export interface FrameLevels {
  lumaMin: number;
  lumaLow: number;
  lumaMean: number;
  lumaHigh: number;
  lumaMax: number;
  /** Mean of the pixel's chroma distance from neutral. */
  saturation: number;
  /** Mean red minus mean blue. */
  warmth: number;
  /** Mean green minus the mean of red and blue. */
  tint: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const luma = (raw: number): number => clamp01((raw - LUMA_BLACK) / LUMA_SPAN);

/** The `lavfi.signalstats.*` keys of one `frame:` block of `metadata=print` output, as numbers. */
function readBlocks(text: string): Map<string, number>[] {
  const blocks: Map<string, number>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("frame:")) {
      blocks.push(new Map());
      continue;
    }
    const match = /^lavfi\.signalstats\.([A-Z]+)=(-?[0-9.]+)$/.exec(line.trim());
    if (match && blocks.length > 0) blocks[blocks.length - 1]!.set(match[1]!, Number(match[2]));
  }
  return blocks;
}

/**
 * The first frame of the text `signalstats,metadata=mode=print:file=-` prints, from 8-bit video-level YUV 4:4:4;
 * null when it holds none. Warmth and tint come from the mean colour differences and the mean luma, which is
 * exact for the means because the conversion is linear.
 */
export function parseSignalstats(text: string): FrameLevels | null {
  const stats = readBlocks(text)[0];
  const need = ["YMIN", "YLOW", "YAVG", "YHIGH", "YMAX", "UAVG", "VAVG", "SATAVG"] as const;
  if (!stats || need.some((key) => !stats.has(key))) return null;
  const cb = (stats.get("UAVG")! - CHROMA_NEUTRAL) / CHROMA_SPAN;
  const cr = (stats.get("VAVG")! - CHROMA_NEUTRAL) / CHROMA_SPAN;
  return {
    lumaMin: luma(stats.get("YMIN")!),
    lumaLow: luma(stats.get("YLOW")!),
    lumaMean: luma(stats.get("YAVG")!),
    lumaHigh: luma(stats.get("YHIGH")!),
    lumaMax: luma(stats.get("YMAX")!),
    saturation: clamp01(stats.get("SATAVG")! / CHROMA_SPAN),
    warmth: R_CR * cr - B_CB * cb,
    tint: TINT_CB * cb + TINT_CR * cr,
  };
}

/** The frames' levels as one: means of every figure, the darkest and the brightest pixel of any frame for `lumaMin` and `lumaMax`. */
export function meanLevels(frames: readonly FrameLevels[]): FrameLevels {
  const mean = (pick: (frame: FrameLevels) => number) => frames.reduce((sum, frame) => sum + pick(frame), 0) / frames.length;
  return {
    lumaMin: Math.min(...frames.map((frame) => frame.lumaMin)),
    lumaLow: mean((frame) => frame.lumaLow),
    lumaMean: mean((frame) => frame.lumaMean),
    lumaHigh: mean((frame) => frame.lumaHigh),
    lumaMax: Math.max(...frames.map((frame) => frame.lumaMax)),
    saturation: mean((frame) => frame.saturation),
    warmth: mean((frame) => frame.warmth),
    tint: mean((frame) => frame.tint),
  };
}

/** `value` to `digits` decimals. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
