import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOTION_PERSONALITY,
  MOTION_PERSONALITIES,
  MOTION_PERSONALITY_IDS,
  PLATFORM_IDS,
  ResolvedStyleSchema,
  SAFE_ZONES,
  STYLE_DEFAULTS,
  SafeZoneSchema,
  StyleMotionValuesSchema,
  StyleValuesSchema,
  VOICE_CHAIN,
  parseStyleFile,
  resolveStyle,
  voiceChainOf,
  type StyleFile,
} from "../src/index.js";

const parse = (value: unknown): StyleFile => {
  const parsed = parseStyleFile({ schemaVersion: 1, ...(value as object) });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const errorOf = (value: unknown): string => {
  const parsed = parseStyleFile({ schemaVersion: 1, ...(value as object) });
  return parsed.ok ? "" : parsed.error;
};

describe("style.json", () => {
  it("ships valid motion values for every personality, calm with no overshoot and no highlight", () => {
    for (const id of MOTION_PERSONALITY_IDS) expect(StyleMotionValuesSchema.safeParse(MOTION_PERSONALITIES[id]).success, id).toBe(true);
    expect(MOTION_PERSONALITIES.calm).toMatchObject({ overshoot: 0, highlight: false, spring: { damping: 1 } });
    expect(MOTION_PERSONALITIES.premium).toMatchObject({ duration: { quick: 0.35, standard: 0.5, slow: 0.8 }, overshoot: 0 });
    for (const id of MOTION_PERSONALITY_IDS) {
      const { quick, standard, slow } = MOTION_PERSONALITIES[id].duration;
      expect(quick <= standard && standard <= slow, id).toBe(true);
    }
  });

  it("resolves defaults and the default personality with source `default` when there is no file", () => {
    const style = resolveStyle(null);
    expect(style.motion.personality).toEqual({ value: DEFAULT_MOTION_PERSONALITY, source: "default" });
    expect(style.motion.duration.standard).toEqual({ value: MOTION_PERSONALITIES[DEFAULT_MOTION_PERSONALITY].duration.standard, source: "default" });
    expect(style.colors.accent).toEqual({ value: null, source: "default" });
    expect(style.type.minReadable).toEqual({ value: 28, source: "default" });
    expect(style.sound.voice.compressor.ratio).toEqual({ value: 2.5, source: "default" });
    expect(style.platforms).toEqual({ value: [], source: "default" });
    expect(StyleValuesSchema.safeParse({ ...STYLE_DEFAULTS, motion: { ...MOTION_PERSONALITIES.corporate, personality: "corporate" } }).success).toBe(true);
  });

  it("puts the file's fields over its personality and the defaults, objects field by field", () => {
    const style = resolveStyle(
      parse({
        motion: { personality: "premium", duration: { quick: 0.3 }, spring: { damping: 0.9 } },
        colors: { accent: "#FF3300" },
        fonts: { display: { family: "Inter", file: "assets/fonts/Inter-Bold.ttf", weight: 700 } },
        sound: { duck: { depth: 9 }, voice: { compressor: { ratio: 3 } } },
        brand: { product: "Acme", hook: "?" },
        platforms: ["instagram-reels"],
        banned: ["emoji in captions"],
      }),
    );
    expect(style.motion.personality).toEqual({ value: "premium", source: "file" });
    expect(style.motion.duration).toEqual({
      quick: { value: 0.3, source: "file" },
      standard: { value: 0.5, source: "personality" },
      slow: { value: 0.8, source: "personality" },
    });
    expect(style.motion.spring).toEqual({ response: { value: 0.5, source: "personality" }, damping: { value: 0.9, source: "file" } });
    expect(style.motion.ease).toEqual({ value: MOTION_PERSONALITIES.premium.ease, source: "personality" });
    expect(style.colors.accent).toEqual({ value: "#FF3300", source: "file" });
    expect(style.colors.bg).toEqual({ value: null, source: "default" });
    expect(style.fonts.display).toEqual({ value: { family: "Inter", file: "assets/fonts/Inter-Bold.ttf", weight: 700 }, source: "file" });
    expect(style.sound.duck).toEqual({ depth: { value: 9, source: "file" }, attack: { value: 0.04, source: "default" }, release: { value: 0.45, source: "default" } });
    expect(style.sound.voice.compressor.ratio).toEqual({ value: 3, source: "file" });
    expect(style.sound.voice.compressor.threshold).toEqual({ value: -20, source: "default" });
    expect(style.brand.hook).toEqual({ value: "?", source: "file" });
    expect(style.platforms).toEqual({ value: ["instagram-reels"], source: "file" });
    expect(style.banned).toEqual({ value: ["emoji in captions"], source: "file" });
    expect(ResolvedStyleSchema.safeParse(style).success).toBe(true);
  });

  it("never shares state between resolutions", () => {
    const first = resolveStyle(null);
    first.motion.ease.value[0] = 0.9;
    first.platforms.value.push("youtube");
    expect(resolveStyle(null).motion.ease.value[0]).toBe(MOTION_PERSONALITIES[DEFAULT_MOTION_PERSONALITY].ease[0]);
    expect(STYLE_DEFAULTS.platforms).toEqual([]);
  });

  it("rejects unknown keys, a missing schemaVersion and unknown personalities or platforms", () => {
    expect(errorOf({ colour: { accent: "#ffffff" } })).toMatch(/Unrecognized key/);
    expect(errorOf({ motion: { personality: "bouncy" } })).toMatch(/^motion\.personality:/);
    expect(errorOf({ motion: { durations: { quick: 0.2 } } })).toMatch(/Unrecognized key/);
    expect(errorOf({ platforms: ["myspace"] })).toMatch(/^platforms\.0:/);
    expect(errorOf({ platforms: ["tiktok", "tiktok"] })).toMatch(/each platform once/);
    expect(parseStyleFile({ colors: {} }).ok).toBe(false);
  });

  it("validates units: hex colours, seconds not milliseconds, decibels, pixels, font files", () => {
    expect(errorOf({ colors: { accent: "red" } })).toMatch(/^colors\.accent: must be a hex colour/);
    expect(errorOf({ colors: { accent: "#fff" } })).toMatch(/hex colour/);
    expect(parse({ colors: { card: "#11223380" } }).colors?.card).toBe("#11223380");
    expect(errorOf({ motion: { duration: { standard: 300 } } })).toMatch(/seconds, not milliseconds/);
    expect(errorOf({ motion: { overshoot: 15 } })).toMatch(/^motion\.overshoot:/);
    expect(errorOf({ motion: { ease: [1.2, 0, 0.5, 1] } })).toMatch(/^motion\.ease\.0:/);
    expect(errorOf({ sound: { musicUnderVoice: -12 } })).toMatch(/^sound\.musicUnderVoice:/);
    expect(errorOf({ sound: { duck: { attack: 40 } } })).toMatch(/seconds, not milliseconds/);
    expect(errorOf({ type: { minReadable: 0 } })).toMatch(/^type\.minReadable:/);
    expect(errorOf({ fonts: { ui: { family: "X", file: "fonts/x.ttf" } } })).toMatch(/assets\/fonts/);
    expect(errorOf({ fonts: { ui: { family: "X", file: "assets/fonts/../x.ttf" } } })).toMatch(/must not leave/);
    expect(errorOf({ fonts: { ui: { family: "X", file: "assets/fonts/x.png" } } })).toMatch(/\.ttf/);
    expect(errorOf({ fonts: { ui: { family: "X", weight: 450 } } })).toBe("");
    expect(errorOf({ fonts: { ui: { family: "X", weight: 1000 } } })).toMatch(/^fonts\.ui\.weight:/);
    expect(errorOf({ from: { id: "house", sha256: "abc" } })).toMatch(/^from\.sha256:/);
  });
});

describe("safe zones", () => {
  it("has one valid entry per platform, keyed by its id, inside its reference frame", () => {
    expect(Object.keys(SAFE_ZONES).sort()).toEqual([...PLATFORM_IDS].sort());
    for (const id of PLATFORM_IDS) {
      const zone = SAFE_ZONES[id];
      expect(SafeZoneSchema.safeParse(zone).success, id).toBe(true);
      expect(zone.platform).toBe(id);
      expect(zone.top + zone.bottom < zone.height && zone.left + zone.right < zone.width, id).toBe(true);
    }
  });

  it("marks only the Instagram numbers as measured", () => {
    expect(PLATFORM_IDS.filter((id) => SAFE_ZONES[id].measured)).toEqual(["instagram-reels"]);
    expect(SAFE_ZONES["instagram-reels"]).toMatchObject({ width: 1080, height: 1920, top: 220, right: 140, bottom: 380 });
  });
});

describe("voiceChainOf (#464)", () => {
  it("gives the voice chain for the default style, so --voice is unchanged without a style", () => {
    expect(voiceChainOf(resolveStyle(null).sound.voice)).toEqual(VOICE_CHAIN);
    expect(voiceChainOf(resolveStyle(parse({})).sound.voice)).toEqual(VOICE_CHAIN);
  });

  it("takes the style's numbers, seconds as milliseconds, and keeps the rest at the default", () => {
    const style = parse({ sound: { voice: { highpass: 100, compressor: { ratio: 3, attack: 0.012, release: 0.2 } } } });
    expect(voiceChainOf(resolveStyle(style).sound.voice)).toEqual([
      { kind: "highpass", frequency: 100 },
      { kind: "denoise", floor: -30, reduction: 8 },
      { kind: "compressor", threshold: -20, ratio: 3, attack: 12, release: 200, makeup: 2 },
    ]);
  });

  it("leaves denoise out at a reduction of 0 and holds every number to the effect's range", () => {
    const style = parse({ sound: { voice: { highpass: 20, denoise: { reduction: 0 }, compressor: { attack: 0, release: 0.001 } } } });
    const chain = voiceChainOf(resolveStyle(style).sound.voice);
    expect(chain.map((effect) => effect.kind)).toEqual(["highpass", "compressor"]);
    expect(chain[1]).toMatchObject({ attack: 0.01, release: 1 });
  });
});
