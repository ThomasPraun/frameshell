import { readFile } from "node:fs/promises";
import { SUBTITLE_FONT } from "@frameshell/schema";
import { fontSource } from "./fonts.js";

/** What the cover needs to size a word in the bundled face; all lengths in em. */
export interface FontMetrics {
  /** Height of capital letters (OS/2 `sCapHeight`). */
  capHeight: number;
  /** Advance width of `text` (no kerning), em. Characters the face lacks take its `.notdef` width. */
  width(text: string): number;
}

/** Cap height assumed when the face's OS/2 table is too old to hold one. */
const FALLBACK_CAP_HEIGHT = 0.7;

/**
 * Read widths and cap height out of a TrueType file: `head`, `hhea`, `hmtx`, `OS/2` and a Unicode `cmap` (format
 * 4 or 12). Only what sizing a word needs; throws when the file is not a TrueType font with those tables.
 */
export function parseFontMetrics(file: Uint8Array): FontMetrics {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const entry = 12 + i * 16;
    tables.set(String.fromCharCode(...file.subarray(entry, entry + 4)), view.getUint32(entry + 8));
  }
  const table = (name: string): number => {
    const offset = tables.get(name);
    if (offset === undefined) throw new Error(`font has no ${name} table`);
    return offset;
  };
  const head = table("head");
  const unitsPerEm = view.getUint16(head + 18);
  const hhea = table("hhea");
  const hmtx = table("hmtx");
  const metrics = view.getUint16(hhea + 34);
  const advance = (glyph: number) => view.getUint16(hmtx + Math.min(glyph, metrics - 1) * 4);

  const os2 = tables.get("OS/2");
  const capHeight = os2 !== undefined && view.getUint16(os2) >= 2 ? view.getInt16(os2 + 88) / unitsPerEm : FALLBACK_CAP_HEIGHT;

  const glyphOf = unicodeCmap(view, table("cmap"));
  return {
    capHeight: capHeight > 0 ? capHeight : FALLBACK_CAP_HEIGHT,
    width: (text) => [...text].reduce((sum, char) => sum + advance(glyphOf(char.codePointAt(0)!)), 0) / unitsPerEm,
  };
}

/** Glyph index of a code point (0, `.notdef`, when the face lacks it) from the best Unicode `cmap` subtable. */
function unicodeCmap(view: DataView, cmap: number): (code: number) => number {
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    else if (format === 4) format4 ??= offset;
  }
  if (format12 !== null) {
    const offset = format12;
    return (code) => {
      for (let g = 0; g < view.getUint32(offset + 12); g++) {
        const group = offset + 16 + g * 12;
        const start = view.getUint32(group);
        if (code >= start && code <= view.getUint32(group + 4)) return view.getUint32(group + 8) + code - start;
      }
      return 0;
    };
  }
  if (format4 === null) throw new Error("font has no Unicode cmap");
  const offset = format4;
  const segments = view.getUint16(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (code) => {
    if (code > 0xffff) return 0;
    for (let s = 0; s < segments; s++) {
      if (code > view.getUint16(ends + s * 2)) continue;
      if (code < view.getUint16(starts + s * 2)) return 0;
      const range = view.getUint16(ranges + s * 2);
      if (range === 0) return (code + view.getInt16(deltas + s * 2)) & 0xffff;
      const glyph = view.getUint16(ranges + s * 2 + range + (code - view.getUint16(starts + s * 2)) * 2);
      return glyph === 0 ? 0 : (glyph + view.getInt16(deltas + s * 2)) & 0xffff;
    }
    return 0;
  };
}

let bundled: Promise<FontMetrics> | undefined;

/** {@link FontMetrics} of the bundled subtitle face ({@link SUBTITLE_FONT}), read once. */
export function bundledFontMetrics(): Promise<FontMetrics> {
  bundled ??= readFile(fontSource(SUBTITLE_FONT.file)).then(parseFontMetrics);
  bundled.catch(() => (bundled = undefined));
  return bundled;
}
