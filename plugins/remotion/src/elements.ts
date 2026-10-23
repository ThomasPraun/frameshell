import { copyFile, link, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Copy of the bundle directory `source` at `dest` whose `index.html` carries
 * `css` as the last element of `<head>` (ADR 0021). Files are hard-linked,
 * or copied across devices, so the copy is cheap; the bundle itself, which
 * is cache input, stays untouched.
 */
export async function patchedBundle(source: string, dest: string, css: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await patchedBundle(from, to, css);
    else if (entry.name !== "index.html") await link(from, to).catch(() => copyFile(from, to));
  }
  const html = await readFile(join(source, "index.html"), "utf8").catch(() => null);
  if (html !== null) await writeFile(join(dest, "index.html"), withSheet(html, css));
}

/** `html` with a `<style data-frameshell-elements>` before `</head>`; appended when there is no head. */
export function withSheet(html: string, css: string): string {
  const style = `<style data-frameshell-elements>${css.replaceAll("</style", "<\\/style")}</style>`;
  const at = html.search(/<\/head>/i);
  return at < 0 ? html + style : html.slice(0, at) + style + html.slice(at);
}
