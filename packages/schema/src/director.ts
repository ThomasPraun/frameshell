import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { SHOT_CORNERS } from "./timeline.js";

/** Canonical `$schema` URL for a project's `director.json`. */
export const DIRECTOR_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/director.json`;

/** Project-relative path of the director rules `frameshell direct` reads by default. */
export const DIRECTOR_FILE = "director.json";

/** Rule sets `frameshell direct` ships (ADR 0016 decision 4). */
export const DIRECTOR_TEMPLATE_IDS = ["interview", "podcast-calm", "panel-dynamic"] as const;

/** One of {@link DIRECTOR_TEMPLATE_IDS}. */
export type DirectorTemplateId = (typeof DIRECTOR_TEMPLATE_IDS)[number];

/** Template used when neither the call nor `director.json` names one. */
export const DEFAULT_DIRECTOR_TEMPLATE: DirectorTemplateId = "interview";

const Seconds = (what: string) => z.number().nonnegative().describe(`${what} Seconds.`);
/** A rule a file may switch off with null. */
const Rule = (what: string) => Seconds(`${what} Null switches the rule off.`).nullable();

/** When two people share the picture (`two-up`). */
export const DirectorTwoShotSchema = z.strictObject({
  exchange: Rule(
    "Quick exchange: three or more turns in a row alternating between the same two people, each shorter than this, become one two-up.",
  ),
  overlap: Rule("Two people talking at once for at least this long get a two-up; shorter overlaps keep the shot that was on."),
});

/** When the picture goes wide (`grid` of every angle with a picture). */
export const DirectorWideSchema = z.strictObject({
  silence: Rule("Nobody speaking for at least this long goes wide; shorter pauses keep the shot that was on."),
  laughter: Rule(
    "Laughter or cross-talk: `together` or more people talking at once for at least this long goes wide (shorter: two-up rules apply).",
  ),
  together: z
    .int()
    .min(2)
    .describe("People talking at once that count as laughter; capped at the group's angles with a picture, so everyone in a group of two."),
});

/** What a solo shot longer than `maxShot` cuts away to. */
export const DirectorCutawaySchema = z.strictObject({
  to: z
    .enum(["listener", "wide"])
    .describe("`listener`: a solo of the listener with the highest weight (a reaction shot); `wide`: a grid of every angle."),
  length: z.number().positive().describe("Seconds the cutaway lasts before the picture returns to the speaker."),
});

/** When a screen angle (`angle.screen`) takes the picture. */
export const DirectorScreenSchema = z.strictObject({
  motion: Rule(
    "A screen angle that changes for at least this long (a slide, a scroll, a demo) is shown: `screen` while nobody speaks, " +
      "`pip` (screen with the speaker in an inset) while someone does. Null switches the rule off.",
  ),
  hold: Seconds("Pauses in a screen's motion shorter than this stay inside the stretch, so a still moment mid-demo does not cut away."),
  threshold: z
    .number()
    .positive()
    .describe("How much of the picture must change to count as motion: mean brightness change between two samples (4 per second), 0 to 255."),
  pip: z.boolean().describe("False: show the screen alone, never with an inset."),
  corner: z.enum(SHOT_CORNERS).describe("Corner of the inset in `pip` shots."),
});

/**
 * Every rule the director applies, all fields present (a template, or a
 * template with `director.json` on top). Times are seconds.
 */
export const DirectorRulesSchema = z.strictObject({
  minShot: Seconds("Shortest shot: a shorter one (a quick interjection) merges into the shot before it, so the voice plays over that picture."),
  maxShot: z
    .number()
    .positive()
    .nullable()
    .describe("Longest solo, seconds: a solo held longer gets a cutaway (see `cutaway`) every this many seconds. Null switches the rule off."),
  cutLead: Seconds(
    "J-cut: the new speaker's voice leads the picture by this long, so a cut to a speaker lands this far into their turn. 0 cuts on the first word.",
  ),
  twoShot: DirectorTwoShotSchema,
  wide: DirectorWideSchema,
  cutaway: DirectorCutawaySchema,
  screen: DirectorScreenSchema,
  weights: z
    .record(z.string().min(1), z.number().nonnegative())
    .describe(
      "Weight per angle id, default 1: who the picture favours when the rules must pick (the two-up pair among more people " +
        "talking at once, the listener of a cutaway). 0: never shown alone or in a two-up (wide shots still show them); their " +
        "turns keep the shot that was on.",
    ),
});

/** See {@link DirectorRulesSchema}. */
export type DirectorRules = z.output<typeof DirectorRulesSchema>;

/**
 * Zod model of `director.json` (ADR 0016 decision 4): a template plus the
 * rules that differ from it. Objects merge field by field over the template;
 * `weights` merge per angle. Unknown keys are rejected so typos surface.
 */
export const DirectorFileSchema = z.strictObject({
  $schema: z.string().optional(),
  template: z
    .enum(DIRECTOR_TEMPLATE_IDS)
    .optional()
    .describe("Rule set to start from: `interview`, `podcast-calm` or `panel-dynamic`. Default `interview`."),
  minShot: DirectorRulesSchema.shape.minShot.optional(),
  maxShot: DirectorRulesSchema.shape.maxShot.optional(),
  cutLead: DirectorRulesSchema.shape.cutLead.optional(),
  twoShot: DirectorTwoShotSchema.partial().optional(),
  wide: DirectorWideSchema.partial().optional(),
  cutaway: DirectorCutawaySchema.partial().optional(),
  screen: DirectorScreenSchema.partial().optional(),
  weights: DirectorRulesSchema.shape.weights.optional(),
});

/** See {@link DirectorFileSchema}. */
export type DirectorFile = z.output<typeof DirectorFileSchema>;

// Starting points, not measured values: projects tune them in `director.json`.
/** Every template's rules. */
export const DIRECTOR_TEMPLATES: Readonly<Record<DirectorTemplateId, DirectorRules>> = {
  /** Two or three people, one asking: long solos on answers, few two-shots. */
  interview: {
    minShot: 2.5,
    maxShot: 20,
    cutLead: 0.3,
    twoShot: { exchange: 1.5, overlap: 1.5 },
    wide: { silence: 4, laughter: 1.5, together: 3 },
    cutaway: { to: "listener", length: 3 },
    screen: { motion: 3, hold: 2, threshold: 0.3, pip: true, corner: "bottom-right" },
    weights: {},
  },
  /** A relaxed conversation: long holds, slow cuts, two-shots on banter. */
  "podcast-calm": {
    minShot: 4,
    maxShot: 30,
    cutLead: 0.4,
    twoShot: { exchange: 2.5, overlap: 1 },
    wide: { silence: 3, laughter: 1, together: 3 },
    cutaway: { to: "wide", length: 4 },
    screen: { motion: 4, hold: 3, threshold: 0.3, pip: true, corner: "bottom-right" },
    weights: {},
  },
  /** Several people trading quickly: short shots, quick cuts, frequent reactions. */
  "panel-dynamic": {
    minShot: 1.5,
    maxShot: 10,
    cutLead: 0.15,
    twoShot: { exchange: 2, overlap: 0.6 },
    wide: { silence: 2.5, laughter: 0.8, together: 3 },
    cutaway: { to: "listener", length: 2 },
    screen: { motion: 2, hold: 1.5, threshold: 0.3, pip: true, corner: "bottom-right" },
    weights: {},
  },
};

/** Validate parsed `director.json` content. */
export function parseDirectorFile(value: unknown): ParseResult<DirectorFile> {
  const result = DirectorFileSchema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

/**
 * Rules of template `template` (else the file's, else {@link DEFAULT_DIRECTOR_TEMPLATE})
 * with `file`'s fields on top: objects merge field by field, `weights` per angle.
 */
export function resolveDirectorRules(file: DirectorFile | null, template?: DirectorTemplateId): { template: DirectorTemplateId; rules: DirectorRules } {
  const id = template ?? file?.template ?? DEFAULT_DIRECTOR_TEMPLATE;
  const base = structuredClone(DIRECTOR_TEMPLATES[id]);
  if (!file) return { template: id, rules: base };
  const defined = <T extends object>(value: { [K in keyof T]?: T[K] | undefined } | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(value ?? {}).filter(([, inner]) => inner !== undefined)) as Partial<T>;
  const rules: DirectorRules = {
    minShot: file.minShot ?? base.minShot,
    maxShot: file.maxShot === undefined ? base.maxShot : file.maxShot,
    cutLead: file.cutLead ?? base.cutLead,
    twoShot: { ...base.twoShot, ...defined<DirectorRules["twoShot"]>(file.twoShot) },
    wide: { ...base.wide, ...defined<DirectorRules["wide"]>(file.wide) },
    cutaway: { ...base.cutaway, ...defined<DirectorRules["cutaway"]>(file.cutaway) },
    screen: { ...base.screen, ...defined<DirectorRules["screen"]>(file.screen) },
    weights: { ...base.weights, ...file.weights },
  };
  return { template: id, rules };
}
