// Voice section of the clip inspector (ADR 0031): edits of a clip's audio effect list as pure functions.
// The list is always written whole through `clip.set audioEffects`; a list that became empty is written as null.
// Builds (`music shape` sweeps, `isBuild`) are not voice: the switch, the preset and a bypass leave them in place.
import { AUDIO_EFFECT_KINDS, AUDIO_EFFECT_LIMITS, MAX_AUDIO_EFFECTS, type NormalizedAudioEffect, VOICE_CHAIN, isBuild } from "@frameshell/schema/effects";

/** Kind of one audio effect. */
export type EffectKind = NormalizedAudioEffect["kind"];

/** Kinds of the voice chain: the ones the inspector can add. A `highpassSweep` is written by `music shape` and only shown. */
export type VoiceKind = Exclude<EffectKind, "highpassSweep">;

/** Parameters of one kind, in the order the inspector shows them. */
export const EFFECT_PARAMS = {
  highpass: ["frequency"],
  denoise: ["floor", "reduction"],
  compressor: ["threshold", "ratio", "attack", "release", "makeup"],
  highpassSweep: ["startHz", "endHz"],
} as const satisfies Record<EffectKind, readonly string[]>;

/** The effects of `list` that are voice effects: everything but a build. */
export function voiceEffects(list: readonly NormalizedAudioEffect[]): NormalizedAudioEffect[] {
  return list.filter((effect) => !isBuild(effect));
}

/** True while `list` holds a voice effect; a clip with only builds has its Voice switch off. */
export function hasVoice(list: readonly NormalizedAudioEffect[]): boolean {
  return list.some((effect) => !isBuild(effect));
}

/**
 * The list with its voice effects replaced by `voice` (none removes them) and every build kept. The new voice effects
 * take the place of the first old one, ahead of the builds when the list had none; null when nothing is left.
 */
export function withVoice(list: readonly NormalizedAudioEffect[], voice: readonly NormalizedAudioEffect[] | null): NormalizedAudioEffect[] | null {
  const first = list.findIndex((effect) => !isBuild(effect));
  const at = first < 0 ? 0 : first; // every entry before `first` is a build
  const kept = list.filter(isBuild);
  const next = [...kept.slice(0, at), ...(voice ?? []), ...kept.slice(at)];
  return next.length > 0 ? next : null;
}

/** The effect of `kind` with every parameter at the voice chain's number. */
export function defaultEffect(kind: VoiceKind): NormalizedAudioEffect {
  return structuredClone(VOICE_CHAIN.find((effect) => effect.kind === kind)!);
}

/** The stored number of `param` on `effect`; undefined when the kind has no such parameter. */
export function paramOf(effect: NormalizedAudioEffect, param: string): number | undefined {
  return (effect as unknown as Record<string, number | undefined>)[param];
}

/** The list with `param` of the effect at `index` set; null when `value` is outside the parameter's range. */
export function withParam(list: readonly NormalizedAudioEffect[], index: number, param: string, value: number): NormalizedAudioEffect[] | null {
  const effect = list[index];
  if (!effect) return null;
  const limit = (AUDIO_EFFECT_LIMITS[effect.kind] as Record<string, { min: number; max: number }>)[param];
  if (!limit || !Number.isFinite(value) || value < limit.min || value > limit.max) return null;
  return list.map((entry, at) => (at === index ? ({ ...entry, [param]: value } as NormalizedAudioEffect) : entry));
}

/** The kinds `list` does not have yet, in the voice chain's order. Empty once the list is full. */
export function missingKinds(list: readonly NormalizedAudioEffect[]): VoiceKind[] {
  if (list.length >= MAX_AUDIO_EFFECTS) return [];
  return AUDIO_EFFECT_KINDS.filter((kind): kind is VoiceKind => kind !== "highpassSweep" && !list.some((effect) => effect.kind === kind));
}

/** The list with a default effect of `kind` at the end. */
export function withEffect(list: readonly NormalizedAudioEffect[], kind: VoiceKind): NormalizedAudioEffect[] {
  return [...list, defaultEffect(kind)];
}

/** The list without the effect at `index`; null when nothing is left (the clip's list is then cleared). */
export function withoutEffect(list: readonly NormalizedAudioEffect[], index: number): NormalizedAudioEffect[] | null {
  const next = list.filter((_, at) => at !== index);
  return next.length > 0 ? next : null;
}

/** The list with the effect at `index` processed one place earlier; unchanged for the first. */
export function movedEarlier(list: readonly NormalizedAudioEffect[], index: number): NormalizedAudioEffect[] {
  if (index <= 0 || index >= list.length) return [...list];
  const next = [...list];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  return next;
}

const bypassed = new Map<string, NormalizedAudioEffect[]>();

/**
 * Bypass memory: the chain a clip had when the Voice switch turned it off, so turning it on again brings the same
 * numbers back instead of the style's. Lives in this window only; the saved clip holds no bypass flag.
 */
export const bypass = {
  /** Remember `list` as the chain of `clip`. */
  keep(clip: string, list: readonly NormalizedAudioEffect[]): void {
    bypassed.set(clip, [...list]);
  },
  /** The remembered chain of `clip`; null when none. */
  recall(clip: string): NormalizedAudioEffect[] | null {
    return bypassed.get(clip) ?? null;
  },
};
