import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SUBTITLE_FONT } from "@frameshell/schema";
import { FONTS_DIR } from "./compiler.js";

const require = createRequire(import.meta.url);

/** Absolute path of a font a plan names (`RenderPlan.fonts`), from its npm package. */
export function fontSource(file: string): string {
  if (file !== SUBTITLE_FONT.file) throw new Error(`unknown export font ${file}`);
  return require.resolve(SUBTITLE_FONT.module);
}

/**
 * Copy `fonts` into `<dir>/fonts/`, where the `ass` filter loads them.
 * Read and written, not copied: inside a packaged app the package lives in
 * an asar archive that only Node's patched `fs` reads, never ffmpeg.
 */
export async function writeFonts(dir: string, fonts: readonly string[]): Promise<void> {
  if (fonts.length === 0) return;
  await mkdir(join(dir, FONTS_DIR), { recursive: true });
  for (const file of fonts) await writeFile(join(dir, FONTS_DIR, file), await readFile(fontSource(file)));
}
