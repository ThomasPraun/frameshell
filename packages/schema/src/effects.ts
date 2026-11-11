// Audio effects of media clips (ADR 0031): one normalized chain, read by the bake key, the bake filter
// (core) and the preview's bake lookup. No Zod here: the preview engine worker imports this file.
import type { AudioEffect, MediaClip } from "./timeline.js";

/** Kinds of {@link AudioEffect}, in no particular order: a clip's list order is the processing order. */
export const AUDIO_EFFECT_KINDS = ["highpass", "denoise", "compressor"] as const;

/** Longest `audio.effects` list. */
export const MAX_AUDIO_EFFECTS = 8;

/** Range and default of one effect parameter; the default is the voice chain's number (ADR 0031). */
export interface EffectParamLimit {
  min: number;
  max: number;
  default: number;
}

/**
 * Parameter ranges of every kind. Ranges are the managed ffmpeg's (`highpass`, `afftdn`, `acompressor`),
 * converted to dB and ms; defaults are the voice chain's numbers.
 */
export const AUDIO_EFFECT_LIMITS = {
  highpass: { frequency: { min: 10, max: 1000, default: 85 } },
  denoise: { floor: { min: -80, max: -20, default: -30 }, reduction: { min: 0.01, max: 97, default: 8 } },
  compressor: {
    threshold: { min: -60, max: 0, default: -20 },
    ratio: { min: 1, max: 20, default: 2.5 },
    attack: { min: 0.01, max: 2000, default: 8 },
    release: { min: 0.01, max: 9000, default: 140 },
    makeup: { min: 0, max: 36, default: 2 },
  },
} as const satisfies Record<(typeof AUDIO_EFFECT_KINDS)[number], Record<string, EffectParamLimit>>;

/** An {@link AudioEffect} with every parameter given. */
export type NormalizedAudioEffect =
  | { kind: "highpass"; frequency: number }
  | { kind: "denoise"; floor: number; reduction: number }
  | { kind: "compressor"; threshold: number; ratio: number; attack: number; release: number; makeup: number };

/**
 * The voice chain (#464): high-pass at 85 Hz, light FFT denoise, gentle 2.5:1 compression. `clip set --voice`
 * writes these as explicit entries; they are also every parameter's default.
 */
export const VOICE_CHAIN: readonly NormalizedAudioEffect[] = [
  { kind: "highpass", frequency: 85 },
  { kind: "denoise", floor: -30, reduction: 8 },
  { kind: "compressor", threshold: -20, ratio: 2.5, attack: 8, release: 140, makeup: 2 },
];

/** `effects` with every omitted parameter at its default, fields in a fixed order. */
export function normalizeAudioEffects(effects: readonly AudioEffect[]): NormalizedAudioEffect[] {
  return effects.map((effect): NormalizedAudioEffect => {
    switch (effect.kind) {
      case "highpass":
        return { kind: "highpass", frequency: effect.frequency ?? AUDIO_EFFECT_LIMITS.highpass.frequency.default };
      case "denoise": {
        const limits = AUDIO_EFFECT_LIMITS.denoise;
        return { kind: "denoise", floor: effect.floor ?? limits.floor.default, reduction: effect.reduction ?? limits.reduction.default };
      }
      case "compressor": {
        const limits = AUDIO_EFFECT_LIMITS.compressor;
        return {
          kind: "compressor",
          threshold: effect.threshold ?? limits.threshold.default,
          ratio: effect.ratio ?? limits.ratio.default,
          attack: effect.attack ?? limits.attack.default,
          release: effect.release ?? limits.release.default,
          makeup: effect.makeup ?? limits.makeup.default,
        };
      }
    }
  });
}

/** Canonical text of a chain: equal for chains that process alike (omitted parameters = their defaults). */
export function audioEffectsKey(effects: readonly AudioEffect[]): string {
  return JSON.stringify(normalizeAudioEffects(effects));
}

/** The audio effects of a media clip; null for other clips and an absent or empty list. */
export function audioEffectsOf(clip: { type: string; audio?: unknown }): readonly AudioEffect[] | null {
  if (clip.type !== "media") return null;
  const effects = (clip as MediaClip).audio?.effects;
  return effects && effects.length > 0 ? effects : null;
}

/**
 * Lookup key of the bake of `asset` through `effects`: export and preview find a clip's baked sound by it.
 * One bake serves every clip of the same asset and chain.
 */
export function bakeRef(asset: string, effects: readonly AudioEffect[]): string {
  return `${asset}\n${audioEffectsKey(effects)}`;
}
