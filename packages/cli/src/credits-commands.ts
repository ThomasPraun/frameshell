import type { CreditsCheckResult, CreditsSetResult, MethodParams } from "@frameshell/protocol";

/** Help text of the `import` provenance flags and the `credits` commands (ADR 0026), in `frameshell --help`. */
export const CREDITS_USAGE = `  credits                      Check the provenance of every asset the timelines place against credits.json and
                               print the credit text for the video description. Exit 1 when any placed asset has
                               no entry, no licence, a licence that needs credit without an author, changed
                               content or a missing file: unverified never passes. CC0, public-domain and own need no credit
  credits set <asset> [--source-url u] [--licence id] [--author name] [--title t] [--credit line]
                               Record where an asset in assets/ came from (same flags as import). Flags left out keep
                               their value while the file is unchanged. \`--licence own\`: the person's own footage
`;

/** Provenance flags of `import` and `credits set`. */
export const PROVENANCE_FLAGS = ["source-url", "licence", "author", "title", "credit"] as const;

/** Flags each `credits` command takes besides the global ones. */
export const CREDITS_FLAGS: Record<string, readonly string[]> = {
  credits: [],
  "credits set": PROVENANCE_FLAGS,
};

/** Provenance as typed: only the flags that were given. */
export type ProvenanceInput = Pick<MethodParams<"credits.set">, "sourceUrl" | "licence" | "author" | "title" | "credit">;

/** A parsed `credits` command. */
export type CreditsInvocation = { kind: "credits.check" } | { kind: "credits.set"; asset: string; provenance: ProvenanceInput };

/** Flag values {@link provenanceOf} reads. */
export interface ProvenanceOptions {
  "source-url"?: string | undefined;
  licence?: string | undefined;
  author?: string | undefined;
  title?: string | undefined;
  credit?: string | undefined;
}

/** The provenance flags that were given, as `asset.import` and `credits.set` take them. */
export function provenanceOf(options: ProvenanceOptions): ProvenanceInput {
  return {
    ...(options["source-url"] !== undefined ? { sourceUrl: options["source-url"] } : {}),
    ...(options.licence !== undefined ? { licence: options.licence } : {}),
    ...(options.author !== undefined ? { author: options.author } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.credit !== undefined ? { credit: options.credit } : {}),
  };
}

/** Parse `credits [set <asset>]`; null when the shape is wrong. */
export function parseCredits(rest: string[], options: ProvenanceOptions): CreditsInvocation | null {
  if (rest.length === 0) return { kind: "credits.check" };
  if (rest[0] === "set" && rest.length === 2) return { kind: "credits.set", asset: rest[1]!, provenance: provenanceOf(options) };
  return null;
}

/** Text of `credits`: problems first, then the credit block. */
export function formatCreditsCheck(result: CreditsCheckResult): string {
  const lines: string[] = [];
  const bad = result.assets.filter((asset) => asset.status !== "ok");
  if (result.assets.length === 0) lines.push("No assets are placed on any timeline: nothing to credit.");
  for (const asset of bad) lines.push(`${asset.status.toUpperCase()}  ${asset.asset}  (${asset.used.join(", ")})`, `  ${asset.problem}`);
  if (bad.length > 0) lines.push("");
  const free = result.assets.filter((asset) => asset.status === "ok" && asset.credit === null).map((asset) => `${asset.asset} (${asset.licence})`);
  if (result.credits.length > 0) lines.push("Credits for the video description:", ...result.credits.map((credit) => `  ${credit}`));
  else if (bad.length === 0 && result.assets.length > 0) lines.push("No credit is needed.");
  if (free.length > 0) lines.push(`No credit needed: ${free.join(", ")}`);
  if (bad.length > 0) lines.push(`${bad.length} of ${result.assets.length} placed asset${result.assets.length === 1 ? "" : "s"} cannot be cleared: the credit text above is incomplete.`);
  return `${lines.join("\n")}\n`;
}

/** Text of `credits set`. */
export function formatCreditsSet(result: CreditsSetResult): string {
  const { entry } = result;
  const facts = [entry.licence ? `licence ${entry.licence}` : "no licence yet", entry.author ? `by ${entry.author}` : null, entry.sourceUrl ?? null].filter(Boolean);
  return `${entry.asset}  recorded: ${facts.join(" · ")}\n`;
}
