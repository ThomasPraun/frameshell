// Curated open fonts that stand in for a face a brand capture may not copy (ADR 0044 decision 4). Taste data, not
// measured. Every family and licence was checked against `METADATA.pb` of its folder in github.com/google/fonts
// (`ofl/`, `apache/`, `ufl/`); add a font only after that check.

/** Broad design class of a face. */
export const FONT_CATEGORIES = ["sans", "serif", "slab", "mono", "script"] as const;

/** One of {@link FONT_CATEGORIES}. */
export type FontCategory = (typeof FONT_CATEGORIES)[number];

/** Width class of a face: OS/2 `usWidthClass` 1-4, 5, 6-9. */
export const FONT_WIDTHS = ["condensed", "normal", "expanded"] as const;

/** One of {@link FONT_WIDTHS}. */
export type FontWidth = (typeof FONT_WIDTHS)[number];

/** Licences under which Frameshell copies or names a font (ADR 0044 decision 4), as `credits.json` records them. */
export const OPEN_FONT_LICENCES = ["OFL-1.1", "Apache-2.0", "UFL-1.0"] as const;

/** One of {@link OPEN_FONT_LICENCES}. */
export type OpenFontLicence = (typeof OPEN_FONT_LICENCES)[number];

/** An open font Frameshell may name as a substitute. */
export interface OpenFont {
  family: string;
  licence: OpenFontLicence;
  category: FontCategory;
  width: FontWidth;
  /** Folder of the family in the google/fonts repository: where to fetch it with its licence. */
  source: string;
}

const GOOGLE_FONTS = "https://github.com/google/fonts/tree/main";

function open(family: string, folder: string, licence: OpenFontLicence, category: FontCategory, width: FontWidth = "normal"): OpenFont {
  return { family, licence, category, width, source: `${GOOGLE_FONTS}/${folder}` };
}

/** Open fonts the table names, and families pages often load from Google Fonts (a page using one gets itself). */
export const OPEN_FONTS: readonly OpenFont[] = [
  open("Inter", "ofl/inter", "OFL-1.1", "sans"),
  open("Arimo", "ofl/arimo", "OFL-1.1", "sans"),
  open("Tinos", "ofl/tinos", "OFL-1.1", "serif"),
  open("Cousine", "ofl/cousine", "OFL-1.1", "mono"),
  open("Carlito", "ofl/carlito", "OFL-1.1", "sans"),
  open("Caladea", "ofl/caladea", "OFL-1.1", "serif"),
  open("Gelasio", "ofl/gelasio", "OFL-1.1", "serif"),
  open("Open Sans", "ofl/opensans", "OFL-1.1", "sans"),
  open("Montserrat", "ofl/montserrat", "OFL-1.1", "sans"),
  open("Jost", "ofl/jost", "OFL-1.1", "sans"),
  open("Nunito Sans", "ofl/nunitosans", "OFL-1.1", "sans"),
  open("DM Sans", "ofl/dmsans", "OFL-1.1", "sans"),
  open("EB Garamond", "ofl/ebgaramond", "OFL-1.1", "serif"),
  open("Libre Baskerville", "ofl/librebaskerville", "OFL-1.1", "serif"),
  open("Libre Caslon Text", "ofl/librecaslontext", "OFL-1.1", "serif"),
  open("Libre Bodoni", "ofl/librebodoni", "OFL-1.1", "serif"),
  open("Playfair Display", "ofl/playfairdisplay", "OFL-1.1", "serif"),
  open("Libre Franklin", "ofl/librefranklin", "OFL-1.1", "sans"),
  open("Barlow", "ofl/barlow", "OFL-1.1", "sans"),
  open("Barlow Condensed", "ofl/barlowcondensed", "OFL-1.1", "sans", "condensed"),
  open("JetBrains Mono", "ofl/jetbrainsmono", "OFL-1.1", "mono"),
  open("Source Serif 4", "ofl/sourceserif4", "OFL-1.1", "serif"),
  open("Roboto Slab", "apache/robotoslab", "Apache-2.0", "slab"),
  open("Dancing Script", "ofl/dancingscript", "OFL-1.1", "script"),
  open("Roboto", "ofl/roboto", "OFL-1.1", "sans"),
  open("Lato", "ofl/lato", "OFL-1.1", "sans"),
  open("Poppins", "ofl/poppins", "OFL-1.1", "sans"),
  open("Manrope", "ofl/manrope", "OFL-1.1", "sans"),
  open("Space Grotesk", "ofl/spacegrotesk", "OFL-1.1", "sans"),
  open("Plus Jakarta Sans", "ofl/plusjakartasans", "OFL-1.1", "sans"),
  open("Outfit", "ofl/outfit", "OFL-1.1", "sans"),
  open("Work Sans", "ofl/worksans", "OFL-1.1", "sans"),
  open("Public Sans", "ofl/publicsans", "OFL-1.1", "sans"),
  open("IBM Plex Sans", "ofl/ibmplexsans", "OFL-1.1", "sans"),
  open("IBM Plex Mono", "ofl/ibmplexmono", "OFL-1.1", "mono"),
  open("Fira Sans", "ofl/firasans", "OFL-1.1", "sans"),
  open("Fira Code", "ofl/firacode", "OFL-1.1", "mono"),
  open("Source Sans 3", "ofl/sourcesans3", "OFL-1.1", "sans"),
  open("Noto Sans", "ofl/notosans", "OFL-1.1", "sans"),
  open("Noto Serif", "ofl/notoserif", "OFL-1.1", "serif"),
  open("Merriweather", "ofl/merriweather", "OFL-1.1", "serif"),
  open("Lora", "ofl/lora", "OFL-1.1", "serif"),
  open("Oswald", "ofl/oswald", "OFL-1.1", "sans", "condensed"),
  open("Roboto Mono", "ofl/robotomono", "OFL-1.1", "mono"),
  open("Source Code Pro", "ofl/sourcecodepro", "OFL-1.1", "mono"),
  open("Ubuntu", "ufl/ubuntu", "UFL-1.0", "sans"),
  open("Geist", "ofl/geist", "OFL-1.1", "sans"),
  open("Geist Mono", "ofl/geistmono", "OFL-1.1", "mono"),
  open("Instrument Sans", "ofl/instrumentsans", "OFL-1.1", "sans"),
  open("Zilla Slab", "ofl/zillaslab", "OFL-1.1", "slab"),
];

/** Closed or system families sites use, each with the open font closest to it and why. */
const KNOWN: readonly { names: readonly string[]; family: string; why: string }[] = [
  { names: ["arial", "arialmt"], family: "Arimo", why: "metric-compatible with Arial" },
  { names: ["timesnewroman", "timesnewromanpsmt", "times"], family: "Tinos", why: "metric-compatible with Times New Roman" },
  { names: ["couriernew", "courier"], family: "Cousine", why: "metric-compatible with Courier New" },
  { names: ["calibri"], family: "Carlito", why: "metric-compatible with Calibri" },
  { names: ["cambria"], family: "Caladea", why: "metric-compatible with Cambria" },
  { names: ["georgia"], family: "Gelasio", why: "metric-compatible with Georgia" },
  { names: ["helvetica", "helveticaneue", "helveticanow", "neuehaasgrotesk", "neuehaasunica", "neuehaasdisplay", "graphik", "sohne", "systemui", "applesystem", "blinkmacsystemfont", "sanfrancisco", "sf", "sfui"], family: "Inter", why: "a neo-grotesque sans like it" },
  { names: ["segoeui"], family: "Open Sans", why: "a humanist sans like it" },
  { names: ["proximanova", "gotham"], family: "Montserrat", why: "a geometric sans with similar proportions" },
  { names: ["futura"], family: "Jost", why: "a geometric sans after Futura" },
  { names: ["avenir", "avenirnext"], family: "Nunito Sans", why: "a geometric sans like it" },
  { names: ["circular", "circularxx"], family: "DM Sans", why: "a geometric sans like it" },
  { names: ["garamond", "adobegaramond", "garamondpremier"], family: "EB Garamond", why: "a Garamond revival" },
  { names: ["baskerville"], family: "Libre Baskerville", why: "a Baskerville revival" },
  { names: ["caslon", "adobecaslon"], family: "Libre Caslon Text", why: "a Caslon revival" },
  { names: ["bodoni"], family: "Libre Bodoni", why: "a Bodoni revival" },
  { names: ["didot"], family: "Playfair Display", why: "a high-contrast Didone like it" },
  { names: ["franklingothic", "itcfranklingothic"], family: "Libre Franklin", why: "a Franklin Gothic revival" },
  { names: ["din", "dinnext", "ffdin", "din2014"], family: "Barlow", why: "a low-contrast grotesk close to DIN" },
  { names: ["sfmono", "menlo", "monaco", "consolas"], family: "JetBrains Mono", why: "a monospaced face for code like it" },
];

/** Open font per category and width when the family is not known; `normal` stands in for a missing width. */
const BY_CLASS: Record<FontCategory, Partial<Record<FontWidth, string>> & { normal: string }> = {
  sans: { normal: "Inter", condensed: "Barlow Condensed" },
  serif: { normal: "Source Serif 4" },
  slab: { normal: "Roboto Slab" },
  mono: { normal: "JetBrains Mono" },
  script: { normal: "Dancing Script" },
};

/** Trailing name parts that name a cut or a vendor's packaging, not the design (`Circular Std`, `Gotham SSm`). */
const SUFFIXES = ["std", "pro", "web", "ssm", "lt", "ot", "variable", "vf", "text", "display", "regular", "font", "next", "now"];

/** Lowercase letters and digits only, accents removed: `Söhne` → `sohne`, `-apple-system` → `applesystem`. */
function key(family: string): string {
  return family
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** `key`, then the same with trailing {@link SUFFIXES} removed one by one: `circularstd` → `circular`. */
function keys(family: string): string[] {
  const out = [key(family)];
  for (let current = out[0]!; ; ) {
    const suffix = SUFFIXES.find((one) => current.endsWith(one) && current.length > one.length);
    if (!suffix) return out;
    current = current.slice(0, -suffix.length);
    out.push(current);
  }
}

const OPEN_BY_KEY = new Map(OPEN_FONTS.map((font) => [key(font.family), font]));
const KNOWN_BY_KEY = new Map(KNOWN.flatMap((entry) => entry.names.map((name) => [name, entry] as const)));

/** The open font named `family`, or null when the table does not list it. */
export function openFont(family: string): OpenFont | null {
  return OPEN_BY_KEY.get(key(family)) ?? null;
}

/** Category and width a family's name states (`… Mono`, `… Condensed`, the CSS generic families); null when none. */
export function fontClassFromName(family: string): { category: FontCategory | null; width: FontWidth | null } {
  const name = family.toLowerCase();
  const category: FontCategory | null = /mono|code|courier|consol/.test(name)
    ? "mono"
    : /slab/.test(name)
      ? "slab"
      : /script|cursive|handwrit|brush/.test(name)
        ? "script"
        : /sans/.test(name) || /^(system-ui|-apple-system|blinkmacsystemfont)$/.test(name)
          ? "sans"
          : /serif/.test(name)
            ? "serif"
            : null;
  const width: FontWidth | null = /condensed|narrow|compressed|\bcond\b/.test(name) ? "condensed" : /extended|expanded|\bwide\b/.test(name) ? "expanded" : null;
  return { category, width };
}

/** The open font to use instead of a face Frameshell may not copy. */
export interface FontSubstitute {
  family: string;
  licence: OpenFontLicence;
  /** Folder in github.com/google/fonts to fetch it from, with its licence file. */
  source: string;
  /** Why this one: `same` (the family is itself open), `known` (curated for that family) or `class` (category and width). */
  match: "same" | "known" | "class";
  why: string;
}

/**
 * The closest open font to `family`: the family itself when it is open, a curated stand-in for a known closed or
 * system family, else the table's font for `hints` (category and width, from the font file or the CSS stack; the
 * name's own `Mono`/`Serif`/`Condensed` wins), a neutral sans when nothing is known.
 */
export function substituteFont(family: string, hints: { category?: FontCategory | null; width?: FontWidth | null } = {}): FontSubstitute {
  const variants = keys(family);
  for (const variant of variants) {
    const same = OPEN_BY_KEY.get(variant);
    if (same) return { family: same.family, licence: same.licence, source: same.source, match: "same", why: `${same.family} is itself open (${same.licence})` };
  }
  for (const variant of variants) {
    const known = KNOWN_BY_KEY.get(variant);
    const font = known ? openFont(known.family) : null;
    if (known && font) return { family: font.family, licence: font.licence, source: font.source, match: "known", why: known.why };
  }
  const named = fontClassFromName(family);
  const category = named.category ?? hints.category ?? "sans";
  const width = named.width ?? hints.width ?? "normal";
  const row = BY_CLASS[category];
  const font = openFont(row[width] ?? row.normal)!;
  const told = (named.category ?? hints.category ?? null) !== null || font.width !== "normal";
  const why = told ? `a ${font.width === "normal" ? "" : `${font.width} `}${category} face` : "no closer match known: a neutral sans";
  return { family: font.family, licence: font.licence, source: font.source, match: "class", why };
}
