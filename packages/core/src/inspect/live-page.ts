// What a headless Chrome needs to show a clip's live page (ADR 0010) the way the app's `frameshell-live:` scheme does:
// its files served from the project, the adapter's `head` inserted. Shared by `inspect.point` and `clip.verify`.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { type ClipLiveResult, PROBE_SCRIPT } from "@frameshell/protocol";
import type { Size } from "@frameshell/schema";
import type { Chrome, ChromePage } from "./chrome.js";

/** Origin the live pages are served from; requests to it never reach the network. */
const ORIGIN = "http://frameshell-inspect.invalid";
/** Longest wait for one page to load, get ready and seek. */
export const LIVE_PAGE_TIMEOUT_MS = 60_000;

/**
 * A page of `chrome` at `size` loaded with the live page `live` of a project (its files served from `project`),
 * with the element probe defined as `window.__frameshellProbe`. The caller closes it.
 */
export async function openLivePage(chrome: Chrome, project: string, live: ClipLiveResult, size: Size): Promise<ChromePage> {
  const page = await chrome.page(size.width, size.height, ORIGIN, (request) => serve(project, live, request.url));
  try {
    const inRoot = live.root === "." ? live.entry : live.entry.slice(live.root.length + 1);
    await page.navigate(`${ORIGIN}/${inRoot.split("/").map(encodeURIComponent).join("/")}`, LIVE_PAGE_TIMEOUT_MS);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/**
 * A request of a probed page: files under the page's `root` only (realpath
 * contained, as the app's `frameshell-live:` scheme serves them), the entry
 * with the adapter's `head` and the probe script inserted. Other origins go
 * to the network (null).
 */
async function serve(project: string, live: ClipLiveResult, url: string): Promise<{ status: number; contentType?: string; body?: Buffer } | null> {
  if (!url.startsWith(`${ORIGIN}/`)) return null;
  let parts: string[];
  try {
    parts = new URL(url).pathname.split("/").map(decodeURIComponent).filter((part) => part !== "" && part !== ".");
  } catch {
    return { status: 403 };
  }
  if (parts.some((part) => part === ".." || part.includes("/") || part.includes("\\"))) return { status: 403 };
  const rootParts = live.root.split("/").filter((part) => part !== ".");
  try {
    const realRoot = await realpath(join(project, ...rootParts));
    if (escapes(relative(await realpath(project), realRoot))) return { status: 403 };
    const target = await realpath(join(realRoot, ...parts));
    if (escapes(relative(realRoot, target))) return { status: 403 };
    if (!(await stat(target)).isFile()) return { status: 404 };
    const rel = [...rootParts, ...parts].join("/");
    const contentType = TYPES[rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
    if (rel === live.entry) return { status: 200, contentType, body: Buffer.from(injectProbeHead(await readFile(target, "utf8"), live.head, live.elementCss, live.styleCss), "utf8") };
    return { status: 200, contentType, body: await readFile(target) };
  } catch {
    return { status: 404 };
  }
}

/**
 * The adapter's `head` and the probe script at the start of `<head>` (else after `<html>`, the doctype, or first),
 * with the clip's element sheet so boxes are those of the adjusted page (ADR 0021). A non-empty `styleCss` (style
 * tokens, ADR 0028) goes first, as in the render and the app's live page, so `var(--fs-*)` resolve as rendered.
 */
export function injectProbeHead(html: string, head: string, elementCss = "", styleCss = ""): string {
  const tokens = styleCss === "" ? "" : `<style data-frameshell-style>${styleCss.replace(/<\//g, "<\\/")}</style>`;
  const sheet = elementCss === "" ? "" : `<style data-frameshell-elements>${elementCss}</style>`;
  const scripts = `${tokens}<script>${head}</script><script>${PROBE_SCRIPT}</script>${sheet}`;
  for (const tag of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    if (tag.test(html)) return html.replace(tag, (open) => open + scripts);
  }
  return scripts + html;
}

export function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
