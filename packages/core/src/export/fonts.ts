import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { SUBTITLE_FONT } from "@frameshell/schema";
import { FONTS_DIR } from "./compiler.js";

const require = createRequire(import.meta.url);

/**
 * Absolute path of a font a plan names (`RenderPlan.fonts`): the bundled face from its npm package, or a font file
 * of the project (project-relative, `/`-separated) under `projectDir`.
 */
export function fontSource(file: string, projectDir?: string): string {
  if (file === SUBTITLE_FONT.file) return require.resolve(SUBTITLE_FONT.module);
  if (projectDir === undefined || !file.includes("/")) throw new Error(`unknown export font ${file}`);
  return join(projectDir, ...file.split("/"));
}

/** Name `file` gets in `fonts/`: libass finds faces by family, so only clashes with the bundled file matter. */
function fontsDirName(file: string): string {
  if (file === SUBTITLE_FONT.file) return file;
  const name = basename(file);
  return name === SUBTITLE_FONT.file ? `project-${name}` : name;
}

/**
 * Copy `fonts` into `<dir>/fonts/`, where the `ass` filter loads them; project font files are read under
 * `projectDir`. Read and written, not copied: inside a packaged app the package lives in an asar archive that only
 * Node's patched `fs` reads, never ffmpeg.
 */
export async function writeFonts(dir: string, fonts: readonly string[], projectDir?: string): Promise<void> {
  if (fonts.length === 0) return;
  await mkdir(join(dir, FONTS_DIR), { recursive: true });
  for (const file of fonts) await writeFile(join(dir, FONTS_DIR, fontsDirName(file)), await readFile(fontSource(file, projectDir)));
}
