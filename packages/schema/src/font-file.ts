// Metrics of a TrueType or OpenType font file. Pure, so export (Node), review and the preview (browser) read the
// same numbers out of the same bytes.

/** What laying out text in a face needs; all lengths in em. */
export interface FontMetrics {
  /**
   * Family name inside the file (Windows name id 1, else 16): the name libass matches a style's `Fontname` against.
   * Null when the file has no readable family name.
   */
  family: string | null;
  /** OS/2 winAscent over unitsPerEm (hhea ascender without OS/2): libass sizes and aligns a line on it. */
  ascent: number;
  /** OS/2 winDescent over unitsPerEm (minus hhea descender without OS/2). */
  descent: number;
  /** Height of capital letters (OS/2 `sCapHeight`). */
  capHeight: number;
  /** Advance width of `text` (no kerning), em. Characters the face lacks take its `.notdef` width. */
  width(text: string): number;
}

/** Cap height assumed when the face's OS/2 table is too old to hold one. */
const FALLBACK_CAP_HEIGHT = 0.7;

/**
 * Read the metrics of a TrueType or OpenType (CFF) file: `head`, `hhea`, `hmtx`, `OS/2`, `name` and a Unicode
 * `cmap` (format 4 or 12). Throws when the file is not an sfnt font with those tables (WOFF and WOFF2 are
 * compressed, so they throw too).
 */
export function parseFontMetrics(file: Uint8Array): FontMetrics {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.byteLength < 12) throw new Error("not a font file: too short");
  const tag = view.getUint32(0);
  // TrueType 1.0, `OTTO` (CFF outlines), `true` (old Apple TrueType).
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) throw new Error("not a TrueType or OpenType font (a WOFF file must be converted to .ttf or .otf)");
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
  const win = os2 !== undefined ? { ascent: view.getUint16(os2 + 74), descent: view.getUint16(os2 + 76) } : null;
  // libass takes the win metrics when they are not both zero, else hhea's.
  const [ascent, descent] =
    win && win.ascent + win.descent > 0 ? [win.ascent, win.descent] : [view.getInt16(hhea + 4), -view.getInt16(hhea + 6)];

  const glyphOf = unicodeCmap(view, table("cmap"));
  const name = tables.get("name");
  return {
    family: name === undefined ? null : familyName(view, name),
    ascent: ascent / unitsPerEm,
    descent: descent / unitsPerEm,
    capHeight: capHeight > 0 ? capHeight : FALLBACK_CAP_HEIGHT,
    width: (text) => [...text].reduce((sum, char) => sum + advance(glyphOf(char.codePointAt(0)!)), 0) / unitsPerEm,
  };
}

/**
 * Windows family (name id 1), else Windows typographic family (16), then the Mac Roman ones; null when none.
 * libass indexes only Microsoft-platform ids 1 and 4, so a static weight ("Montserrat ExtraBold" in 1,
 * "Montserrat" in 16) must be named by its id 1.
 */
function familyName(view: DataView, name: number): string | null {
  const found = new Map<string, string>();
  for (const record of nameRecords(view, name)) {
    if (record.id !== 1 && record.id !== 16) continue;
    const key = `${record.id}:${record.windows ? "w" : "m"}`;
    if (!found.has(key)) found.set(key, record.text);
  }
  return found.get("1:w") ?? found.get("16:w") ?? found.get("1:m") ?? found.get("16:m") ?? null;
}

/** One readable string of a `name` table: Windows Unicode or Mac Roman, trimmed, never empty. */
interface NameRecord {
  id: number;
  windows: boolean;
  text: string;
}

function* nameRecords(view: DataView, name: number): Generator<NameRecord> {
  const count = view.getUint16(name + 2);
  const strings = name + view.getUint16(name + 4);
  for (let i = 0; i < count; i++) {
    const record = name + 6 + i * 12;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const length = view.getUint16(record + 8);
    const start = strings + view.getUint16(record + 10);
    if (start + length > view.byteLength) continue;
    let text = "";
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      for (let at = 0; at + 1 < length; at += 2) text += String.fromCharCode(view.getUint16(start + at));
    } else if (platform === 1 && encoding === 0) {
      for (let at = 0; at < length; at++) text += String.fromCharCode(view.getUint8(start + at));
    } else continue;
    if (text.trim() !== "") yield { id: view.getUint16(record + 6), windows: platform === 3, text: text.trim() };
  }
}

/**
 * Strings of a font's `name` table by name id (0 copyright, 1 family, 8 manufacturer, 9 designer, 13 licence,
 * 14 licence URL, 16 typographic family…), Windows Unicode preferred over Mac Roman. `table` is the table's bytes
 * alone, as a WOFF or WOFF2 unwrapper hands it over. Throws when it is too short to be a `name` table.
 */
export function readNameTable(table: Uint8Array): Map<number, string> {
  if (table.byteLength < 6) throw new Error("not a name table: too short");
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const found = new Map<number, string>();
  const mac = new Map<number, string>();
  for (const record of nameRecords(view, 0)) {
    const into = record.windows ? found : mac;
    if (!into.has(record.id)) into.set(record.id, record.text);
  }
  for (const [id, text] of mac) if (!found.has(id)) found.set(id, text);
  return found;
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
