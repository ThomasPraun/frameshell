import type { Grade } from "@frameshell/schema";
import { type FrameLevels, round } from "./levels.js";

// A bounded first-pass correction from measured levels, in the fields of a clip's grade (ADR 0031: correct first,
// then style). Pure; `analyze.ts` measures. The numbers are judgment, not colour science: see ADR 0031.

/** The correction fields a suggestion can carry: a grade without its LUT. */
export type GradeCorrection = Omit<Grade, "lut" | "lutMix">;

/** What the picture is moved towards, and how far, in one place so a test and the ADR can name them. */
export const SUGGEST = {
  /** Mean brightness of the encoded picture the exposure aims at (about 18 % grey in light with the grade's gamma 2.4 is 0.46). */
  meanTarget: 0.45,
  /** Display gamma of the grade's exposure: a stop is a factor 2 in light, `2^(1/2.4)` in the encoded levels. */
  gamma: 2.4,
  /** Most stops either way: a bigger fix is a different shot, not a correction. */
  maxStops: 1,
  /** Under this, exposure is left alone (stops). */
  stopsDeadband: 0.15,
  /** Exposure never pushes the 90th percentile above this encoded level. */
  highlightCeiling: 0.92,
  /** 90th minus 10th percentile the contrast aims at. */
  spreadTarget: 0.55,
  contrastRange: [0.8, 1.25],
  /** Under this distance from 1, contrast is left alone. */
  contrastDeadband: 0.06,
  /** Contrast never pushes the 90th percentile above, or the 10th below, these encoded levels. */
  contrastCeiling: 0.97,
  contrastFloor: 0.02,
  /** Mean colour strength the saturation aims at. */
  saturationTarget: 0.15,
  saturationRange: [0.85, 1.2],
  saturationDeadband: 0.1,
  /** Below this the picture is taken as monochrome and its saturation is left alone. */
  monochrome: 0.02,
  /** Share of a measured cast removed: a grey-world reading is a guess (sunsets are warm), so never all of it. */
  castShare: 0.6,
  /** Encoded change of red minus blue per unit of `temperature`, per unit of mean level: `2 * 0.2 / 2.4` of gamma-encoded gains. */
  temperatureGain: 0.167,
  /** The same for green against red and blue per unit of `tint`: `0.2 / 2.4`. */
  tintGain: 0.0833,
  /** Most white balance either way (the controls' units). */
  maxCast: 0.4,
  /** A mean cast under this (red minus blue, or green against red and blue; about 4 of 255) is left alone. */
  castDeadband: 0.015,
  /** A picture with less spread than this, or a mean below the floor, has nothing to correct by. */
  minSpread: 0.02,
  minMean: 0.02,
} as const;

/** The suggestion: the fields to set (absent ones stay as they are) and a line on why for each, or on why none. */
export interface GradeSuggestion {
  correction: GradeCorrection;
  reasons: string[];
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

/** The value of each correction field that does nothing. */
export const NEUTRAL_CORRECTION = { exposure: 0, temperature: 0, tint: 0, contrast: 1, saturation: 1 } as const satisfies Required<GradeCorrection>;

/**
 * The bounded correction that moves `levels` towards the targets; empty when it is within them or has no range to work with.
 * `clip.set` merges `grade` field by field, so a correction field `current` sets and the suggestion leaves out is
 * put back to neutral: applying the suggestion then replaces the clip's own correction (its LUT stays).
 */
export function suggestGrade(levels: FrameLevels, current?: Grade | null): GradeSuggestion {
  const { lumaMean: mean, lumaLow: low, lumaHigh: high } = levels;
  if (mean < SUGGEST.minMean || high - low < SUGGEST.minSpread) {
    return { correction: {}, reasons: ["The picture has no range to correct by (black, or one flat colour): no suggestion."] };
  }
  const correction: GradeCorrection = {};
  const reasons: string[] = [];

  // Exposure: bring the mean to the target, but never let the highlights through the ceiling.
  let stops = SUGGEST.gamma * Math.log2(SUGGEST.meanTarget / mean);
  stops = clamp(stops, -SUGGEST.maxStops, SUGGEST.maxStops);
  if (stops > 0) stops = Math.min(stops, Math.max(0, SUGGEST.gamma * Math.log2(SUGGEST.highlightCeiling / Math.max(high, 0.01))));
  stops = round(stops, 2);
  if (Math.abs(stops) >= SUGGEST.stopsDeadband) {
    correction.exposure = stops;
    reasons.push(`exposure ${signed(stops)}: the mean brightness is ${round(mean, 2)}, the target ${SUGGEST.meanTarget}.`);
  } else stops = 0;
  const gain = 2 ** (stops / SUGGEST.gamma);
  const [afterLow, afterHigh] = [low * gain, Math.min(1, high * gain)];

  // Contrast: stretch or relax the 10th to 90th percentile spread to the target, without clipping either end.
  let contrast = SUGGEST.spreadTarget / Math.max(afterHigh - afterLow, SUGGEST.minSpread);
  contrast = clamp(contrast, ...SUGGEST.contrastRange);
  if (contrast > 1) {
    if (afterHigh > 0.5) contrast = Math.min(contrast, (SUGGEST.contrastCeiling - 0.5) / (afterHigh - 0.5));
    if (afterLow < 0.5) contrast = Math.min(contrast, (0.5 - SUGGEST.contrastFloor) / (0.5 - afterLow));
    contrast = Math.max(1, contrast);
  }
  contrast = round(contrast, 2);
  let chromaGain = gain;
  if (Math.abs(contrast - 1) >= SUGGEST.contrastDeadband) {
    chromaGain *= contrast;
    correction.contrast = contrast;
    reasons.push(`contrast ${contrast}: the shadows to highlights spread is ${round(afterHigh - afterLow, 2)}, the target ${SUGGEST.spreadTarget}.`);
  }

  // White balance: remove part of the mean cast; the cast in encoded levels per unit of the control scales with brightness.
  // Exposure and white balance multiply in the grade's table, so the exposure gain cancels and the mean is the level.
  const level = Math.max(mean, 0.15);
  const temperature = round(clamp((-SUGGEST.castShare * levels.warmth) / (SUGGEST.temperatureGain * level), -SUGGEST.maxCast, SUGGEST.maxCast), 2);
  if (Math.abs(levels.warmth) >= SUGGEST.castDeadband && temperature !== 0) {
    correction.temperature = temperature;
    reasons.push(`temperature ${signed(temperature)}: the picture leans ${levels.warmth > 0 ? "warm" : "cool"} (red minus blue ${signed(round(levels.warmth, 3))}).`);
  }
  const tint = round(clamp((SUGGEST.castShare * levels.tint) / (SUGGEST.tintGain * level), -SUGGEST.maxCast, SUGGEST.maxCast), 2);
  if (Math.abs(levels.tint) >= SUGGEST.castDeadband && tint !== 0) {
    correction.tint = tint;
    reasons.push(`tint ${signed(tint)}: the picture leans ${levels.tint > 0 ? "green" : "magenta"} (green against red and blue ${signed(round(levels.tint, 3))}).`);
  }

  // Saturation: towards the usual colour strength of footage, not for a picture with hardly any. The exposure and
  // contrast suggested above scale the colour differences too, so the strength it starts from is theirs.
  if (levels.saturation >= SUGGEST.monochrome) {
    const saturation = round(clamp(SUGGEST.saturationTarget / (levels.saturation * chromaGain), ...SUGGEST.saturationRange), 2);
    if (Math.abs(saturation - 1) >= SUGGEST.saturationDeadband) {
      correction.saturation = saturation;
      reasons.push(`saturation ${saturation}: the mean colour strength is ${round(levels.saturation, 3)}, the target ${SUGGEST.saturationTarget}.`);
    }
  }

  for (const field of Object.keys(NEUTRAL_CORRECTION) as (keyof GradeCorrection)[]) {
    const own = current?.[field];
    if (correction[field] !== undefined || own === undefined || own === NEUTRAL_CORRECTION[field]) continue;
    correction[field] = NEUTRAL_CORRECTION[field];
    reasons.push(`${field} ${NEUTRAL_CORRECTION[field]}: the clip's own ${field} ${own} is replaced, the source needs none.`);
  }

  if (reasons.length === 0) reasons.push("The picture is within the targets: no correction suggested.");
  return { correction, reasons };
}

/** `correction` as `clip set` flags in the order the grade applies them; a negative number takes `=` so the shell does not read it as a flag. */
export function correctionFlags(correction: GradeCorrection): string {
  const flag = (name: string, value: number | undefined): string[] => (value === undefined ? [] : [`--grade-${name}${value < 0 ? "=" : " "}${value}`]);
  return [
    ...flag("exposure", correction.exposure),
    ...flag("temperature", correction.temperature),
    ...flag("tint", correction.tint),
    ...flag("contrast", correction.contrast),
    ...flag("saturation", correction.saturation),
  ].join(" ");
}
