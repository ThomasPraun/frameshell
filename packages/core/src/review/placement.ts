import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AdapterClip, type FormatLayout, type LayerRect, type Size, type Timeline, formatCrop, layerRect, placementAt, showsPicture } from "@frameshell/schema";
import { generatedClips } from "../clips/renderer.js";
import type { GeneratedSource } from "../export/compiler.js";
import { runTool } from "../media/ffmpeg.js";
import type { ScannedAsset } from "../people/face-clusters.js";
import { GRAPHIC_ALPHA, GRAPHIC_HZ, GRAPHIC_SAMPLES, GRAPHIC_WIDTH } from "./thresholds.js";
import type { Box } from "./safe.js";

// Where graphics and faces are in the film, for the platform safe zones (#457). Pure but for the alpha read: a box of the
// film's pixels over a stretch of timeline seconds, from a generated clip's alpha or a footage clip's cached face scan.

/** A box a subject holds over `[from, to)` timeline seconds. */
export interface BoxSpan {
  subject: "graphic" | "face";
  /** Video track of the clip. */
  track: string;
  clip: string;
  from: number;
  to: number;
  box: Box;
}

/** A box as fractions of the picture it is in: corners from 0 to 1. */
export interface FractionBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Opacity under which a layer is not there. */
const GONE = 0.05;

/** `box` of a `source`-sized picture laid out by `clip` at `at`, in the `film`'s pixels; null when the clip is not drawn then. */
function inFilm(clip: Parameters<typeof placementAt>[0], at: number, source: Size, film: Size, project: Size, box: FractionBox): Box | null {
  const placement = placementAt(clip, at);
  if (placement.opacity < GONE) return null;
  const rect = layerRect(source, film, project, placement);
  return { x0: rect.left + box.x0 * rect.width, y0: rect.top + box.y0 * rect.height, x1: rect.left + box.x1 * rect.width, y1: rect.top + box.y1 * rect.height };
}

/** `box` of a picture of `source` size when `crop` of it fills the `film` (a format that covers the frame), in the film's pixels. */
function inCrop(crop: LayerRect, source: Size, film: Size, box: FractionBox): Box {
  const x = (fraction: number) => ((fraction * source.width - crop.left) / crop.width) * film.width;
  const y = (fraction: number) => ((fraction * source.height - crop.top) / crop.height) * film.height;
  return { x0: x(box.x0), y0: y(box.y0), x1: x(box.x1), y1: y(box.y1) };
}

/**
 * The faces of the footage clips of `timeline` (a flattened one: nested timelines are in it) that a cached face scan
 * knows, as boxes of the `film`'s pixels. A detection holds for the time between two samples of the scan. `layout`: the
 * format the film is laid out in, whose cover crops an untransformed clip to fill the frame. Clips of hidden tracks,
 * multicam shots and assets with no scan give none.
 */
export function faceBoxes(timeline: Timeline, scans: readonly ScannedAsset[], film: Size, project: Size, layout?: FormatLayout): BoxSpan[] {
  const found: BoxSpan[] = [];
  const byAsset = new Map(scans.map((entry) => [entry.asset, entry.scan]));
  const base = timeline.tracks.find(showsPicture);
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || track.hidden === true) continue;
    for (const clip of track.clips) {
      if (clip.type !== "media" || !("asset" in clip)) continue;
      const scan = byAsset.get(clip.asset);
      if (!scan) continue;
      const speed = clip.speed ?? 1;
      const hold = 1 / (scan.hz * speed);
      const source = { width: scan.width, height: scan.height };
      const end = clip.start + (clip.out - clip.in) / speed;
      const crop = formatCrop(layout, clip, { size: source, generated: false, alpha: false, base: base?.id === track.id }, film);
      for (const face of scan.tracks) {
        for (const detected of face.boxes) {
          if (detected.time < clip.in || detected.time >= clip.out) continue;
          const from = clip.start + (detected.time - clip.in) / speed;
          const fraction = { x0: detected.x - detected.width / 2, y0: detected.y - detected.height / 2, x1: detected.x + detected.width / 2, y1: detected.y + detected.height / 2 };
          const box = crop ? inCrop(crop, source, film, fraction) : inFilm(clip, from, source, film, project, fraction);
          if (box) found.push({ subject: "face", track: track.id, clip: clip.id, from, to: Math.min(end, from + hold), box });
        }
      }
    }
  }
  return found;
}

/** Corners of the pixels of a grey picture `width` x `height` at or above {@link GRAPHIC_ALPHA}, as fractions; null when none is. */
export function alphaBox(grey: Uint8Array, width: number, height: number): FractionBox | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (grey[y * width + x]! < GRAPHIC_ALPHA) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height };
}

/** The alpha of `render` over `span` seconds of it from `from`, at up to {@link GRAPHIC_SAMPLES} evenly spaced frames: their boxes (null for an empty frame) and the seconds between them. */
async function alphaSamples(ffmpeg: string, render: GeneratedSource, from: number, span: number, work: string, signal?: AbortSignal): Promise<{ boxes: (FractionBox | null)[]; step: number }> {
  const hz = Math.min(GRAPHIC_HZ, GRAPHIC_SAMPLES / span);
  const width = GRAPHIC_WIDTH;
  const height = Math.max(2, 2 * Math.round((render.height * width) / (render.width * 2)));
  const raw = join(work, "alpha.gray");
  await mkdir(work, { recursive: true });
  try {
    await runTool(
      ffmpeg,
      [
        ...["-hide_banner", "-nostdin", "-loglevel", "error", "-y"],
        // VP9's alpha is a side stream only libvpx decodes (ADR 0002).
        ...(render.hasAlpha ? ["-c:v", "libvpx-vp9"] : []),
        ...["-ss", String(from), "-t", String(span), "-i", render.path],
        ...["-vf", `fps=${hz},alphaextract,scale=${width}:${height}:flags=area,format=gray`, "-frames:v", String(GRAPHIC_SAMPLES), "-an", "-f", "rawvideo", raw],
      ],
      signal ? { signal } : {},
    );
    const bytes = await readFile(raw);
    const boxes: (FractionBox | null)[] = [];
    for (let at = 0; at + width * height <= bytes.length; at += width * height) boxes.push(alphaBox(bytes.subarray(at, at + width * height), width, height));
    return { boxes, step: 1 / hz };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** What {@link graphicBoxes} reads and where it works. */
export interface GraphicsInput {
  ffmpeg: string;
  /** A flattened timeline, as export lays it out. */
  timeline: Timeline;
  /** Render of each generated clip by id. */
  renders: ReadonlyMap<string, GeneratedSource>;
  film: Size;
  project: Size;
  /** Folder for scratch files; each clip makes its own subfolder. */
  work: string;
  signal?: AbortSignal | undefined;
}

/**
 * The picture a generated clip draws, as boxes of the film's pixels: the extent of its alpha at up to {@link GRAPHIC_SAMPLES}
 * frames of the clip, each held until the next. A render with no alpha fills its frame, so it has no box to judge: its clip id
 * goes in `opaque`. A clip with no render yet is left out.
 */
export async function graphicBoxes(input: GraphicsInput): Promise<{ boxes: BoxSpan[]; opaque: string[] }> {
  const boxes: BoxSpan[] = [];
  const opaque: string[] = [];
  for (const { clip, track } of generatedClips(input.timeline)) {
    const render = input.renders.get(clip.id);
    const trackOf = input.timeline.tracks.find((candidate) => candidate.id === track);
    if (!render || trackOf?.kind !== "video" || trackOf.hidden === true) continue;
    if (!render.hasAlpha) {
      opaque.push(clip.id);
      continue;
    }
    const adapter = clip as AdapterClip;
    const sampled = await alphaSamples(input.ffmpeg, render, adapter.in ?? 0, adapter.duration, join(input.work, `alpha-${clip.id}`), input.signal);
    for (const [k, fraction] of sampled.boxes.entries()) {
      if (!fraction) continue;
      const from = adapter.start + k * sampled.step;
      const box = inFilm(adapter, from, render, input.film, input.project, fraction);
      if (box) boxes.push({ subject: "graphic", track, clip: clip.id, from, to: Math.min(adapter.start + adapter.duration, from + sampled.step), box });
    }
  }
  return { boxes, opaque };
}
