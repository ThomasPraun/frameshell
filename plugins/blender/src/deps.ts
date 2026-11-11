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
 * Hashes .blend files and lists the files each one loads from inside the project (ADR 0035). Both are
 * remembered, so a refresh of unchanged clips starts no Blender: the hash while the file's size and mtime stay,
 * the listing for as long as the hash does (`.frameshell/blender/<hash>/deps.json`, which survives restarts).
 */
export class BlendDeps {
  readonly #projectDir: string;
  readonly #hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  readonly #listings = new Map<string, Promise<string[]>>();

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
    const known = this.#hashes.get(path);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return { hash: known.hash };
    const hash = await sha256(path);
    this.#hashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash });
    return { hash };
  }

  /**
   * Project-relative, `/`-separated files the .blend `rel` links or loads (libraries, images, caches) that sit
   * inside the project, from `bpy.utils.blend_paths`. Files outside the project are not tracked (ADR 0035).
   */
  async list(rel: string, blender: string, info: BlendInfo): Promise<string[]> {
    const file = join(this.#projectDir, ...STATE_DIR.split("/"), info.hash, "deps.json");
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

  async #read(file: string, rel: string): Promise<string[] | null> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { blend?: unknown; paths?: unknown };
      if (parsed.blend !== rel) return null;
      return Array.isArray(parsed.paths) && parsed.paths.every((p) => typeof p === "string") ? (parsed.paths as string[]) : null;
    } catch {
      return null;
    }
  }

  async #ask(rel: string, blender: string, file: string): Promise<string[]> {
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
      const paths = insideProject(this.#projectDir, absolute.filter((p): p is string => typeof p === "string"), rel);
      await writeAtomic(file, `${JSON.stringify({ blend: rel, paths }, null, 2)}\n`);
      return paths;
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
