import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import type { JobStep } from "@frameshell/protocol";
import { writeJsonAtomic } from "../fs-util.js";
import type { JobContext } from "../jobs/queue.js";
import { ToolError, probeMedia, runTool } from "./ffmpeg.js";
import {
  PEAKS_PER_SECOND,
  RECIPE_VERSION,
  SIDECAR_CHANNELS,
  SIDECAR_SAMPLE_RATE,
  proxyArgs,
  sidecarArgs,
  thumbnailArgs,
  thumbnailInterval,
} from "./recipe.js";
import { DERIVED_DIRS, type Manifest, type MediaStore } from "./store.js";

/** Resolved executables. */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

/** Share of overall progress per step, by typical cost. */
const WEIGHTS: Record<JobStep, number> = { hash: 0.05, probe: 0.02, proxy: 0.6, sidecar: 0.13, waveform: 0.05, thumbnails: 0.15 };
const ORDER: JobStep[] = ["hash", "probe", "proxy", "sidecar", "waveform", "thumbnails"];

/** Inputs of {@link ingestAsset}. */
export interface IngestOptions {
  store: MediaStore;
  /** Project-relative asset path. */
  rel: string;
  /** Project fps: proxy rate and part of the cache key. */
  fps: number;
  /** Resolved lazily: a cache hit never needs ffmpeg (or its download). */
  tools: () => Promise<MediaTools>;
  ctx: JobContext;
  /**
   * Serializes builds of one cache key, so two paths with the same bytes build
   * once. Resolves to the release function.
   */
  lock: (key: string) => Promise<() => void>;
}

/**
 * Hash → probe → proxy → sidecar → waveform → thumbnails (SPEC §6.3).
 * Unchanged content with a complete manifest is a cache hit: nothing runs.
 * Outputs are built under temp names and published by rename, the manifest
 * last, so an aborted job leaves no half file that looks complete.
 */
export async function ingestAsset(options: IngestOptions): Promise<void> {
  const { store, rel, fps, ctx } = options;
  const { signal } = ctx;
  const report = (step: JobStep, fraction = 0) => {
    const done = ORDER.slice(0, ORDER.indexOf(step)).reduce((sum, s) => sum + WEIGHTS[s], 0);
    ctx.update({ step, progress: done + WEIGHTS[step] * Math.min(1, Math.max(0, fraction)) });
  };

  report("hash");
  const hash = await store.hash(rel, (fraction) => report("hash", fraction), signal);
  const key = store.key(hash, fps);
  if (await store.manifest(key)) {
    ctx.update({ cached: true });
    return;
  }
  const release = await options.lock(key);
  try {
    // Another job may have built the same bytes while we waited.
    if (await store.manifest(key)) {
      ctx.update({ cached: true });
      return;
    }
    ctx.update({ cached: false });
    await build(options, hash, key, report);
  } finally {
    release();
  }
}

async function build(
  options: IngestOptions,
  hash: string,
  key: string,
  report: (step: JobStep, fraction?: number) => void,
): Promise<void> {
  const { store, rel, fps, ctx } = options;
  const { signal } = ctx;
  const source = store.abs(rel);
  const tools = await options.tools();

  report("probe");
  let media;
  try {
    media = await probeMedia(tools.ffprobe, source, signal);
  } catch (error) {
    if (error instanceof ToolError) throw notMedia(rel, error.stderr);
    throw error;
  }
  if (!media.video && !media.audio) throw notMedia(rel, "no audio or video stream");
  const duration = media.duration ?? 0;
  const progressOf = (step: JobStep) => (seconds: number) => report(step, duration > 0 ? seconds / duration : 0);
  const partial = `${process.pid}-${Date.now()}.partial`;
  const moving = media.video && !media.video.still;

  const manifest: Manifest = {
    version: 1,
    recipe: RECIPE_VERSION,
    fps,
    hash,
    media,
    proxy: null,
    sidecar: null,
    waveform: null,
    thumbnails: null,
  };
  const temps: string[] = [];
  try {
    await mkdir(store.abs(DERIVED_DIRS.proxies), { recursive: true });
    if (moving) {
      report("proxy");
      const proxy = `${DERIVED_DIRS.proxies}/${key}.mp4`;
      const temp = `${store.abs(proxy)}.${partial}`;
      temps.push(temp);
      await runTool(tools.ffmpeg, proxyArgs(source, temp, fps), { signal, onProgress: progressOf("proxy") });
      await rename(temp, store.abs(proxy));
      manifest.proxy = proxy;
    }

    if (media.audio) {
      report("sidecar");
      const sidecar = `${DERIVED_DIRS.proxies}/${key}.pcm`;
      const temp = `${store.abs(sidecar)}.${partial}`;
      temps.push(temp);
      await runTool(tools.ffmpeg, sidecarArgs(source, temp), { signal, onProgress: progressOf("sidecar") });
      await rename(temp, store.abs(sidecar));
      manifest.sidecar = { path: sidecar, format: "s16le", sampleRate: SIDECAR_SAMPLE_RATE, channels: SIDECAR_CHANNELS };

      report("waveform");
      const waveform = `${DERIVED_DIRS.waveforms}/${key}.json`;
      const peaks = await computePeaks(store.abs(sidecar), signal);
      await writeJsonAtomic(store.abs(waveform), { version: 1, peaksPerSecond: PEAKS_PER_SECOND, sampleRate: SIDECAR_SAMPLE_RATE, peaks });
      manifest.waveform = { path: waveform, peaksPerSecond: PEAKS_PER_SECOND };
    }

    if (media.video) {
      report("thumbnails");
      const dir = `${DERIVED_DIRS.thumbs}/${key}`;
      const temp = `${store.abs(dir)}.${partial}`;
      temps.push(temp);
      await mkdir(temp, { recursive: true });
      // From the proxy when there is one: already small, so decoding is cheap.
      const input = manifest.proxy ? store.abs(manifest.proxy) : source;
      const interval = moving ? thumbnailInterval(duration) : null;
      await runTool(tools.ffmpeg, thumbnailArgs(input, temp, interval), {
        signal,
        onProgress: progressOf("thumbnails"),
      });
      const count = (await readdir(temp)).filter((name) => name.endsWith(".jpg")).length;
      await rm(store.abs(dir), { recursive: true, force: true });
      await rename(temp, store.abs(dir));
      manifest.thumbnails = { dir, count, interval: interval ?? 0 };
    }

    await store.writeManifest(key, manifest);
  } finally {
    for (const temp of temps) await rm(temp, { recursive: true, force: true });
  }
}

function notMedia(rel: string, details: string): Error {
  const reason = details.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ") || "unknown format";
  return new Error(`${rel} is not a media file ffprobe can read (${reason}). Remove it from assets/ or replace it.`);
}

/** [min, max] per 10 ms of s16le mono, scaled to -128..127. */
async function computePeaks(path: string, signal: AbortSignal): Promise<[number, number][]> {
  const window = SIDECAR_SAMPLE_RATE / PEAKS_PER_SECOND;
  const peaks: [number, number][] = [];
  let min = 0;
  let max = 0;
  let count = 0;
  let carry: Buffer | null = null;
  for await (const raw of createReadStream(path, { signal })) {
    let chunk = raw as Buffer;
    if (carry) {
      chunk = Buffer.concat([carry, chunk]);
      carry = null;
    }
    const usable = chunk.length - (chunk.length % 2);
    for (let offset = 0; offset < usable; offset += 2) {
      const sample = chunk.readInt16LE(offset);
      if (count === 0 || sample < min) min = sample;
      if (count === 0 || sample > max) max = sample;
      if (++count === window) {
        peaks.push([scale(min), scale(max)]);
        count = 0;
      }
    }
    if (usable < chunk.length) carry = chunk.subarray(usable);
  }
  if (count > 0) peaks.push([scale(min), scale(max)]);
  return peaks;
}

function scale(sample: number): number {
  return Math.max(-128, Math.min(127, Math.round(sample / 256)));
}
