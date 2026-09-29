import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppDirs, PluginPins, TrustState } from "@frameshell/protocol";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";

const TRUST_FILE = "trust.json";

/** Stored trust decision; `trusted`/`denied` apply only while the plugin list hashes to `pluginsHash`. */
interface TrustRecord {
  pluginsHash: string;
  decision: "trusted" | "denied";
  decidedAt: string;
}

interface TrustFile {
  version: 1;
  projects: Record<string, TrustRecord>;
}

/** Order-independent hash of a plugin list: any added, removed or re-pinned plugin changes it. */
export function pluginsHash(pins: PluginPins): string {
  const entries = Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * Per-user project trust decisions (SPEC §6.6), in `<configDir>/trust.json`,
 * keyed by project root and the hash of its declared plugins. Machine-local
 * on purpose: a cloned project never carries its own trust.
 *
 * Earlier releases kept the file in the data dir (differs from the config dir
 * only on Linux and Windows; on Windows it was never there). While
 * `<configDir>/trust.json` is missing, that legacy file is read instead; the
 * next decision writes everything to the config dir. The legacy file stays.
 */
export class TrustStore {
  readonly #file: string;
  readonly #legacyFile: string | undefined;

  constructor(dirs: AppDirs) {
    this.#file = join(dirs.configDir, TRUST_FILE);
    const legacy = join(dirs.dataDir, TRUST_FILE);
    this.#legacyFile = legacy === this.#file ? undefined : legacy;
  }

  /** Trust of `root` for exactly `pins`. A corrupt store reads as empty, so the user is asked again. */
  async state(root: string, pins: PluginPins): Promise<TrustState> {
    if (Object.keys(pins).length === 0) return "not-required";
    const record = (await this.#read()).projects[root];
    if (!record || record.pluginsHash !== pluginsHash(pins)) return "unknown";
    return record.decision;
  }

  /** Remember `decision` for `root` with exactly `pins`, replacing any earlier one. */
  async decide(root: string, pins: PluginPins, decision: "trusted" | "denied"): Promise<void> {
    const file = await this.#read();
    file.projects[root] = { pluginsHash: pluginsHash(pins), decision, decidedAt: new Date().toISOString() };
    await writeJsonAtomic(this.#file, file);
  }

  async #read(): Promise<TrustFile> {
    const readOrMissing = (path: string) => readJsonIfExists(path).catch(() => null);
    let raw = (await readOrMissing(this.#file)) as Partial<TrustFile> | null | undefined;
    // `undefined` = missing; a corrupt current file (null) never falls back to stale legacy decisions.
    if (raw === undefined && this.#legacyFile) raw = (await readOrMissing(this.#legacyFile)) as typeof raw;
    const projects = raw?.version === 1 && typeof raw.projects === "object" && raw.projects ? raw.projects : {};
    return { version: 1, projects };
  }
}
