import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ErrorCode, RpcError, type AssetInfo } from "@frameshell/protocol";
import { BEATS_SCHEMA_URL, type BeatGrid, type BeatsFile, SCHEMA_VERSION, effectiveBeatGrid, isLowConfidence, parseBeatsFile } from "@frameshell/schema";
import { assetFileNames } from "../asset-names.js";
import { readJsonIfExists, writeTextAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";
import { type AudioExtractor, TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "../transcripts/audio.js";
import { runWorkerTask } from "../worker-task.js";
import { ANALYSIS_RATE, BEAT_DETECTOR, type BeatAnalysis, MAX_BEAT_AUDIO_S, type PcmAnalysis, type PcmAnalysisResult } from "./beats.js";
import { decodeFloats, encodeFloats, wavData } from "./energy-store.js";

/** Project-relative directory of beat grids (versioned with the project, ADR 0029). */
export const BEATS_DIR = "beats";
/** Project-relative cache directory of onset envelopes (regenerable). */
export const BEATS_CACHE_DIR = ".frameshell/beats";
/** Bump when the envelope computation changes: it is part of the cache file name. */
const BEATS_CACHE_VERSION = 1;

/** Cache key of the envelope of content `hash` (`sha256:<hex>`): its file is `<key>-<rate>.f32` in {@link BEATS_CACHE_DIR}. */
export function beatsCacheKey(hash: string): string {
  return `${hash.replace(/^sha256:/, "").slice(0, 20)}-b${BEATS_CACHE_VERSION}`;
}

const ENVELOPE_FILE = /^([0-9a-f]{20}-b\d+)-\d+\.f32$/;
/** Decode temps of {@link BeatsStore} and atomic-write temps of envelopes. */
const BEATS_TEMP = /^(\.decode-[0-9a-f]+\.wav|[0-9a-f]{20}-b\d+-\d+\.f32\..+\.tmp)$/;

/**
 * What an entry of {@link BEATS_CACHE_DIR} is, for `gc`: the envelope of cache `key` (an older
 * version never matches a current key), a temp, or null (not ours: kept). `gc` never looks at
 * {@link BEATS_DIR}, which holds the person's corrections.
 */
export function classifyBeatsCache(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  if (BEATS_TEMP.test(name)) return { kind: "temp", key: null };
  const key = ENVELOPE_FILE.exec(name)?.[1];
  return key ? { kind: "beats", key } : null;
}

/** Beat grid file names for an asset, in preference order: `beats/<name>.beats.json`, then with the asset's extension kept. */
export function beatsPathsFor(assetRel: string): [string, string] {
  const [short, long] = assetFileNames(assetRel);
  return [`${BEATS_DIR}/${short}.beats.json`, `${BEATS_DIR}/${long}.beats.json`];
}

async function candidatesOf(root: string, assetRel: string) {
  const candidates = [];
  for (const rel of new Set(beatsPathsFor(assetRel))) {
    const path = join(root, ...rel.split("/"));
    candidates.push({ rel, path, previous: await readBeatsFile(path) });
  }
  return candidates;
}

/** The beats file that records `assetRel`, or null when it was never measured. Throws `InvalidProjectFile` when a candidate is broken. */
export async function ownBeatsFile(root: string, assetRel: string): Promise<{ rel: string; path: string; file: BeatsFile } | null> {
  const found = (await candidatesOf(root, assetRel)).find((candidate) => candidate.previous?.asset === assetRel);
  return found ? { rel: found.rel, path: found.path, file: found.previous! } : null;
}

/**
 * The beats file to write for `assetRel`: the name whose file already records this asset, else the first
 * free name. A grid is never overwritten for another asset. Throws `InvalidOperation` (reason
 * `name taken`) when both names belong to other assets, `InvalidProjectFile` when a candidate file is
 * broken (its owner is unknown and its edits would be lost).
 */
export async function resolveBeatsFile(root: string, assetRel: string): Promise<{ rel: string; path: string; previous: BeatsFile | null }> {
  const candidates = await candidatesOf(root, assetRel);
  const chosen = candidates.find((candidate) => candidate.previous?.asset === assetRel) ?? candidates.find((candidate) => candidate.previous === null);
  if (chosen) return chosen;
  const owners = candidates.map((candidate) => `${candidate.rel} (${candidate.previous!.asset})`).join(", ");
  throw new RpcError(
    ErrorCode.InvalidOperation,
    `Cannot write the beat grid of ${assetRel}: ${owners} belong to other assets. Rename the asset, or delete or move one of those files if it is stale.`,
    { reason: "name taken", asset: assetRel },
  );
}

/** The beats file at `path`, or null when there is none. Throws `InvalidProjectFile` when it is broken. */
export async function readBeatsFile(path: string): Promise<BeatsFile | null> {
  const invalid = (details: string) =>
    new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${path}:\n${details}\nFix it or delete it; measuring again would lose its edits.`, { path, details });
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (raw === undefined) return null;
  const parsed = parseBeatsFile(raw);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}

/**
 * JSON text of a beats file: two-space indent like every project file, but the long number arrays wrapped
 * to rows of about 100 columns instead of one number per line, so a hand edit of `edits` stays readable.
 */
export function formatBeatsFile(file: BeatsFile): string {
  const { beats, onsets, ...rest } = file;
  const rows = (values: number[], indent: string) => {
    const lines: string[] = [];
    let line = "";
    for (const value of values) {
      const piece = `${value},`;
      if (line !== "" && indent.length + line.length + piece.length > 100) {
        lines.push(line);
        line = "";
      }
      line += (line === "" ? "" : " ") + piece;
    }
    if (line !== "") lines.push(line);
    return `[\n${lines.map((text) => `${indent}  ${text}`).join("\n").replace(/,$/, "")}\n${indent}]`;
  };
  const text = JSON.stringify({ ...rest, beats: "@@beats@@", ...(onsets ? { onsets: "@@onsets@@" } : {}) }, null, 2);
  return `${text.replace('"@@beats@@"', rows(beats, "  ")).replace('"@@onsets@@"', rows(onsets ?? [], "  "))}\n`;
}

/** Options for {@link BeatsStore}. */
export interface BeatsStoreOptions {
  /** Content hash and PCM sidecar of an asset; see `MediaService.derivedAudio`. */
  derivedAudio(root: string, rel: string): Promise<{ hash: string; sidecar: AssetInfo["sidecar"] }>;
  /** Managed or overridden ffmpeg for the project; only run when there is no sidecar. */
  ffmpeg(root: string): Promise<string>;
  /** Decoder of assets without sidecar. Default: ffmpeg on the ingest clock. */
  extractAudio?: AudioExtractor | undefined;
}

/** What {@link BeatsStore.measure} returns. */
export interface MeasuredBeats {
  /** `sha256:<hex>` of the asset's content. */
  hash: string;
  analysis: BeatAnalysis;
  /** Sample rate of the audio that was analysed: the sidecar's, or the fallback decode's. */
  sampleRate: number;
  /** True when the onset envelope came from the cache and only the grid was worked out again. */
  cached: boolean;
}

/**
 * Worker script beside this module. Under the test runner this module is the TypeScript source, so the
 * worker runs from the build (`pnpm test` builds first).
 */
const BEATS_WORKER = import.meta.url.endsWith(".ts") ? new URL("../../dist/media/beats-worker.js", import.meta.url) : new URL("./beats-worker.js", import.meta.url);

/**
 * Per-asset beat grids (ADR 0029): the PCM sidecar of the ingest, else the asset decoded by ffmpeg at 16 kHz
 * (a less precise grid, marked low confidence), measured in a worker thread. The onset envelope, which costs
 * most of the work, is cached by content hash in {@link BEATS_CACHE_DIR}, so measuring again with another
 * hint takes a second. Writing the beats file is the caller's.
 */
export class BeatsStore {
  readonly #options: BeatsStoreOptions;

  constructor(options: BeatsStoreOptions) {
    this.#options = options;
  }

  /**
   * Measure project-relative `rel`. `hint` is the tempo the person expects (BPM). Throws `InvalidOperation`
   * when the asset has no audio, is longer than {@link MAX_BEAT_AUDIO_S} or holds no rhythm; `signal` aborts it.
   */
  async measure(
    root: string,
    rel: string,
    options: { hint?: number | undefined; signal?: AbortSignal | undefined; onProgress?: ((fraction: number) => void) | undefined } = {},
  ): Promise<MeasuredBeats> {
    const { hash, sidecar } = await this.#options.derivedAudio(root, rel);
    const input = sidecar
      ? { pcm: await readFile(join(root, ...sidecar.path.split("/"))), channels: sidecar.channels, rate: sidecar.sampleRate }
      : await this.#decode(root, rel);
    const seconds = input.pcm.byteLength / (2 * input.channels * input.rate);
    if (seconds > MAX_BEAT_AUDIO_S) {
      throw new RpcError(ErrorCode.InvalidOperation, `${rel} lasts ${Math.round(seconds / 60)} minutes: a beat grid is for music, at most ${MAX_BEAT_AUDIO_S / 60}.`, {
        reason: "too long",
        asset: rel,
      });
    }
    const cache = join(root, ...BEATS_CACHE_DIR.split("/"), `${beatsCacheKey(hash)}-${Math.min(input.rate, ANALYSIS_RATE)}.f32`);
    const stored = await readFile(cache).catch(() => null);
    const envelope = stored && stored.length > 0 && stored.length % 4 === 0 ? decodeFloats(stored) : null;
    const request: PcmAnalysis = { ...input, hint: options.hint, envelope };
    const result = await runWorkerTask<PcmAnalysisResult>(BEATS_WORKER, request, "beat detection", {
      signal: options.signal,
      onProgress: options.onProgress,
    });
    if (!result.ok) {
      throw new RpcError(ErrorCode.InvalidOperation, `No beats in ${rel}: ${result.reason}.`, { reason: "no beats", asset: rel });
    }
    const reused = envelope !== null && result.envelope.length === envelope.length;
    if (!reused) await writeTextAtomic(cache, encodeFloats(result.envelope));
    return { hash, analysis: result.analysis, sampleRate: input.rate, cached: reused };
  }

  /** Decode `rel` to a temp 16 kHz mono WAV and read its samples. */
  async #decode(root: string, rel: string): Promise<{ pcm: Uint8Array; channels: number; rate: number }> {
    const temp = join(root, ...BEATS_CACHE_DIR.split("/"), `.decode-${randomUUID().slice(0, 8)}.wav`);
    const extract = this.#options.extractAudio ?? extractAudioWithFfmpeg;
    try {
      await mkdir(dirname(temp), { recursive: true });
      await extract({ path: join(root, ...rel.split("/")) }, temp, () => this.#options.ffmpeg(root));
      const { rate, channels, data } = wavData(await readFile(temp));
      return { pcm: data, channels, rate: rate || TRANSCRIPTION_SAMPLE_RATE };
    } finally {
      await rm(temp, { force: true });
    }
  }
}

/** A beats file for a freshly measured grid, carrying the human `edits` of `previous` unless `keepEdits` is false or the asset content changed since (edits fit the old audio). */
export function beatsFileOf(options: {
  asset: string;
  measured: MeasuredBeats;
  previous: BeatsFile | null;
  keepEdits: boolean;
}): BeatsFile {
  const { asset, measured, previous, keepEdits } = options;
  const { analysis } = measured;
  return {
    $schema: BEATS_SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    asset,
    assetHash: measured.hash,
    detector: BEAT_DETECTOR,
    sampleRate: measured.sampleRate,
    bpm: analysis.bpm,
    meter: analysis.meter,
    downbeat: analysis.downbeat,
    confidence: analysis.confidence,
    residualMs: analysis.residualMs,
    ...(analysis.alternatives.length > 0 ? { alternatives: analysis.alternatives } : {}),
    edits: keepEdits && previous && previous.assetHash === measured.hash ? previous.edits : {},
    beats: analysis.beats,
    onsets: analysis.onsets,
  };
}

/** The facts both `beats.measure` and `beats.show` report about a beats file at project-relative `path`, and its grid with the edits applied. */
export function summarizeBeats(file: BeatsFile, path: string) {
  const grid: BeatGrid = effectiveBeatGrid(file);
  return {
    grid,
    summary: {
      asset: file.asset,
      file: path,
      hash: file.assetHash,
      detector: file.detector,
      bpm: Math.round(grid.bpm * 100) / 100,
      meter: file.meter,
      confidence: file.confidence,
      low: isLowConfidence(file),
      residualMs: file.residualMs ?? null,
      sampleRate: file.sampleRate ?? null,
      alternatives: file.alternatives ?? [],
      beatCount: grid.beats.length,
      onsetCount: file.onsets?.length ?? 0,
    },
  };
}
