import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { AUDIO_EFFECT_LIMITS, BACKDROP_LIMITS, GLASS, type NormalizedAudioEffect } from "./effects.js";
import { EASE_CURVES, SPRING_PRESETS } from "./motion.js";
import { PLATFORM_IDS } from "./safe-zones.js";
import type { Backdrop } from "./timeline.js";

/** Canonical `$schema` URL for a project's `style.json`. */
export const STYLE_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/style.json`;

/** Project-relative path of the project's style guide (ADR 0028). */
export const STYLE_FILE = "style.json";

/** Motion personalities a style picks its motion values from (ADR 0028 decision 8). */
export const MOTION_PERSONALITY_IDS = ["playful", "premium", "corporate", "energetic", "calm"] as const;

/** One of {@link MOTION_PERSONALITY_IDS}. */
export type MotionPersonalityId = (typeof MOTION_PERSONALITY_IDS)[number];

/** Personality whose motion values apply when `style.json` names none. */
export const DEFAULT_MOTION_PERSONALITY: MotionPersonalityId = "corporate";

const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, "must be a hex colour: #rrggbb or #rrggbbaa")
  .describe("Hex colour `#rrggbb` (or `#rrggbbaa`).");
// Maxima catch milliseconds typed as seconds.
const Seconds = (what: string, max: number) =>
  z.number().nonnegative().max(max, `at most ${max}: seconds, not milliseconds`).describe(`${what} Seconds, not milliseconds (at most ${max}).`);
const Db = (what: string) => z.number().min(0).max(60).describe(`${what} dB, 0 to 60.`);
const Px = (what: string) => z.number().positive().max(1080).describe(`${what} Pixels on a frame whose short side is 1080; scale with the short side.`);
const Words = (what: string) => z.array(z.string().trim().min(1)).describe(what);

/** A font role: a family name, optionally a font file of the project. */
export const StyleFontSchema = z.strictObject({
  family: z.string().trim().min(1).describe("Family name, e.g. `Archivo Black`: a face Frameshell bundles, or the family inside `file`."),
  file: z
    .string()
    .regex(/^assets\/fonts\/[^\\]+\.(?:ttf|otf|woff2?)$/i, "must be a .ttf, .otf, .woff or .woff2 file under assets/fonts/, `/`-separated")
    .refine((path) => !path.split("/").includes(".."), "must not leave assets/fonts/")
    .optional()
    .describe("Font file under `assets/fonts/` (project-relative, `/`-separated). Frameshell never downloads fonts: import the file with its credit."),
  weight: z.int().min(100).max(900).optional().describe("Weight, 100 to 900 (400 regular, 700 bold)."),
  tracking: z.number().min(-0.5).max(1).optional().describe("Letter spacing in em (-0.02 = slightly tighter)."),
});

/** See {@link StyleFontSchema}. */
export type StyleFont = z.output<typeof StyleFontSchema>;

const BrandText = (what: string) => z.string().trim().min(1).nullable().describe(`${what} \`?\` marks a field to ask the person about.`);

/** What the video sells and to whom, in the person's words. */
export const StyleBrandSchema = z.strictObject({
  product: BrandText("Product or channel name."),
  url: BrandText("Address shown or spoken."),
  promise: BrandText("The one-line promise."),
  hook: BrandText("Opening line: 2 to 5 words ending in a full stop."),
  cta: BrandText("Call to action at the end."),
  audience: BrandText("Who it is for."),
  reference: BrandText("A video or brand the look follows."),
  mustShow: Words("Things every video shows (a logo, the product screen)."),
  mustAvoid: Words("Things no video shows or says."),
});

const Color = (what: string) => Hex.nullable().describe(`${what} Hex \`#rrggbb\`.`);

/** Colour roles: one accent, inks on a background. */
export const StyleColorsSchema = z.strictObject({
  bg: Color("Background."),
  ink: Color("Main text."),
  ink2: Color("Secondary text."),
  accent: Color("The one accent (the key word, the chosen item)."),
  card: Color("Cards and panels over the picture."),
  keyword: Color("Keyword colour in captions."),
  highlight: Color("Box behind the spoken word in captions."),
});

/** Font roles; at most two faces is the usual rule (display + UI). */
export const StyleFontsSchema = z.strictObject({
  display: StyleFontSchema.nullable().describe("Titles and big words."),
  ui: StyleFontSchema.nullable().describe("Body text, labels, cards."),
  captions: StyleFontSchema.nullable().describe("Captions (subtitle tracks)."),
  keyword: StyleFontSchema.nullable().describe("The highlighted keyword in captions."),
});

/** Text sizes and margins. */
export const StyleTypeSchema = z.strictObject({
  hero: Px("Hero text size (one big word or number)."),
  card: Px("Text size on cards."),
  minReadable: Px("Smallest text meant to be read; smaller is decoration."),
  margin: Px("Left edge of left-aligned text, from the frame's edge."),
});

/** The motion values a personality sets (ADR 0028 decision 8). */
export const StyleMotionValuesSchema = z.strictObject({
  duration: z
    .strictObject({
      quick: Seconds("Feedback and small moves.", 5),
      standard: Seconds("Most entrances.", 5),
      slow: Seconds("Hero moves and full-frame changes.", 5),
    })
    .describe("Duration palette of a move."),
  ease: z
    .tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()])
    .describe("Signature ease, about 80 % of moves: `cubic-bezier(x1, y1, x2, y2)` as 4 numbers, x within 0 to 1."),
  overshoot: z.number().min(0).max(0.3).describe("Most a move may pass its target, fraction of its travel (0.03 = 3 %). Over 0.25 reads as broken."),
  spring: z
    .strictObject({
      response: z.number().positive().max(5).describe("Period of the spring, seconds."),
      damping: z.number().min(0.1).max(2).describe("Damping ratio ζ: 1 never bounces, 0.7 to 0.85 barely, 0.4 to 0.6 bouncy."),
    })
    .describe("Spring for position and size; opacity and colour never spring."),
  stagger: Seconds("Delay between items entering one after another.", 1),
  exit: z.number().min(0.1).max(1).describe("Exit length as a fraction of the entrance (exits are shorter, ease-in)."),
  highlight: z.boolean().describe("Mark the key word (accent colour, captions keyword). False keeps every word one colour."),
});

/** See {@link StyleMotionValuesSchema}. */
export type StyleMotionValues = z.output<typeof StyleMotionValuesSchema>;

/** Sound levels relative to the voice; the loudness target stays `export.loudness` (ADR 0028 decision 5). */
export const StyleSoundSchema = z.strictObject({
  musicUnderVoice: Db("How far music sits under the voice,"),
  sfxUnderVoice: Db("How far sound effects sit under the voice,"),
  duck: z
    .strictObject({
      depth: Db("How far music dips while someone speaks,"),
      attack: Seconds("Dip complete as the voice starts, this long after the dip begins.", 5),
      release: Seconds("Dip gone this long after the voice ends.", 5),
    })
    .describe("Music ducking under speech."),
  voice: z
    .strictObject({
      highpass: z.number().min(20).max(300).describe("High-pass cutoff, Hz."),
      denoise: z
        .strictObject({
          floor: z.number().min(-80).max(-20).describe("Noise floor, dBFS."),
          reduction: z.number().min(0).max(97).describe("Noise reduction, dB."),
        })
        .describe("Noise reduction."),
      compressor: z
        .strictObject({
          threshold: z.number().min(-60).max(0).describe("Threshold, dBFS."),
          ratio: z.number().min(1).max(20).describe("Ratio, e.g. 2.5 for 2.5:1."),
          attack: Seconds("Attack.", 1),
          release: Seconds("Release.", 5),
          makeup: z.number().min(0).max(24).describe("Makeup gain, dB."),
        })
        .describe("Compressor."),
    })
    .describe("Voice chain defaults; an effect set on a clip overrides them."),
});

/** Glass cards (ADR 0031): a style choice, never a default (HyperFrames lists glass cards everywhere among AI-looking defaults). */
export const StyleGlassSchema = z
  .strictObject({
    cards: z
      .boolean()
      .describe("True: cards over the picture are glass in this style (`clip set --glass` on each). False: solid cards. Default false."),
    blur: z.number().min(BACKDROP_LIMITS.blur.min).max(BACKDROP_LIMITS.blur.max).describe("Backdrop blur, Gaussian sigma in project pixels."),
    saturate: z.number().min(BACKDROP_LIMITS.saturate.min).max(BACKDROP_LIMITS.saturate.max).describe("Backdrop saturation, 1 unchanged."),
    dim: z
      .number()
      .min(BACKDROP_LIMITS.dim.min)
      .max(BACKDROP_LIMITS.dim.max)
      .describe("Dark scrim over the blurred backdrop, 0 to 1: 0.55, up to 0.72 over bright footage."),
  })
  .describe("Glass cards: the backdrop `clip set --glass` copies onto a generated clip.");

/** Every value of a style, all present: defaults and the personality with `style.json` on top. */
export const StyleValuesSchema = z.strictObject({
  brand: StyleBrandSchema,
  colors: StyleColorsSchema,
  fonts: StyleFontsSchema,
  type: StyleTypeSchema,
  motion: StyleMotionValuesSchema.extend({
    personality: z.enum(MOTION_PERSONALITY_IDS).describe("Motion personality the motion values start from."),
  }),
  sound: StyleSoundSchema,
  glass: StyleGlassSchema,
  platforms: z
    .array(z.enum(PLATFORM_IDS))
    .describe("Platforms the videos go to, each once; their safe zones are Frameshell's data, named, never copied."),
  notes: Words("House notes in the person's words."),
  rules: Words("Rules every video keeps, in the person's words (e.g. `sentence case`)."),
  banned: Words("Things never to do again, from critique (e.g. `emoji in captions`)."),
});

/** See {@link StyleValuesSchema}. */
export type StyleValues = z.output<typeof StyleValuesSchema>;

const partial = <T extends z.ZodObject>(schema: T) => schema.partial().optional();

/**
 * Zod model of `style.json` (ADR 0028): a motion personality plus the values that differ from it and
 * from the defaults. Objects merge field by field; a font, a colour or a list replaces the whole value.
 * Unknown keys are rejected so typos surface.
 */
export const StyleFileSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  from: z
    .strictObject({
      id: z.string().trim().min(1).describe("User style id."),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex digits").describe("SHA-256 of the user style when copied."),
    })
    .optional()
    .describe("User style this file was copied from; nothing is inherited from it afterwards."),
  brand: partial(StyleBrandSchema),
  colors: partial(StyleColorsSchema),
  fonts: partial(StyleFontsSchema),
  type: partial(StyleTypeSchema),
  motion: z
    .strictObject({
      personality: z
        .enum(MOTION_PERSONALITY_IDS)
        .optional()
        .describe(`Motion values to start from: ${MOTION_PERSONALITY_IDS.map((id) => `\`${id}\``).join(", ")}. Default \`${DEFAULT_MOTION_PERSONALITY}\`.`),
      duration: partial(StyleMotionValuesSchema.shape.duration),
      ease: StyleMotionValuesSchema.shape.ease.optional(),
      overshoot: StyleMotionValuesSchema.shape.overshoot.optional(),
      spring: partial(StyleMotionValuesSchema.shape.spring),
      stagger: StyleMotionValuesSchema.shape.stagger.optional(),
      exit: StyleMotionValuesSchema.shape.exit.optional(),
      highlight: StyleMotionValuesSchema.shape.highlight.optional(),
    })
    .optional(),
  sound: z
    .strictObject({
      musicUnderVoice: StyleSoundSchema.shape.musicUnderVoice.optional(),
      sfxUnderVoice: StyleSoundSchema.shape.sfxUnderVoice.optional(),
      duck: partial(StyleSoundSchema.shape.duck),
      voice: z
        .strictObject({
          highpass: StyleSoundSchema.shape.voice.shape.highpass.optional(),
          denoise: partial(StyleSoundSchema.shape.voice.shape.denoise),
          compressor: partial(StyleSoundSchema.shape.voice.shape.compressor),
        })
        .optional(),
    })
    .optional(),
  glass: partial(StyleGlassSchema),
  platforms: StyleValuesSchema.shape.platforms
    .refine((ids) => new Set(ids).size === ids.length, "must name each platform once")
    .optional(),
  notes: StyleValuesSchema.shape.notes.optional(),
  rules: StyleValuesSchema.shape.rules.optional(),
  banned: StyleValuesSchema.shape.banned.optional(),
});

/** See {@link StyleFileSchema}. */
export type StyleFile = z.output<typeof StyleFileSchema>;

// Duration ranges and premium's quick/standard/slow palette are LottieFiles' motion-design numbers (#468);
// the other palettes take their range's low end, middle and high end. Overshoot ceilings come from the same
// source (playful: the 20 % of #465's playful spring). Eases, springs and staggers are picked from #465's
// curves, spring presets and stagger budgets: starting points, tuned per project in `style.json`.
/** Motion values of every personality. */
export const MOTION_PERSONALITIES: Readonly<Record<MotionPersonalityId, StyleMotionValues>> = {
  /** 150-300 ms, a visible bounce. */
  playful: {
    duration: { quick: 0.15, standard: 0.225, slow: 0.3 },
    ease: [...EASE_CURVES["out-back"]],
    overshoot: 0.2,
    spring: { ...SPRING_PRESETS.playful },
    stagger: 0.06,
    exit: 0.7,
    highlight: true,
  },
  /** 350-600 ms, no overshoot, long settling tails. */
  premium: {
    duration: { quick: 0.35, standard: 0.5, slow: 0.8 },
    ease: [...EASE_CURVES["out-quint"]],
    overshoot: 0,
    spring: { ...SPRING_PRESETS.heavy },
    stagger: 0.08,
    exit: 0.7,
    highlight: true,
  },
  /** 200-400 ms, at most 3 % overshoot. */
  corporate: {
    duration: { quick: 0.2, standard: 0.3, slow: 0.4 },
    ease: [...EASE_CURVES["out-expo"]],
    overshoot: 0.03,
    spring: { ...SPRING_PRESETS.default },
    stagger: 0.05,
    exit: 0.7,
    highlight: true,
  },
  /** 100-250 ms snaps, 15-30 % overshoot. */
  energetic: {
    duration: { quick: 0.1, standard: 0.175, slow: 0.25 },
    ease: [...EASE_CURVES["out-expo"]],
    overshoot: 0.3,
    // Snappy's response with playful's bounce: no preset has this pair.
    spring: { response: 0.22, damping: 0.45 },
    stagger: 0.03,
    exit: 0.7,
    highlight: true,
  },
  /** Premium's timing with no bounce and no keyword highlight, for those who find both machine-made. */
  calm: {
    duration: { quick: 0.35, standard: 0.5, slow: 0.8 },
    ease: [...EASE_CURVES["out-quint"]],
    overshoot: 0,
    spring: { ...SPRING_PRESETS.heavy },
    stagger: 0.1,
    exit: 0.7,
    highlight: false,
  },
};

// Type sizes are the floors seen in every source of #468 at 1080p; sound levels are #456 (music, ducking as
// `duck` does), #463 (effects) and #464 (voice chain).
/** Values that apply where neither `style.json` nor the personality sets one. Null: not decided. */
export const STYLE_DEFAULTS: Readonly<Omit<StyleValues, "motion">> = {
  brand: { product: null, url: null, promise: null, hook: null, cta: null, audience: null, reference: null, mustShow: [], mustAvoid: [] },
  colors: { bg: null, ink: null, ink2: null, accent: null, card: null, keyword: null, highlight: null },
  fonts: { display: null, ui: null, captions: null, keyword: null },
  type: { hero: 200, card: 110, minReadable: 28, margin: 120 },
  sound: {
    musicUnderVoice: 12,
    sfxUnderVoice: 20,
    duck: { depth: 7, attack: 0.04, release: 0.45 },
    voice: {
      highpass: 85,
      denoise: { floor: -30, reduction: 8 },
      compressor: { threshold: -20, ratio: 2.5, attack: 0.008, release: 0.14, makeup: 2 },
    },
  },
  glass: { cards: false, ...GLASS },
  platforms: [],
  notes: [],
  rules: [],
  banned: [],
};

/** Where a resolved style value comes from. */
export const STYLE_SOURCES = ["file", "personality", "default"] as const;

/** One of {@link STYLE_SOURCES}: written in `style.json`, from its motion personality, or Frameshell's default. */
export type StyleSource = (typeof STYLE_SOURCES)[number];

/** A resolved value and where it comes from. */
export interface Sourced<T> {
  value: T;
  source: StyleSource;
}

type IsBranch<T> = [T] extends [readonly unknown[]] ? false : [null] extends [T] ? false : [T] extends [Record<string, unknown>] ? true : false;

/** `T` with every leaf (number, string, list, colour, font) a {@link Sourced} value. */
export type SourcedTree<T> = { [K in keyof T]: IsBranch<T[K]> extends true ? SourcedTree<T[K]> : Sourced<T[K]> };

/** Every style value with its source, as `resolveStyle` returns it. */
export type ResolvedStyle = SourcedTree<StyleValues>;

const StyleSourceSchema = z
  .enum(STYLE_SOURCES)
  .describe("`file`: written in style.json. `personality`: from the motion personality it picks. `default`: Frameshell's (null = not decided, ask the person).");

function sourcedSchema(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodObject)) return z.object({ value: schema, source: StyleSourceSchema });
  return z.object(Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, inner]) => [key, sourcedSchema(inner)])));
}

/**
 * The voice chain a style asks for (`sound.voice`, ADR 0028), as the explicit entries `clip set --voice` writes
 * (ADR 0031): style seconds become effect milliseconds and every number is held to the effect's range. A
 * noise reduction of 0 leaves the `denoise` entry out. The default style gives `VOICE_CHAIN`.
 */
export function voiceChainOf(voice: ResolvedStyle["sound"]["voice"]): NormalizedAudioEffect[] {
  const limits = AUDIO_EFFECT_LIMITS;
  const fit = ({ min, max }: { min: number; max: number }, value: number) => Math.min(max, Math.max(min, Math.round(value * 1e6) / 1e6));
  const chain: NormalizedAudioEffect[] = [{ kind: "highpass", frequency: fit(limits.highpass.frequency, voice.highpass.value) }];
  if (voice.denoise.reduction.value > 0) {
    chain.push({
      kind: "denoise",
      floor: fit(limits.denoise.floor, voice.denoise.floor.value),
      reduction: fit(limits.denoise.reduction, voice.denoise.reduction.value),
    });
  }
  const compressor = voice.compressor;
  chain.push({
    kind: "compressor",
    threshold: fit(limits.compressor.threshold, compressor.threshold.value),
    ratio: fit(limits.compressor.ratio, compressor.ratio.value),
    attack: fit(limits.compressor.attack, compressor.attack.value * 1000),
    release: fit(limits.compressor.release, compressor.release.value * 1000),
    makeup: fit(limits.compressor.makeup, compressor.makeup.value),
  });
  return chain;
}

/** The backdrop a style's glass asks for (`glass`), as the explicit numbers `clip set --glass` writes (ADR 0031). */
export function glassOf(glass: ResolvedStyle["glass"]): Required<Backdrop> {
  return { blur: glass.blur.value, saturate: glass.saturate.value, dim: glass.dim.value };
}

/** Zod model of {@link ResolvedStyle}: {@link StyleValuesSchema} with `{ value, source }` at every leaf. */
export const ResolvedStyleSchema = sourcedSchema(StyleValuesSchema) as unknown as z.ZodType<ResolvedStyle>;

/** Validate parsed `style.json` content. */
export function parseStyleFile(value: unknown): ParseResult<StyleFile> {
  const result = StyleFileSchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

/**
 * Every style value with its source: Frameshell's defaults, the motion values of the file's personality
 * (else {@link DEFAULT_MOTION_PERSONALITY}), then the file's fields on top. Objects merge field by field;
 * a list, a colour or a font replaces the whole value.
 */
export function resolveStyle(file: StyleFile | null): ResolvedStyle {
  const personality = file?.motion?.personality;
  const motionSource: StyleSource = personality === undefined ? "default" : "personality";
  const resolved = {
    brand: overlay(STYLE_DEFAULTS.brand, file?.brand, "default"),
    colors: overlay(STYLE_DEFAULTS.colors, file?.colors, "default"),
    fonts: overlay(STYLE_DEFAULTS.fonts, file?.fonts, "default"),
    type: overlay(STYLE_DEFAULTS.type, file?.type, "default"),
    motion: {
      personality: personality === undefined ? { value: DEFAULT_MOTION_PERSONALITY, source: "default" } : { value: personality, source: "file" },
      ...overlay(MOTION_PERSONALITIES[personality ?? DEFAULT_MOTION_PERSONALITY], file?.motion, motionSource),
    },
    sound: overlay(STYLE_DEFAULTS.sound, file?.sound, "default"),
    glass: overlay(STYLE_DEFAULTS.glass, file?.glass, "default"),
    ...overlay({ platforms: STYLE_DEFAULTS.platforms, notes: STYLE_DEFAULTS.notes, rules: STYLE_DEFAULTS.rules, banned: STYLE_DEFAULTS.banned }, file ?? undefined, "default"),
  };
  return resolved as ResolvedStyle;
}

/** `base` with every leaf sourced `source`, then the defined fields of `given` on top, sourced `file`. */
function overlay(base: object, given: object | undefined, source: StyleSource): Record<string, unknown> {
  const fields = (given ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => {
      const set = fields[key];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return [key, overlay(value, set as object | undefined, source)];
      return [key, set === undefined ? { value: structuredClone(value), source } : { value: structuredClone(set), source: "file" }];
    }),
  );
}

/**
 * Dotted path of every value `style.json` sets on its own, in schema order (`colors.accent`,
 * `motion.duration.quick`, `fonts.display`): what `style set` takes and what review mode keys by (ADR 0036
 * decision 6). A font, a colour, an ease and a list are one value each; `from` is not a path.
 */
export const STYLE_PATHS: readonly string[] = leafPaths(resolveStyle(null) as unknown as Record<string, unknown>, []);

/** Folder of the user styles under `configDir` (ADR 0028 decision 1): one `<id>.json` each, in this schema. */
export const USER_STYLES_DIR = "styles";

/** Id of a user style: its file name without `.json`. Lowercase, so ids never clash on case-insensitive disks. */
export const UserStyleIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "must be 1 to 64 lowercase letters, digits, `-` or `_`, starting with a letter or digit")
  .describe("User style id, e.g. `acme`: lowercase letters, digits, `-`, `_` (at most 64).");

function leafPaths(node: Record<string, unknown>, at: string[]): string[] {
  return Object.entries(node).flatMap(([key, child]) => {
    const path = [...at, key];
    const leaf = typeof child === "object" && child !== null && "value" in child && "source" in child;
    return leaf ? [path.join(".")] : leafPaths(child as Record<string, unknown>, path);
  });
}
