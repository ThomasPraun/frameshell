import { z } from "zod";

/** Project-config document a config operation changes (ADR 0036). `project`: `formats` of `frameshell.json`. */
export const ConfigDocSchema = z.enum(["project"]).describe("Config document changed: `project` = `formats` of `frameshell.json`.");

/** See {@link ConfigDocSchema}. */
export type ConfigDoc = z.output<typeof ConfigDocSchema>;

/**
 * One key a config operation changed (ADR 0036). Keys: `format:<id>`, value `{ id, width, height, index }`
 * (`index` = position, 1 = right after the primary, which is never a key). `null`: absent.
 */
export const ConfigPatchEntrySchema = z.object({
  key: z.string().describe("Entity key, e.g. `format:9x16`."),
  before: z.unknown().describe("Value before the operation; null when the key was absent."),
  after: z.unknown().describe("Value after the operation; null when it was removed."),
});

/** See {@link ConfigPatchEntrySchema}. */
export type ConfigPatchEntry = z.output<typeof ConfigPatchEntrySchema>;

/** See {@link ProposalConfigChangeSchema}. */
export interface ProposalConfigChange {
  doc: ConfigDoc;
  key: string;
  before: unknown;
  after: unknown;
}

/**
 * One key an open proposal changes in a config document (ADR 0036): its file value and the proposal's.
 * Typed explicitly: inferred, it pushes the `methods` registry past the declaration size the compiler can print.
 */
export const ProposalConfigChangeSchema: z.ZodType<ProposalConfigChange> = z.object({
  doc: ConfigDocSchema,
  key: z.string().describe("Entity key, e.g. `format:9x16`."),
  before: z.unknown().describe("Value in the file now; null when the key is absent."),
  after: z.unknown().describe("Value once the proposal is accepted; null when it removes the key."),
});
