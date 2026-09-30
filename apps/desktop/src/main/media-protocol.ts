// `frameshell-media://` (SPEC §3.2): proxies, PCM sidecars and still images for the preview, with HTTP range support.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Readable } from "node:stream";

/** URL scheme of preview media. */
export const MEDIA_SCHEME = "frameshell-media";

/**
 * What is served: daemon-derived proxies and sidecars (SPEC §5.1), cached
 * renders of generated clips (§6.5), and still images under `assets/` (no
 * proxy is built for stills; the preview draws the file). `types` limits a folder to those extensions; null allows any.
 */
const SERVED: readonly { dir: string; types: ReadonlySet<string> | null }[] = [
  { dir: ".frameshell/proxies/", types: null },
  { dir: ".frameshell/cache/clips/", types: new Set(["webm", "mp4"]) },
  { dir: "assets/", types: new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]) },
];

const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  pcm: "application/octet-stream",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

/** Renderer workers run on the page's `file://` origin: every reply allows it to read. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

/**
 * Open projects by URL host. Each project a window opens gets an unguessable
 * base URL, `frameshell-media://<token>/`; the renderer appends the
 * project-relative paths `asset.list` reports. A revoked token serves nothing.
 */
export class MediaRoots {
  readonly #roots = new Map<string, string>();

  /** Base URL (trailing `/`) serving derived media of project `dir`. */
  issue(dir: string): string {
    const token = randomBytes(12).toString("hex");
    this.#roots.set(token, dir);
    return `${MEDIA_SCHEME}://${token}/`;
  }

  /** Stop serving a base URL from {@link issue}; unknown URLs are ignored. */
  revoke(base: string): void {
    this.#roots.delete(hostOf(base));
  }

  /** Project dir of a URL host; undefined when not (or no longer) issued. */
  resolve(host: string): string | undefined {
    return this.#roots.get(host);
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
 * Answer one `frameshell-media://` request: GET/HEAD of a file
 * {@link SERVED} in the project the host names, whole (200) or one byte
 * range (206; 416 past the end). 403 for any other path, symlinks leading
 * elsewhere included; 404 for missing files and revoked hosts.
 */
export async function serveMedia(request: Request, roots: MediaRoots): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const root = roots.resolve(url.host);
  if (!root) return reply(404);
  let parts: string[];
  try {
    parts = url.pathname.split("/").map(decodeURIComponent).filter((part) => part !== "" && part !== ".");
  } catch {
    return reply(403);
  }
  const rel = parts.join("/");
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  const served = SERVED.find(({ dir, types }) => rel.startsWith(dir) && (types === null || types.has(ext)));
  if (parts.some((part) => part === ".." || part.includes("/") || part.includes("\\")) || !served) {
    return reply(403);
  }
  let target: string;
  let size: number;
  try {
    target = await realpath(join(root, ...parts));
    const inside = relative(await realpath(join(root, served.dir)), target);
    if (inside.startsWith("..") || inside.split(sep).includes("..")) return reply(403);
    const info = await stat(target);
    if (!info.isFile()) return reply(404);
    size = info.size;
  } catch {
    return reply(404);
  }

  const type = TYPES[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = { ...CORS, "Content-Type": type, "Accept-Ranges": "bytes" };
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") return reply(416, { "Content-Range": `bytes */${size}` });
  const [start, end] = range ?? [0, size - 1];
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const status = range ? 206 : 200;
  if (request.method === "HEAD" || end < start) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

function reply(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...CORS, ...extra } });
}

/**
 * First range of a `Range: bytes=…` header as inclusive `[start, end]`
 * clamped to the file; null for none or a form it does not parse (the whole
 * file is served, as HTTP allows).
 */
function parseRange(header: string | null, size: number): [number, number] | null | "unsatisfiable" {
  const match = header && /^bytes=(\d*)-(\d*)\s*(?:,|$)/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === "" && to === "") return null;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "unsatisfiable";
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? "unsatisfiable" : [start, end];
}
