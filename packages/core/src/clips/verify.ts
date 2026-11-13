// `clip.verify` (ADR 0033): a generated clip's picture must be a pure function of time. Its live page is captured at
// probe times twice, cold (a fresh page seeks straight to the time) and after a reseek (one page shows an unrelated
// probe first); the two captures of a probe must agree within the tolerance.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type ClipLiveResult,
  type ClipVerifyResult,
  ErrorCode,
  type ProbedElement,
  RpcError,
  VERIFY_DEFAULT_PROBES,
  VERIFY_DEFAULT_TOLERANCE,
} from "@frameshell/protocol";
import type { Size, Timeline } from "@frameshell/schema";
import { Chrome, type ChromePage } from "../inspect/chrome.js";
import { LIVE_PAGE_TIMEOUT_MS, openLivePage } from "../inspect/live-page.js";
import { generatedClips } from "./renderer.js";

const execFileAsync = promisify(execFile);

/** Where in each probe's span the probe falls: `(i + 0.37) / n`, off the frame grid and the clip's edges (#465). */
const PROBE_PHASE = 0.37;

/** What {@link ClipVerifier} needs from the daemon. */
export interface ClipVerifyOptions {
  /** The timeline with nested timelines flattened (ids `<nested clip>/<clip>`) and the project fps. */
  timeline(root: string, id: string): Promise<{ timeline: Timeline; fps: number }>;
  /** The clip's live page (`clip.live`); rejects with `LiveUnavailable` when it has none. */
  live(root: string, timeline: string, clip: string): Promise<ClipLiveResult>;
  /** Project resolution: the page is captured at this size. */
  resolution(root: string): Promise<Size>;
  /** Path of managed `chrome-headless-shell` for the project. */
  chrome(root: string): Promise<string>;
  /** Path of managed `ffmpeg` for the project: it decodes the captures. */
  ffmpeg(root: string): Promise<string>;
}

/** Where two RGBA pictures of one size differ most. */
export interface PixelDifference {
  /** Largest difference of one channel of one pixel, 0 to 255. */
  max: number;
  /** Pixels with a channel that differs by more than the tolerance. */
  pixels: number;
  /** First pixel with the `max` difference; null when the pictures are identical. */
  at: { x: number; y: number } | null;
}

/** Compare two RGBA pictures of `width` pixels per row and the same length; `tolerance` only sets what `pixels` counts. */
export function comparePixels(a: Uint8Array, b: Uint8Array, width: number, tolerance: number): PixelDifference {
  if (a.length !== b.length) throw new Error(`pictures of different sizes (${a.length} and ${b.length} bytes)`);
  let max = 0;
  let pixels = 0;
  let worst = -1;
  for (let i = 0; i < a.length; i += 4) {
    let pixel = 0;
    for (let channel = 0; channel < 4; channel++) pixel = Math.max(pixel, Math.abs(a[i + channel]! - b[i + channel]!));
    if (pixel > tolerance) pixels++;
    if (pixel > max) {
      max = pixel;
      worst = i / 4;
    }
  }
  return { max, pixels, at: worst < 0 ? null : { x: worst % width, y: Math.floor(worst / width) } };
}

/**
 * Probe times of a clip: `count` instants at `(i + 0.37) * duration / count` of its played part, in composition
 * seconds (file time of its render), from the clip's `in`.
 */
export function probeTimes(start: number, duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => round(start + ((i + PROBE_PHASE) * duration) / count));
}

/**
 * Index of the unrelated probe the reseek pass shows before probe `i`: about half the list away, never the probe
 * itself, so the reseek has to move a long way (and back through the clip's later and earlier states).
 */
export function reseekIndex(i: number, count: number): number {
  return (i + Math.max(1, Math.floor(count / 2) - 1)) % count;
}

/** Answers `clip.verify`. */
export class ClipVerifier {
  readonly #options: ClipVerifyOptions;

  constructor(options: ClipVerifyOptions) {
    this.#options = options;
  }

  /**
   * Verify generated clip `clipId` of timeline `id`: `probes` frames, each captured cold and after a reseek.
   * Throws ClipNotFound, LiveUnavailable (no live page, or the page failed), OutsideProject.
   */
  async verify(root: string, request: { timeline: string; clip: string; probes?: number; tolerance?: number }): Promise<ClipVerifyResult> {
    const count = request.probes ?? VERIFY_DEFAULT_PROBES;
    const tolerance = request.tolerance ?? VERIFY_DEFAULT_TOLERANCE;
    const { timeline } = await this.#options.timeline(root, request.timeline);
    const placed = generatedClips(timeline);
    const clip = placed.find((candidate) => candidate.clip.id === request.clip)?.clip;
    if (!clip) {
      const ids = placed.map((candidate) => candidate.clip.id);
      throw new RpcError(
        ErrorCode.ClipNotFound,
        `No generated clip "${request.clip}" on timeline ${timeline.id}` + (ids.length > 0 ? ` (generated clips: ${ids.join(", ")}).` : " (it has none)."),
        { clip: request.clip },
      );
    }
    const live = await this.#options.live(root, request.timeline, clip.id);
    const size = await this.#options.resolution(root);
    const times = probeTimes(clip.in ?? 0, clip.duration, count);
    const chromePath = await this.#options.chrome(root);
    const ffmpeg = await this.#options.ffmpeg(root);
    const scratch = await mkdtemp(join(tmpdir(), "frameshell-verify-"));
    let chrome: Chrome | null = null;
    try {
      chrome = await Chrome.launch(chromePath);
      const cold: Buffer[] = [];
      for (const time of times) {
        const page = await openLivePage(chrome, root, live, size);
        try {
          await seek(page, time);
          cold.push(await page.capture(LIVE_PAGE_TIMEOUT_MS));
        } finally {
          await page.close();
        }
      }
      const probes: ClipVerifyResult["probes"] = [];
      let worst: ClipVerifyResult["worst"] = null;
      const page = await openLivePage(chrome, root, live, size);
      try {
        for (const [i, time] of times.entries()) {
          const from = times[reseekIndex(i, count)]!;
          await seek(page, from);
          await seek(page, time);
          const again = await page.capture(LIVE_PAGE_TIMEOUT_MS);
          let difference: PixelDifference = { max: 0, pixels: 0, at: null };
          // Identical bytes are identical pictures; decode only when they differ.
          if (!cold[i]!.equals(again)) {
            const [a, b] = await Promise.all([decode(ffmpeg, scratch, cold[i]!, `cold-${i}`, size), decode(ffmpeg, scratch, again, `reseek-${i}`, size)]);
            difference = comparePixels(a, b, size.width, tolerance);
          }
          probes.push({ at: time, reseekFrom: from, max: difference.max, pixels: difference.pixels, ok: difference.max <= tolerance });
          // The page still shows this probe, so the element at the pixel is the one that painted the difference.
          if (difference.at && difference.max > (worst?.max ?? 0)) {
            // Where the reseek left the pixel empty, the cold picture is the one that painted it.
            const element = (await elementAt(page, difference.at)) ?? (await coldElementAt(chrome, root, live, size, time, difference.at));
            worst = { at: time, max: difference.max, pixel: difference.at, element };
          }
        }
      } finally {
        await page.close();
      }
      const distinct = new Set(cold.map((png) => createHash("sha256").update(png).digest("hex"))).size;
      const warnings: string[] = [];
      if (distinct === 1) {
        warnings.push(
          "Every probe frame is the same picture: the clip does not move, or the page ignores `seek` (a composition that is not driven by the seek stays on its first frame).",
        );
      }
      return {
        timeline: timeline.id,
        clip: clip.id,
        type: clip.type,
        ok: probes.every((probe) => probe.ok),
        tolerance,
        size,
        probes,
        distinct,
        worst,
        warnings,
      };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      const details = (error as Error)?.message ?? String(error);
      throw new RpcError(ErrorCode.LiveUnavailable, `${clip.type} clip ${clip.id} cannot be verified: ${details}`, {
        clip: clip.id,
        type: clip.type,
        timeline: timeline.id,
        details,
      });
    } finally {
      await chrome?.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Make `page` show composition time `seconds`. */
async function seek(page: ChromePage, seconds: number): Promise<void> {
  await page.evaluate<boolean>(
    `(async () => { const live = window.frameshellLive;` +
      ` if (!live || typeof live.seek !== "function") throw new Error("The live page defines no window.frameshellLive with a seek function.");` +
      ` await live.ready; await live.seek(${JSON.stringify(seconds)}); return true; })()`,
    LIVE_PAGE_TIMEOUT_MS,
  );
}

/** The element painting page pixel `at` on a fresh page at `seconds`. */
async function coldElementAt(chrome: Chrome, root: string, live: ClipLiveResult, size: Size, seconds: number, at: { x: number; y: number }) {
  const page = await openLivePage(chrome, root, live, size);
  try {
    await seek(page, seconds);
    return await elementAt(page, at);
  } finally {
    await page.close();
  }
}

/** The topmost element painting page pixel `at`; null when nothing does or the probe is missing. */
async function elementAt(page: ChromePage, at: { x: number; y: number }): Promise<NonNullable<ClipVerifyResult["worst"]>["element"]> {
  try {
    const [hit] = await page.evaluate<ProbedElement[]>(`window.__frameshellProbe.at(${at.x}, ${at.y}, 0)`, LIVE_PAGE_TIMEOUT_MS);
    if (!hit) return null;
    return { selector: hit.selector, tag: hit.tag, id: hit.id, classes: hit.classes, text: hit.text.slice(0, 80), box: hit.box };
  } catch {
    return null;
  }
}

/** RGBA bytes of a PNG, decoded by ffmpeg through a file in `dir`. */
async function decode(ffmpeg: string, dir: string, png: Buffer, name: string, size: Size): Promise<Buffer> {
  const file = join(dir, `${name}.png`);
  await writeFile(file, png);
  const bytes = size.width * size.height * 4;
  const { stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    encoding: "buffer",
    maxBuffer: bytes + 1024 * 1024,
    windowsHide: true,
  });
  if (stdout.length !== bytes) throw new Error(`a capture decoded to ${stdout.length} bytes, expected ${bytes} for ${size.width}x${size.height}`);
  return stdout;
}
