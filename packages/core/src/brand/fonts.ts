// Fonts of a captured page (ADR 0044 decision 2): which faces the page declares, which one serves each weight in
// use, and whether a face's own name table names an open licence. A face is copied only on that verdict.
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { readNameTable } from "@frameshell/schema";

/** Licences a face may be copied under, as `credits.json` records them. */
export type OpenFontLicence = "OFL-1.1" | "Apache-2.0" | "UFL-1.0";

/** What a face's name table says about itself. */
export interface FontNames {
  family: string | null;
  /** Foundry (name id 8), else designer (9). */
  maker: string | null;
  licence: OpenFontLicence | null;
  /** Licence text and URL as written (ids 13 and 14), for the note. */
  licenceText: string | null;
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

/** Read the name table of a TrueType, OpenType, WOFF or WOFF2 file. Throws when it is none of them. */
export function readFontNames(file: Uint8Array): FontNames {
  const names = readNameTable(nameTableOf(file));
  const licenceText = [names.get(13), names.get(14)].filter(Boolean).join(" ") || null;
  return { family: names.get(16) ?? names.get(1) ?? null, maker: names.get(8) ?? names.get(9) ?? null, licence: fontLicence(names), licenceText };
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

/** The bytes of the `name` table, unwrapped from WOFF (zlib per table) or WOFF2 (one brotli stream). */
function nameTableOf(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const kind = fontExtension(file);
  if (kind === "ttf" || kind === "otf") {
    for (let i = 0; i < view.getUint16(4); i++) {
      const entry = 12 + i * 16;
      if (tagAt(file, entry) === "name") return file.subarray(view.getUint32(entry + 8), view.getUint32(entry + 8) + view.getUint32(entry + 12));
    }
    throw new Error("font has no name table");
  }
  if (kind === "woff") {
    for (let i = 0; i < view.getUint16(12); i++) {
      const entry = 44 + i * 20;
      if (tagAt(file, entry) !== "name") continue;
      const offset = view.getUint32(entry + 4);
      const compressed = view.getUint32(entry + 8);
      const original = view.getUint32(entry + 12);
      if (offset + compressed > file.byteLength || original > MAX_NAME_TABLE) throw new Error("bad WOFF table directory");
      const stored = file.subarray(offset, offset + compressed);
      // The cap stops a zlib bomb: inflating past the declared length throws instead of filling memory.
      return compressed < original ? inflateSync(stored, { maxOutputLength: original }) : stored;
    }
    throw new Error("font has no name table");
  }
  if (kind === "woff2") return woff2NameTable(file, view);
  throw new Error("not a TrueType, OpenType, WOFF or WOFF2 font");
}

/** Largest `name` table read. Real ones are a few KB; the cap bounds decoding of a page's untrusted bytes. */
const MAX_NAME_TABLE = 1024 * 1024;

/** Largest decoded WOFF2 table stream read: the name table may sit after glyf, so the whole prefix is decoded. */
const MAX_WOFF2_STREAM = 32 * 1024 * 1024;

/** WOFF2 table tags by their known-tag index (W3C WOFF2 §4.2). */
const WOFF2_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/**
 * The `name` table of a WOFF2 file: tables sit back to back in one brotli stream, in directory order, each
 * `transformLength` long when transformed (glyf and loca by default, hmtx on request), else `origLength`. `name`
 * is never transformed. Font collections are refused.
 */
function woff2NameTable(file: Uint8Array, view: DataView): Uint8Array {
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
  let found: { offset: number; length: number } | null = null;
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
    if (tag === "name") found = { offset, length };
    offset += length;
  }
  if (!found) throw new Error("font has no name table");
  // `offset` is now the whole stream's decoded length. Decoding is capped there, so a brotli bomb throws instead of
  // filling memory; a directory declaring more than MAX_WOFF2_STREAM is refused before decoding.
  if (offset > MAX_WOFF2_STREAM || found.length > MAX_NAME_TABLE) throw new Error("WOFF2 tables larger than Frameshell reads");
  if (at + compressedLength > file.byteLength) throw new Error("bad WOFF2 table directory");
  const stream = brotliDecompressSync(file.subarray(at, at + compressedLength), { maxOutputLength: Math.max(offset, 1) });
  if (stream.byteLength !== offset) throw new Error("WOFF2 stream length does not match its table directory");
  return stream.subarray(found.offset, found.offset + found.length);
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
