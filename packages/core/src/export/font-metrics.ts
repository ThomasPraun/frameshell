import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CaptionFont, type FontMetrics, SUBTITLE_FONT, parseFontMetrics } from "@frameshell/schema";
import { fontSource } from "./fonts.js";

let bundled: Promise<FontMetrics> | undefined;

/** {@link FontMetrics} of the bundled subtitle face ({@link SUBTITLE_FONT}), read once. */
export function bundledFontMetrics(): Promise<FontMetrics> {
  bundled ??= readFile(fontSource(SUBTITLE_FONT.file)).then(parseFontMetrics);
  bundled.catch(() => (bundled = undefined));
  return bundled;
}

const read = new Map<string, { stamp: string; metrics: FontMetrics }>();

/** {@link FontMetrics} of the font file at absolute `path`, read again only when its size or mtime changed. Throws for a file that is no font. */
export async function fontFileMetrics(path: string): Promise<FontMetrics> {
  const info = await stat(path);
  const stamp = `${info.size}:${info.mtimeMs}`;
  const cached = read.get(path);
  if (cached?.stamp === stamp) return cached.metrics;
  const metrics = parseFontMetrics(await readFile(path));
  read.set(path, { stamp, metrics });
  return metrics;
}

/** {@link FontMetrics} of a caption face: the bundled one, or its font file under project `root`. */
export function captionFontMetrics(root: string, font: CaptionFont): Promise<FontMetrics> {
  return font.file === null ? bundledFontMetrics() : fontFileMetrics(join(root, ...font.file.split("/")));
}
