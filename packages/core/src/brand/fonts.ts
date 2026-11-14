// Fonts of a captured page (ADR 0044 decision 4): which faces the page declares, which one serves each weight in
// use, whether a face's own name table names an open licence, and whether its cmap makes it an icon font. A face is
// copied only on those verdicts; otherwise the curated substitute table names an open font to use instead.
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { type CmapCoverage, type FontCategory, type FontWidth, type OpenFontLicence, cmapCoverage, readNameTable } from "@frameshell/schema";

/** What a face's own tables say about itself. */
export interface FontFacts {
  family: string | null;
  /** Foundry (name id 8), else designer (9). */
  maker: string | null;
  licence: OpenFontLicence | null;
  /** Licence text and URL as written (ids 13 and 14), for the note. */
  licenceText: string | null;
  /** Design class from OS/2 (`sFamilyClass`, PANOSE); null when the file has no OS/2 table or does not say. */
  category: FontCategory | null;
  /** OS/2 `usWidthClass`; null without an OS/2 table. */
  width: FontWidth | null;
  /** What the Unicode cmap maps; null when the file has no readable one. */
  coverage: CmapCoverage | null;
}

/** One `@font-face` rule of a stylesheet, its `src` URLs resolved. */
export interface DeclaredFace {
  family: string;
  weight: string;
  style: string;
  unicodeRange: string | null;
  /** `url()` sources in declared order, with their `format()` hint. */
  sources: { url: string; format: string | null }[];
}

const LICENCES: readonly [OpenFontLicence, RegExp][] = [
  ["OFL-1.1", /open font licen[cs]e,?\s*(?:version\s*)?1\.1|\bOFL[- ]?1\.1\b|openfontlicense\.org|scripts\.sil\.org\/(?:cms\/scripts\/page\.php\?.*id=)?OFL/i],
  ["Apache-2.0", /apache licen[cs]e,?\s*(?:version\s*)?2\.0|apache\.org\/licenses\/LICENSE-2\.0/i],
  ["UFL-1.0", /ubuntu font licen[cs]e|font\.ubuntu\.com\/(?:ufl|licen[cs]e)/i],
];

/** The open licence names 13 (licence) or 14 (licence URL) state, else null. */
export function fontLicence(names: Map<number, string>): OpenFontLicence | null {
  const text = `${names.get(13) ?? ""}\n${names.get(14) ?? ""}`;
  return LICENCES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/**
 * Read the `name`, `OS/2` and `cmap` tables of a TrueType, OpenType, WOFF or WOFF2 file. Throws when it is none of
 * them or has no `name` table; a missing or broken `OS/2` or `cmap` only leaves its facts null.
 */
export function readFontFacts(file: Uint8Array): FontFacts {
  const tables = fontTables(file, ["name", "OS/2", "cmap"]);
  const name = tables.get("name");
  if (!name) throw new Error("font has no name table");
  const names = readNameTable(name);
  const licenceText = [names.get(13), names.get(14)].filter(Boolean).join(" ") || null;
  let coverage: CmapCoverage | null;
  try {
    const cmap = tables.get("cmap");
    coverage = cmap ? cmapCoverage(cmap) : null;
  } catch {
    coverage = null;
  }
  return {
    family: names.get(16) ?? names.get(1) ?? null,
    maker: names.get(8) ?? names.get(9) ?? null,
    licence: fontLicence(names),
    licenceText,
    coverage,
    ...os2Class(tables.get("OS/2")),
  };
}

/**
 * True when a face's cmap makes it an icon font: at least half of what it maps sits in the Private Use Area (Font
 * Awesome, Material Symbols: icons there, a few letters for ligatures at most). Text faces map few or none there.
 */
export function isIconCoverage(coverage: CmapCoverage | null): boolean {
  return coverage !== null && coverage.privateUse > 0 && coverage.privateUse * 2 >= coverage.mapped;
}

/** Category and width from an OS/2 table: `usWidthClass` (offset 6), `sFamilyClass` (30), PANOSE (32). */
function os2Class(os2: Uint8Array | undefined): { category: FontCategory | null; width: FontWidth | null } {
  if (!os2 || os2.byteLength < 42) return { category: null, width: null };
  const view = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
  const widthClass = view.getUint16(6);
  const width: FontWidth | null = widthClass >= 1 && widthClass <= 4 ? "condensed" : widthClass === 5 ? "normal" : widthClass >= 6 && widthClass <= 9 ? "expanded" : null;
  // PANOSE family kind 2 (Latin text) with proportion 9 is monospaced; kind 3 is hand-written.
  const panoseKind = view.getUint8(32);
  if (panoseKind === 2 && view.getUint8(35) === 9) return { category: "mono", width };
  if (panoseKind === 3) return { category: "script", width };
  // IBM font class (high byte of sFamilyClass): 1-3 and 7 serif, 4 and 5 slab, 8 sans, 10 script.
  const ibm = view.getUint8(30);
  const category: FontCategory | null = [1, 2, 3, 7].includes(ibm) ? "serif" : ibm === 4 || ibm === 5 ? "slab" : ibm === 8 ? "sans" : ibm === 10 ? "script" : null;
  return { category, width };
}

/** File extension for a font by its signature, or null when it is not a font file. */
export function fontExtension(file: Uint8Array): "ttf" | "otf" | "woff" | "woff2" | null {
  if (file.byteLength < 4) return null;
  const tag = new DataView(file.buffer, file.byteOffset, 4).getUint32(0);
  if (tag === 0x774f4632) return "woff2";
  if (tag === 0x774f4646) return "woff";
  if (tag === 0x4f54544f) return "otf";
  if (tag === 0x00010000 || tag === 0x74727565) return "ttf";
  return null;
}

/**
 * The bytes of the `wanted` tables a file has, unwrapped from WOFF (zlib per table) or WOFF2 (one brotli stream).
 * Throws when the file is no font or its directory is broken.
 */
function fontTables(file: Uint8Array, wanted: readonly string[]): Map<string, Uint8Array> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const kind = fontExtension(file);
  const out = new Map<string, Uint8Array>();
  if (kind === "ttf" || kind === "otf") {
    for (let i = 0; i < view.getUint16(4); i++) {
      const entry = 12 + i * 16;
      const tag = tagAt(file, entry);
      if (!wanted.includes(tag)) continue;
      const offset = view.getUint32(entry + 8);
      const length = view.getUint32(entry + 12);
      if (offset + length > file.byteLength) throw new Error("bad table directory");
      out.set(tag, file.subarray(offset, offset + length));
    }
    return out;
  }
  if (kind === "woff") {
    for (let i = 0; i < view.getUint16(12); i++) {
      const entry = 44 + i * 20;
      const tag = tagAt(file, entry);
      if (!wanted.includes(tag)) continue;
      const offset = view.getUint32(entry + 4);
      const compressed = view.getUint32(entry + 8);
      const original = view.getUint32(entry + 12);
      if (offset + compressed > file.byteLength || original > maxTable(tag)) throw new Error("bad WOFF table directory");
      const stored = file.subarray(offset, offset + compressed);
      // The cap stops a zlib bomb: inflating past the declared length throws instead of filling memory.
      out.set(tag, compressed < original ? inflateSync(stored, { maxOutputLength: original }) : stored);
    }
    return out;
  }
  if (kind === "woff2") return woff2Tables(file, view, wanted);
  throw new Error("not a TrueType, OpenType, WOFF or WOFF2 font");
}

/** Largest `name` table read. Real ones are a few KB; the cap bounds decoding of a page's untrusted bytes. */
const MAX_NAME_TABLE = 1024 * 1024;

/** Largest `OS/2` or `cmap` table read: a full CJK cmap is a few hundred KB. */
const MAX_OTHER_TABLE = 4 * 1024 * 1024;

function maxTable(tag: string): number {
  return tag === "name" ? MAX_NAME_TABLE : MAX_OTHER_TABLE;
}

/** Largest decoded WOFF2 table stream read: the tables read may sit after glyf, so the whole prefix is decoded. */
const MAX_WOFF2_STREAM = 32 * 1024 * 1024;

/** WOFF2 table tags by their known-tag index (W3C WOFF2 §4.2). */
const WOFF2_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/**
 * Tables of a WOFF2 file: they sit back to back in one brotli stream, in directory order, each `transformLength`
 * long when transformed (glyf and loca by default, hmtx on request), else `origLength`. `name`, `OS/2` and `cmap`
 * are never transformed. Font collections are refused.
 */
function woff2Tables(file: Uint8Array, view: DataView, wanted: readonly string[]): Map<string, Uint8Array> {
  if (view.getUint32(4) === 0x74746366) throw new Error("WOFF2 font collections are not read");
  const tables = view.getUint16(12);
  const compressedLength = view.getUint32(20);
  let at = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = view.getUint8(at++);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("bad WOFF2 table directory");
  };
  let offset = 0;
  const found = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < tables; i++) {
    const flags = view.getUint8(at++);
    const index = flags & 0x3f;
    let tag: string;
    if (index === 0x3f) {
      tag = tagAt(file, at);
      at += 4;
    } else tag = WOFF2_TAGS[index] ?? "";
    const version = (flags >> 6) & 3;
    const original = base128();
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    const length = transformed ? base128() : original;
    if (wanted.includes(tag)) found.set(tag, { offset, length });
    offset += length;
  }
  if (found.size === 0) return new Map();
  // `offset` is now the whole stream's decoded length. Decoding is capped there, so a brotli bomb throws instead of
  // filling memory; a directory declaring more than MAX_WOFF2_STREAM is refused before decoding.
  if (offset > MAX_WOFF2_STREAM || [...found].some(([tag, table]) => table.length > maxTable(tag))) throw new Error("WOFF2 tables larger than Frameshell reads");
  if (at + compressedLength > file.byteLength) throw new Error("bad WOFF2 table directory");
  const stream = brotliDecompressSync(file.subarray(at, at + compressedLength), { maxOutputLength: Math.max(offset, 1) });
  if (stream.byteLength !== offset) throw new Error("WOFF2 stream length does not match its table directory");
  return new Map([...found].map(([tag, table]) => [tag, stream.subarray(table.offset, table.offset + table.length)]));
}

function tagAt(file: Uint8Array, at: number): string {
  return String.fromCharCode(...file.subarray(at, at + 4));
}

/** True for a family that holds icons, not letters: never a face for text. */
export function isIconFamily(family: string, unicodeRange: string | null = null): boolean {
  if (/icon|awesome|glyph|symbol|icomoon|fontello|dashicons|ionicons|feather|remixicon|bootstrap-icons|lucide|phosphor/i.test(family)) return true;
  // A face covering only the Private Use Area (U+E000-F8FF) maps icons there.
  if (unicodeRange) {
    const ranges = unicodeRange.split(",").map((part) => part.trim().replace(/^u\+/i, ""));
    return ranges.length > 0 && ranges.every((range) => /^(e|f[0-8])[0-9a-f]{2,3}(?:-(?:e|f[0-8])[0-9a-f]{2,3})?$/i.test(range));
  }
  return false;
}

/** Families that name no face to copy. */
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "-apple-system", "blinkmacsystemfont", "segoe ui", "helvetica", "helvetica neue", "arial", "times new roman", "times", "courier new", "georgia", "verdana", "inherit", "initial"]);

/** True for a CSS generic family or a face the operating system ships (no file of the page to copy). */
export function isGenericFamily(family: string): boolean {
  return GENERIC.has(family.toLowerCase());
}

/** The first family of a `font-family` stack, unquoted. */
export function firstFamily(stack: string): string {
  const first = stack.split(",")[0] ?? "";
  return first.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
}

/** Every `@font-face` rule of a stylesheet's text, `src` URLs resolved against `base`. */
export function parseFontFaces(css: string, base: string): DeclaredFace[] {
  const faces: DeclaredFace[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = rule[1]!;
    const property = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(body)?.[1]?.trim() ?? null;
    const family = property("font-family");
    const src = property("src");
    if (!family || !src) continue;
    const sources: DeclaredFace["sources"] = [];
    for (const source of src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*['"]?([\w-]+)['"]?\s*\))?/gi)) {
      try {
        sources.push({ url: new URL(source[2]!, base).href, format: source[3]?.toLowerCase() ?? null });
      } catch {
        // An unparsable URL is not a source.
      }
    }
    faces.push({
      family: firstFamily(family),
      weight: property("font-weight") ?? "400",
      style: property("font-style") ?? "normal",
      unicodeRange: property("unicode-range"),
      sources,
    });
  }
  return faces;
}

/** True when a `unicode-range` covers U+0041 (Latin capital A); a face without one covers everything. */
export function coversLatinA(unicodeRange: string | null): boolean {
  if (!unicodeRange) return true;
  return unicodeRange.split(",").some((part) => {
    const range = part.trim().replace(/^u\+/i, "");
    if (range.includes("?")) {
      const low = parseInt(range.replace(/\?/g, "0"), 16);
      const high = parseInt(range.replace(/\?/g, "f"), 16);
      return low <= 0x41 && 0x41 <= high;
    }
    const [low, high = low] = range.split("-").map((value) => parseInt(value, 16));
    return low !== undefined && high !== undefined && low <= 0x41 && 0x41 <= high;
  });
}

/** Weights a declared `font-weight` spans: `400`, `bold`, or a variable range `100 900`. */
export function weightSpan(weight: string): [number, number] {
  const named: Record<string, number> = { normal: 400, bold: 700 };
  const parts = weight.trim().split(/\s+/).map((part) => named[part.toLowerCase()] ?? Number(part));
  const low = Number.isFinite(parts[0]) ? parts[0]! : 400;
  const high = Number.isFinite(parts[1]) ? parts[1]! : low;
  return [low, high];
}

/**
 * The declared face that draws `family` at `weight` in upright text: same family, not italic, covering Latin A,
 * the span holding the weight or else the nearest. Null when the family has no such face.
 */
export function faceFor(faces: DeclaredFace[], family: string, weight: number): DeclaredFace | null {
  const candidates = faces.filter((face) => face.family.toLowerCase() === family.toLowerCase() && !/italic|oblique/i.test(face.style) && coversLatinA(face.unicodeRange));
  let best: DeclaredFace | null = null;
  let bestDistance = Infinity;
  for (const face of candidates) {
    const [low, high] = weightSpan(face.weight);
    const distance = weight < low ? low - weight : weight > high ? weight - high : 0;
    if (distance < bestDistance) [best, bestDistance] = [face, distance];
  }
  return best;
}

/** The source to copy: woff2, then woff, then TrueType or OpenType; null when there is no url() source. */
export function bestSource(face: DeclaredFace): string | null {
  const rank = (source: DeclaredFace["sources"][number]) => {
    const kind = source.format ?? /\.(woff2|woff|ttf|otf)(?:[?#]|$)/i.exec(source.url)?.[1]?.toLowerCase() ?? "";
    return kind === "woff2" ? 0 : kind === "woff" ? 1 : kind.includes("truetype") || kind === "ttf" ? 2 : kind.includes("opentype") || kind === "otf" ? 3 : 4;
  };
  return [...face.sources].sort((a, b) => rank(a) - rank(b))[0]?.url ?? null;
}
