import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { THREE_RUNTIME_FILE } from "./three-runtime.js";

/**
 * Most sub-frame samples a 3D composition renders per frame (ADR 0042 decision 13): each sample is a full capture on
 * the software renderer, so 16 to 64 of them would take minutes per second of film.
 */
export const WEBGL_BLUR_SAMPLES = 8;

/** Largest script or page read when looking for WebGL; a bigger file is a library, not the author's scene. */
const SCAN_LIMIT = 4 * 1024 * 1024;

/** A scene that makes a WebGL context: three.js's renderer, or a canvas asked for `webgl`/`webgl2`. */
const WEBGL_USE = /\bWebGLRenderer\b|getContext\(\s*["'](?:experimental-)?webgl2?["']/;

/**
 * Whether the composition in `dir` draws with WebGL (three.js): it holds the Frameshell three.js bundle (a 3D
 * template, ADR 0042), or one of its pages or scripts makes a WebGL renderer or context. `files` are its
 * `/`-separated files relative to `dir`, as the adapter lists them for the cache key.
 */
export async function usesWebGL(dir: string, files: readonly string[]): Promise<boolean> {
  if (files.includes(THREE_RUNTIME_FILE)) return true;
  for (const file of files) {
    if (!/\.(?:html?|[cm]?js)$/i.test(file)) continue;
    const path = join(dir, ...file.split("/"));
    const info = await stat(path).catch(() => null);
    if (!info || info.size > SCAN_LIMIT) continue;
    if (WEBGL_USE.test(await readFile(path, "utf8").catch(() => ""))) return true;
  }
  return false;
}
