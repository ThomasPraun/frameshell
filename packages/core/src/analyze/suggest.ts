import type { AnalyzeResultShape, AnalyzeStyleSuggestion } from "@frameshell/protocol";
import { MOTION_PERSONALITIES, type MotionPersonalityId, StyleSoundSchema } from "@frameshell/schema";
import { hsl, isNeutral } from "../brand/findings.js";
import { luminance } from "../export/cover.js";
import { median } from "./median.js";

// `style.json` values read from an analysis: the grammar of a reference as `style.set` calls. Pure: `service.ts`
// feeds it the measured result. Never applied here; `style.apply` with `analysis` applies what the person agrees to.

/** Share of the picture the largest palette colour must hold to be the background; less is a subject, not a ground. */
export const BG_MIN_SHARE = 0.25;
/** Contrast ratio against the background text needs to be ink: WCAG 2 level AA for body text. */
export const INK_MIN_CONTRAST = 4.5;
/** HSL saturation from which a palette colour reads as an accent rather than a tint of grey. */
export const ACCENT_MIN_SATURATION = 0.35;
/** Fit (RMS gap to the closest ease, in mean speeds) under which a move is an animated one: `analyze`'s "over 0.5 a poor one". */
export const MOVE_MAX_FIT = 0.5;
/** Eased moves needed before their median length names a personality: one or two are a gesture, not a habit. */
export const MIN_EASED_MOVES = 3;
/** Personalities the move lengths choose between: calm shares premium's timing and differs only by its unmeasured highlight. */
const TIMED_PERSONALITIES: readonly MotionPersonalityId[] = ["energetic", "playful", "corporate", "premium"];
// The pace rule is a taste rule (labelled DECISION): a median shot of a second or less with 30 cuts a minute reads as
// energetic, one of 4 s or more holding still half the time as calm. No source measured these edges.
/** Median shot length (s) at or under which, with {@link ENERGETIC_CUTS_PER_MINUTE}, the cutting reads as energetic. */
export const ENERGETIC_MEDIAN_SHOT_S = 1;
/** Cuts a minute at or over which, with {@link ENERGETIC_MEDIAN_SHOT_S}, the cutting reads as energetic. */
export const ENERGETIC_CUTS_PER_MINUTE = 30;
/** Median shot length (s) at or over which, with {@link CALM_STILL_SHARE}, the cutting reads as calm. */
export const CALM_MEDIAN_SHOT_S = 4;
/** Share of still frames at or over which, with {@link CALM_MEDIAN_SHOT_S}, the cutting reads as calm. */
export const CALM_STILL_SHARE = 0.5;

/** The measured fields suggestions are read from. */
export type SuggestionInput = Pick<AnalyzeResultShape, "palette" | "curve" | "stats" | "rhythm" | "audio">;

/**
 * `style.json` values the analysed film suggests, at most one per path, in `STYLE_PATHS` order: background, ink and
 * accent from the palette, a motion personality from the moves (else the cutting), music under the voice from the
 * speech. The integrated loudness is no style value (ADR 0028 decision 5: it stays `export.loudness`).
 */
export function styleSuggestions(input: SuggestionInput): AnalyzeStyleSuggestion[] {
  const out: AnalyzeStyleSuggestion[] = [];
  out.push(...colorSuggestions(input.palette));
  const personality = personalitySuggestion(input);
  if (personality) out.push(personality);
  const music = musicSuggestion(input.audio);
  if (music) out.push(music);
  return out;
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const percent = (share: number) => `${Math.round(share * 100)} %`;

function colorSuggestions(palette: SuggestionInput["palette"]): AnalyzeStyleSuggestion[] {
  const bg = palette[0];
  if (!bg || bg.share < BG_MIN_SHARE) return [];
  const out: AnalyzeStyleSuggestion[] = [
    { path: "colors.bg", value: bg.hex, why: `the film's largest colour, ${percent(bg.share)} of the picture`, from: ["palette"], label: "ESTIMATED" },
  ];
  const rest = palette.slice(1);
  const ink = rest
    .map((color) => ({ color, contrast: contrastRatio(color.hex, bg.hex) }))
    .filter(({ contrast }) => contrast >= INK_MIN_CONTRAST)
    .sort((a, b) => b.contrast - a.contrast || b.color.share - a.color.share)[0];
  if (ink) {
    out.push({
      path: "colors.ink",
      value: ink.color.hex,
      why: `the palette colour with the most contrast against ${bg.hex}: ${ink.contrast.toFixed(1)}:1, ${percent(ink.color.share)} of the picture`,
      from: ["palette"],
      label: "ESTIMATED",
    });
  }
  const accent = rest
    .filter((color) => color !== ink?.color && !isNeutral(color.hex) && hsl(color.hex).s >= ACCENT_MIN_SATURATION)
    .sort((a, b) => hsl(b.hex).s - hsl(a.hex).s || b.share - a.share)[0];
  if (accent) {
    out.push({
      path: "colors.accent",
      value: accent.hex,
      why: `the most saturated colour of the palette (saturation ${hsl(accent.hex).s.toFixed(2)}, ${percent(accent.share)} of the picture)`,
      from: ["palette"],
      label: "ESTIMATED",
    });
  }
  return out;
}

function personalitySuggestion({ curve, stats, rhythm }: SuggestionInput): AnalyzeStyleSuggestion | null {
  const eased = curve.moves.filter((move) => move.ease !== null && move.fit !== null && move.fit <= MOVE_MAX_FIT).map((move) => move.duration);
  if (eased.length >= MIN_EASED_MOVES) {
    const length = median(eased);
    const nearest = TIMED_PERSONALITIES.map((id) => ({ id, standard: MOTION_PERSONALITIES[id].duration.standard })).sort(
      (a, b) => Math.abs(a.standard - length) - Math.abs(b.standard - length),
    )[0]!;
    return {
      path: "motion.personality",
      value: nearest.id,
      why: `the median eased move lasts ${length.toFixed(2)} s (${eased.length} moves); ${nearest.id} moves in ${nearest.standard} s. Overshoot is not measured, so energetic and playful are told apart by length alone`,
      from: ["curve.moves"],
      label: "ESTIMATED",
    };
  }
  const pace = `median shot ${stats.medianLength} s, ${stats.cutsPerMinute} cuts a minute, ${percent(rhythm.stillShare)} still frames`;
  const from = ["stats.medianLength", "stats.cutsPerMinute", "rhythm.stillShare"];
  if (stats.shotCount > 1 && stats.medianLength <= ENERGETIC_MEDIAN_SHOT_S && stats.cutsPerMinute >= ENERGETIC_CUTS_PER_MINUTE) {
    return { path: "motion.personality", value: "energetic", why: `fast cutting (${pace}); too few eased moves to time`, from, label: "DECISION" };
  }
  if (stats.medianLength >= CALM_MEDIAN_SHOT_S && rhythm.stillShare >= CALM_STILL_SHARE) {
    return { path: "motion.personality", value: "calm", why: `slow cutting that holds still (${pace}); too few eased moves to time`, from, label: "DECISION" };
  }
  return null;
}

function musicSuggestion(audio: SuggestionInput["audio"]): AnalyzeStyleSuggestion | null {
  const over = audio?.speech.overMusic;
  if (!over || over.median <= 0) return null;
  const value = Math.round(over.median);
  if (!StyleSoundSchema.shape.musicUnderVoice.safeParse(value).success) return null;
  return {
    path: "sound.musicUnderVoice",
    value,
    why: `the voice sits a median ${over.median} dB over the music in ${over.count} sentence${over.count === 1 ? "" : "s"} (lowest ${over.lowest} dB)`,
    from: ["audio.speech.overMusic"],
    label: "ESTIMATED",
  };
}
