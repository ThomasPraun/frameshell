// `inspect.point` (ADR 0011): what a point of the frame shows, for agents and the app's `ui.select` points. The clip
// stack comes from the export placement; elements of generated clips from their live page in managed headless Chrome,
// probed with the same script as the app's Pick tool.
import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type ClipLiveResult,
  ErrorCode,
  type InspectedPoint,
  type MethodResult,
  PROBE_MAX_DEPTH,
  type ProbedElement,
  RpcError,
  type SegmentedPoint,
  markGenerated,
} from "@frameshell/protocol";
import { type AnyClip, type Size, type Timeline, isShotClip, isSubjectClip, layerRect, placementAt, programGroup, shotLayers, showsPicture } from "@frameshell/schema";
import type { InstallProgress } from "../binaries/manager.js";
import { writeContext } from "../context.js";
import { encodeGrayPng } from "../segment/png.js";
import type { PhotoPoint, SegmentResult } from "../segment/segmenter.js";
import { Chrome } from "./chrome.js";
import { LIVE_PAGE_TIMEOUT_MS, escapes, openLivePage } from "./live-page.js";

/** Alpha × opacity below this does not count as painting, as in the app (`PAINT_MIN`). */
const PAINT_MIN = 0.05;

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
  /** True when the project is an image project (ADR 0017); photos are segmented only there. */
  imageProject(root: string): Promise<boolean>;
  /**
   * The three masks of the part of still image `asset` under `point` (asset pixels) and the pinned model;
   * rejects with `InvalidOperation` when the asset is not a still image.
   */
  segment(root: string, asset: string, point: PhotoPoint, onProgress?: (progress: InstallProgress) => void): Promise<SegmentResult & { model: string }>;
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
    request: { timeline: string; at: number; x: number; y: number; unit?: "fraction" | "pixel"; segment?: boolean },
    loaded?: { timeline: Timeline; fps: number },
    onProgress?: (progress: InstallProgress) => void,
  ): Promise<InspectResult> {
    const { timeline, fps } = loaded ?? (await this.#options.timeline(root, request.timeline));
    const resolution = await this.#options.resolution(root);
    const pixels = request.unit === "pixel";
    const { segment: wantSegment = false, ...where } = request;
    const params = { ...where, x: pixels ? request.x / resolution.width : request.x, y: pixels ? request.y / resolution.height : request.y };
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
    if (wantSegment) {
      const seen = hits.find((hit) => hit.clip.id === result.target);
      const photo = await this.#segment(root, seen, resolution, pixel, frame, onProgress);
      if (typeof photo === "string") result.segmentUnavailable = photo;
      else result.segment = photo;
    }
    result.layers = hits.map((hit) => ({ clip: hit.clip.id, type: hit.type, paints: hit.paints }));
    return { ...result, timeline: timeline.id, frame, pixel: { x: Math.round(pixel.x), y: Math.round(pixel.y) } };
  }

  /**
   * The photo seen at `pixel` segmented: the point maps through the inverse of the clip's placement into the
   * asset's own pixels. A string is why nothing was segmented.
   */
  async #segment(
    root: string,
    seen: Hit | undefined,
    resolution: Size,
    pixel: { x: number; y: number },
    frame: number,
    onProgress?: (progress: InstallProgress) => void,
  ): Promise<SegmentedPoint | string> {
    if (!(await this.#options.imageProject(root))) return "not an image project";
    if (!seen) return "black";
    if (seen.generated || seen.type !== "media") return "not a still image";
    const asset = (seen.clip as { asset: string }).asset;
    const size = await this.#options.pictureSize(root, asset);
    if (!size) return "not a still image";
    const { rect } = seen;
    const at = {
      x: Math.min(size.width - 1, Math.max(0, ((pixel.x - rect.left) / rect.width) * size.width)),
      y: Math.min(size.height - 1, Math.max(0, ((pixel.y - rect.top) / rect.height) * size.height)),
    };
    let found: SegmentResult & { model: string };
    try {
      found = await this.#options.segment(root, asset, at, onProgress);
    } catch (error) {
      if (error instanceof RpcError && error.code === ErrorCode.InvalidOperation) return "not a still image";
      throw error;
    }
    const prefix = `m_${String(frame).padStart(4, "0")}_${Math.round(at.x)}_${Math.round(at.y)}`;
    const toFrame = (x: number, y: number): [number, number] => [(rect.left + (x / found.width) * rect.width) / resolution.width, (rect.top + (y / found.height) * rect.height) / resolution.height];
    const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4;
    const masks: SegmentedPoint["masks"] = [];
    for (const [index, mask] of found.masks.entries()) {
      const { path } = await writeContext(root, `${prefix}_${index + 1}.png`, encodeGrayPng(mask.mask, found.width, found.height));
      const [x, y, w, h] = mask.bbox;
      const [x0, y0] = toFrame(x, y);
      const [x1, y1] = toFrame(x + w, y + h);
      masks.push({ mask: path, bbox: mask.bbox, frameBox: [round(x0), round(y0), round(x1), round(y1)], area: round(mask.area), score: round(mask.score) });
    }
    return { asset, size: { width: found.width, height: found.height }, model: found.model, chosen: found.chosen, masks };
  }

  /** Every clip whose picture's box holds `pixel` at `frame`, topmost first; `paints` from opacity alone. */
  async #hits(root: string, timeline: Timeline, fps: number, frame: number, resolution: Size, pixel: { x: number; y: number }): Promise<Hit[]> {
    const hits: Hit[] = [];
    for (const track of timeline.tracks) {
      if (!showsPicture(track)) continue;
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
      // A subject layer is the plate drawn again where its person is, not a clip of its own (ADR 0032).
      if (!clip || clip.type === "timeline" || isSubjectClip(clip)) continue;
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
    const page = await openLivePage(chrome, root, live, size);
    try {
      const script =
        `(async () => { const live = window.frameshellLive;` +
        ` if (!live || typeof live.seek !== "function") throw new Error("The live page defines no window.frameshellLive with a seek function.");` +
        ` await live.ready; await live.seek(${JSON.stringify(seconds)});` +
        ` return window.__frameshellProbe.at(${JSON.stringify(at.x)}, ${JSON.stringify(at.y)}, ${PROBE_MAX_DEPTH}); })()`;
      return await page.evaluate<ProbedElement[]>(script, LIVE_PAGE_TIMEOUT_MS);
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

/** A project file's text, for {@link markGenerated}; rejects outside the project. */
async function readProjectFile(root: string, path: string): Promise<string> {
  const target = await realpath(join(root, ...path.split("/")));
  if (escapes(relative(await realpath(root), target))) throw new Error(`${path} is outside the project`);
  return readFile(target, "utf8");
}
