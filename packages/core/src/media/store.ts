import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssetInfo, MediaProbe } from "@frameshell/protocol";
import { exists, readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";
import { RECIPE_VERSION, fpsRational } from "./recipe.js";

/** Derived files of one content hash at one fps and recipe. Written last: its presence marks a complete build. */
export interface Manifest {
  version: 1;
  recipe: number;
  fps: number;
  hash: string;
  media: MediaProbe;
  proxy: AssetInfo["proxy"];
  sidecar: AssetInfo["sidecar"];
  waveform: AssetInfo["waveform"];
  thumbnails: AssetInfo["thumbnails"];
}

/** Last known content of one asset file; the hash is reused while size and mtime match. */
interface IndexEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}

/** `/`-separated project-relative directories of derived media (SPEC §5.1). */
export const DERIVED_DIRS = {
  proxies: ".frameshell/proxies",
  waveforms: ".frameshell/waveforms",
  thumbs: ".frameshell/thumbs",
} as const;

const INDEX_FILE = ".frameshell/media.json";

/** A {@link MediaStore.key}: 20 hex digits of the content hash, fps (`30`, `30000_1001`), recipe. */
const KEY = String.raw`[0-9a-f]{20}-\d+(?:_\d+)?-r\d+`;
const PROXY_FILE = new RegExp(String.raw`^(${KEY})\.(mp4|pcm|json)$`);
const WAVEFORM_FILE = new RegExp(String.raw`^(${KEY})\.json$`);
const THUMBS_DIR = new RegExp(String.raw`^(${KEY})$`);
/** Build temps (`.<pid>-<time>.partial`) and atomic-write temps (`.<pid>.<hex>.tmp`) of a key's outputs. */
const KEY_TEMP = new RegExp(String.raw`^${KEY}\..+\.(partial|tmp)$`);

/**
 * What an entry of one {@link DERIVED_DIRS} directory is, for `gc`: an
 * output of cache key `key`, a build temp, or null (not ours: kept).
 */
export function classifyDerived(area: keyof typeof DERIVED_DIRS, name: string, isDirectory: boolean): GcClass {
  if (KEY_TEMP.test(name)) return { kind: "temp", key: null };
  if (area === "thumbs") {
    const key = isDirectory ? THUMBS_DIR.exec(name)?.[1] : undefined;
    return key ? { kind: "thumbnails", key } : null;
  }
  if (isDirectory) return null;
  if (area === "waveforms") {
    const key = WAVEFORM_FILE.exec(name)?.[1];
    return key ? { kind: "waveform", key } : null;
  }
  const match = PROXY_FILE.exec(name);
  if (!match) return null;
  return { kind: match[2] === "mp4" ? "proxy" : match[2] === "pcm" ? "sidecar" : "manifest", key: match[1]! };
}

/**
 * Per-project cache of derived media, keyed by content hash (SPEC §6.3):
 * renamed or re-imported bytes map to the same outputs. Everything here is
 * regenerable; a lost index only costs re-hashing.
 */
export class MediaStore {
  readonly root: string;
  #index: Map<string, IndexEntry> | undefined;
  /** Serializes index writes: they share one temp file. */
  #writing: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  /** Absolute path of a project-relative `/`-separated path. */
  abs(rel: string): string {
    return join(this.root, ...rel.split("/"));
  }

  /** Cache key: content hash, project fps and recipe version. */
  key(hash: string, fps: number): string {
    return `${hash.replace(/^sha256:/, "").slice(0, 20)}-${fpsRational(fps).replace("/1", "").replace("/", "_")}-r${RECIPE_VERSION}`;
  }

  /** `sha256:<hex>` of `rel`, reusing the indexed hash while size and mtime are unchanged. */
  async hash(rel: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
    const path = this.abs(rel);
    const { size, mtimeMs } = await stat(path);
    const known = (await this.#load()).get(rel);
    if (known && known.size === size && known.mtimeMs === mtimeMs) return known.hash;
    const hash = await hashFile(path, size, onProgress, signal);
    await this.remember(rel, { size, mtimeMs, hash });
    return hash;
  }

  /** Hash already known for the current content of `rel`, without reading it; null when stale or unknown. */
  async knownHash(rel: string): Promise<string | null> {
    const known = (await this.#load()).get(rel);
    if (!known) return null;
    const current = await stat(this.abs(rel)).catch(() => null);
    return current && current.size === known.size && current.mtimeMs === known.mtimeMs ? known.hash : null;
  }

  /** Record the content of `rel` (after import or hashing). */
  async remember(rel: string, entry: IndexEntry): Promise<void> {
    (await this.#load()).set(rel, entry);
    await this.#save();
  }

  /** Drop `rel` from the index (file deleted). Derived files stay: other paths may share the content. */
  async forget(rel: string): Promise<void> {
    if ((await this.#load()).delete(rel)) await this.#save();
  }

  /** Every project-relative path the index holds, whether or not the file still exists. */
  async indexedPaths(): Promise<string[]> {
    return [...(await this.#load()).keys()];
  }

  /** Complete manifest for `key` whose outputs all exist, or null. */
  async manifest(key: string): Promise<Manifest | null> {
    let manifest: Manifest;
    try {
      manifest = (await readJsonIfExists(this.abs(`${DERIVED_DIRS.proxies}/${key}.json`))) as Manifest;
    } catch {
      return null; // Corrupt: rebuild.
    }
    if (manifest?.version !== 1 || manifest.recipe !== RECIPE_VERSION) return null;
    const outputs = [manifest.proxy, manifest.sidecar?.path, manifest.waveform?.path, manifest.thumbnails?.dir];
    for (const rel of outputs) if (rel && !(await exists(this.abs(rel)))) return null;
    return manifest;
  }

  /** Publish a build. Call after every output is in place. */
  async writeManifest(key: string, manifest: Manifest): Promise<void> {
    await writeJsonAtomic(this.abs(`${DERIVED_DIRS.proxies}/${key}.json`), manifest);
  }

  async #load(): Promise<Map<string, IndexEntry>> {
    if (this.#index) return this.#index;
    let files: Record<string, IndexEntry> = {};
    try {
      const raw = (await readJsonIfExists(this.abs(INDEX_FILE))) as { version?: number; files?: Record<string, IndexEntry> };
      if (raw?.version === 1 && raw.files) files = raw.files;
    } catch {
      // Corrupt index: start over, hashes are recomputed.
    }
    this.#index ??= new Map(Object.entries(files));
    return this.#index;
  }

  #save(): Promise<void> {
    const write = async () => {
      const files = Object.fromEntries([...(this.#index ?? new Map<string, IndexEntry>())].sort(([a], [b]) => a.localeCompare(b)));
      await writeJsonAtomic(this.abs(INDEX_FILE), { version: 1, files });
    };
    this.#writing = this.#writing.then(write, write);
    return this.#writing;
  }
}

/** Streaming SHA-256 as `sha256:<hex>`. */
export async function hashFile(
  path: string,
  size: number,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  let read = 0;
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
    if (size > 0) onProgress?.(read / size);
  }
  return `sha256:${hash.digest("hex")}`;
}
