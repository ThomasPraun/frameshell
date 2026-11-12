import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { FormatIdSchema } from "./formats.js";

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

/** What a slot points at, as {@link parseSlotTarget} splits it. */
export type SlotTarget = { clip: string; kind: "asset" } | { clip: string; kind: "props"; path: string[] };

const SLOT_PATTERN = /^([^.\s]+)\.(?:(asset)|props\.([^.\s]+(?:\.[^.\s]+)*))$/;

/** `<clipId>.asset` or `<clipId>.props.<dot.path>` split into its parts; null when it is neither. */
export function parseSlotTarget(slot: string): SlotTarget | null {
  const match = SLOT_PATTERN.exec(slot);
  if (!match) return null;
  return match[2] ? { clip: match[1]!, kind: "asset" } : { clip: match[1]!, kind: "props", path: match[3]!.split(".") };
}

const SlotSchema = z
  .string()
  .regex(SLOT_PATTERN, "must be `<clipId>.asset` or `<clipId>.props.<path>`, e.g. `c_8f2a1b.props.title`")
  .refine(
    (slot) => {
      const target = parseSlotTarget(slot);
      return target?.kind !== "props" || !target.path.some((key) => PROTOTYPE_KEYS.has(key));
    },
    { message: "a props path may not use `__proto__`, `prototype` or `constructor`" },
  )
  .describe("`<clipId>.props.<dot.path>` (a value written at that path of an adapter clip's props) or `<clipId>.asset` (a media clip's asset).");

/** One row: its `id` and a value per slot it sets; a slot it leaves out keeps the template's value. */
export const BatchRowSchema = z
  .object({ id: BatchRowIdSchema })
  .catchall(z.unknown())
  .describe("`id` plus one value per slot it sets, e.g. `{ \"id\": \"es\", \"title\": \"Hola\", \"voice\": \"assets/vo-es.wav\" }`.");

/**
 * Zod model of a batch file (`*.batch.json`, ADR 0040): a template timeline of the project, named slots into its
 * clips, and rows of slot values. Each row renders the template patched in memory, never written to `timelines/`.
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
      .describe("Slot name → what it sets: `<clipId>.props.<dot.path>` or `<clipId>.asset`."),
    rows: z.array(BatchRowSchema).min(1).describe("One render per row (times each format), in order."),
    formats: z.array(FormatIdSchema).min(1).optional().describe("Formats of the project each row renders in (`format.list`); default the primary only."),
    preset: z.string().min(1).optional().describe("Export preset id; default the project's `export.defaultPreset`, else the built-in default."),
    quality: z.enum(["draft", "final"]).optional().describe("Quality tier, as `render` takes it."),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.rows.forEach((row, index) => {
      if (seen.has(row.id)) ctx.addIssue({ code: "custom", message: `row id ${row.id} is used twice; ids name output files`, path: ["rows", index, "id"] });
      seen.add(row.id);
      for (const [key, value] of Object.entries(row)) {
        if (key === "id") continue;
        const slot = file.slots[key];
        if (slot === undefined) {
          ctx.addIssue({ code: "custom", message: `unknown slot ${key}; slots: ${Object.keys(file.slots).join(", ")}`, path: ["rows", index, key] });
        } else if (parseSlotTarget(slot)?.kind === "asset" && (typeof value !== "string" || value.trim() === "")) {
          ctx.addIssue({ code: "custom", message: "an asset slot takes a project-relative path, e.g. `assets/vo-es.wav`", path: ["rows", index, key] });
        }
      }
    });
  });

/** Validated batch file. */
export type BatchFile = z.infer<typeof BatchFileSchema>;

/** One row of a {@link BatchFile}. */
export type BatchRow = z.infer<typeof BatchRowSchema>;

/** Validate unknown input as a batch file. Never throws. */
export function parseBatchFile(input: unknown): ParseResult<BatchFile> {
  const result = BatchFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
