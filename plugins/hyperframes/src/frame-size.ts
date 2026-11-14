import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A frame size in pixels. */
export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** Opening tag of an element carrying `data-composition-id`: the producer sizes the page by the first one. */
const ROOT_TAG = /<[a-zA-Z][-a-zA-Z0-9]*\b[^>]*\sdata-composition-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)[^>]*>/i;
/** Script, style and comment bodies: text there is never markup. */
const OPAQUE = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi;

/**
 * Same aspect ratio within 1 %, so 1366x768 counts as 16:9. Twin of `sameAspect` in
 * `packages/schema/src/formats.ts` (a plugin ships only its own files); `test/frame-size.test.ts` checks parity.
 */
export function sameAspect(a: FrameSize, b: FrameSize): boolean {
  return Math.abs((a.width * b.height) / (a.height * b.width) - 1) < 0.01;
}

/** `data-width` / `data-height` of the composition root of `html`, or null when it has none or they are not positive. */
export function declaredSize(html: string): FrameSize | null {
  const root = findRoot(html);
  if (!root) return null;
  const width = Number(attribute(root.tag, "data-width"));
  const height = Number(attribute(root.tag, "data-height"));
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Resolution in the project's `frameshell.json`, 1920x1080 when it names none (the scaffold's default).
 * Throws when the file cannot be read.
 */
export async function projectResolution(projectDir: string): Promise<FrameSize> {
  const config = JSON.parse(await readFile(join(projectDir, "frameshell.json"), "utf8")) as {
    resolution?: { width?: number; height?: number };
  };
  return { width: config.resolution?.width ?? 1920, height: config.resolution?.height ?? 1080 };
}

/**
 * The entry HTML laid out at `size` (ADR 0027 decision 8): the root's `data-width` / `data-height` set to it.
 * The producer sizes the page and the root by them, so nothing else needs editing (spike in ADR 0027).
 * Only a composition laid out for the `project` frame is resized, and only into a format of another aspect.
 * Otherwise (same aspect as `size`, a composition of its own shape such as a square card in a 16:9 project, or
 * no declared size) it is returned unchanged, so the primary output of an existing composition never changes.
 */
export function sizeEntry(html: string, size: FrameSize, project: FrameSize): string {
  const root = findRoot(html);
  const declared = declaredSize(html);
  if (!root || !declared || !sameAspect(declared, project) || sameAspect(declared, size)) return html;
  const tag = setAttribute(setAttribute(root.tag, "data-width", String(size.width)), "data-height", String(size.height));
  return html.slice(0, root.index) + tag + html.slice(root.index + root.tag.length);
}

/**
 * `css` as the last stylesheet of the document, tagged with attribute `marker`: before `</head>`, else at the
 * start when the file has none. `</` in the CSS is escaped so it cannot close the element.
 */
export function withStyle(html: string, marker: string, css: string): string {
  const tag = `<style ${marker}>\n${css.replace(/<\//g, "<\\/")}\n</style>`;
  const at = html.search(/<\/head\s*>/i);
  return at >= 0 ? html.slice(0, at) + tag + html.slice(at) : tag + html;
}

/**
 * `css` as the first stylesheet of the document, tagged with attribute `marker`: right after the `<head>` tag, else
 * after `<html>`, else after the doctype (standards mode stays), else first. Escaped as {@link withStyle} does.
 */
export function withLeadingStyle(html: string, marker: string, css: string): string {
  return withLeadingTag(html, `<style ${marker}>\n${css.replace(/<\//g, "<\\/")}\n</style>`);
}

/** `tag` first in the document: right after the `<head>` tag, else after `<html>`, else after the doctype, else first. */
export function withLeadingTag(html: string, tag: string): string {
  for (const open of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = open.exec(html);
    if (match) return html.slice(0, match.index + match[0].length) + tag + html.slice(match.index + match[0].length);
  }
  return tag + html;
}

/** First composition root tag outside scripts, styles and comments. */
function findRoot(html: string): { tag: string; index: number } | null {
  const masked = html.replace(OPAQUE, (text) => " ".repeat(text.length));
  const match = ROOT_TAG.exec(masked);
  return match ? { tag: html.slice(match.index, match.index + match[0].length), index: match.index } : null;
}

/** Value of attribute `name` in an opening tag: double-, single- or unquoted. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** `tag` with attribute `name` set to `value` (double-quoted). */
function setAttribute(tag: string, name: string, value: string): string {
  return tag.replace(new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, "i"), (_, key: string) => `${key}"${value}"`);
}
