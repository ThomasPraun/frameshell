// Colour grade of media clips (ADR 0031): a correction, then an optional `.cube` LUT, baked into one 3D table that
// export applies with ffmpeg `lut3d` and the preview engine with a WebGL2 pass. Both sample the same numbers.
// No Zod here: the preview engine worker imports this file.
import type { Grade } from "./timeline.js";

/** Range and default of each correction number; the defaults change nothing. */
export const GRADE_LIMITS = {
  exposure: { min: -4, max: 4, default: 0 },
  temperature: { min: -1, max: 1, default: 0 },
  tint: { min: -1, max: 1, default: 0 },
  contrast: { min: 0, max: 3, default: 1 },
  saturation: { min: 0, max: 3, default: 1 },
  lutMix: { min: 0, max: 1, default: 1 },
} as const;

/** Most lattice points per side of a `.cube` LUT (#384). */
export const MAX_LUT_SIZE = 65;

/** Lattice points per side of a grade's table without a LUT, or with a smaller one. */
export const GRADE_TABLE_SIZE = 33;

/** Gain per unit of `temperature` (red up, blue down) and `tint` (green down), in linear light. */
const WHITE_BALANCE_SPAN = 0.2;
/** BT.1886 display gamma: exposure and white balance work on light, contrast and saturation on the encoded values. */
const DISPLAY_GAMMA = 2.4;
/** Contrast turns about this encoded level. */
const CONTRAST_PIVOT = 0.5;
/** Table entries are written with 6 decimals; the preview uses the same rounded numbers ffmpeg parses. */
const TABLE_DECIMALS = 1e6;

/** A {@link Grade} with every number given, fields in a fixed order. */
export interface NormalizedGrade {
  /** Stops of light. */
  exposure: number;
  /** -1 cooler (blue) to 1 warmer (red). */
  temperature: number;
  /** -1 green to 1 magenta. */
  tint: number;
  /** Factor about mid grey of the encoded picture. */
  contrast: number;
  /** Factor of the distance from Rec.709 luma. */
  saturation: number;
  /** Project-relative `.cube` file; null for none. */
  lut: string | null;
  /** 0 the corrected picture, 1 the LUT's full look. */
  lutMix: number;
}

/** `grade` with every omitted number at its default. */
export function normalizeGrade(grade: Grade): NormalizedGrade {
  return {
    exposure: grade.exposure ?? GRADE_LIMITS.exposure.default,
    temperature: grade.temperature ?? GRADE_LIMITS.temperature.default,
    tint: grade.tint ?? GRADE_LIMITS.tint.default,
    contrast: grade.contrast ?? GRADE_LIMITS.contrast.default,
    saturation: grade.saturation ?? GRADE_LIMITS.saturation.default,
    lut: grade.lut ?? null,
    lutMix: grade.lutMix ?? GRADE_LIMITS.lutMix.default,
  };
}

/** True when `grade` leaves every colour as it is: export and the preview then draw the clip as if it had none. */
export function isIdentityGrade(grade: NormalizedGrade): boolean {
  return (
    grade.exposure === 0 &&
    grade.temperature === 0 &&
    grade.tint === 0 &&
    grade.contrast === 1 &&
    grade.saturation === 1 &&
    (grade.lut === null || grade.lutMix === 0)
  );
}

/** The grade of a media clip that changes colours; null for other clips, none, and an identity grade. */
export function gradeOf(clip: { type: string; grade?: unknown }): NormalizedGrade | null {
  if (clip.type !== "media") return null;
  const grade = (clip as { grade?: Grade }).grade;
  if (!grade) return null;
  const normalized = normalizeGrade(grade);
  return isIdentityGrade(normalized) ? null : normalized;
}

/** Canonical text of a grade: equal for grades that look alike (omitted numbers = their defaults). */
export function gradeKey(grade: NormalizedGrade): string {
  return JSON.stringify(grade);
}

/** ffprobe `color_transfer` values of footage that is not Rec.709: HDR (HLG, PQ), cinema and logarithmic curves. */
const NON_709_TRANSFERS: ReadonlySet<string> = new Set(["arib-std-b67", "smpte2084", "log100", "log316", "smpte428"]);
/** ffprobe `color_primaries` values of wide-gamut footage (Rec.2020, DCI-P3). */
const WIDE_PRIMARIES: ReadonlySet<string> = new Set(["bt2020", "smpte431", "smpte432"]);
/**
 * Camera LOG names in a file name: S-Log, C-Log, N-Log, F-Log, D-Log, J-Log, V-Log (with its dash: bare `vlog` is
 * a video diary), LogC, HLG, or a bare `log` word. A word boundary on both sides keeps `dialog` and `blog` out.
 */
const LOG_NAME = /(?<![a-z0-9])(?:[scnfdj]-?log\d?|v-log|log-?c\d?|log\d?|hlg)(?![a-z0-9])/;

/** Why a source looks like LOG footage (ADR 0031 decision 9): what in its tags or its name says so. */
export type LogHint =
  | { kind: "transfer"; value: string }
  | { kind: "primaries"; value: string }
  | { kind: "name"; value: string };

/**
 * Whether the source `asset` looks like LOG or other non-Rec.709 footage, which the grade's LUTs and white balance
 * are not made for. Heuristic, in order: the probe's `color_transfer` is HDR or logarithmic, its `color_primaries`
 * are wide gamut, or the file name holds a camera LOG word. Cameras often tag LOG as plain Rec.709, so the name is
 * a second chance; an asset probed before the tags were recorded has only the name. A hint never refuses a grade.
 */
export function logFootageHint(
  asset: string,
  video?: { colorTransfer?: string | null | undefined; colorPrimaries?: string | null | undefined } | null,
): LogHint | null {
  const transfer = video?.colorTransfer;
  if (transfer && NON_709_TRANSFERS.has(transfer)) return { kind: "transfer", value: transfer };
  const primaries = video?.colorPrimaries;
  if (primaries && WIDE_PRIMARIES.has(primaries)) return { kind: "primaries", value: primaries };
  const base = asset.slice(asset.lastIndexOf("/") + 1);
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const named = LOG_NAME.exec(stem.toLowerCase());
  return named ? { kind: "name", value: named[0] } : null;
}

/** The warning text (English: CLI, MCP and daemon output) for a {@link LogHint} of `asset`. */
export function logFootageWarning(asset: string, hint: LogHint): string {
  const why =
    hint.kind === "transfer"
      ? `its transfer curve is tagged ${hint.value}`
      : hint.kind === "primaries"
        ? `its colour primaries are tagged ${hint.value}`
        : `its name says ${hint.value}`;
  return `${asset} may be LOG or HDR footage (${why}), not Rec.709: a LUT or white balance made for Rec.709 will look wrong. Apply the camera's own transform to Rec.709 first (a LUT from the camera maker); the grade is kept.`;
}

/** A parsed `.cube` 3D LUT (Adobe Cube LUT 1.0). */
export interface CubeLut {
  /** Lattice points per side, 2 to {@link MAX_LUT_SIZE}. */
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** `size`³ RGB triplets, red fastest, then green, then blue (the file's order). */
  data: Float32Array;
}

/** Parse a `.cube` file. Throws an `Error` naming the line for what it cannot read; 1D LUTs are refused. */
export function parseCube(text: string): CubeLut {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let data: Float32Array | null = null;
  let count = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = `line ${i + 1}`;
    const head = line.split(/\s+/, 1)[0]!;
    if (/^[A-Z][A-Z_0-9]*$/.test(head)) {
      const rest = line.slice(head.length).trim();
      switch (head) {
        case "TITLE":
          continue;
        case "LUT_1D_SIZE":
        case "LUT_1D_INPUT_RANGE":
          throw new Error(`${at}: 1D LUTs are not supported; use a 3D LUT (LUT_3D_SIZE).`);
        case "LUT_3D_SIZE": {
          size = Number(rest);
          if (!Number.isInteger(size) || size < 2 || size > MAX_LUT_SIZE) throw new Error(`${at}: LUT_3D_SIZE must be 2 to ${MAX_LUT_SIZE}, got ${rest}.`);
          data = new Float32Array(size ** 3 * 3);
          continue;
        }
        case "DOMAIN_MIN":
          domainMin = triplet(rest, at);
          continue;
        case "DOMAIN_MAX":
          domainMax = triplet(rest, at);
          continue;
        case "LUT_3D_INPUT_RANGE": {
          const [min, max] = rest.split(/\s+/).map(Number);
          if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`${at}: LUT_3D_INPUT_RANGE needs two numbers.`);
          domainMin = [min!, min!, min!];
          domainMax = [max!, max!, max!];
          continue;
        }
        default:
          // Other keywords (vendor extensions) carry no lattice data.
          continue;
      }
    }
    if (!data) throw new Error(`${at}: data before LUT_3D_SIZE.`);
    if (count >= size ** 3) throw new Error(`${at}: more than ${size ** 3} entries for LUT_3D_SIZE ${size}.`);
    const [r, g, b] = triplet(line, at);
    data[count * 3] = r;
    data[count * 3 + 1] = g;
    data[count * 3 + 2] = b;
    count++;
  }
  if (!data) throw new Error("no LUT_3D_SIZE: not a 3D .cube LUT.");
  if (count !== size ** 3) throw new Error(`${count} entries for LUT_3D_SIZE ${size}; expected ${size ** 3}.`);
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c]! > domainMin[c]!)) throw new Error("DOMAIN_MAX must be greater than DOMAIN_MIN.");
  }
  return { size, domainMin, domainMax, data };
}

function triplet(text: string, at: string): [number, number, number] {
  const parts = text.split(/\s+/);
  const values = parts.map(Number);
  if (parts.length !== 3 || values.some((value) => !Number.isFinite(value))) throw new Error(`${at}: expected three numbers, got "${text}".`);
  return values as [number, number, number];
}

/** The 3D table export (`lut3d`) and the preview both apply. */
export interface GradeTable {
  /** Lattice points per side. */
  size: number;
  /** `size`³ RGB triplets, red fastest (the `.cube` order); every value rounded to 6 decimals, as written. */
  data: Float32Array;
}

/** Lattice points of the table of a grade with `lut`: the LUT's own when larger than {@link GRADE_TABLE_SIZE}. */
export function gradeTableSize(lut: CubeLut | null): number {
  return Math.max(GRADE_TABLE_SIZE, lut?.size ?? 0);
}

/**
 * The table of `grade`, with `lut` parsed from its `lut` file (null when it has none): at every lattice point the
 * correction (exposure and white balance on light, then contrast and saturation), then the LUT mixed in by `lutMix`.
 */
export function gradeTable(grade: NormalizedGrade, lut: CubeLut | null): GradeTable {
  const size = gradeTableSize(lut);
  const data = new Float32Array(size ** 3 * 3);
  const gain = 2 ** grade.exposure;
  const gains = [
    gain * (1 + WHITE_BALANCE_SPAN * grade.temperature),
    gain * (1 - WHITE_BALANCE_SPAN * grade.tint),
    gain * (1 - WHITE_BALANCE_SPAN * grade.temperature),
  ];
  const rgb = [0, 0, 0];
  const looked = [0, 0, 0];
  let n = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rgb[0] = r / (size - 1);
        rgb[1] = g / (size - 1);
        rgb[2] = b / (size - 1);
        for (let c = 0; c < 3; c++) rgb[c] = clamp01(clamp01(rgb[c]! ** DISPLAY_GAMMA * gains[c]!) ** (1 / DISPLAY_GAMMA));
        for (let c = 0; c < 3; c++) rgb[c] = clamp01((rgb[c]! - CONTRAST_PIVOT) * grade.contrast + CONTRAST_PIVOT);
        const luma = 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
        for (let c = 0; c < 3; c++) rgb[c] = clamp01(luma + (rgb[c]! - luma) * grade.saturation);
        if (lut && grade.lutMix > 0) {
          sampleLut(lut, rgb, looked);
          for (let c = 0; c < 3; c++) rgb[c] = rgb[c]! + (looked[c]! - rgb[c]!) * grade.lutMix;
        }
        for (let c = 0; c < 3; c++) data[n++] = Math.round(rgb[c]! * TABLE_DECIMALS) / TABLE_DECIMALS;
      }
    }
  }
  return { size, data };
}

/** Trilinear lookup of `rgb` (0 to 1 each) in `lut`, through its domain, into `out`. */
function sampleLut(lut: CubeLut, rgb: readonly number[], out: number[]): void {
  const max = lut.size - 1;
  const at = [0, 0, 0];
  const low = [0, 0, 0];
  const high = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const unit = (rgb[c]! - lut.domainMin[c]!) / (lut.domainMax[c]! - lut.domainMin[c]!);
    at[c] = Math.min(max, Math.max(0, unit * max));
    low[c] = Math.floor(at[c]!);
    high[c] = Math.min(low[c]! + 1, max);
  }
  const { data, size } = lut;
  const entry = (r: number, g: number, b: number, c: number) => data[((b * size + g) * size + r) * 3 + c]!;
  const [dr, dg, db] = [at[0]! - low[0]!, at[1]! - low[1]!, at[2]! - low[2]!];
  for (let c = 0; c < 3; c++) {
    const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
    const c00 = lerp(entry(low[0]!, low[1]!, low[2]!, c), entry(high[0]!, low[1]!, low[2]!, c), dr);
    const c10 = lerp(entry(low[0]!, high[1]!, low[2]!, c), entry(high[0]!, high[1]!, low[2]!, c), dr);
    const c01 = lerp(entry(low[0]!, low[1]!, high[2]!, c), entry(high[0]!, low[1]!, high[2]!, c), dr);
    const c11 = lerp(entry(low[0]!, high[1]!, high[2]!, c), entry(high[0]!, high[1]!, high[2]!, c), dr);
    out[c] = lerp(lerp(c00, c10, dg), lerp(c01, c11, dg), db);
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `table` as a `.cube` file for ffmpeg `lut3d` (6 decimals: the numbers {@link gradeTable} rounded to). */
export function cubeText(table: GradeTable): string {
  const lines = [`LUT_3D_SIZE ${table.size}`];
  const { data } = table;
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i]!.toFixed(6)} ${data[i + 1]!.toFixed(6)} ${data[i + 2]!.toFixed(6)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * One 8-bit RGB pixel through `table` the way ffmpeg 9 `lut3d=interp=trilinear` computes it on 8-bit RGB: single
 * precision, the input scaled to the lattice, 8 taps mixed red, then green, then blue, the result truncated to 8 bit.
 * The preview's shader (`preview/grade.ts`) does the same steps; tests hold both to it.
 */
export function applyGradeTable(table: GradeTable, pixel: readonly [number, number, number]): [number, number, number] {
  const f = Math.fround;
  const max = table.size - 1;
  const scale = f(1 / 255);
  const lattice = f(max);
  const prev = [0, 0, 0];
  const next = [0, 0, 0];
  const d = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const s = Math.min(lattice, Math.max(0, f(f(pixel[c]! * scale) * lattice)));
    prev[c] = Math.trunc(s);
    next[c] = Math.min(prev[c]! + 1, max);
    d[c] = f(s - prev[c]!);
  }
  const { data, size } = table;
  const entry = (r: number, g: number, b: number, c: number) => data[((b * size + g) * size + r) * 3 + c]!;
  const lerp = (x: number, y: number, t: number) => f(x + f(f(y - x) * t));
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = lerp(entry(prev[0]!, prev[1]!, prev[2]!, c), entry(next[0]!, prev[1]!, prev[2]!, c), d[0]!);
    const c10 = lerp(entry(prev[0]!, next[1]!, prev[2]!, c), entry(next[0]!, next[1]!, prev[2]!, c), d[0]!);
    const c01 = lerp(entry(prev[0]!, prev[1]!, next[2]!, c), entry(next[0]!, prev[1]!, next[2]!, c), d[0]!);
    const c11 = lerp(entry(prev[0]!, next[1]!, next[2]!, c), entry(next[0]!, next[1]!, next[2]!, c), d[0]!);
    const value = lerp(lerp(c00, c10, d[1]!), lerp(c01, c11, d[1]!), d[2]!);
    out[c] = Math.min(255, Math.max(0, Math.trunc(f(value * 255))));
  }
  return out;
}
