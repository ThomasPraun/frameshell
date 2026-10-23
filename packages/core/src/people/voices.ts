// Voice prints (ADR 0020 decision 3): per transcript speaker, the mean CAM++ embedding of its longest
// stretches where nobody else speaks, cached in `.frameshell/people/voices/` per asset content.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ErrorCode, type Progress, RpcError } from "@frameshell/protocol";
import { type Transcript, wordSpeaker } from "@frameshell/schema";
import { DIARIZATION_MODELS, SPEAKER_EMBEDDING_MODEL } from "../binaries/manifest.js";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";
import type { AudioExtractor } from "../transcripts/audio.js";
import {
  type TranscriberMedia,
  type TranscriberTools,
  audioCacheKey,
  hashAsset,
  readPrevious,
  resolveAsset,
  transcriptionAudio,
} from "../transcripts/transcriber.js";
import type { Stretch, VoiceEmbedder } from "./voice-embed.js";

/** Project-relative folder of the voice print caches, one file per asset content (`<audio cache key>.json`). */
export const VOICES_DIR = ".frameshell/people/voices";

/** Stretches shorter than this give CAM++ too little speech for a stable embedding. */
const STRETCH_MIN_S = 1.5;
/** Longer runs are split: the model was trained on a few seconds at a time, and a split adds samples. */
const STRETCH_MAX_S = 10;
/** Longest stretches kept per speaker: about 3 minutes of audio at most, a few seconds of inference. */
const MAX_STRETCHES = 20;
/** A pause up to this long between one speaker's words stays inside a stretch. */
const STRETCH_GAP_S = 0.5;
/** Prints kept per cache file; older ones (earlier word assignments) are dropped first. */
const MAX_CACHED_PRINTS = 64;
/** Bump when stretch selection or print math changes: cached prints of older versions are recomputed. */
const VOICE_PRINT_VERSION = 1;

const VOICE_FILE = /^([0-9a-f]{16})\.json$/;
/** `writeJsonAtomic` temps: `<file>.<pid>.<hex>.tmp`. */
const VOICE_TEMP = /^[0-9a-f]{16}\.json\..+\.tmp$/;

/** What an entry of {@link VOICES_DIR} is, for `gc`: the prints of audio cache key `key`, a write temp, or null (kept). */
export function classifyVoiceCache(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  if (VOICE_TEMP.test(name)) return { kind: "temp", key: null };
  const key = VOICE_FILE.exec(name)?.[1];
  return key ? { kind: "voice", key } : null;
}

/**
 * Stretches of `transcript` where `speaker` talks and nobody else does
 * (`speaker` undefined: every word, for a transcript linked whole): runs of
 * its words with pauses up to 0.5 s, cut where another speaker's word starts,
 * split into equal parts of at most 10 s, kept from 1.5 s. The 20 longest, in
 * time order, rounded to milliseconds.
 */
export function voiceStretches(transcript: Pick<Transcript, "words" | "edits">, speaker?: string): Stretch[] {
  const words = [...transcript.words].sort((a, b) => a.start - b.start);
  const runs: Stretch[] = [];
  let run: Stretch | null = null;
  /** End of the last word of someone else: a run never starts before it. */
  let blocked = 0;
  const close = (until = Number.POSITIVE_INFINITY) => {
    if (run) runs.push({ start: run.start, end: Math.min(run.end, until) });
    run = null;
  };
  for (const word of words) {
    const ours = speaker === undefined || wordSpeaker(transcript, word) === speaker;
    if (!ours) {
      close(word.start);
      blocked = Math.max(blocked, word.end);
      continue;
    }
    const start = Math.max(word.start, blocked);
    if (run && start - run.end <= STRETCH_GAP_S) run.end = Math.max(run.end, word.end);
    else {
      close();
      if (word.end > start) run = { start, end: word.end };
    }
  }
  close();
  const pieces: Stretch[] = [];
  for (const { start, end } of runs) {
    const length = end - start;
    if (length < STRETCH_MIN_S) continue;
    const parts = Math.ceil(length / STRETCH_MAX_S);
    for (let i = 0; i < parts; i++) pieces.push({ start: round(start + (length * i) / parts), end: round(start + (length * (i + 1)) / parts) });
  }
  return pieces
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
    .slice(0, MAX_STRETCHES)
    .sort((a, b) => a.start - b.start);
}

/** Mean of L2-normalized `embeddings` weighted by their stretch's length, normalized; null when there are none. */
export function meanPrint(embeddings: readonly (readonly number[])[], weights: readonly number[]): number[] | null {
  if (embeddings.length === 0) return null;
  const sum = new Array<number>(embeddings[0]!.length).fill(0);
  embeddings.forEach((embedding, i) => {
    const scale = weights[i]! / norm(embedding);
    embedding.forEach((value, d) => (sum[d]! += value * scale));
  });
  const length = norm(sum);
  return length === 0 ? null : sum.map((value) => value / length);
}

function norm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** A voice print and what it was made of. */
export interface VoicePrint {
  print: number[];
  /** Stretches embedded. */
  stretches: number;
  /** Seconds of speech they hold. */
  seconds: number;
}

/** One transcript speaker (or a whole transcript, `speaker` undefined) to print. */
export interface VoiceWanted {
  /** Project-relative transcript file. */
  transcript: string;
  speaker?: string | undefined;
}

/** What {@link computeVoicePrints} found for one {@link VoiceWanted}. */
export type VoiceOutcome = { ok: true; value: VoicePrint } | { ok: false; reason: string };

/** Inputs of {@link computeVoicePrints}. */
export interface VoicePrintOptions {
  root: string;
  wanted: readonly VoiceWanted[];
  /** Runs CAM++ on the stretches missing from the cache. */
  embed: VoiceEmbedder;
  /** Installs ffmpeg when a transcription WAV must be extracted again. */
  tools: Pick<TranscriberTools, "ensureBinary">;
  media?: TranscriberMedia | undefined;
  extractAudio: AudioExtractor;
  progress: (progress: Progress) => void;
  signal?: AbortSignal | undefined;
}

interface CacheFile {
  version: number;
  model: string;
  /** By {@link printKey}: the asset content, the model and the stretches. */
  prints: Record<string, VoicePrint>;
}

/** Id and version of the embedding model, part of every print's key. */
function modelId(): string {
  const model = DIARIZATION_MODELS.find((candidate) => candidate.id === SPEAKER_EMBEDDING_MODEL)!;
  return `${model.id}@${model.version}`;
}

function printKey(assetHash: string, stretches: readonly Stretch[]): string {
  return createHash("sha256").update(JSON.stringify([VOICE_PRINT_VERSION, modelId(), assetHash, stretches])).digest("hex").slice(0, 24);
}

/**
 * Voice prints of `wanted`, by transcript and speaker, from the cache when
 * the asset content, the model and the speaker's stretches are the same, else
 * computed from the transcription WAV (extracted again when `gc` removed it)
 * and cached. A transcript that is missing, stale (its asset changed) or a
 * speaker with no stretch of 1.5 s gets a reason instead of a print.
 */
export async function computeVoicePrints(options: VoicePrintOptions): Promise<Map<string, VoiceOutcome>> {
  const { root, progress } = options;
  const outcomes = new Map<string, VoiceOutcome>();
  const byTranscript = new Map<string, VoiceWanted[]>();
  for (const wanted of options.wanted) byTranscript.set(wanted.transcript, [...(byTranscript.get(wanted.transcript) ?? []), wanted]);
  for (const [rel, wanted] of byTranscript) {
    options.signal?.throwIfAborted();
    const fail = (reason: string) => wanted.forEach((entry) => outcomes.set(voiceKey(entry), { ok: false, reason }));
    let transcript: Transcript | null;
    try {
      transcript = await readPrevious(join(root, ...rel.split("/")));
    } catch {
      fail(`${rel} is not a valid transcript`);
      continue;
    }
    if (!transcript) {
      fail(`${rel} does not exist`);
      continue;
    }
    let asset: { real: string; rel: string };
    try {
      asset = await resolveAsset(root, join(root, ...transcript.asset.split("/")));
    } catch {
      fail(`${transcript.asset}, the asset of ${rel}, is missing`);
      continue;
    }
    const hashed = await hashAsset({ assetPath: asset.real, assetRel: asset.rel, media: options.media, progress });
    if (transcript.assetHash !== `sha256:${hashed.hash}`) {
      fail(`${rel} is stale: ${asset.rel} changed after it was transcribed`);
      continue;
    }
    const cachePath = join(root, ...VOICES_DIR.split("/"), `${audioCacheKey(hashed.hash)}.json`);
    const cache = await readCache(cachePath);
    const todo: { entry: VoiceWanted; key: string; stretches: Stretch[] }[] = [];
    for (const entry of wanted) {
      const stretches = voiceStretches(transcript, entry.speaker);
      if (stretches.length === 0) {
        const who = entry.speaker ? `${entry.speaker} of ${rel}` : rel;
        outcomes.set(voiceKey(entry), { ok: false, reason: `${who} has no stretch of ${STRETCH_MIN_S} s or more without another voice` });
        continue;
      }
      const key = printKey(transcript.assetHash, stretches);
      const known = cache.prints[key];
      if (known) outcomes.set(voiceKey(entry), { ok: true, value: known });
      else todo.push({ entry, key, stretches });
    }
    if (todo.length === 0) continue;

    let audio: string;
    try {
      ({ audio } = await transcriptionAudio({ projectDir: root, assetPath: asset.real, assetRel: asset.rel, hashed, tools: options.tools, extractAudio: options.extractAudio, progress }));
    } catch (error) {
      if (error instanceof RpcError) throw error;
      todo.forEach(({ entry }) => outcomes.set(voiceKey(entry), { ok: false, reason: `the audio of ${asset.rel} could not be extracted: ${(error as Error).message.split("\n")[0]}` }));
      continue;
    }
    const all = todo.flatMap((item) => item.stretches);
    const message = `Listening to the voices of ${rel}`;
    progress({ message, stage: "voices", values: { transcript: rel } });
    const embeddings = await options.embed({
      audio,
      stretches: all,
      signal: options.signal,
      onProgress: (fraction) => progress({ message, fraction, stage: "voices", values: { transcript: rel } }),
    });
    if (embeddings.length !== all.length) throw new RpcError(ErrorCode.InternalError, `voice embedder returned ${embeddings.length} embeddings for ${all.length} stretches`);
    let offset = 0;
    for (const { entry, key, stretches } of todo) {
      const lengths = stretches.map((stretch) => stretch.end - stretch.start);
      const print = meanPrint(embeddings.slice(offset, offset + stretches.length), lengths);
      offset += stretches.length;
      if (!print) {
        outcomes.set(voiceKey(entry), { ok: false, reason: `the voice of ${entry.speaker ?? "all"} in ${rel} gave no print` });
        continue;
      }
      const value: VoicePrint = { print: print.map((v) => Math.round(v * 1e6) / 1e6), stretches: stretches.length, seconds: round(lengths.reduce((a, b) => a + b, 0)) };
      cache.prints[key] = value;
      outcomes.set(voiceKey(entry), { ok: true, value });
    }
    const keys = Object.keys(cache.prints);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_PRINTS))) delete cache.prints[old];
    await writeJsonAtomic(cachePath, cache);
  }
  return outcomes;
}

/** Key of a {@link VoiceWanted} in the result of {@link computeVoicePrints}. */
export function voiceKey(wanted: VoiceWanted): string {
  return `${wanted.transcript}\0${wanted.speaker ?? "*"}`;
}

async function readCache(path: string): Promise<CacheFile> {
  const empty: CacheFile = { version: VOICE_PRINT_VERSION, model: modelId(), prints: {} };
  try {
    const raw = (await readJsonIfExists(path)) as Partial<CacheFile> | undefined;
    if (!raw || raw.version !== VOICE_PRINT_VERSION || raw.model !== modelId() || typeof raw.prints !== "object" || raw.prints === null) return empty;
    return { ...empty, prints: raw.prints };
  } catch {
    // A broken cache is regenerated.
    return empty;
  }
}
