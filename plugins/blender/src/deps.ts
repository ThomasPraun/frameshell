import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { runBlender, scriptPath } from "./blender.js";

/** Where the adapter keeps files that feed render keys; under `.frameshell/`, which the watcher ignores (ADR 0009). */
export const STATE_DIR = ".frameshell/blender";

/** Longest a listing of one .blend's files may take. */
const LISTING_TIMEOUT_MS = 5 * 60_000;

/** A .blend as the key sees it. */
export interface BlendInfo {
  /** SHA-256 of the file's bytes, first 16 hex digits. */
  hash: string;
}

/**
 * Project-relative `/` path of the listing file of the .blend `rel` with content `info`. Named by the content hash
 * and the path, because relative links resolve against where the .blend sits: two identical copies must not share
 * (and overwrite) one file.
 */
export function listingPath(rel: string, info: BlendInfo): string {
  const where = createHash("sha256").update(rel).digest("hex").slice(0, 8);
  return posix.join(STATE_DIR, `${info.hash}-${where}`, "deps.json");
}

/** Files a .blend loads (libraries, images, caches), split at the project's edge. */
export interface BlendFiles {
  /** Project-relative `/` paths inside the project, sorted. */
  inside: string[];
  /** Absolute paths outside the project, sorted. Kept in memory only: never written into the project. */
  outside: string[];
}

/**
 * Hashes .blend files and lists the files each one loads (ADR 0035). Both are remembered, so a refresh of unchanged
 * clips starts no Blender: the hash while the file's size and mtime stay, the listing for as long as the hash does
 * (`.frameshell/blender/<hash>-<path hash>/deps.json`, which survives restarts). That file holds only the inside paths
 * and how many lie outside; a .blend that loads outside files is listed again once per daemon, so their absolute paths
 * never land in the project.
 */
export class BlendDeps {
  readonly #projectDir: string;
  readonly #hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  readonly #listings = new Map<string, Promise<BlendFiles>>();

  constructor(projectDir: string) {
    this.#projectDir = projectDir;
  }

  /**
   * Content hash of the .blend `rel` (project-relative). Throws when it is missing or cannot be a finished
   * Blender file: Blender saves through a temporary file, but an editor or sync tool may not.
   */
  async hash(rel: string): Promise<BlendInfo> {
    const path = resolve(this.#projectDir, ...rel.split("/"));
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`${rel} does not exist.`);
    if (!(await looksComplete(path, info.size))) throw new Error(`${rel} is not a finished Blender file (it may still be saving); it is rendered when it is.`);
    return { hash: await this.#contentHash(path, info.size, info.mtimeMs) };
  }

  /**
   * Files the .blend `rel` links or loads (libraries, images, caches), from `bpy.utils.blend_paths`: the ones inside
   * the project as project-relative paths (the host hashes and watches them), the ones outside as absolute paths.
   */
  async list(rel: string, blender: string, info: BlendInfo): Promise<BlendFiles> {
    const file = join(this.#projectDir, ...listingPath(rel, info).split("/"));
    // Relative links resolve against where the .blend sits, so a copy elsewhere in the project lists again.
    const id = `${info.hash}\0${rel}`;
    let listing = this.#listings.get(id);
    if (!listing) {
      listing = this.#read(file, rel).then((cached) => cached ?? this.#ask(rel, blender, file));
      this.#listings.set(id, listing);
      listing.catch(() => this.#listings.delete(id));
    }
    return listing;
  }

  /**
   * Project-relative path of a key input holding the content hashes of `outside` (from {@link list} of the .blend `rel`
   * with content `info`), in their order, with no path in it; null when there are none. A file that is missing, or is a
   * folder (a cache directory), counts as missing: it appearing changes the key, its content inside a folder does not.
   */
  async outsideKey(rel: string, info: BlendInfo, outside: readonly string[]): Promise<string | null> {
    if (outside.length === 0) return null;
    const files = await Promise.all(
      outside.map(async (path) => {
        const found = await stat(path).catch(() => null);
        return found?.isFile() ? { sha256: await this.#contentHash(path, found.size, found.mtimeMs), bytes: found.size } : { missing: true };
      }),
    );
    return marker(this.#projectDir, posix.join(posix.dirname(listingPath(rel, info)), "outside.json"), `${JSON.stringify({ outside: files })}\n`);
  }

  /** SHA-256 of `path` (first 16 hex digits), remembered while its size and mtime stay. */
  async #contentHash(path: string, size: number, mtimeMs: number): Promise<string> {
    const known = this.#hashes.get(path);
    if (known && known.size === size && known.mtimeMs === mtimeMs) return known.hash;
    const hash = await sha256(path);
    this.#hashes.set(path, { size, mtimeMs, hash });
    return hash;
  }

  /** The listing in `file`, unless it was written by an older plugin (no `outside` count) or names outside files. */
  async #read(file: string, rel: string): Promise<BlendFiles | null> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { blend?: unknown; paths?: unknown; outside?: unknown };
      if (parsed.blend !== rel || parsed.outside !== 0) return null;
      return Array.isArray(parsed.paths) && parsed.paths.every((p) => typeof p === "string") ? { inside: parsed.paths as string[], outside: [] } : null;
    } catch {
      return null;
    }
  }

  async #ask(rel: string, blender: string, file: string): Promise<BlendFiles> {
    const scratch = await mkdtemp(join(tmpdir(), "frameshell-blender-deps-"));
    const raw = join(scratch, "paths.json");
    try {
      const blend = resolve(this.#projectDir, ...rel.split("/"));
      const { error, tail } = await runBlender(blender, blend, scriptPath("deps.py"), { out: raw }, { cwd: scratch, timeoutMs: LISTING_TIMEOUT_MS });
      if (error) throw new Error(`Blender could not list the files ${rel} loads: ${String(error["message"] ?? error.code)}`);
      let absolute: unknown;
      try {
        absolute = (JSON.parse(await readFile(raw, "utf8")) as { paths?: unknown }).paths;
      } catch {
        throw new Error(`Blender could not read ${rel} to list its files:\n${tail.slice(-8).join("\n")}`);
      }
      if (!Array.isArray(absolute)) throw new Error(`Blender listed no files for ${rel}.`);
      const listed = absolute.filter((p): p is string => typeof p === "string");
      const paths = insideProject(this.#projectDir, listed, rel);
      const outside = outsideProject(this.#projectDir, listed);
      // A rewrite with the same bytes keeps the key; skipping it keeps the file's mtime for the host's hash cache.
      const content = `${JSON.stringify({ blend: rel, paths, outside: outside.length }, null, 2)}\n`;
      if ((await readFile(file, "utf8").catch(() => null)) !== content) await writeAtomic(file, content);
      return { inside: paths, outside };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

/**
 * Absolute paths that sit inside `projectDir`, as sorted unique project-relative `/` paths. Dropped: anything
 * outside, `.frameshell/` (our own output), and the .blend itself.
 */
export function insideProject(projectDir: string, absolute: readonly string[], blend: string): string[] {
  const found = new Set<string>();
  for (const path of absolute) {
    const inside = relative(projectDir, resolve(path));
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
    const rel = inside.split(sep).join("/");
    if (rel === blend || rel === ".frameshell" || rel.startsWith(".frameshell/")) continue;
    found.add(rel);
  }
  return [...found].sort();
}

/** Absolute paths that sit outside `projectDir`, resolved, sorted and unique: the files {@link insideProject} drops as outside. */
export function outsideProject(projectDir: string, absolute: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of absolute) {
    const full = resolve(path);
    const inside = relative(projectDir, full);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) found.add(full);
  }
  return [...found].sort();
}

/**
 * Writes `content` to the project-relative `rel` when it is not there as it is, and returns `rel`. The key hashes the
 * content, so a marker file is how an adapter puts a fact (the Blender version, the length rendered) into it.
 */
export async function marker(projectDir: string, rel: string, content: string): Promise<string> {
  const file = resolve(projectDir, ...rel.split("/"));
  if ((await readFile(file, "utf8").catch(() => null)) !== content) await writeAtomic(file, content);
  return posix.normalize(rel);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, content);
  await rename(temp, file);
}

/** Blender writes plain `BLENDER`, gzip (up to 2.x) or zstd (3.0+) compressed files. */
async function looksComplete(path: string, size: number): Promise<boolean> {
  if (size < 12) return false;
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(7);
    await handle.read(head, 0, 7, 0);
    return head.toString("latin1") === "BLENDER" || (head[0] === 0x1f && head[1] === 0x8b) || (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd);
  } finally {
    await handle.close();
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex").slice(0, 16);
}
