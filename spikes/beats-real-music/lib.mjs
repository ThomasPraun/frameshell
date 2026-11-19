// Shared by make-corpus.mjs, fetch-cc0.mjs and run.mjs: repo guard, managed ffmpeg lookup, decode, the built detector.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The nearest ancestor of `path` that holds a `.git` entry (a checkout or a worktree), or null. */
function gitRootOf(path) {
  for (let at = path; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}

/** Refuse a directory inside the repo or any git checkout (symlinks resolved): this spike never holds audio next to code. */
export function outsideRepo(dir) {
  const path = resolve(dir);
  const checked = real(path);
  const inside = (root) => {
    const rel = relative(real(root), checked);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const git = gitRootOf(checked);
  if (inside(REPO) || git) {
    throw new Error(`refusing ${path}: it is inside a repo (${git ?? REPO}); use a temp directory`);
  }
  return path;
}

function findFfmpeg(dir, depth = 0) {
  if (!existsSync(dir) || depth > 5) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && /^ffmpeg(\.exe)?$/.test(entry.name)) return full;
    if (entry.isDirectory()) {
      const found = findFfmpeg(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Managed ffmpeg: `FRAMESHELL_FFMPEG`, else `FRAMESHELL_TEST_BINARIES_DIR` or the repo's `.cache/test-binaries`. */
export function ffmpegPath() {
  if (process.env.FRAMESHELL_FFMPEG) return process.env.FRAMESHELL_FFMPEG;
  const roots = [process.env.FRAMESHELL_TEST_BINARIES_DIR, join(REPO, ".cache", "test-binaries")].filter(Boolean);
  for (const root of roots) {
    const found = findFfmpeg(join(root, "binaries", "ffmpeg")) ?? findFfmpeg(root);
    if (found) return found;
  }
  throw new Error("ffmpeg not found: set FRAMESHELL_FFMPEG or FRAMESHELL_TEST_BINARIES_DIR");
}

/** Run ffmpeg with `args`; resolves to stdout bytes (use `pipe:1` outputs). */
export function ffmpeg(args) {
  return new Promise((done, fail) => {
    const child = spawn(ffmpegPath(), ["-v", "error", "-nostdin", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(Buffer.concat(out)) : fail(new Error(`ffmpeg ${args.join(" ")}: ${err.trim()}`))));
  });
}

/** Decode like the product: the ingest sidecar (48 kHz stereo s16) or the fallback (16 kHz mono s16). */
export const DECODES = {
  sidecar: { channels: 2, rate: 48_000 },
  fallback: { channels: 1, rate: 16_000 },
};

export async function decode(file, mode = "sidecar") {
  const { channels, rate } = DECODES[mode];
  const pcm = await ffmpeg(["-i", file, "-map", "0:a:0", "-ac", String(channels), "-ar", String(rate), "-f", "s16le", "pipe:1"]);
  return { pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), channels, rate };
}

/** The product's LOW threshold (`LOW_BEAT_CONFIDENCE` of the built schema), never a copy. */
export async function lowBeatConfidence() {
  const file = join(REPO, "packages", "schema", "dist", "beats.js");
  if (!existsSync(file)) throw new Error(`${file} is missing: run pnpm build first`);
  return (await import(pathToFileURL(file).href)).LOW_BEAT_CONFIDENCE;
}

/** A module of the built core (`pnpm build` of packages/core first), by path under `dist/`. */
export async function loadCore(path) {
  const file = join(REPO, "packages", "core", "dist", ...path.split("/"));
  if (!existsSync(file)) throw new Error(`${file} is missing: run pnpm build first`);
  return import(pathToFileURL(file).href);
}
