import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { STYLE_FILE, type StyleTokenFace, resolveStyle, styleTokenCss } from "@frameshell/schema";
import { readStyleFile } from "./read.js";

/** The token sheet of a project (ADR 0028) and the hash its generated clips' render keys take. */
export interface StyleTokenSheet {
  css: string;
  /** 32 hex digits of the sheet's SHA-256. */
  hash: string;
}

const sheets = new Map<string, { stamp: string; files: string[]; faces: string; sheet: StyleTokenSheet }>();

/** `size:mtime` of a project file, `-` when missing: what tells a cached sheet it is stale. */
async function stampOf(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? `${info.size}:${info.mtimeMs}` : "-";
}

const facesStamp = async (root: string, files: readonly string[]) =>
  (await Promise.all(files.map((file) => stampOf(join(root, ...file.split("/")))))).join(",");

/**
 * {@link styleTokenCss} of the project's `style.json` with the bytes of its font files (a missing one gets no
 * `@font-face`); null without a style. Read again only when `style.json` or one of its font files changed.
 * Throws `InvalidProjectFile` for an invalid `style.json`.
 */
export async function readStyleTokens(root: string): Promise<StyleTokenSheet | null> {
  const stamp = await stampOf(join(root, STYLE_FILE));
  if (stamp === "-") {
    sheets.delete(root);
    return null;
  }
  const cached = sheets.get(root);
  if (cached && cached.stamp === stamp && cached.faces === (await facesStamp(root, cached.files))) return cached.sheet;
  const file = await readStyleFile(root);
  if (!file) return null;
  const style = resolveStyle(file);
  const files = [...new Set(Object.values(style.fonts).flatMap((leaf) => (leaf.value?.file ? [leaf.value.file] : [])))];
  const faces: StyleTokenFace[] = [];
  for (const font of files) {
    const bytes = await readFile(join(root, ...font.split("/"))).catch(() => null);
    if (bytes) faces.push({ file: font, base64: bytes.toString("base64") });
  }
  const css = styleTokenCss(style, faces);
  const sheet = { css, hash: createHash("sha256").update(css).digest("hex").slice(0, 32) };
  sheets.set(root, { stamp, files, faces: await facesStamp(root, files), sheet });
  return sheet;
}
