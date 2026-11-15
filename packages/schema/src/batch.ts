import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { FormatIdSchema } from "./formats.js";
import { VOICEOVER_TEMPO_RANGE } from "./script.js";

/** Canonical `$schema` URL for `*.batch.json`. */
export const BATCH_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/batch.json`;

/** Row id: a file name of the batch's outputs, so lowercase letters, digits and `-` only. */
export const BatchRowIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be lowercase letters, digits and `-`, up to 64, e.g. `es` or `product-12`")
  .describe("Row id, used as the output file name: lowercase letters, digits and `-`, up to 64, e.g. `es` or `product-12`.");

/**
 * Keys a slot name or props path may not use: on a plain object they reach `Object.prototype` (pollution of the
 * long-lived daemon) or inherited members rather than own data.
 */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Slot name: the key rows set, never `id`. */
const SlotNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, "must start with a letter or `_` and hold letters, digits, `_` and `-`, e.g. `title`")
  .refine((name) => name !== "id", { message: "`id` is the row id, not a slot" })
  .refine((name) => !PROTOTYPE_KEYS.has(name), { message: "`__proto__`, `prototype` and `constructor` are not slot names" });

/** The slot target that places a row's voiceover as `voiceover.place` does (ADR 0040); it names no clip. */
export const VOICEOVER_SLOT = "voiceover";

/** What a slot points at, as {@link parseSlotTarget} splits it. */
export type SlotTarget = { clip: string; kind: "asset" } | { clip: string; kind: "props"; path: string[] } | { kind: "voiceover" };

const SLOT_PATTERN = /^([^.\s]+)\.(?:(asset)|props(?:\.([^.\s]+(?:\.[^.\s]+)*))?)$/;

/**
 * `<clipId>.asset`, `<clipId>.props.<dot.path>`, `<clipId>.props` or `voiceover` split into its parts; null when it is
 * none of them. The `props` form with no path names no path: the prop is the slot's own name, so `name` (the slot's)
 * becomes the path.
 */
export function parseSlotTarget(slot: string, name: string): SlotTarget | null {
  if (slot === VOICEOVER_SLOT) return { kind: "voiceover" };
  const match = SLOT_PATTERN.exec(slot);
  if (!match) return null;
  if (match[2]) return { clip: match[1]!, kind: "asset" };
  return { clip: match[1]!, kind: "props", path: match[3] === undefined ? [name] : match[3].split(".") };
}

/** A time as `voiceover.place` takes it: seconds, a marker id or label (`hook`, `hook+0.5`), `beat:N` or `bar:N`. */
const TimeRefValue = z.union([z.number().nonnegative(), z.string().min(1)]);

/**
 * A row's voiceover as an object: the script and the `voiceover.place` arguments that make sense per row (the
 * timeline is the template, `dryRun` has no meaning). The takes of the script must exist already: batch never
 * generates.
 */
export const BatchVoiceoverSchema = z.strictObject({
  script: z.string().min(1).describe("Voiceover script of the project (`voiceover: true`), project-relative, e.g. `scripts/launch-es.md`."),
  lines: z.array(z.string().min(1)).min(1).optional().describe("Line ids to place; default every line."),
  at: z.record(z.string().min(1), TimeRefValue).optional().describe("Where lines or phrases go, as `voiceover.place` `at`."),
  tempo: z
    .record(z.string().min(1), z.number().min(VOICEOVER_TEMPO_RANGE.min).max(VOICEOVER_TEMPO_RANGE.max))
    .optional()
    .describe("Speed of single phrases, as `voiceover.place` `tempo`."),
  start: TimeRefValue.optional().describe("Time of the first line that has no `at`; default right after the last clip of the voice track, else 0."),
  gap: z.number().min(0).max(30).optional().describe("Seconds of air between lines that have no `at`; default 0.4."),
  track: z.string().min(1).optional().describe("Audio track id of the template for the voice; default the track named `Voiceover`, made when absent."),
  replace: z.boolean().optional().describe("Remove the template's clips that already play these lines' takes first."),
});

/** A row's value for a `voiceover` slot: the script path, or the script with placement arguments. */
export const BatchVoiceoverValueSchema = z.union([z.string().min(1), BatchVoiceoverSchema]);

/** {@link BatchVoiceoverSchema}: the object form of a row's voiceover. */
export type BatchVoiceover = z.infer<typeof BatchVoiceoverSchema>;

/** A row's `voiceover` slot value as the object form (a string is the script). Throws when it is neither; {@link batchRowIssues} checks first. */
export function voiceoverOf(value: unknown): BatchVoiceover {
  const parsed = BatchVoiceoverValueSchema.parse(value);
  return typeof parsed === "string" ? { script: parsed } : parsed;
}

const SlotSchema = z
  .string()
  .refine((slot) => slot === VOICEOVER_SLOT || SLOT_PATTERN.test(slot), {
    message: "must be `<clipId>.asset`, `<clipId>.props.<path>`, `<clipId>.props` or `voiceover`, e.g. `c_8f2a1b.props.title`",
  })
  .refine(
    (slot) => {
      // The slot's name is the path of the bare `<clipId>.props` form, and slot names are checked on their own.
      const target = parseSlotTarget(slot, "name");
      return target?.kind !== "props" || !target.path.some((key) => PROTOTYPE_KEYS.has(key));
    },
    { message: "a props path may not use `__proto__`, `prototype` or `constructor`" },
  )
  .describe(
    "`<clipId>.props.<dot.path>` (a value written at that path of an adapter clip's props), `<clipId>.props` (the prop named like the slot: " +
      "`\"title\": \"c_8f2a1b.props\"` is `c_8f2a1b.props.title`), `<clipId>.asset` (a media clip's asset) or `voiceover` " +
      "(the row's value is a voiceover script whose takes are placed as phrase clips, or `{ script, lines, at, tempo, start, gap, track, replace }`).",
  );

/** One row: its `id` and a value per slot it sets; a slot it leaves out keeps the template's value. */
export const BatchRowSchema = z
  .object({ id: BatchRowIdSchema })
  .catchall(z.unknown())
  .describe("`id` plus one value per slot it sets, e.g. `{ \"id\": \"es\", \"title\": \"Hola\", \"voice\": \"assets/vo-es.wav\" }`.");

/**
 * Zod model of a batch file (`*.batch.json`, ADR 0040): a template timeline of the project, named slots into its
 * clips, and rows of slot values, written in the file (`rows`) or in a CSV file next to it (`csv`). Each row renders
 * the template patched in memory, never written to `timelines/`.
 */
export const BatchFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    template: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a timeline id like `main` (file `timelines/<id>.json`)")
      .default("main")
      .describe("Timeline id the rows patch; default `main`. A single generated clip is a timeline holding that one clip."),
    slots: z
      .record(SlotNameSchema, SlotSchema)
      .refine((slots) => Object.keys(slots).length > 0, { message: "must name at least one slot" })
      .refine((slots) => Object.values(slots).filter((target) => target === VOICEOVER_SLOT).length <= 1, { message: "at most one slot may be `voiceover`" })
      .describe(
        "Slot name → what it sets: `<clipId>.props.<dot.path>`, `<clipId>.props` (the prop named like the slot), `<clipId>.asset` or `voiceover`.",
      ),
    rows: z.array(BatchRowSchema).min(1).optional().describe("One render per row (times each format), in order. Give `rows` or `csv`, not both."),
    csv: z
      .string()
      .min(1)
      .optional()
      .describe(
        "CSV file with the rows instead of `rows`, relative to this file's folder: a header of `id` and slot names (`price:number` types a column: " +
          "`text`, `number`, `boolean`, `json`; otherwise the type of the template's value), one row per line, an empty cell leaves the slot to the template.",
      ),
    formats: z.array(FormatIdSchema).min(1).optional().describe("Formats of the project each row renders in (`format.list`); default the primary only."),
    preset: z.string().min(1).optional().describe("Export preset id; default the project's `export.defaultPreset`, else the built-in default."),
    quality: z.enum(["draft", "final"]).optional().describe("Quality tier, as `render` takes it."),
  })
  .superRefine((file, ctx) => {
    if ((file.rows === undefined) === (file.csv === undefined)) {
      ctx.addIssue({ code: "custom", message: "give `rows` (the rows in this file) or `csv` (a CSV file with them), not both and not neither", path: [file.rows === undefined ? "rows" : "csv"] });
    }
    if (file.rows) {
      for (const issue of batchRowIssues(file.slots, file.rows)) ctx.addIssue({ code: "custom", message: issue.message, path: ["rows", ...issue.path] });
    }
  });

/** Validated batch file; `rows` or `csv` is set, and {@link ResolvedBatchFile} once a `csv` was read. */
export type BatchFile = z.infer<typeof BatchFileSchema>;

/** A batch file with its rows in hand, whether they were written in it or read from its `csv`. */
export type ResolvedBatchFile = Omit<BatchFile, "rows" | "csv"> & { rows: BatchRow[] };

/** One row of a {@link BatchFile}. */
export type BatchRow = z.infer<typeof BatchRowSchema>;

/**
 * What is wrong with `rows` as rows of a batch with `slots`: a row id used twice, a value for a slot the file does not
 * declare, an asset slot without a path, a voiceover that is neither a script path nor a valid object. Paths start at
 * the row's index.
 */
export function batchRowIssues(slots: Readonly<Record<string, string>>, rows: readonly BatchRow[]): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (seen.has(row.id)) issues.push({ path: [index, "id"], message: `row id ${row.id} is used twice; ids name output files` });
    seen.add(row.id);
    for (const [key, value] of Object.entries(row)) {
      if (key === "id") continue;
      const slot = slots[key];
      if (slot === undefined) {
        issues.push({ path: [index, key], message: `unknown slot ${key}; slots: ${Object.keys(slots).join(", ")}` });
        continue;
      }
      const kind = parseSlotTarget(slot, key)?.kind;
      if (kind === "asset" && (typeof value !== "string" || value.trim() === "")) {
        issues.push({ path: [index, key], message: "an asset slot takes a project-relative path, e.g. `assets/vo-es.wav`" });
      } else if (kind === "voiceover") {
        const parsed = BatchVoiceoverValueSchema.safeParse(value);
        if (!parsed.success) {
          issues.push({ path: [index, key], message: `a voiceover slot takes a voiceover script path or { script, lines, at, tempo, start, gap, track, replace }: ${formatIssues(parsed.error)}` });
        }
      }
    }
  });
  return issues;
}

/** `file` with `rows` in place of its `csv`, the rows checked as {@link batchRowIssues} says. Never throws. */
export function withRows(file: BatchFile, rows: readonly BatchRow[]): ParseResult<ResolvedBatchFile> {
  const issues = batchRowIssues(file.slots, rows);
  if (rows.length === 0) issues.unshift({ path: [], message: "has no rows" });
  if (issues.length > 0) return { ok: false, error: issues.map((issue) => `${["rows", ...issue.path].join(".")}: ${issue.message}`).join("\n") };
  const { csv: _csv, rows: _rows, ...rest } = file;
  return { ok: true, value: { ...rest, rows: [...rows] } };
}

/** Validate unknown input as a batch file. Never throws. */
export function parseBatchFile(input: unknown): ParseResult<BatchFile> {
  const result = BatchFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
