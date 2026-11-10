import { z } from "zod";
import { CreditEntrySchema } from "@frameshell/schema";

// Asset provenance and credits (ADR 0026): `credits.json`, the verdict `credits.check` derives from it.

/**
 * Provenance fields shared by `asset.import` (outside source) and `credits.set`. Every one is optional so a
 * partial record can be written and completed later; what is missing shows up as a problem in `credits.check`.
 */
export const ProvenanceParams = {
  sourceUrl: CreditEntrySchema.shape.sourceUrl.describe("Page the file was fetched from, `http` or `https`, e.g. `https://openverse.org/audio/9f2c`."),
  licence: CreditEntrySchema.shape.licence.describe(
    "Licence id as the source states it: `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `public-domain`, or `own` for the person's own work. " +
      "Unknown ids count as needing credit. Absent or `unknown`: unverified, `credits.check` fails.",
  ),
  author: CreditEntrySchema.shape.author.describe("Who made it, as the credit should name them, e.g. `Ana Pérez`."),
  title: CreditEntrySchema.shape.title.describe("Name of the work, e.g. `Rain on a window`."),
  credit: CreditEntrySchema.shape.credit.describe("Credit line to publish as written; replaces the one built from title, author, licence and source."),
};

/** Why `credits.check` does not pass an asset, or `ok`. */
export const CreditStatusSchema = z.enum(["ok", "unrecorded", "no-licence", "no-credit", "changed", "missing"]);

/** See {@link CreditStatusSchema}. */
export type CreditStatus = z.output<typeof CreditStatusSchema>;

/** One placed asset as `credits.check` judges it. */
export const CreditAssetSchema = z.object({
  asset: z.string().describe("Project-relative asset path."),
  used: z.array(z.string()).describe("Ids of the timelines that place it, sorted."),
  status: CreditStatusSchema.describe(
    "`ok`: licence known and, when it needs credit, a credit line exists. `unrecorded`: no entry in `credits.json`. " +
      "`no-licence`: entry without a licence, or `unknown`. `no-credit`: licence needs credit but there is no author or `credit`. " +
      "`changed`: the file's content is not the one the entry was written for. `missing`: the file is gone.",
  ),
  licence: z.string().nullable().describe("Canonical licence id; null when unverified."),
  credit: z.string().nullable().describe("Credit line to publish; null when the licence needs none, or when it needs one that is missing."),
  problem: z.string().nullable().describe("What to do about it, when `status` is not `ok`."),
});

/** One asset of {@link CreditAssetSchema}. */
export type CreditAsset = z.output<typeof CreditAssetSchema>;
