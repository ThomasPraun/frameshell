import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PluginPins, TrustState } from "@frameshell/protocol";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";

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
 * Per-user project trust decisions (SPEC §6.6), in `<appData>/trust.json`,
 * keyed by project root and the hash of its declared plugins. Machine-local
 * on purpose: a cloned project never carries its own trust.
 */
export class TrustStore {
  readonly #file: string;

  constructor(appDataDir: string) {
    this.#file = join(appDataDir, "trust.json");
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
    const raw = (await readJsonIfExists(this.#file).catch(() => undefined)) as Partial<TrustFile> | undefined;
    const projects = raw?.version === 1 && typeof raw.projects === "object" && raw.projects ? raw.projects : {};
    return { version: 1, projects };
  }
}
