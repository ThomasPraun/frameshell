import { describe, expect, it } from "vitest";
import { FONT_CATEGORIES, FONT_WIDTHS, OPEN_FONTS, fontClassFromName, openFont, substituteFont } from "../src/index.js";

// Seam under test: the curated substitute table of ADR 0044 decision 4, used when a captured face may not be copied.

describe("open fonts table", () => {
  it("names each font's google/fonts folder, whose licence directory matches its licence", () => {
    const folder = { "OFL-1.1": "ofl", "Apache-2.0": "apache", "UFL-1.0": "ufl" } as const;
    for (const font of OPEN_FONTS) {
      expect(font.source).toMatch(new RegExp(`^https://github\\.com/google/fonts/tree/main/${folder[font.licence]}/[a-z0-9]+$`));
      expect(font.source.endsWith(`/${font.family.toLowerCase().replace(/[^a-z0-9]/g, "")}`)).toBe(true);
    }
    expect(new Set(OPEN_FONTS.map((font) => font.family)).size).toBe(OPEN_FONTS.length);
  });

  it("has a font for every category and width", () => {
    for (const category of FONT_CATEGORIES) {
      for (const width of FONT_WIDTHS) {
        const sub = substituteFont("Unknown Face", { category, width });
        expect(openFont(sub.family)).not.toBeNull();
        expect(sub.match).toBe("class");
        expect(openFont(sub.family)!.category).toBe(category);
      }
    }
  });
});

describe("substituteFont", () => {
  it("names the family itself when it is open, whatever the vendor suffix", () => {
    expect(substituteFont("Inter")).toMatchObject({ family: "Inter", licence: "OFL-1.1", match: "same" });
    expect(substituteFont("Inter Display")).toMatchObject({ family: "Inter", match: "same" });
    expect(substituteFont("roboto-mono")).toMatchObject({ family: "Roboto Mono", match: "same" });
    expect(substituteFont("Roboto Slab")).toMatchObject({ licence: "Apache-2.0", source: "https://github.com/google/fonts/tree/main/apache/robotoslab" });
    expect(substituteFont("Ubuntu")).toMatchObject({ licence: "UFL-1.0" });
  });

  it("names the curated stand-in of a known closed or system family", () => {
    expect(substituteFont("Arial")).toMatchObject({ family: "Arimo", match: "known", why: "metric-compatible with Arial" });
    expect(substituteFont("Helvetica Neue")).toMatchObject({ family: "Inter", match: "known" });
    expect(substituteFont("-apple-system")).toMatchObject({ family: "Inter", match: "known" });
    expect(substituteFont("SF Pro Display")).toMatchObject({ family: "Inter", match: "known" });
    expect(substituteFont("SF Mono")).toMatchObject({ family: "JetBrains Mono", match: "known" });
    expect(substituteFont("Söhne")).toMatchObject({ family: "Inter", match: "known" });
    expect(substituteFont("Circular Std")).toMatchObject({ family: "DM Sans", match: "known" });
    expect(substituteFont("proxima-nova")).toMatchObject({ family: "Montserrat", match: "known" });
    expect(substituteFont("Times New Roman")).toMatchObject({ family: "Tinos", match: "known" });
    expect(substituteFont("Georgia")).toMatchObject({ family: "Gelasio", match: "known" });
  });

  it("falls back on category and width: the name's words first, then the hints, else a neutral sans", () => {
    expect(substituteFont("Acme Grotesk Condensed")).toMatchObject({ family: "Barlow Condensed", match: "class", why: "a condensed sans face" });
    expect(substituteFont("Acme Slab")).toMatchObject({ family: "Roboto Slab", why: "a slab face" });
    expect(substituteFont("monospace")).toMatchObject({ family: "JetBrains Mono" });
    expect(substituteFont("Acme", { category: "serif", width: "condensed" })).toMatchObject({ family: "Source Serif 4", why: "a serif face" });
    expect(substituteFont("Acme Mono", { category: "serif" })).toMatchObject({ family: "JetBrains Mono" });
    expect(substituteFont("Acme")).toMatchObject({ family: "Inter", why: "no closer match known: a neutral sans" });
  });

  it("reads category and width words from a name", () => {
    expect(fontClassFromName("sans-serif")).toEqual({ category: "sans", width: null });
    expect(fontClassFromName("serif")).toEqual({ category: "serif", width: null });
    expect(fontClassFromName("ui-monospace")).toEqual({ category: "mono", width: null });
    expect(fontClassFromName("cursive")).toEqual({ category: "script", width: null });
    expect(fontClassFromName("Acme Extended")).toEqual({ category: null, width: "expanded" });
    expect(fontClassFromName("Encode Sans")).toEqual({ category: "sans", width: null });
    expect(fontClassFromName("Source Code Pro")).toEqual({ category: "mono", width: null });
    expect(fontClassFromName("Acme PostScript")).toEqual({ category: null, width: null });
  });
});
