import { describe, expect, it } from "vitest";
import {
  GRADE_TABLE_SIZE,
  type MediaClip,
  applyGradeTable,
  cubeText,
  gradeKey,
  gradeOf,
  gradeTable,
  gradeTableSize,
  logFootageHint,
  logFootageWarning,
  normalizeGrade,
  parseCube,
  parseTimeline,
} from "../src/index.js";

const media = (grade?: MediaClip["grade"]): MediaClip => ({ id: "c_a", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 1, ...(grade ? { grade } : {}) });

/** A 2-point LUT that swaps red and blue. */
const SWAP = ["# comment", "TITLE \"swap\"", "LUT_3D_SIZE 2", "", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${b} ${g} ${r}`)))].join("\r\n");

describe("colour grade (ADR 0031)", () => {
  it("reads only grades that change colours, on media clips, keyed alike when they look alike", () => {
    expect(gradeOf(media())).toBeNull();
    expect(gradeOf(media({ exposure: 0, contrast: 1 }))).toBeNull();
    expect(gradeOf(media({ lut: "luts/a.cube", lutMix: 0 }))).toBeNull();
    expect(gradeOf({ type: "hyperframes", grade: { exposure: 1 } })).toBeNull();
    expect(gradeOf(media({ exposure: 1 }))).toEqual({ exposure: 1, temperature: 0, tint: 0, contrast: 1, saturation: 1, lut: null, lutMix: 1 });
    expect(gradeKey(normalizeGrade({ exposure: 1 }))).toBe(gradeKey(normalizeGrade({ exposure: 1, saturation: 1 })));
    expect(parseTimeline({ schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "v", kind: "video", clips: [media({ saturation: 9 })] }] }).ok).toBe(false);
  });

  it("parses .cube files: keywords, comments, CRLF, domain; refuses 1D, short and oversized LUTs, naming the line", () => {
    const swap = parseCube(SWAP);
    expect(swap.size).toBe(2);
    // Red fastest: entry 1 is red = 1, written as blue.
    expect([...swap.data.slice(3, 6)]).toEqual([0, 0, 1]);
    expect(parseCube("DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\nLUT_3D_SIZE 2\n" + "0 0 0\n".repeat(8)).domainMax).toEqual([2, 2, 2]);
    expect(() => parseCube("LUT_1D_SIZE 4\n")).toThrow(/line 1: 1D LUTs are not supported/);
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toThrow(/1 entries for LUT_3D_SIZE 2; expected 8/);
    expect(() => parseCube("LUT_3D_SIZE 66\n")).toThrow(/2 to 65/);
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 x\n")).toThrow(/line 2: expected three numbers/);
    expect(() => parseCube("0 0 0\n")).toThrow(/data before LUT_3D_SIZE/);
  });

  it("bakes correction and LUT into one table, 6 decimals, that round-trips through its .cube text", () => {
    expect(gradeTableSize(null)).toBe(GRADE_TABLE_SIZE);
    const swap = parseCube(SWAP);
    const table = gradeTable(normalizeGrade({ lut: "luts/swap.cube" }), swap);
    expect(table.size).toBe(GRADE_TABLE_SIZE);
    // A pure red lattice point comes out blue: the LUT alone, the correction left at its defaults.
    const red = (GRADE_TABLE_SIZE - 1) * 3;
    expect([...table.data.slice(red, red + 3)]).toEqual([0, 0, 1]);
    const half = gradeTable(normalizeGrade({ lut: "luts/swap.cube", lutMix: 0.5 }), swap);
    expect([...half.data.slice(red, red + 3)]).toEqual([0.5, 0, 0.5]);
    const looked = gradeTable(normalizeGrade({ exposure: 0.7, temperature: 0.4, tint: -0.3, contrast: 1.4, saturation: 1.6 }), null);
    for (const value of looked.data) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(Math.abs(value * 1e6 - Math.round(value * 1e6))).toBeLessThan(0.05);
    }
    expect(parseCube(cubeText(looked)).data).toEqual(looked.data);
  });

  it("samples like ffmpeg lut3d: an identity table truncates, never rounds, and moves no byte by more than 1", () => {
    const identity = gradeTable(normalizeGrade({}), null);
    for (let v = 0; v < 256; v++) {
      const [r, g, b] = applyGradeTable(identity, [v, 255 - v, v]);
      expect(Math.abs(r - v)).toBeLessThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(v);
      expect(Math.abs(g - (255 - v))).toBeLessThanOrEqual(1);
      expect(b).toBe(r);
    }
    expect(applyGradeTable(identity, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(applyGradeTable(identity, [255, 255, 255])).toEqual([255, 255, 255]);
    const flat = { size: 2, data: new Float32Array(24).fill(100.9 / 255) };
    expect(applyGradeTable(flat, [10, 200, 30])).toEqual([100, 100, 100]);
  });
});

describe("LOG footage hint (ADR 0031 decision 9)", () => {
  it("reads HDR and logarithmic transfer curves, wide-gamut primaries, tags first", () => {
    expect(logFootageHint("assets/a.mp4", { colorTransfer: "arib-std-b67", colorPrimaries: "bt2020" })).toEqual({ kind: "transfer", value: "arib-std-b67" });
    expect(logFootageHint("assets/a.mp4", { colorTransfer: "smpte2084" })).toEqual({ kind: "transfer", value: "smpte2084" });
    expect(logFootageHint("assets/a.mp4", { colorTransfer: "log316" })).toEqual({ kind: "transfer", value: "log316" });
    expect(logFootageHint("assets/a.mp4", { colorTransfer: "bt709", colorPrimaries: "bt2020" })).toEqual({ kind: "primaries", value: "bt2020" });
    expect(logFootageHint("assets/a.mp4", { colorTransfer: "bt709", colorPrimaries: "bt709" })).toBeNull();
    expect(logFootageHint("assets/a.mp4", { colorTransfer: null, colorPrimaries: null })).toBeNull();
    expect(logFootageHint("assets/a.mp4")).toBeNull();
  });

  it("reads camera LOG words in the file name, not words that merely hold the letters", () => {
    for (const name of ["assets/A001_LogC.mov", "assets/clip-S-Log3.mp4", "assets/C-Log2 take 4.mov", "assets/v-log_01.mp4", "assets/footage_log.mp4", "assets/hlg-sunset.mov"]) {
      expect(logFootageHint(name, { colorTransfer: "bt709" })?.kind, name).toBe("name");
    }
    for (const name of ["assets/dialog.mp4", "assets/blog-intro.mp4", "assets/my-vlog.mp4", "assets/catalog.mov", "assets/logs/clip.mp4", "assets/login.mp4"]) {
      expect(logFootageHint(name, { colorTransfer: "bt709" }), name).toBeNull();
    }
    // The extension is not the name.
    expect(logFootageHint("assets/clip.log", null)).toBeNull();
  });

  it("words the warning for the CLI and the agent", () => {
    const hint = logFootageHint("assets/a.mp4", { colorTransfer: "arib-std-b67" })!;
    expect(logFootageWarning("assets/a.mp4", hint)).toMatch(/assets\/a\.mp4 may be LOG or HDR footage \(its transfer curve is tagged arib-std-b67\), not Rec\.709/);
  });
});
