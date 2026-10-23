// `inspect.point` (ADR 0011): what a point of the frame shows, for agents and the app's `ui.select` points. The clip
// stack comes from the export placement; elements of generated clips from their live page in managed headless Chrome,
// probed with the same script as the app's Pick tool.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type ClipLiveResult,
  ErrorCode,
  type InspectedPoint,
  type MethodResult,
  PROBE_MAX_DEPTH,
  PROBE_SCRIPT,
  type ProbedElement,
  RpcError,
  markGenerated,
} from "@frameshell/protocol";
import { type AnyClip, type Size, type Timeline, isShotClip, layerRect, placementAt, programGroup, shotLayers } from "@frameshell/schema";
import { Chrome } from "./chrome.js";

/** Alpha × opacity below this does not count as painting, as in the app (`PAINT_MIN`). */
const PAINT_MIN = 0.05;
/** Origin the probed pages are served from; requests to it never reach the network. */
const ORIGIN = "http://frameshell-inspect.invalid";
/** Longest wait for one page to load, get ready and seek. */
const PAGE_TIMEOUT_MS = 60_000;

/** What {@link InspectService} needs from the daemon. */
export interface InspectOptions {
  /** The timeline with nested timelines flattened (ids `<nested clip>/<clip>`) and the project fps. */
  timeline(root: string, id: string): Promise<{ timeline: Timeline; fps: number }>;
  /** Project resolution. */
  resolution(root: string): Promise<Size>;
  /** Picture size of an asset; null when it has none (audio only). */
  pictureSize(root: string, asset: string): Promise<Size | null>;
  /** The clip's live page (`clip.live`); rejects with `LiveUnavailable` when it has none. */
  live(root: string, timeline: string, clip: string): Promise<ClipLiveResult>;
  /** Path of managed `chrome-headless-shell` for the project. */
  chrome(root: string): Promise<string>;
}

/** Result of `inspect.point` before the daemon adds which view it shows. */
export type InspectResult = Omit<MethodResult<"inspect.point">, "view" | "proposal">;

interface Hit {
  clip: AnyClip;
  type: string;
  paints: boolean;
  generated: boolean;
  /** Where its picture lies, project pixels. */
  rect: { left: number; top: number; width: number; height: number };
}

/** Answers `inspect.point`. */
export class InspectService {
  readonly #options: InspectOptions;

  constructor(options: InspectOptions) {
    this.#options = options;
  }

  /**
   * What point (`x`, `y`, fractions of the frame) of timeline `id` shows at `at` seconds.
   * `loaded`: the flattened timeline to inspect instead of the file's (a review-mode proposal's version).
   */
  async point(
    root: string,
    request: { timeline: string; at: number; x: number; y: number; unit?: "fraction" | "pixel" },
    loaded?: { timeline: Timeline; fps: number },
  ): Promise<InspectResult> {
    const { timeline, fps } = loaded ?? (await this.#options.timeline(root, request.timeline));
    const resolution = await this.#options.resolution(root);
    const pixels = request.unit === "pixel";
    const params = { ...request, x: pixels ? request.x / resolution.width : request.x, y: pixels ? request.y / resolution.height : request.y };
    if (params.x > 1 || params.y > 1) {
      const where = pixels ? `${request.x},${request.y} px is outside the ${resolution.width}x${resolution.height} frame` : `${request.x},${request.y} is not a fraction of the frame (0 to 1)`;
      throw new RpcError(ErrorCode.InvalidOperation, `The point ${where}.`, { op: "inspect.point", reason: "out of range", field: pixels ? "x/y (pixels)" : "x/y" });
    }
    const frame = Math.floor((params.at + 0.0005) * fps);
    const frames = Math.max(0, ...timeline.tracks.flatMap((track) => (track.kind === "subtitles" ? [] : track.clips.map((clip) => endFrame(clip, fps)))));
    if (frame < 0 || frame >= frames) {
      const last = Math.max(0, frames - 1) / fps;
      throw new RpcError(ErrorCode.InvalidOperation, `at ${params.at} s is outside timeline ${timeline.id} (frames start from 0 to ${last} s).`, {
        op: "inspect.point",
        reason: "out of range",
        field: "at",
        valid: { min: 0, max: last },
      });
    }
    const pixel = { x: params.x * resolution.width, y: params.y * resolution.height };
    const hits = await this.#hits(root, timeline, fps, frame, resolution, pixel);
    const at = frame / fps;
    const result: InspectedPoint = { x: params.x, y: params.y, at, layers: [], target: null, elements: [], unavailable: null };
    let chrome: Chrome | null = null;
    try {
      for (const hit of hits) {
        if (!hit.generated) {
          if (hit.paints) {
            result.target = hit.clip.id;
            break;
          }
          continue;
        }
        let elements: ProbedElement[] | null = null;
        let unavailable: string | null = null;
        try {
          // The page first: an untrusted project or a clip without live preview never starts Chrome.
          const live = await this.#options.live(root, params.timeline, hit.clip.id);
          chrome ??= await Chrome.launch(await this.#options.chrome(root));
          const page = { x: ((pixel.x - hit.rect.left) / hit.rect.width) * resolution.width, y: ((pixel.y - hit.rect.top) / hit.rect.height) * resolution.height };
          const seconds = ("in" in hit.clip && typeof hit.clip.in === "number" ? hit.clip.in : 0) + (at - hit.clip.start);
          elements = await this.#probe(chrome, root, live, resolution, seconds, page);
        } catch (error) {
          unavailable = error instanceof RpcError ? (error.data as { details?: string } | undefined)?.details ?? error.message : (error as Error).message;
        }
        if (elements) {
          hit.paints = elements.length > 0;
          if (elements.length > 0) {
            result.target = hit.clip.id;
            result.elements = await markGenerated(elements, (path) => readProjectFile(root, path));
            break;
          }
          continue;
        }
        if (hit.paints) {
          result.target = hit.clip.id;
          result.unavailable = unavailable;
          break;
        }
      }
    } finally {
      await chrome?.close();
    }
    result.layers = hits.map((hit) => ({ clip: hit.clip.id, type: hit.type, paints: hit.paints }));
    return { ...result, timeline: timeline.id, frame, pixel: { x: Math.round(pixel.x), y: Math.round(pixel.y) } };
  }

  /** Every clip whose picture's box holds `pixel` at `frame`, topmost first; `paints` from opacity alone. */
  async #hits(root: string, timeline: Timeline, fps: number, frame: number, resolution: Size, pixel: { x: number; y: number }): Promise<Hit[]> {
    const hits: Hit[] = [];
    for (const track of timeline.tracks) {
      if (track.kind === "program") {
        const shot = track.clips.find((candidate) => Math.round(candidate.start * fps) <= frame && frame < endFrame(candidate, fps));
        const group = programGroup(timeline, track);
        if (!shot || !group) continue;
        const sizes = new Map<string, Size>();
        for (const angle of group.angles) sizes.set(angle.asset, (await this.#options.pictureSize(root, angle.asset)) ?? resolution);
        const layer = shotLayers(shot, group, resolution, (asset) => sizes.get(asset) ?? resolution).find(
          ({ tile }) => pixel.x >= tile.left && pixel.x < tile.left + tile.width && pixel.y >= tile.top && pixel.y < tile.top + tile.height,
        );
        if (layer) hits.unshift({ clip: shot, type: "shot", paints: true, generated: false, rect: layer.tile });
        continue;
      }
      if (track.kind !== "video") continue;
      const clip = track.clips.find((candidate) => Math.round(candidate.start * fps) <= frame && frame < endFrame(candidate, fps));
      if (!clip || clip.type === "timeline") continue;
      const generated = clip.type !== "media";
      // Renders are made at the project format.
      const size = generated ? resolution : await this.#options.pictureSize(root, (clip as { asset: string }).asset);
      if (!size) continue;
      // Keys and the nested clips it plays inside move it: where it is on this frame.
      const placement = placementAt(clip, frame / fps);
      const rect = layerRect(size, resolution, resolution, placement);
      if (pixel.x < rect.left || pixel.x >= rect.left + rect.width || pixel.y < rect.top || pixel.y >= rect.top + rect.height) continue;
      hits.unshift({ clip, type: generated ? clip.type : "media", paints: placement.opacity >= PAINT_MIN, generated, rect });
    }
    return hits;
  }

  /** Elements of a clip's live page `live` painting page pixel `at` once it shows `seconds`. */
  async #probe(chrome: Chrome, root: string, live: ClipLiveResult, size: Size, seconds: number, at: { x: number; y: number }): Promise<ProbedElement[]> {
    const page = await chrome.page(size.width, size.height, ORIGIN, (request) => serve(root, live, request.url));
    try {
      const inRoot = live.root === "." ? live.entry : live.entry.slice(live.root.length + 1);
      await page.navigate(`${ORIGIN}/${inRoot.split("/").map(encodeURIComponent).join("/")}`, PAGE_TIMEOUT_MS);
      const script =
        `(async () => { const live = window.frameshellLive;` +
        ` if (!live || typeof live.seek !== "function") throw new Error("The live page defines no window.frameshellLive with a seek function.");` +
        ` await live.ready; await live.seek(${JSON.stringify(seconds)});` +
        ` return window.__frameshellProbe.at(${JSON.stringify(at.x)}, ${JSON.stringify(at.y)}, ${PROBE_MAX_DEPTH}); })()`;
      return await page.evaluate<ProbedElement[]>(script, PAGE_TIMEOUT_MS);
    } finally {
      await page.close();
    }
  }
}

/** Last frame + 1 of a clip on the frame grid; its start for an unresolved nested clip. */
function endFrame(clip: AnyClip, fps: number): number {
  const start = Math.round(clip.start * fps);
  if ("asset" in clip) return Math.max(start + 1, Math.round((clip.start + (clip.out - clip.in) / (clip.speed ?? 1)) * fps));
  if (isShotClip(clip)) return Math.max(start + 1, Math.round((clip.start + (clip.out - clip.in)) * fps));
  return clip.duration !== undefined ? Math.max(start + 1, Math.round((clip.start + clip.duration) * fps)) : start;
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
    if (rel === live.entry) return { status: 200, contentType, body: Buffer.from(injectHead(await readFile(target, "utf8"), live.head), "utf8") };
    return { status: 200, contentType, body: await readFile(target) };
  } catch {
    return { status: 404 };
  }
}

/** The adapter's `head` and the probe script at the start of `<head>` (else after `<html>`, the doctype, or first). */
function injectHead(html: string, head: string): string {
  const scripts = `<script>${head}</script><script>${PROBE_SCRIPT}</script>`;
  for (const tag of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    if (tag.test(html)) return html.replace(tag, (open) => open + scripts);
  }
  return scripts + html;
}

function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** A project file's text, for {@link markGenerated}; rejects outside the project. */
async function readProjectFile(root: string, path: string): Promise<string> {
  const target = await realpath(join(root, ...path.split("/")));
  if (escapes(relative(await realpath(root), target))) throw new Error(`${path} is outside the project`);
  return readFile(target, "utf8");
}
