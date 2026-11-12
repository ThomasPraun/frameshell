import { describe, expect, it } from "vitest";
import {
  AUDIO_EFFECT_KINDS,
  AUDIO_EFFECT_LIMITS,
  AudioEffectSchema,
  BACKDROP_ALPHA_THRESHOLD,
  BackdropSchema,
  GLASS,
  backdropLayer,
  backdropMatrix,
  backdropOf,
  type Timeline,
  VOICE_CHAIN,
  audioEffectsKey,
  audioEffectsOf,
  bakeRef,
  normalizeAudioEffects,
  parseTimeline,
} from "../src/index.js";

const withClip = (clip: Record<string, unknown>): unknown => ({
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "a1", kind: "audio", clips: [{ id: "c_1", start: 0, ...clip }] }],
});

describe("audio effects (ADR 0031)", () => {
  it("fills omitted parameters with the voice chain's numbers, which are every default", () => {
    expect(normalizeAudioEffects([{ kind: "highpass" }, { kind: "denoise" }, { kind: "compressor" }])).toEqual(VOICE_CHAIN);
    expect(normalizeAudioEffects([{ kind: "compressor", ratio: 4 }])).toEqual([{ ...VOICE_CHAIN[2], ratio: 4 }]);
    for (const effect of VOICE_CHAIN) {
      const limits = AUDIO_EFFECT_LIMITS[effect.kind] as Record<string, { default: number }>;
      for (const [name, limit] of Object.entries(limits)) expect(effect[name as keyof typeof effect]).toBe(limit.default);
    }
    expect(new Set(VOICE_CHAIN.map((effect) => effect.kind))).toEqual(new Set(AUDIO_EFFECT_KINDS));
  });

  it("keys chains that process alike the same, whatever parameters are spelled out; order matters", () => {
    expect(audioEffectsKey([{ kind: "highpass" }])).toBe(audioEffectsKey([{ kind: "highpass", frequency: 85 }]));
    expect(audioEffectsKey([{ kind: "highpass" }, { kind: "denoise" }])).not.toBe(audioEffectsKey([{ kind: "denoise" }, { kind: "highpass" }]));
    expect(bakeRef("assets/a.wav", VOICE_CHAIN)).not.toBe(bakeRef("assets/b.wav", VOICE_CHAIN));
  });

  it("validates kinds and ranges; media clips only", () => {
    expect(AudioEffectSchema.safeParse({ kind: "highpass", frequency: 5 }).success).toBe(false);
    expect(AudioEffectSchema.safeParse({ kind: "denoise", floor: -10 }).success).toBe(false);
    expect(AudioEffectSchema.safeParse({ kind: "reverb" }).success).toBe(false);
    expect(AudioEffectSchema.safeParse({ kind: "compressor", knee: 2 }).success).toBe(false);
    const media = parseTimeline(withClip({ type: "media", asset: "assets/a.wav", in: 0, out: 1, audio: { gain: -3, effects: VOICE_CHAIN } }));
    expect(media.ok).toBe(true);
    expect(parseTimeline(withClip({ type: "media", asset: "assets/a.wav", in: 0, out: 1, audio: { effects: [] } })).ok).toBe(false);
    expect(parseTimeline(withClip({ type: "timeline", source: "timelines/b.json", audio: { effects: VOICE_CHAIN } })).ok).toBe(false);
  });

  it("reads a media clip's effects, none for an empty list or other clips", () => {
    const timeline = parseTimeline(withClip({ type: "media", asset: "assets/a.wav", in: 0, out: 1, audio: { effects: [{ kind: "denoise" }] } }));
    const clip = (timeline as { ok: true; value: Timeline }).value.tracks[0]!;
    expect(audioEffectsOf((clip as { clips: { type: string }[] }).clips[0]!)).toEqual([{ kind: "denoise" }]);
    expect(audioEffectsOf({ type: "media", audio: {} })).toBeNull();
    expect(audioEffectsOf({ type: "hyperframes", audio: { effects: [{ kind: "denoise" }] } })).toBeNull();
  });
});

describe("backdrop (ADR 0031, #462)", () => {
  it("scales the blur by the output's short side, defaults to no colour change", () => {
    const project = { width: 1920, height: 1080 };
    expect(backdropLayer({ blur: 46 }, project, project)).toEqual({ sigma: 46, saturate: 1, dim: 0, threshold: BACKDROP_ALPHA_THRESHOLD });
    expect(backdropLayer(GLASS, { width: 960, height: 540 }, project)).toEqual({ sigma: 23, saturate: 1.45, dim: 0.55, threshold: BACKDROP_ALPHA_THRESHOLD });
    // A vertical format of a landscape project keeps the sigma: same short side.
    expect(backdropLayer({ blur: 46 }, { width: 1080, height: 1920 }, project).sigma).toBe(46);
  });

  it("is the CSS saturate matrix times the scrim: identity unchanged, rows summing to 1 - dim, grey at 0", () => {
    expect(backdropMatrix({ saturate: 1, dim: 0 })).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const rows = (matrix: number[]) => [0, 3, 6].map((i) => matrix[i]! + matrix[i + 1]! + matrix[i + 2]!);
    for (const row of rows(backdropMatrix({ saturate: 1.45, dim: 0.55 }))) expect(row).toBeCloseTo(0.45, 5);
    const grey = backdropMatrix({ saturate: 0, dim: 0 });
    expect(grey.slice(0, 3)).toEqual(grey.slice(3, 6));
    expect(grey.slice(0, 3)).toEqual([0.213, 0.715, 0.072]);
  });

  it("belongs to generated clips: ranges checked, none read from media or nested clips", () => {
    expect(BackdropSchema.safeParse(GLASS).success).toBe(true);
    expect(BackdropSchema.safeParse({ saturate: 1 }).success).toBe(false);
    expect(BackdropSchema.safeParse({ blur: 46, dim: 1.5 }).success).toBe(false);
    expect(parseTimeline(withVideo({ type: "hyperframes", duration: 1, backdrop: GLASS })).ok).toBe(true);
    expect(parseTimeline(withVideo({ type: "media", asset: "assets/a.mp4", in: 0, out: 1, backdrop: GLASS })).ok).toBe(false);
    expect(backdropOf({ type: "hyperframes", backdrop: GLASS })).toEqual(GLASS);
    expect(backdropOf({ type: "hyperframes" })).toBeNull();
    expect(backdropOf({ type: "media", backdrop: GLASS })).toBeNull();
  });
});

const withVideo = (clip: Record<string, unknown>): unknown => ({
  schemaVersion: 1,
  id: "main",
  revision: 1,
  tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_1", start: 0, ...clip }] }],
});
