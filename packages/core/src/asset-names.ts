import { posix } from "node:path";

/**
 * File names a per-asset project file (`transcripts/<name>.words.json`, `beats/<name>.beats.json`) may
 * use, in preference order: the path under `assets/` without its extension, then with it, for when a
 * same-name sibling (`song.mp3` and `song.wav`) owns the first. Assets outside `assets/` keep their full
 * project-relative path.
 */
export function assetFileNames(assetRel: string): [string, string] {
  const inner = assetRel.startsWith("assets/") ? assetRel.slice("assets/".length) : assetRel;
  const ext = posix.extname(inner);
  return [ext ? inner.slice(0, -ext.length) : inner, inner];
}
