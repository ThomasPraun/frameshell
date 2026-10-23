// `frameshell-live://` (ADR 0010): live pages of generated clips, served from the project into a sandboxed preview iframe.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { PROBE_MAX_DEPTH, PROBE_MAX_ELEMENTS, PROBE_SCRIPT } from "@frameshell/protocol";
import { parseRange } from "./media-protocol.js";

/** URL scheme of live pages. */
export const LIVE_SCHEME = "frameshell-live";

/** One live page as `clip.live` returns it: project-relative, `/`-separated `root` and `entry`, and the adapter's `head`. */
export interface LivePageSource {
  /** Project directory, absolute. */
  project: string;
  /** Directory served, project-relative (`.` = the project). */
  root: string;
  /** Entry HTML, project-relative, inside `root`. */
  entry: string;
  /** Script text inserted at the start of the entry's `<head>`. */
  head: string;
  /** Sheet of the clip's `elements` (ADR 0021) the bridge applies first; absent when it has none. */
  elementCss?: string;
}

/** Messages between the preview and a live page's bridge. */
export const LIVE_MESSAGE = {
  /**
   * `source` of what the preview posts: `{ source, seek: seconds }`, and the
   * element probes of ADR 0011, `{ source, probe: { id, x, y, depth } }` and
   * `{ source, probeRect: { id, x0, y0, x1, y1, max } }` (page pixels), and for
   * ADR 0021 the element sheet, `{ source, elements: { id, css?, selectors? } }`,
   * and the element an adjustment moves, `{ source, probeMovable: { id, x, y, depth } }`
   * or `{ source, probeSelector: { id, selector } }`.
   */
  toPage: "frameshell-preview",
  /**
   * `source` of what the bridge posts: `{ source, ready: true }`,
   * `{ source, shown: seconds }`, `{ source, error }`, and the answer to a
   * probe, `{ source, probe: { id, elements } }` (`ProbedElement`s; for
   * `probeMovable` and `probeSelector` at most one, with its `unit`), and the
   * answer to `elements`, `{ source, elements: { id, counts } }`.
   */
  fromPage: "frameshell-live",
} as const;

/**
 * Host bridge, inserted after the adapter's `head`. It turns the parent's
 * `{ seek }` messages into `frameshellLive.seek` calls, one at a time:
 * while a seek runs, only the latest request waits, older ones are dropped.
 * It answers `ready` once `frameshellLive.ready` settles, `shown` after each
 * seek, and `error` when either fails or the page defines no `frameshellLive`.
 * A probe (ADR 0011) runs {@link PROBE_SCRIPT} once the page is ready and no
 * seek is pending, so it describes the frame last seeked to. Messages come
 * from the parent, or from the parent's opener: a page in a detached panel's
 * window (ADR 0012) is driven by the project window's renderer, which opened
 * that window, so it gains nothing new.
 *
 * The bridge owns the one `<style data-frameshell-elements>` of the clip's
 * element adjustments (ADR 0021): the first sheet comes from the script tag's
 * `data-frameshell-elements` attribute ({@link injectHead}); `{ elements: { id,
 * css, selectors } }` swaps the sheet without a reload (`css` absent keeps it,
 * `""` clears it). The sheet is re-appended to the end of `<head>` on each swap
 * and at `DOMContentLoaded`, so it follows the composition's own styles. Once
 * the page is ready and no seek is pending it answers `{ elements: { id, counts } }`:
 * how many elements each of `selectors` matches in the frame shown (0 for a
 * selector that matches nothing or is not valid).
 */
export const LIVE_BRIDGE = `${PROBE_SCRIPT}
(function () {
  var post = function (message) { message.source = "${LIVE_MESSAGE.fromPage}"; window.parent.postMessage(message, "*"); };
  var fail = function (error) { post({ error: String((error && error.message) || error) }); };
  var live = window.frameshellLive;
  if (!live || typeof live.seek !== "function") return fail("The live page defines no window.frameshellLive with a seek function.");
  var ready = Promise.resolve(live.ready);
  var pending = null;
  var running = false;
  var next = function () {
    if (running || pending === null) return;
    var seconds = pending;
    pending = null;
    running = true;
    ready
      .then(function () { return live.seek(seconds); })
      .then(function () { post({ shown: seconds }); }, fail)
      .then(function () { running = false; next(); });
  };
  var settled = function () {
    return new Promise(function (resolve) {
      (function check() { if (!running && pending === null) resolve(); else setTimeout(check, 16); })();
    });
  };
  var probe = function (id, run) {
    ready
      .then(settled)
      .then(run)
      .then(function (found) {
        var answer = Array.isArray(found) ? { id: id, elements: found } : { id: id, elements: found ? [found.element] : [], unit: found ? found.unit : 1 };
        post({ probe: answer });
      }, function (error) { post({ probe: { id: id, elements: [], error: String((error && error.message) || error) } }); });
  };
  var sheet = null;
  var applySheet = function (css) {
    if (css === null) return;
    if (!sheet) { sheet = document.createElement("style"); sheet.setAttribute("data-frameshell-elements", ""); }
    sheet.textContent = css;
    (document.head || document.documentElement).appendChild(sheet);
  };
  var count = function (selectors) {
    var counts = {};
    selectors.forEach(function (selector) {
      try { counts[selector] = document.querySelectorAll(selector).length; } catch (e) { counts[selector] = 0; }
    });
    return counts;
  };
  var first = document.currentScript && document.currentScript.getAttribute("data-frameshell-elements");
  if (typeof first === "string" && first !== "") {
    applySheet(first);
    document.addEventListener("DOMContentLoaded", function () { applySheet(sheet.textContent); });
  }
  var num = function (value) { return typeof value === "number" && isFinite(value); };
  window.addEventListener("message", function (event) {
    var data = event.data;
    if ((event.source !== window.parent && event.source !== window.parent.opener) || !data || data.source !== "${LIVE_MESSAGE.toPage}") return;
    if (typeof data.seek === "number") {
      pending = data.seek;
      next();
      return;
    }
    var swap = data.elements;
    if (swap && num(swap.id)) {
      applySheet(typeof swap.css === "string" ? swap.css : null);
      var selectors = Array.isArray(swap.selectors) ? swap.selectors.filter(function (s) { return typeof s === "string"; }) : [];
      ready.then(settled).then(function () { post({ elements: { id: swap.id, counts: count(selectors) } }); }, fail);
      return;
    }
    var at = data.probe;
    if (at && num(at.id) && num(at.x) && num(at.y)) {
      var depth = num(at.depth) ? Math.max(0, Math.min(${PROBE_MAX_DEPTH}, at.depth)) : 0;
      probe(at.id, function () { return window.__frameshellProbe.at(at.x, at.y, depth); });
      return;
    }
    var rect = data.probeRect;
    if (rect && num(rect.id) && num(rect.x0) && num(rect.y0) && num(rect.x1) && num(rect.y1)) {
      var max = num(rect.max) ? Math.max(0, Math.min(${PROBE_MAX_ELEMENTS}, rect.max)) : ${PROBE_MAX_ELEMENTS};
      probe(rect.id, function () { return window.__frameshellProbe.within(rect.x0, rect.y0, rect.x1, rect.y1, max); });
      return;
    }
    var move = data.probeMovable;
    if (move && num(move.id) && num(move.x) && num(move.y)) {
      var up = num(move.depth) ? Math.max(0, Math.min(${PROBE_MAX_DEPTH}, move.depth)) : 0;
      probe(move.id, function () { return window.__frameshellProbe.movable(move.x, move.y, up); });
      return;
    }
    var named = data.probeSelector;
    if (named && num(named.id) && typeof named.selector === "string") {
      probe(named.id, function () { return window.__frameshellProbe.element(named.selector); });
    }
  });
  ready.then(function () { post({ ready: true }); }, fail);
})();`;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  wasm: "application/wasm",
};

/**
 * The page has an opaque origin (sandboxed without `allow-same-origin`), so
 * module scripts, fonts and fetches need CORS. Never cached: a page reloads
 * after its composition changes.
 */
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  "Cache-Control": "no-store",
};

/**
 * Live pages by URL host. Each page gets an unguessable base URL,
 * `frameshell-live://<token>/`, serving its `root`; a revoked token serves
 * nothing.
 */
export class LivePages {
  readonly #pages = new Map<string, LivePageSource>();

  /** URL of the entry of `page`, under a new token. Throws when `head` would close the `<script>` it goes in. */
  issue(page: LivePageSource): string {
    if (/<\/script/i.test(page.head)) throw new Error("The adapter's live page head contains `</script`, so it cannot be inserted into the page.");
    const token = randomBytes(12).toString("hex");
    this.#pages.set(token, page);
    const inRoot = page.root === "." ? page.entry : page.entry.slice(page.root.length + 1);
    return `${LIVE_SCHEME}://${token}/${inRoot.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Stop serving the page of a URL from {@link issue}; unknown URLs are ignored. */
  revoke(url: string): void {
    this.#pages.delete(hostOf(url));
  }

  /** Stop serving every page of project `dir`. */
  revokeProject(dir: string): void {
    for (const [token, page] of this.#pages) if (page.project === dir) this.#pages.delete(token);
  }

  /** Page of a URL host; undefined when not (or no longer) issued. */
  resolve(host: string): LivePageSource | undefined {
    return this.#pages.get(host);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Answer one `frameshell-live://` request: GET/HEAD of a file under the
 * page's `root`, whole or one byte range (media elements seek with ranges).
 * The entry gets the adapter's `head` and {@link LIVE_BRIDGE} at the start of
 * its `<head>`; every other file is served as it is. 403 for paths leaving
 * `root`, symlinks included; 404 for missing files and revoked hosts.
 */
export async function serveLive(request: Request, pages: LivePages): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const url = new URL(request.url);
  const page = pages.resolve(url.host);
  if (!page) return reply(404);
  let parts: string[];
  try {
    parts = url.pathname.split("/").map(decodeURIComponent).filter((part) => part !== "" && part !== ".");
  } catch {
    return reply(403);
  }
  if (parts.some((part) => part === ".." || part.includes("/") || part.includes("\\"))) return reply(403);
  const rootDir = join(page.project, ...page.root.split("/").filter((part) => part !== "."));
  let target: string;
  let size: number;
  try {
    const realRoot = await realpath(rootDir);
    if (escapes(relative(await realpath(page.project), realRoot))) return reply(403);
    target = await realpath(join(rootDir, ...parts));
    if (escapes(relative(realRoot, target))) return reply(403);
    const info = await stat(target);
    if (!info.isFile()) return reply(404);
    size = info.size;
  } catch {
    return reply(404);
  }

  const rel = [...page.root.split("/").filter((part) => part !== "."), ...parts].join("/");
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";
  if (rel === page.entry) {
    const html = injectHead(await readFile(target, "utf8"), page.head, page.elementCss);
    const body = Buffer.from(html, "utf8");
    const headers = { ...HEADERS, "Content-Type": type, "Content-Length": String(body.length) };
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  }
  const headers: Record<string, string> = { ...HEADERS, "Content-Type": type, "Accept-Ranges": "bytes" };
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") return reply(416, { "Content-Range": `bytes */${size}` });
  const [start, end] = range ?? [0, size - 1];
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (request.method === "HEAD" || end < start) return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream<Uint8Array>, { status, headers });
}

/**
 * `html` with `head` and the bridge as the first scripts of the document:
 * right after the `<head>` tag, else after `<html>`, else after the
 * doctype (so the page keeps standards mode), else first. A function
 * replacement keeps `$` sequences in the scripts literal. A non-empty
 * `elementCss` is the bridge's first element sheet, carried as an attribute.
 */
export function injectHead(html: string, head: string, elementCss?: string): string {
  const initial = elementCss ? ` data-frameshell-elements="${escapeAttribute(elementCss)}"` : "";
  const scripts = `<script>${head}</script><script${initial}>${LIVE_BRIDGE}</script>`;
  for (const tag of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    if (tag.test(html)) return html.replace(tag, (open) => open + scripts);
  }
  return scripts + html;
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True when a `relative()` result leaves its base. */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function reply(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...HEADERS, ...extra } });
}
