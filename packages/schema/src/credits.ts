import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for a project's `credits.json`. */
export const CREDITS_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/credits.json`;

/** Project-relative path of the asset provenance ledger (ADR 0026). */
export const CREDITS_FILE = "credits.json";

/** Content hash as `asset.list` reports it: `sha256:` and 64 lowercase hex digits. */
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must look like `sha256:<64 hex digits>`");

/** Longest source URL a credit (and so a brand capture, whose files get credits) records. */
export const MAX_SOURCE_URL = 2048;

/** An http or https URL of at most {@link MAX_SOURCE_URL} characters. */
export const HttpUrl = z
  .string()
  .max(MAX_SOURCE_URL)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

/** Where one asset came from and under which licence. */
export const CreditEntrySchema = z.strictObject({
  asset: z
    .string()
    .regex(/^assets\/[^\\]+$/, "must be a project-relative path under `assets/`")
    .describe("Project-relative asset path, e.g. `assets/rain.ogg`."),
  hash: HashSchema.describe("Content the entry was written for. An asset whose content changed since is unverified."),
  sourceUrl: HttpUrl.optional().describe("Page the file was fetched from (http or https)."),
  licence: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("SPDX-style id such as `CC0-1.0`, `CC-BY-4.0`, or `own` for the person's own work. Absent or `unknown`: unverified."),
  author: z.string().trim().min(1).max(300).optional().describe("Who made it, as the credit should name them."),
  title: z.string().trim().min(1).max(300).optional().describe("Name of the work, for the credit line."),
  credit: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe("Credit line to use as written, instead of the one built from title, author, licence and source."),
  addedAt: z.iso.date().describe("Day (UTC, `YYYY-MM-DD`) the entry was last written."),
});

/**
 * Zod model of `credits.json` (ADR 0026): provenance of third-party assets,
 * at most one entry per asset path. Written when a file is imported from an
 * outside source or by `credits.set`; never holds a verdict, which is derived
 * from the entry and the file on every check.
 */
export const CreditsFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    assets: z.array(CreditEntrySchema).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.assets.forEach((entry, index) => {
      if (seen.has(entry.asset)) ctx.addIssue({ code: "custom", message: `duplicate entry for ${entry.asset}`, path: ["assets", index, "asset"] });
      seen.add(entry.asset);
    });
  });

/** Validated `credits.json` content. */
export type CreditsFile = z.output<typeof CreditsFileSchema>;

/** One asset of a {@link CreditsFile}. */
export type CreditEntry = CreditsFile["assets"][number];

/** A ledger with no entries, as the daemon writes it first. */
export function createCreditsFile(): CreditsFile {
  return { $schema: CREDITS_SCHEMA_URL, schemaVersion: SCHEMA_VERSION, assets: [] };
}

/** Validate unknown input as `credits.json`. Never throws. */
export function parseCreditsFile(input: unknown): ParseResult<CreditsFile> {
  const result = CreditsFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

/**
 * What a licence asks of the video: `none` (no credit needed), `credit`
 * (a credit line is required) or `unverified` (no licence, or one that says
 * it was never checked). A licence this module does not know needs credit:
 * unknown never counts as free.
 */
export type LicenceDuty = "none" | "credit" | "unverified";

/** A licence as the ledger reads it. */
export interface LicenceInfo {
  /** Canonical id: `CC-BY-4.0`, or the text as given when not recognised. */
  id: string;
  /** What to print in a credit: `CC BY 4.0`. */
  label: string;
  /** Licence deed, when the id names a Creative Commons licence with a version. */
  url: string | null;
  duty: LicenceDuty;
}

const UNVERIFIED = new Set(["", "unknown", "unverified", "none", "n/a", "?"]);
const NO_CREDIT = new Map([
  ["cc0", "CC0-1.0"],
  ["cc0-1.0", "CC0-1.0"],
  ["cc0 1.0", "CC0-1.0"],
  ["pdm", "public-domain"],
  ["pdm-1.0", "public-domain"],
  ["public domain", "public-domain"],
  ["public-domain", "public-domain"],
  ["own", "own"],
  ["own work", "own"],
  ["unlicense", "Unlicense"],
]);
const NO_CREDIT_LABEL: Record<string, string> = { "CC0-1.0": "CC0 1.0", "public-domain": "Public domain", own: "Own work", Unlicense: "Unlicense" };
const CC = /^cc[ -]by((?:[ -]nc)?(?:[ -](?:sa|nd))?)(?:[ -](\d\.\d))?$/;

/** Read a licence text: `undefined` and unverified spellings give duty `unverified`. */
export function licenceInfo(text: string | undefined): LicenceInfo {
  const given = (text ?? "").trim();
  const key = given.toLowerCase();
  if (UNVERIFIED.has(key)) return { id: "", label: "", url: null, duty: "unverified" };
  const free = NO_CREDIT.get(key);
  if (free) return { id: free, label: NO_CREDIT_LABEL[free]!, url: free === "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : null, duty: "none" };
  const cc = CC.exec(key);
  if (cc) {
    const terms = cc[1]!.replace(/[ -]/g, " ").trim();
    const kind = `BY${terms ? ` ${terms.toUpperCase()}` : ""}`;
    const version = cc[2];
    return {
      id: `CC-${kind.replace(/ /g, "-")}${version ? `-${version}` : ""}`,
      label: `CC ${kind}${version ? ` ${version}` : ""}`,
      url: version ? `https://creativecommons.org/licenses/${kind.toLowerCase().replace(/ /g, "-")}/${version}/` : null,
      duty: "credit",
    };
  }
  return { id: given, label: given, url: null, duty: "credit" };
}

/**
 * The credit line to publish for an entry, or null when it has no author and
 * no explicit `credit`: nothing to name. An explicit `credit` is used as
 * written; otherwise `"Title" by Author, CC BY 4.0 (deed URL), source URL`,
 * with the file name for a missing title.
 */
export function creditLine(entry: Pick<CreditEntry, "asset" | "title" | "author" | "credit" | "licence" | "sourceUrl">): string | null {
  if (entry.credit) return entry.credit;
  if (!entry.author) return null;
  const licence = licenceInfo(entry.licence);
  const name = entry.title ?? entry.asset.slice(entry.asset.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const parts = [`"${name}" by ${entry.author}`];
  if (licence.label) parts.push(licence.url ? `${licence.label} (${licence.url})` : licence.label);
  if (entry.sourceUrl) parts.push(entry.sourceUrl);
  return parts.join(", ");
}
