import { describe, expect, it } from "vitest";
import { bestSource, coversLatinA, faceFor, fontExtension, fontLicence, isIconFamily, parseFontFaces, readFontNames } from "../src/brand/fonts.js";
import { pickAccent, rankColors, suggestStyle } from "../src/brand/findings.js";
import { svgProblems } from "../src/brand/page-script.js";
import { nameTable, sfnt, woff, woff2 } from "./brand-fixture.js";

// Seam under test: the pure judgements of brand capture (ADR 0044): font licence from the file's own name table
// (TrueType, WOFF, WOFF2), which declared face serves a weight, the accent rule, the style suggestions, the SVG check.

const OFL = nameTable({ 1: "Acme Sans", 8: "Acme Type Co", 13: "This Font Software is licensed under the SIL Open Font License, Version 1.1.", 14: "https://openfontlicense.org" });

describe("font licence from the name table", () => {
  it("reads TrueType, WOFF and WOFF2 alike", () => {
    for (const file of [sfnt({ name: OFL }), woff({ head: Buffer.alloc(54, 1), name: OFL }), woff2(OFL)]) {
      expect(readFontNames(file)).toMatchObject({ family: "Acme Sans", maker: "Acme Type Co", licence: "OFL-1.1" });
    }
    expect(fontExtension(woff2(OFL))).toBe("woff2");
    expect(fontExtension(Buffer.from("<!doctype html>"))).toBeNull();
  });

  it("names Apache and UFL, and nothing for a proprietary or missing licence", () => {
    expect(fontLicence(new Map([[13, "Licensed under the Apache License, Version 2.0"]]))).toBe("Apache-2.0");
    expect(fontLicence(new Map([[14, "https://www.apache.org/licenses/LICENSE-2.0"]]))).toBe("Apache-2.0");
    expect(fontLicence(new Map([[13, "Ubuntu Font Licence 1.0"]]))).toBe("UFL-1.0");
    expect(fontLicence(new Map([[13, "This font is licensed for use on example.com only. All rights reserved."]]))).toBeNull();
    expect(readFontNames(sfnt({ name: nameTable({ 1: "Closed Serif" }) })).licence).toBeNull();
  });

  it("refuses a file that is no font", () => {
    expect(() => readFontNames(Buffer.from("not a font at all"))).toThrow(/not a TrueType/);
  });
});

describe("declared faces", () => {
  const css = `/* latin-ext */ @font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900;
      src: url(inter-ext.woff2) format('woff2'); unicode-range: U+0100-024F; }
    @font-face { font-family: 'Inter'; font-style: normal; font-weight: 100 900;
      src: url(inter-latin.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }
    @font-face { font-family: "Inter"; font-style: italic; font-weight: 400; src: url(/f/inter-italic.woff2); }
    @font-face { font-family: Brand; font-weight: bold; src: local(Brand), url("brand.ttf") format("truetype"), url("brand.woff") format("woff"); }
    @font-face { font-family: "Font Awesome 6"; src: url(fa.woff2); unicode-range: U+E000-F8FF; }`;
  const faces = parseFontFaces(css, "https://cdn.example.com/css/site.css");

  it("parses every rule with sources resolved against the sheet", () => {
    expect(faces).toHaveLength(5);
    expect(faces[0]).toMatchObject({ family: "Inter", weight: "100 900", unicodeRange: "U+0100-024F", sources: [{ url: "https://cdn.example.com/css/inter-ext.woff2", format: "woff2" }] });
    expect(faces[2]!.sources[0]!.url).toBe("https://cdn.example.com/f/inter-italic.woff2");
  });

  it("keeps the upright subset covering Latin A for a weight, and prefers woff2, then woff", () => {
    expect(faceFor(faces, "inter", 600)?.sources[0]!.url).toBe("https://cdn.example.com/css/inter-latin.woff2");
    expect(bestSource(faceFor(faces, "Brand", 700)!)).toBe("https://cdn.example.com/css/brand.woff");
    expect(faceFor(faces, "Missing", 400)).toBeNull();
    expect(coversLatinA("U+00??")).toBe(true);
    expect(coversLatinA("U+0100-024F, U+1E00")).toBe(false);
  });

  it("tells icon fonts by name or by a Private Use Area range", () => {
    expect(isIconFamily("Font Awesome 6")).toBe(true);
    expect(isIconFamily("Material Symbols Outlined")).toBe(true);
    expect(isIconFamily("Brand", "U+E000-F8FF")).toBe(true);
    expect(isIconFamily("Inter", "U+0000-00FF")).toBe(false);
  });
});

describe("colours and the accent", () => {
  const colors = rankColors([
    { hex: "#ffffff", roles: { background: 40, text: 3 } },
    { hex: "#1a1a2e", roles: { text: 30, heading: 2 } },
    { hex: "#ff5a1f", roles: { button: 3, heading: 2, border: 3 } },
    { hex: "#0000ee", roles: { link: 25, text: 1 } },
    { hex: "#e00000", roles: { text: 20 } },
    { hex: "#2f6fde", roles: { link: 4 } },
  ]);

  it("ranks by use and picks the colour in the most roles, never link blue or a red used only for text", () => {
    expect(colors.map((color) => color.hex)).toEqual(["#ffffff", "#1a1a2e", "#0000ee", "#e00000", "#ff5a1f", "#2f6fde"]);
    expect(colors[0]!.roles).toEqual(["background", "text"]);
    expect(pickAccent(colors)).toBe("#ff5a1f");
    expect(pickAccent(rankColors([{ hex: "#e00000", roles: { text: 20 } }, { hex: "#333333", roles: { text: 9 } }]))).toBeNull();
    expect(pickAccent(rankColors([{ hex: "#e50914", roles: { button: 2, text: 1 } }]))).toBe("#e50914");
  });

  it("suggests style set calls without writing anything", () => {
    const suggestions = suggestStyle(
      {
        colors,
        accent: "#ff5a1f",
        finalUrl: "https://www.acme.test/en",
        title: "Acme Rockets | Fly anywhere",
        headings: [{ tag: "h1", text: "Fly", family: "Closed Serif", size: 48, weight: 700, tracking: 0, color: "#ff5a1f", background: null }],
        files: [{ path: "assets/brand/acme-test/logo-1.svg", role: "logo", kind: "svg", origin: "captured", sourceUrl: "https://www.acme.test/en", width: 100, height: 40 }],
        fonts: [
          { family: "Acme Sans", uses: 30, weights: [400], generic: false, icon: false, faces: [{ weight: "400", style: "normal", unicodeRange: null, url: "https://www.acme.test/a.ttf", file: "assets/fonts/AcmeSans-400.ttf", licence: "OFL-1.1", note: "copied" }] },
          { family: "Closed Serif", uses: 3, weights: [700], generic: false, icon: false, faces: [] },
          { family: "sans-serif", uses: 2, weights: [400], generic: true, icon: false, faces: [] },
        ],
      },
      null,
      "#fafafa",
    );
    expect(Object.fromEntries(suggestions.map((one) => [one.path, one.value]))).toEqual({
      "colors.bg": "#fafafa",
      "colors.ink": "#1a1a2e",
      "colors.accent": "#ff5a1f",
      "fonts.display": { family: "Closed Serif", weight: 700 },
      "fonts.ui": { family: "Acme Sans", file: "assets/fonts/AcmeSans-400.ttf", weight: 400 },
      "brand.product": "Acme Rockets",
      "brand.url": "acme.test",
      "brand.mustShow": ["logo"],
    });
  });
});

describe("svgProblems", () => {
  it("passes a clean logo and names what a dirty one holds", () => {
    expect(svgProblems('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>')).toBeNull();
    expect(svgProblems("<svg><script>alert(1)</script></svg>")).toMatch(/script/);
    expect(svgProblems('<svg onload="x()"></svg>')).toMatch(/event handler/);
    expect(svgProblems('<svg><image href="https://evil.test/a.png"/></svg>')).toMatch(/external reference/);
    expect(svgProblems('<svg><rect style="fill:url(https://evil.test/a)"/></svg>')).toMatch(/url\(\)/);
    expect(svgProblems('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>')).toMatch(/not an SVG|DTD/);
    expect(svgProblems("<html><svg></svg></html>")).toMatch(/not an SVG/);
  });
});
