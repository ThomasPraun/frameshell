// Film finish in the app (ADR 0043 slice 4b): the numbers the inspector shows for a clip's vignette and grain, and the
// letterbox menu's choices. Pure, so the window and its tests share them; no number of the formulas lives here.
import { GRAIN_LIMITS, type GrainFields, VIGNETTE_LIMITS, type VignetteFields } from "@frameshell/schema/finish";

/** A clip's vignette with every number given: what the sliders show, from the stored fields and the schema defaults. */
export interface ShownVignette {
  strength: number;
  radius: number;
  softness: number;
}

/** A clip's grain as the inspector shows it; `seed` is null while the clip follows the hash of its id. */
export interface ShownGrain {
  amount: number;
  size: number;
  seed: number | null;
}

/** `stored` (a clip's `vignette` field, any shape) with defaults filled in; null for none. A strength of 0 stays: it is a vignette turned all the way down. */
export function shownVignette(stored: unknown): ShownVignette | null {
  if (typeof stored !== "object" || stored === null) return null;
  const fields = stored as VignetteFields;
  return {
    strength: fields.strength ?? VIGNETTE_LIMITS.strength.default,
    radius: fields.radius ?? VIGNETTE_LIMITS.radius.default,
    softness: fields.softness ?? VIGNETTE_LIMITS.softness.default,
  };
}

/** `stored` (a clip's `grain` field, any shape) with defaults filled in; null for none. An amount of 0 stays. */
export function shownGrain(stored: unknown): ShownGrain | null {
  if (typeof stored !== "object" || stored === null) return null;
  const fields = stored as GrainFields;
  return { amount: fields.amount ?? GRAIN_LIMITS.amount.default, size: fields.size ?? GRAIN_LIMITS.size.default, seed: fields.seed ?? null };
}

/** The sliders of each group: stored name, range from the schema and the step a keyboard press moves it by. */
export const VIGNETTE_SLIDERS = [
  { name: "strength", step: 0.01 },
  { name: "radius", step: 0.01 },
  { name: "softness", step: 0.01 },
] as const satisfies readonly { name: keyof ShownVignette; step: number }[];

export const GRAIN_SLIDERS = [
  { name: "amount", step: 0.01 },
  { name: "size", step: 0.1 },
] as const satisfies readonly { name: "amount" | "size"; step: number }[];

/** A film aspect the menu lists: `id` is the option's value, `aspect` width / height. */
export const LETTERBOX_PRESETS = [
  { id: "2.39", aspect: 2.39 },
  { id: "2.35", aspect: 2.35 },
  { id: "1.85", aspect: 1.85 },
  { id: "4:3", aspect: 4 / 3 },
] as const;

/** What the letterbox menu shows selected. */
export type LetterboxChoice = "none" | "custom" | (typeof LETTERBOX_PRESETS)[number]["id"];

/** Aspects this close count as the same one, so a stored 1.3333 shows as 4:3. */
const SAME_ASPECT = 0.001;

/** The menu entry of a stored aspect: its preset, `custom` for any other, `none` without one. */
export function letterboxChoice(aspect: number | null): LetterboxChoice {
  if (aspect === null) return "none";
  return LETTERBOX_PRESETS.find((preset) => Math.abs(preset.aspect - aspect) < SAME_ASPECT)?.id ?? "custom";
}

/** `aspect` as written in the custom field and the history: at most three decimals, `:1` left off. */
export function aspectText(aspect: number): string {
  return String(Number(aspect.toFixed(3)));
}

/**
 * The `letterbox.set` arguments for `aspect` (null clears) in `format`: the id of the non-primary format being shown,
 * null for the primary (ADR 0043 decision 2, ADR 0027 decision 14).
 */
export function letterboxArgs(aspect: number | null, format: string | null): { aspect?: number; clear?: true; format?: string } {
  return { ...(aspect === null ? { clear: true as const } : { aspect }), ...(format === null ? {} : { format }) };
}

/** The letterbox's stored view of a timeline, as `TimelineView` carries it. */
export interface StoredLetterbox {
  letterbox?: { aspect: number } | undefined;
  formats?: Record<string, { letterbox?: { aspect: number } | undefined } | undefined> | undefined;
}

/** The aspect stored for `format` (null: the primary), or null without one. */
export function storedAspect(view: StoredLetterbox | null, format: string | null): number | null {
  if (view === null) return null;
  return (format === null ? view.letterbox : view.formats?.[format]?.letterbox)?.aspect ?? null;
}
