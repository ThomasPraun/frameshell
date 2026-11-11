import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type CreditAsset, type CreditStatus, ErrorCode, type MethodResult, RpcError } from "@frameshell/protocol";
import {
  CREDITS_FILE,
  type CreditEntry,
  type CreditsFile,
  createCreditsFile,
  creditLine,
  licenceInfo,
  parseCreditsFile,
} from "@frameshell/schema";
import { listTimelineIds } from "../clips/renderer.js";
import { timelineRefs } from "../file-uses.js";
import { canonicalPath, readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import { readTimelineFile } from "../timeline/service.js";

/** Provenance fields a caller gives; what is left out keeps the entry's value while the file is unchanged. */
export interface Provenance {
  sourceUrl?: string | undefined;
  licence?: string | undefined;
  author?: string | undefined;
  title?: string | undefined;
  credit?: string | undefined;
}

const FIELDS = ["sourceUrl", "licence", "author", "title", "credit"] as const;

/** Options of {@link CreditsService}. */
export interface CreditsServiceOptions {
  /** `sha256:<hex>` of a project-relative file; see `MediaService.hash`. */
  hash(root: string, rel: string): Promise<string>;
}

/**
 * `credits.json` (ADR 0026): the only writer, one change at a time per
 * project, each written atomically; and the judge of it. An entry says what
 * was recorded; whether the video may go out with it is decided on every
 * check from the entry, the file and the licence, never stored.
 */
export class CreditsService {
  readonly #hash: CreditsServiceOptions["hash"];
  /** Last change of each project in flight, by canonical root: the next one waits for it. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: CreditsServiceOptions) {
    this.#hash = options.hash;
  }

  /**
   * Record where `assets` (project-relative, under `assets/`) came from, with the content hash they have now.
   * Fields in `given` replace the entry's; the rest are kept when the content is unchanged. Throws `AssetNotFound`,
   * `InvalidOperation` (outside `assets/`), `InvalidProjectFile`.
   */
  record(root: string, assets: string[], given: Provenance): Promise<CreditEntry[]> {
    return this.#change(root, async () => {
      const file = await readCredits(root);
      const today = new Date().toISOString().slice(0, 10);
      const entries = new Map(file.assets.map((entry) => [entry.asset, entry]));
      const written: CreditEntry[] = [];
      for (const asset of assets) {
        const rel = requireAssetPath(asset);
        const info = await stat(join(root, ...rel.split("/"))).catch(() => null);
        if (!info?.isFile()) throw new RpcError(ErrorCode.AssetNotFound, `${rel} is not a file in this project. Import it first: \`frameshell import <file>\`.`, { path: rel });
        const hash = await this.#hash(root, rel);
        const before = entries.get(rel);
        const kept = before && before.hash === hash ? before : undefined;
        const fields: Provenance = {};
        for (const field of FIELDS) {
          const value = given[field] ?? kept?.[field];
          if (value !== undefined) fields[field] = value;
        }
        const entry: CreditEntry = { asset: rel, hash, ...fields, addedAt: today };
        const checked = parseCreditsFile({ ...file, assets: [entry] });
        if (!checked.ok) throw new RpcError(ErrorCode.InvalidParams, `credits for ${rel}: ${checked.error}`, { issues: checked.error.split("\n") });
        entries.set(rel, checked.value.assets[0]!);
        written.push(checked.value.assets[0]!);
      }
      const sorted = [...entries.values()].sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
      await writeJsonAtomic(join(root, CREDITS_FILE), { ...file, assets: sorted });
      return written;
    });
  }

  /**
   * Judge every asset the project's timelines place, with the content of recorded ones compared to their entry.
   * Throws `InvalidProjectFile` for an unreadable `credits.json` or timeline: a placement that cannot be read cannot pass.
   */
  async check(root: string): Promise<MethodResult<"credits.check">> {
    const file = await readCredits(root);
    const placed = await placedAssets(root);
    const assets: CreditAsset[] = [];
    for (const [asset, used] of [...placed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const entry = file.assets.find((candidate) => candidate.asset === asset);
      const info = await stat(join(root, ...asset.split("/"))).catch(() => null);
      const hash = entry && info?.isFile() ? await this.#hash(root, asset) : undefined;
      assets.push({ ...assess(asset, entry, info?.isFile() ?? false, hash), used: [...used].sort() });
    }
    const credits = [...new Set(assets.flatMap((asset) => (asset.credit ? [asset.credit] : [])))].sort();
    return { dir: root, ok: assets.every((asset) => asset.status === "ok"), assets, credits, text: credits.join("\n") };
  }

  /**
   * Lines for an export of `assets`: those with no usable provenance, but only in a project that records any
   * (a project of its own footage stays quiet). Reads the entries only, never the files, so a render does not wait
   * on hashing; `credits.check` also compares content.
   */
  async warnings(root: string, assets: string[]): Promise<string[]> {
    let file: CreditsFile;
    try {
      file = await readCredits(root);
    } catch (error) {
      // An unreadable ledger must not stop an export, but nothing is verified either.
      if (error instanceof RpcError && error.code === ErrorCode.InvalidProjectFile) return [`${CREDITS_FILE} cannot be read, so no asset's provenance is verified: ${error.message.split("\n")[0]}`];
      throw error;
    }
    if (file.assets.length === 0) return [];
    const loose = assets.filter((asset) => {
      if (!asset.startsWith("assets/")) return false;
      return assess(asset, file.assets.find((entry) => entry.asset === asset), true, undefined).status !== "ok";
    });
    if (loose.length === 0) return [];
    return [
      `${loose.length} placed asset${loose.length === 1 ? " has" : "s have"} no verified provenance or credit (credits.json): ${loose.join(", ")}. ` +
        "Run `frameshell credits` before publishing.",
    ];
  }

  /** Run `work` after the project's earlier changes, so two requests never read the same file and overwrite each other. */
  async #change<T>(root: string, work: () => Promise<T>): Promise<T> {
    const key = await canonicalPath(root);
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }
}

/**
 * The verdict on one asset. `hash` is the file's current content hash, or undefined when not computed (then a
 * recorded entry is taken at its word).
 */
function assess(asset: string, entry: CreditEntry | undefined, present: boolean, hash: string | undefined): Omit<CreditAsset, "used"> {
  const verdict = (status: CreditStatus, licence: string | null, credit: string | null, problem: string | null) => ({ asset, status, licence, credit, problem });
  if (!present) return verdict("missing", null, null, `${asset} is not in the project any more; remove its clips or import it again.`);
  if (!entry) {
    return verdict(
      "unrecorded",
      null,
      null,
      `No provenance recorded. From an outside source: \`frameshell credits set ${asset} --licence <id> --author <name> --source-url <url>\`; the person's own footage: \`--licence own\`.`,
    );
  }
  const licence = licenceInfo(entry.licence);
  if (licence.duty === "unverified") {
    return verdict("no-licence", null, null, `The licence of ${asset} is not known. Find it at the source and record it, or do not use the asset: \`frameshell credits set ${asset} --licence <id>\`.`);
  }
  if (hash !== undefined && hash !== entry.hash) {
    return verdict("changed", licence.id, null, `${asset} changed since its provenance was recorded. If it is still the same work, record it again: \`frameshell credits set ${asset} --licence ${licence.id}\`.`);
  }
  if (licence.duty === "none") return verdict("ok", licence.id, null, null);
  const credit = creditLine(entry);
  if (!credit) return verdict("no-credit", licence.id, null, `${licence.label} needs a credit. Name the author: \`frameshell credits set ${asset} --author <name>\` (or give --credit).`);
  return verdict("ok", licence.id, credit, null);
}

/** Asset paths the timelines place, each with the ids of the timelines that place it. */
async function placedAssets(root: string): Promise<Map<string, Set<string>>> {
  const placed = new Map<string, Set<string>>();
  for (const id of (await listTimelineIds(root)).sort()) {
    for (const { ref } of timelineRefs(id, await readTimelineFile(root, `timelines/${id}.json`))) {
      if (!ref.startsWith("assets/")) continue;
      const timelines = placed.get(ref) ?? new Set<string>();
      timelines.add(id);
      placed.set(ref, timelines);
    }
  }
  return placed;
}

/** `asset` as a clean project-relative path under `assets/`; throws `InvalidOperation` otherwise. */
function requireAssetPath(asset: string): string {
  const rel = asset.replace(/^\.\//, "");
  const parts = rel.split("/");
  if (parts[0] !== "assets" || parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..") || rel.includes("\\")) {
    throw new RpcError(ErrorCode.InvalidOperation, `credits: "${asset}" is not a path under assets/. Use the project-relative path, e.g. assets/rain.ogg.`, {
      op: "credits.set",
      reason: "not an asset path",
    });
  }
  return rel;
}

/** `credits.json`, or an empty ledger when there is none. Throws `InvalidProjectFile`. */
export async function readCredits(root: string): Promise<CreditsFile> {
  const path = join(root, CREDITS_FILE);
  const invalid = (details: string) => new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}`, { path, details });
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (raw === undefined) return createCreditsFile();
  const parsed = parseCreditsFile(raw);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}
