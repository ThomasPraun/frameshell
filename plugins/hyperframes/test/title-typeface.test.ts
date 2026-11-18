import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Font } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { describe, expect, it } from "vitest";
import { THREE_RUNTIME } from "../src/three-runtime.js";
import { TITLE_TYPEFACE, TITLE_TYPEFACE_FILE, TITLE_TYPEFACE_HEADER, TITLE_TYPEFACE_VERSION } from "../src/title-typeface.js";

// The Archivo Black outlines `pnpm gen:typeface` converts for the `title-3d` template (ADR 0042).
interface Glyph {
  ha: number;
  x_min: number;
  x_max: number;
  o?: string;
}
interface Typeface {
  frameshellTypeface: string;
  glyphs: Record<string, Glyph>;
  familyName: string;
  ascender: number;
  descender: number;
  resolution: number;
  boundingBox: { xMin: number; yMin: number; xMax: number; yMax: number };
  original_font_information: { copyright: string; license: string };
}
const typeface = JSON.parse(TITLE_TYPEFACE) as Typeface;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

describe("title typeface (Archivo Black, SIL OFL 1.1)", () => {
  it("is three.js typeface JSON of resolution 1000 that names its version first", () => {
    expect(TITLE_TYPEFACE_FILE).toBe("frameshell-title.typeface.json");
    expect(TITLE_TYPEFACE).toMatch(TITLE_TYPEFACE_HEADER);
    expect(typeface).toMatchObject({ familyName: "Archivo Black", resolution: 1000, frameshellTypeface: TITLE_TYPEFACE_VERSION });
    expect(typeface.ascender).toBeGreaterThan(0);
    expect(typeface.descender).toBeLessThan(0);
    expect(typeface.boundingBox.xMax).toBeGreaterThan(typeface.boundingBox.xMin);
    expect(typeface.original_font_information.license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(typeface.original_font_information.copyright).toBe("Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack)");
    // ASCII only: the file is the same bytes whatever the encoding it is read in.
    expect(TITLE_TYPEFACE).toMatch(/^[\x20-\x7e]*$/);
  });

  it("covers ASCII, Latin-1 and the punctuation of everyday titles", () => {
    const wanted = [...range(0x20, 0x7e), ...range(0xa1, 0xff).filter((ch) => ch !== "\u00ad"), "\u00a0", "–", "—", "‘", "’", "“", "”", "•", "…", "€", "™"];
    expect(wanted.filter((ch) => !typeface.glyphs[ch])).toEqual([]);
    expect(typeface.glyphs[" "]).toMatchObject({ ha: expect.any(Number) });
    expect(typeface.glyphs[" "]!.o).toBeUndefined();
    expect(typeface.glyphs["\u00a0"]!.ha).toBe(typeface.glyphs[" "]!.ha);
  });

  it("writes every outline in the commands three.js reads, with whole numbers", () => {
    const arity: Record<string, number> = { m: 2, l: 2, q: 4, b: 6 };
    let [curves, glyphs] = [0, 0];
    for (const [ch, glyph] of Object.entries(typeface.glyphs)) {
      expect(Number.isInteger(glyph.ha) && glyph.ha >= 0, `advance of ${JSON.stringify(ch)}`).toBe(true);
      if (glyph.o === undefined) continue;
      glyphs++;
      const tokens = glyph.o.split(" ");
      expect(tokens[0], `outline of ${JSON.stringify(ch)} starts with a moveTo`).toBe("m");
      for (let i = 0; i < tokens.length; ) {
        const count = arity[tokens[i++]!];
        expect(count, `command before token ${i} of ${JSON.stringify(ch)}`).toBeDefined();
        for (const token of tokens.slice(i, i + count!)) expect(Number.isInteger(Number(token)), `${token} in ${JSON.stringify(ch)}`).toBe(true);
        expect(i + count!).toBeLessThanOrEqual(tokens.length);
        if (tokens[i - 1] === "q") curves++;
        i += count!;
      }
    }
    expect(glyphs).toBeGreaterThan(180);
    expect(curves).toBeGreaterThan(500);
  });

  it("builds shapes with their counters through three.js: O has one hole, B two, i is two shapes", () => {
    const font = new Font(typeface);
    const holes = (text: string) => font.generateShapes(text, 1).map((shape) => shape.holes.length);
    expect(holes("O")).toEqual([1]);
    expect(holes("B")).toEqual([2]);
    expect(holes("i")).toEqual([0, 0]);
    expect(holes("É")).toHaveLength(2);
    expect(holes("Hi\nyo")).toHaveLength(5);
  });

  it("extrudes a capital H about 0.7 em tall and its advance matches the glyph table", () => {
    const font = new Font(typeface);
    const geometry = new TextGeometry("H", { font, size: 1, depth: 0.3, curveSegments: 6 });
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.y - box.min.y).toBeGreaterThan(0.6);
    expect(box.max.y - box.min.y).toBeLessThan(0.8);
    expect(box.max.z - box.min.z).toBeCloseTo(0.3, 5);
    const pair = new TextGeometry("HH", { font, size: 1, depth: 0.3, curveSegments: 6 });
    pair.computeBoundingBox();
    expect(pair.boundingBox!.max.x - box.max.x).toBeCloseTo(typeface.glyphs["H"]!.ha / typeface.resolution, 5);
  });

  it("carries the Archivo Black notice in its source and keeps opentype.js out of the bundle and the runtime dependencies", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/title-typeface.ts", import.meta.url)), "utf8");
    expect(source).toContain("Converted outlines of Archivo Black");
    expect(source).toContain("SIL Open Font License 1.1");
    expect(source).toContain("Reserved Font Name");
    expect(THREE_RUNTIME).not.toMatch(/opentype/i);
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.devDependencies).toMatchObject({ "opentype.js": expect.any(String), "@expo-google-fonts/archivo-black": expect.any(String) });
    expect(Object.keys(pkg.dependencies).filter((name) => /opentype|archivo/.test(name))).toEqual([]);
  });

  it("is current (run `pnpm gen:typeface` after changing the converter or the font)", async () => {
    const script = fileURLToPath(new URL("../scripts/build-typeface.mjs", import.meta.url));
    await expect(promisify(execFile)(process.execPath, [script, "--check"])).resolves.toBeDefined();
  }, 60_000);
});
