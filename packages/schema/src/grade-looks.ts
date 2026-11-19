// Built-in looks (ADR 0031 decision 8): named grades as plain correction numbers, no `.cube` file and no
// third-party LUT. No Zod here, like grade.ts: a look is a `Grade` written into the clip, so it stays the clip's own copy.
import type { Grade } from "./timeline.js";

/** A grade of the built-in table and the words that say what it is for. */
export interface BuiltInLook {
  /** Lower-case word the CLI, MCP and the inspector use, e.g. `warm`. */
  name: string;
  /** One line of what the look does to a picture. */
  summary: string;
  /** Every correction number given (no LUT), inside `GRADE_LIMITS`; none is neutral together with the rest. */
  grade: Required<Pick<Grade, "exposure" | "temperature" | "tint" | "contrast" | "saturation">>;
}

/**
 * The built-in looks, in the order they are listed. Judgment, not colour science: each is a starting point to judge by
 * eye (`grade.compare`) on Rec.709 footage, then to adjust. Numbers, not LUTs, so nothing is bundled and a clip that
 * took a look keeps its own copy when this table changes.
 */
export const GRADE_LOOKS: readonly BuiltInLook[] = [
  { name: "warm", summary: "Golden skin and light: white balance towards red, a little more colour and body.", grade: { exposure: 0.05, temperature: 0.4, tint: 0.04, contrast: 1.04, saturation: 1.08 } },
  { name: "cool", summary: "Clean, a little distant: white balance towards blue, colour held back a touch.", grade: { exposure: 0, temperature: -0.4, tint: -0.03, contrast: 1.04, saturation: 0.95 } },
  { name: "filmic", summary: "Soft contrast and quieter colour with a faint warmth, like a print of film.", grade: { exposure: -0.05, temperature: 0.08, tint: 0, contrast: 0.92, saturation: 0.88 } },
  { name: "punchy", summary: "Hard contrast and rich colour for phone screens and short clips.", grade: { exposure: 0.05, temperature: 0, tint: 0, contrast: 1.25, saturation: 1.3 } },
  { name: "faded", summary: "Lifted, flat and pale: low contrast and little colour, a touch warm.", grade: { exposure: 0.15, temperature: 0.05, tint: 0, contrast: 0.8, saturation: 0.82 } },
  { name: "mono", summary: "Black and white with a little extra contrast.", grade: { exposure: 0, temperature: 0, tint: 0, contrast: 1.1, saturation: 0 } },
];

/** Names of {@link GRADE_LOOKS}, in their order. */
export const lookNames: readonly string[] = GRADE_LOOKS.map((look) => look.name);

/** The built-in look called `name` (exact, lower case), or undefined. */
export function findLook(name: string): BuiltInLook | undefined {
  return GRADE_LOOKS.find((look) => look.name === name);
}

/**
 * A copy of the correction numbers of the built-in look `name`, ready to write as a clip's `grade`; undefined for a
 * name that is not one. A copy, so the caller may change it.
 */
export function lookGrade(name: string): Grade | undefined {
  const look = findLook(name);
  return look ? { ...look.grade } : undefined;
}
