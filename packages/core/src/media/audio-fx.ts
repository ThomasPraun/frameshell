import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AudioBakeInfo, GcEntry, GcSkip, JobInfo } from "@frameshell/protocol";
import {
  type AudioEffect,
  type NormalizedAudioEffect,
  type Timeline,
  audioEffectsKey,
  audioEffectsOf,
  bakeRef,
  normalizeAudioEffects,
  withTrackMutes,
} from "@frameshell/schema";
import { exists, renameRetrying } from "../fs-util.js";
import { type GcClass, sweep } from "../gc.js";
import type { JobQueue } from "../jobs/queue.js";
import { runTool } from "./ffmpeg.js";
import { SIDECAR_CHANNELS, SIDECAR_SAMPLE_RATE, alignedAudioFilter } from "./recipe.js";

// Baked audio effects (ADR 0031): asset + normalized chain -> ffmpeg -> one raw PCM file in the sidecar's format
// and clock, cached by content hash and chain. Export mixes it and the preview plays it in place of the dry
// sidecar, so both hear the same samples. Energy snapping and transcription keep reading the dry audio.

/** Project-relative cache directory of baked audio (regenerable). */
export const AUDIO_FX_DIR = ".frameshell/audio-fx";
/** Bump when a bake's output changes for the same chain (filter recipe, format): it is part of the cache key. */
export const AUDIO_FX_VERSION = 1;
/**
 * Samples `afftdn` delays its output by at {@link SIDECAR_SAMPLE_RATE} (its 25 ms window; measured on the pinned
 * ffmpeg 9.0.2, pinned by `audio-fx.test.ts`). The bake pads and trims it away, so the bake stays on the sidecar clock.
 */
export const DENOISE_LATENCY_SAMPLES = 1200;

const KEY = String.raw`[0-9a-f]{20}-[0-9a-f]{12}-x\d+`;
const BAKE_FILE = new RegExp(String.raw`^(${KEY})\.pcm$`);
const BAKE_TEMP = new RegExp(String.raw`^${KEY}\.pcm\..+\.partial$`);

/** Cache key of the bake of content `hash` (`sha256:<hex>`) through `effects`: its file is `<key>.pcm` in {@link AUDIO_FX_DIR}. */
export function audioFxCacheKey(hash: string, effects: readonly AudioEffect[]): string {
  const chain = createHash("sha256").update(audioEffectsKey(effects)).digest("hex").slice(0, 12);
  return `${hash.replace(/^sha256:/, "").slice(0, 20)}-${chain}-x${AUDIO_FX_VERSION}`;
}

/** What an entry of {@link AUDIO_FX_DIR} is, for `gc`: the bake of cache key `key`, a temp, or null (not ours: kept). */
export function classifyAudioFx(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  if (BAKE_TEMP.test(name)) return { kind: "temp", key: null };
  const key = BAKE_FILE.exec(name)?.[1];
  return key ? { kind: "audio-fx", key } : null;
}

/** ffmpeg filter of one effect at {@link SIDECAR_SAMPLE_RATE}; dB and ms converted to what each filter takes. */
function effectFilter(effect: NormalizedAudioEffect): string {
  switch (effect.kind) {
    case "highpass":
      return `highpass=f=${effect.frequency}`;
    case "denoise":
      return `afftdn=nf=${effect.floor}:nr=${effect.reduction}`;
    case "compressor":
      return (
        `acompressor=threshold=${linear(effect.threshold)}:ratio=${effect.ratio}:attack=${effect.attack}` +
        `:release=${effect.release}:makeup=${linear(effect.makeup)}`
      );
  }
}

/** Linear factor of `db` decibels, 6 significant digits. */
function linear(db: number): string {
  return String(Number((10 ** (db / 20)).toPrecision(6)));
}

/**
 * The bake's audio filter: the sidecar clock ({@link alignedAudioFilter}), mono like the sidecar, then the chain in
 * order. Each `denoise` delays by {@link DENOISE_LATENCY_SAMPLES}: the input is padded by that much and the start
 * trimmed, so the bake has the sidecar's length and timing.
 */
export function audioFxFilter(effects: readonly AudioEffect[]): string {
  const chain = normalizeAudioEffects(effects);
  const delay = chain.filter((effect) => effect.kind === "denoise").length * DENOISE_LATENCY_SAMPLES;
  return [
    alignedAudioFilter(SIDECAR_SAMPLE_RATE),
    `aformat=channel_layouts=${SIDECAR_CHANNELS === 1 ? "mono" : "stereo"}`,
    ...(delay > 0 ? [`apad=pad_len=${delay}`] : []),
    ...chain.map(effectFilter),
    ...(delay > 0 ? [`atrim=start_sample=${delay}`, "asetpts=PTS-STARTPTS"] : []),
  ].join(",");
}

/** ffmpeg args baking the first audio stream of `input` through `effects` into raw s16le `output` (the sidecar's format). */
export function audioFxArgs(input: string, output: string, effects: readonly AudioEffect[]): string[] {
  return [
    ...["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"],
    ...["-i", input, "-map", "0:a:0", "-vn", "-af", audioFxFilter(effects), "-ac", String(SIDECAR_CHANNELS)],
    ...["-c:a", "pcm_s16le", "-f", "s16le", output],
  ];
}

/** One bake a timeline needs: an asset through one chain, and the clips that play it. */
export interface AudioBakeNeed {
  /** {@link bakeRef} of asset and chain. */
  ref: string;
  asset: string;
  effects: NormalizedAudioEffect[];
  /** Clip ids (flattened: `<nested clip>/<clip>`) playing it, in track then time order. */
  clips: string[];
}

/** Options for {@link AudioFxService}. */
export interface AudioFxServiceOptions {
  jobs: JobQueue;
  /** Content hash of a project-relative asset; see `MediaService.hash`. */
  hash(root: string, rel: string): Promise<string>;
  /** True when the asset has an audio stream; see `MediaService.probe`. Throws when it cannot be read. */
  hasAudio(root: string, rel: string): Promise<boolean>;
  /** Managed or overridden ffmpeg for the project. */
  ffmpeg(root: string): Promise<string>;
  /** Timeline ids of the project (`timelines/<id>.json`). */
  timelines(root: string): Promise<string[]>;
  /** A timeline file with its nested timelines flattened; throws when it cannot be read. */
  flattened(root: string, id: string): Promise<Timeline>;
}

/**
 * Bakes of clip audio effects (ADR 0031), cached in {@link AUDIO_FX_DIR}. Export bakes what it needs before
 * mixing ({@link ensure}); the preview asks for {@link status}, which queues the missing bakes as `audio-fx` jobs
 * and plays the dry sidecar until each is ready. One bake per asset content and chain, shared by every clip.
 */
export class AudioFxService {
  readonly #options: AudioFxServiceOptions;
  /** ffmpeg runs in flight by absolute bake file. */
  readonly #running = new Map<string, Promise<void>>();
  /** Last failure by absolute bake file; a later success clears it. */
  readonly #failed = new Map<string, string>();
  /** Queued or running `audio-fx` job by absolute bake file. */
  readonly #jobs = new Map<string, string>();

  constructor(options: AudioFxServiceOptions) {
    this.#options = options;
  }

  /** Bakes `timeline` (nested timelines flattened) needs: unmuted media clips with audio effects, one per asset and chain. */
  needs(timeline: Timeline): AudioBakeNeed[] {
    const found = new Map<string, AudioBakeNeed>();
    for (const track of withTrackMutes(timeline).tracks) {
      if (track.kind !== "video" && track.kind !== "audio") continue;
      for (const clip of track.clips) {
        const effects = audioEffectsOf(clip);
        if (!effects || clip.type !== "media" || !("asset" in clip) || clip.audio?.muted === true) continue;
        const ref = bakeRef(clip.asset, effects);
        const need = found.get(ref) ?? { ref, asset: clip.asset, effects: normalizeAudioEffects(effects), clips: [] };
        need.clips.push(clip.id);
        found.set(ref, need);
      }
    }
    return [...found.values()];
  }

  /**
   * State of every bake `timeline` (flattened) needs. With `queue`, bakes neither ready nor failed are queued as
   * background `audio-fx` jobs. A failed bake is retried by a later call once its asset changes.
   */
  async status(root: string, timeline: Timeline, queue: boolean): Promise<AudioBakeInfo[]> {
    const out: AudioBakeInfo[] = [];
    for (const need of this.needs(timeline)) {
      const base = { asset: need.asset, effects: need.effects, clips: need.clips, sampleRate: SIDECAR_SAMPLE_RATE, channels: SIDECAR_CHANNELS };
      let rel: string;
      try {
        if (!(await this.#options.hasAudio(root, need.asset))) continue;
        rel = `${AUDIO_FX_DIR}/${audioFxCacheKey(await this.#options.hash(root, need.asset), need.effects)}.pcm`;
      } catch (error) {
        out.push({ ...base, state: "failed", file: null, job: null, error: (error as Error).message });
        continue;
      }
      const abs = join(root, ...rel.split("/"));
      if (await exists(abs)) {
        out.push({ ...base, state: "ready", file: rel, job: null, error: null });
        continue;
      }
      const failed = this.#failed.get(abs);
      if (failed !== undefined) {
        out.push({ ...base, state: "failed", file: null, job: null, error: failed });
        continue;
      }
      let job = this.#job(abs);
      if (!job && queue) job = this.#queue(root, need, abs);
      out.push({ ...base, state: job?.state === "running" ? "baking" : "queued", file: null, job: job?.id ?? null, error: null });
    }
    return out;
  }

  /**
   * Bake whatever `timeline` (flattened) needs and is not cached yet, one after another, and return the bake of each
   * {@link AudioBakeNeed.ref} as an absolute path. Assets without sound are left out. Rejects with ffmpeg's error.
   */
  async ensure(root: string, timeline: Timeline, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Map<string, string>> {
    const needs = this.needs(timeline);
    const baked = new Map<string, string>();
    for (const [index, need] of needs.entries()) {
      onProgress?.(index / needs.length);
      if (!(await this.#options.hasAudio(root, need.asset))) continue;
      const abs = await this.#file(root, need);
      await this.#bake(root, need, abs, signal);
      baked.set(need.ref, abs);
    }
    onProgress?.(1);
    return baked;
  }

  /**
   * Delete bakes no clip of any timeline plays now, plus temps of interrupted bakes when `temps`. When a timeline
   * cannot be read, or `busy` (an export may be mixing), nothing keyed is deleted and `skipped` says why.
   */
  async gc(root: string, options: { dryRun: boolean; temps: boolean; busy: boolean }): Promise<{ removed: GcEntry[]; skipped: GcSkip[] }> {
    const skipped: GcSkip[] = [];
    let keys: Set<string> | null = null;
    if (options.busy) {
      skipped.push({ area: "audio-fx", reason: "an export of this project is running; it may read any baked audio." });
    } else {
      const found = await this.#currentKeys(root);
      if (typeof found === "string") skipped.push({ area: "audio-fx", reason: found });
      else keys = found;
    }
    const removed = await sweep({
      root,
      dir: AUDIO_FX_DIR,
      classify: classifyAudioFx,
      keep: (key) => keys === null || keys.has(key),
      temps: options.temps && this.#running.size === 0,
      dryRun: options.dryRun,
      claim: async (key) => ([...this.#running.keys()].some((file) => file.endsWith(`${key}.pcm`)) ? null : () => {}),
    });
    return { removed, skipped };
  }

  async #currentKeys(root: string): Promise<Set<string> | string> {
    const keys = new Set<string>();
    for (const id of await this.#options.timelines(root)) {
      let timeline: Timeline;
      try {
        timeline = await this.#options.flattened(root, id);
      } catch (error) {
        return `timelines/${id}.json could not be read (${(error as Error).message}); its clips may play any bake.`;
      }
      for (const need of this.needs(timeline)) {
        const hash = await this.#options.hash(root, need.asset).catch(() => null);
        if (hash === null) return `${need.asset} could not be hashed; bakes of it are kept.`;
        keys.add(audioFxCacheKey(hash, need.effects));
      }
    }
    return keys;
  }

  async #file(root: string, need: AudioBakeNeed): Promise<string> {
    return join(root, ...AUDIO_FX_DIR.split("/"), `${audioFxCacheKey(await this.#options.hash(root, need.asset), need.effects)}.pcm`);
  }

  /** The queued or running job baking `abs`, if any. */
  #job(abs: string): JobInfo | undefined {
    const id = this.#jobs.get(abs);
    const job = id === undefined ? undefined : this.#options.jobs.get(id);
    return job && (job.state === "queued" || job.state === "running") ? job : undefined;
  }

  #queue(root: string, need: AudioBakeNeed, abs: string): JobInfo {
    const job = this.#options.jobs.enqueue({
      kind: "audio-fx",
      project: root,
      asset: need.asset,
      output: abs,
      run: async (ctx) => {
        const cached = await exists(abs);
        await this.#bake(root, need, abs, ctx.signal);
        ctx.update({ cached });
      },
    });
    this.#jobs.set(abs, job.id);
    return job;
  }

  /**
   * Bake `need` into `abs` unless it exists; a bake of the same file in flight is awaited, never started twice.
   * Runs outside the job queue's slots, so an export job waiting on it cannot starve the queue.
   */
  async #bake(root: string, need: AudioBakeNeed, abs: string, signal?: AbortSignal): Promise<void> {
    for (let running = this.#running.get(abs); running; running = this.#running.get(abs)) await running.catch(() => {});
    if (await exists(abs)) return;
    const run = this.#run(root, need, abs, signal);
    this.#running.set(abs, run);
    try {
      await run;
      this.#failed.delete(abs);
    } catch (error) {
      if (!signal?.aborted) this.#failed.set(abs, (error as Error).message);
      throw error;
    } finally {
      this.#running.delete(abs);
    }
  }

  async #run(root: string, need: AudioBakeNeed, abs: string, signal?: AbortSignal): Promise<void> {
    const ffmpeg = await this.#options.ffmpeg(root);
    const temp = `${abs}.${randomUUID().slice(0, 8)}.partial`;
    await mkdir(dirname(abs), { recursive: true });
    try {
      await runTool(ffmpeg, audioFxArgs(join(root, ...need.asset.split("/")), temp, need.effects), signal ? { signal } : {});
      await renameRetrying(temp, abs);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
