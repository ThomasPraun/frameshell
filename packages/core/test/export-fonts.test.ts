import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBTITLE_FONT } from "@frameshell/schema";
import { writeFonts } from "../src/export/fonts.js";
import { fontSource, parseFontMetrics } from "../src/index.js";
import { tempDir } from "./helpers.js";

/** Offsets of the sfnt tables of a TTF, by tag. */
function tables(font: Buffer): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < font.readUInt16BE(4); i++) out[font.toString("latin1", 12 + i * 16, 16 + i * 16)] = font.readUInt32BE(20 + i * 16);
  return out;
}

describe("subtitle font", () => {
  it("is the file SUBTITLE_FONT describes: family and the win metrics libass lays lines out with", () => {
    const font = readFileSync(fontSource(SUBTITLE_FONT.file));
    const t = tables(font);
    const unitsPerEm = font.readUInt16BE(t["head"]! + 18);
    const os2 = t["OS/2"]!;
    expect(font.readUInt16BE(os2 + 74) / unitsPerEm).toBe(SUBTITLE_FONT.ascent);
    expect(font.readUInt16BE(os2 + 76) / unitsPerEm).toBe(SUBTITLE_FONT.descent);
    // Family name (name id 1, Windows UTF-16): the name ASS styles and the preview's @font-face use.
    const name = t["name"]!;
    const strings = name + font.readUInt16BE(name + 4);
    const families: string[] = [];
    for (let i = 0; i < font.readUInt16BE(name + 2); i++) {
      const record = name + 6 + i * 12;
      if (font.readUInt16BE(record) !== 3 || font.readUInt16BE(record + 6) !== 1) continue;
      const start = strings + font.readUInt16BE(record + 10);
      families.push(font.subarray(start, start + font.readUInt16BE(record + 8)).swap16().toString("utf16le"));
    }
    expect(families).toContain(SUBTITLE_FONT.family);
  });

  it("is copied into the work directory's fonts/ for the ass filter", async () => {
    const dir = tempDir();
    await writeFonts(dir, [SUBTITLE_FONT.file]);
    expect(readFileSync(join(dir, "fonts", SUBTITLE_FONT.file))).toEqual(readFileSync(fontSource(SUBTITLE_FONT.file)));
  });

  it("gives the metrics libass lays it out with, read by the parser preview and review share", () => {
    const metrics = parseFontMetrics(readFileSync(fontSource(SUBTITLE_FONT.file)));
    expect(metrics).toMatchObject({ family: SUBTITLE_FONT.family, ascent: SUBTITLE_FONT.ascent, descent: SUBTITLE_FONT.descent });
    expect(() => parseFontMetrics(new Uint8Array(Buffer.from("wOF2 not a font at all")))).toThrow(/not a TrueType or OpenType font/);
  });
});

describe("project caption fonts (ADR 0028)", () => {
  it("are read under the project and copied into fonts/ by name; one named like the bundled file is renamed", async () => {
    const project = tempDir();
    const bytes = readFileSync(fontSource(SUBTITLE_FONT.file));
    mkdirSync(join(project, "assets", "fonts", "brand"), { recursive: true });
    writeFileSync(join(project, "assets", "fonts", "brand", "Brand.ttf"), bytes);
    writeFileSync(join(project, "assets", "fonts", SUBTITLE_FONT.file), bytes);
    const dir = tempDir();
    await writeFonts(dir, ["assets/fonts/brand/Brand.ttf", `assets/fonts/${SUBTITLE_FONT.file}`, SUBTITLE_FONT.file], project);
    expect(readdirSync(join(dir, "fonts")).sort()).toEqual(["ArchivoBlack-Regular.ttf", "Brand.ttf", `project-${SUBTITLE_FONT.file}`]);
    await expect(writeFonts(tempDir(), ["assets/fonts/brand/Brand.ttf"])).rejects.toThrow("unknown export font");
  });
});
