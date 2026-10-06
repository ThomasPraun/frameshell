import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { TranscriptionProvider, TranscriptionResult } from "@frameshell/plugin-api";
import { type AssetInfo, ErrorCode, type Progress, RpcError, type TranscribeResult } from "@frameshell/protocol";
import { SCHEMA_VERSION, TRANSCRIPT_SCHEMA_URL, type Transcript, parseTranscript } from "@frameshell/schema";
import { exists, readJsonIfExists, renameRetrying, writeJsonAtomic } from "../fs-util.js";
import { type AudioExtractor, type AudioInput, extractAudioWithFfmpeg } from "./audio.js";
import { assignWordIds } from "./ids.js";
import { recoverLongWords } from "./long-words.js";
import { readPcmWav, transcribeWindow } from "./window.js";

/** Native tools a transcription may need, with progress for first-run installs. */
export interface TranscriberTools {
  /** See `BinaryManager.ensure`; project overrides already applied. */
  ensureBinary(name: string, onProgress: (progress: Progress) => void): Promise<string>;
  /** See `BinaryManager.ensureModel`. */
  ensureModel(id: string, onProgress: (progress: Progress) => void): Promise<string>;
}

/**
 * Derived media of the project (SPEC §6.3) the transcriber reuses; the daemon
 * backs it with `MediaService.derivedAudio`.
 */
export interface TranscriberMedia {
  /**
   * Content hash `sha256:<hex>` of the asset at `assetRel` (project-relative,
   * `/`-separated) and the PCM sidecar of a complete ingest of that content.
   * `sidecar` is null when the asset is not ingested yet, its ingest is not
   * complete, or it has no audio.
   */
  derivedAudio(assetRel: string, onProgress: (fraction: number) => void): Promise<{ hash: string; sidecar: AssetInfo["sidecar"] }>;
}

/** Input of {@link transcribeAsset}. */
export interface TranscribeAssetOptions {
  /** Project root (real path). */
  projectDir: string;
  /** Asset path, absolute. */
  asset: string;
  providerId: string;
  /** The provider, or a loader run after the asset checks (loading plugins is slower than failing fast). */
  provider: TranscriptionProvider | (() => Promise<TranscriptionProvider>);
  model?: string | undefined;
  language?: string | undefined;
  tools: TranscriberTools;
  /** Derived media lookup. Absent: the asset is hashed here and audio always comes from the asset. */
  media?: TranscriberMedia | undefined;
  /** Defaults to ffmpeg via `tools`. */
  extractAudio?: AudioExtractor | undefined;
  progress?: ((progress: Progress) => void) | undefined;
}

/**
 * Transcribe one asset and write its transcript file (SPEC §5.4; name: see
 * {@link resolveTranscript}).
 *
 * Audio: the asset's PCM sidecar when `media` has a complete ingest of its
 * current content (no decode of the source; same clock as the CFR proxy),
 * else the asset itself through the same clock filter. Ingest is never
 * triggered or awaited: it also encodes proxy and thumbnails, which
 * transcription does not need. Either source is resampled once to 16 kHz mono
 * WAV under `.frameshell/cache/audio/`, keyed by content hash. A long word
 * hiding more speech is re-transcribed alone and split, or else flagged
 * `speechInside` ({@link recoverLongWords}). Word ids
 * survive re-transcription where the same word is found again, and so do
 * their human edits; new words get ids never used before in the file.
 *
 * Throws `AssetNotFound`, `OutsideProject`, `TranscriptNameTaken`,
 * `InvalidProjectFile`, `TranscriptionFailed` (provider or extraction error),
 * or the binary manager's errors unchanged.
 */
export async function transcribeAsset(options: TranscribeAssetOptions): Promise<TranscribeResult> {
  const started = performance.now();
  const { projectDir, providerId, tools } = options;
  const progress = options.progress ?? (() => {});
  const extractAudio = options.extractAudio ?? extractAudioWithFfmpeg;
  const { real: assetPath, rel: assetRel } = await resolveAsset(projectDir, options.asset);
  // Fail before minutes of work when the old transcript is broken or every name is taken.
  const { rel: transcriptRel, path: transcriptPath } = await resolveTranscript(projectDir, assetRel);
  const provider = typeof options.provider === "function" ? await options.provider() : options.provider;

  progress({ message: `Hashing ${assetRel}` });
  const onHash = (fraction: number) => progress({ message: `Hashing ${assetRel}`, fraction });
  const derived = options.media ? await options.media.derivedAudio(assetRel, onHash) : null;
  const hash = derived ? derived.hash.replace(/^sha256:/, "") : await sha256File(assetPath);
  const sidecar = derived?.sidecar ?? null;
  const audioSource = sidecar ? sidecar.path : assetRel;
  const input: AudioInput = sidecar
    ? {
        path: join(projectDir, ...sidecar.path.split("/")),
        raw: { format: sidecar.format, sampleRate: sidecar.sampleRate, channels: sidecar.channels },
      }
    : { path: assetPath };
  const audio = join(projectDir, ".frameshell", "cache", "audio", `${hash.slice(0, 16)}-${sidecar ? "sidecar" : "asset"}.wav`);

  const failed = (error: unknown): never => {
    if (error instanceof RpcError) throw error;
    const details = (error as Error)?.message ?? String(error);
    throw new RpcError(ErrorCode.TranscriptionFailed, `Transcribing ${assetRel} with ${providerId} failed: ${details}`, {
      provider: providerId,
      asset: assetRel,
      details,
    });
  };

  if (!(await isFile(audio))) {
    progress({ message: `Extracting audio from ${audioSource}` });
    const temp = `${audio}.${process.pid}.tmp.wav`;
    try {
      await mkdir(dirname(audio), { recursive: true });
      await extractAudio(input, temp, () => tools.ensureBinary("ffmpeg", progress));
      await renameRetrying(temp, audio);
    } catch (error) {
      await rm(temp, { force: true });
      failed(error);
    }
  }

  const transcribeOptions = { ...(options.model ? { model: options.model } : {}), ...(options.language ? { language: options.language } : {}) };
  const context = {
    ensureBinary: (name: string) => tools.ensureBinary(name, progress),
    ensureModel: (id: string) => tools.ensureModel(id, progress),
    progress: (update: Progress) => progress({ ...update }),
  };
  let result: TranscriptionResult;
  try {
    result = await provider.transcribe(audio, transcribeOptions, context);
  } catch (error) {
    return failed(error);
  }

  const windowDir = join(projectDir, ".frameshell", "cache", "transcribe");
  const long = await recoverLongWords({
    words: result.words,
    loadPcm: () => readPcmWav(audio),
    async transcribeWindow(pcm, from, to) {
      progress({ message: `Re-transcribing ${round(from)}-${round(to)} s: one word holds more speech` });
      await mkdir(windowDir, { recursive: true });
      return transcribeWindow({ pcm, from, to, dir: windowDir, transcribe: (path) => provider.transcribe(path, transcribeOptions, context) });
    },
  });

  // Re-read: the user may have edited it while the engine ran, or another asset's run may have taken the name.
  const previous = await readPrevious(transcriptPath);
  if (previous && previous.asset !== assetRel) throw nameTaken(assetRel, [{ path: transcriptRel, asset: previous.asset }]);
  const assigned = assignWordIds(long.words, previous);
  const speechInside: string[] = [];
  assigned.words.forEach((word, i) => {
    if (!long.speechInside[i]) return;
    word.speechInside = true;
    speechInside.push(word.id);
  });
  const transcript: Transcript = {
    $schema: TRANSCRIPT_SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    asset: assetRel,
    assetHash: `sha256:${hash}`,
    provider: providerId,
    model: result.model,
    ...(result.language ? { language: result.language } : {}),
    words: assigned.words,
    edits: assigned.edits,
    nextWordId: assigned.nextWordId,
  };
  const checked = parseTranscript(transcript);
  if (!checked.ok) failed(new Error(`provider returned words the transcript format rejects:\n${checked.error}`));
  await writeJsonAtomic(transcriptPath, transcript);

  return {
    transcript: transcriptRel,
    asset: assetRel,
    assetHash: transcript.assetHash,
    audioSource,
    provider: providerId,
    model: result.model,
    language: result.language ?? null,
    device: result.device ?? null,
    words: assigned.words.length,
    reusedIds: assigned.reusedIds,
    keptEdits: Object.keys(assigned.edits).length,
    droppedEdits: assigned.droppedEdits,
    recoveredWords: long.recovered,
    speechInside,
    seconds: Math.round(performance.now() - started) / 1000,
  };
}

/**
 * Transcript names for an asset, in preference order:
 * `transcripts/<path under assets/ minus extension>.words.json` (SPEC §5.4),
 * then the same with the extension kept, for when a same-name sibling
 * (`interview.mp4` and `interview.wav`) owns the first. Assets outside
 * `assets/` keep their full project-relative path.
 */
export function transcriptPathsFor(assetRel: string): [string, string] {
  const inner = assetRel.startsWith("assets/") ? assetRel.slice("assets/".length) : assetRel;
  return [`transcripts/${stripExtension(inner)}.words.json`, `transcripts/${inner}.words.json`];
}

/**
 * The transcript file of `assetRel`: the name whose file already records this
 * asset, else the first free name. A transcript is never overwritten for
 * another asset: that would lose its human edits or attach them to the wrong
 * words. Throws `TranscriptNameTaken` when every name belongs to another
 * asset, `InvalidProjectFile` when a candidate file is broken (its owner is
 * unknown and its edits would be lost).
 */
export async function resolveTranscript(
  projectDir: string,
  assetRel: string,
): Promise<{ rel: string; path: string; previous: Transcript | null }> {
  const candidates = [];
  for (const rel of new Set(transcriptPathsFor(assetRel))) {
    const path = join(projectDir, ...rel.split("/"));
    candidates.push({ rel, path, previous: await readPrevious(path) });
  }
  const chosen =
    candidates.find((candidate) => candidate.previous?.asset === assetRel) ?? candidates.find((candidate) => candidate.previous === null);
  if (chosen) return chosen;
  throw nameTaken(
    assetRel,
    candidates.map((candidate) => ({ path: candidate.rel, asset: candidate.previous!.asset })),
  );
}

function nameTaken(assetRel: string, transcripts: { path: string; asset: string }[]): RpcError {
  const owners = transcripts.map((t) => `${t.path} (${t.asset})`).join(", ");
  return new RpcError(
    ErrorCode.TranscriptNameTaken,
    `Cannot write the transcript of ${assetRel}: ${owners} belong to other assets. Rename the asset, or delete or move ` +
      "one of those transcripts if it is stale.",
    { asset: assetRel, transcripts },
  );
}

function stripExtension(path: string): string {
  const ext = posix.extname(path);
  return ext ? path.slice(0, -ext.length) : path;
}

/** Real path and `/`-separated project-relative path of an existing asset file inside the project. */
async function resolveAsset(projectDir: string, asset: string): Promise<{ real: string; rel: string }> {
  const target = resolve(asset);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new RpcError(ErrorCode.AssetNotFound, `Asset ${target} does not exist.`, { path: target });
  }
  const rel = relative(await realpath(projectDir), real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RpcError(
      ErrorCode.OutsideProject,
      `${target} is outside the project ${projectDir}. Copy it into assets/ first.`,
      { path: target },
    );
  }
  const relPosix = rel.split(sep).join("/");
  if ((relPosix.split("/")[0] ?? "").toLowerCase() === ".frameshell") {
    throw new RpcError(ErrorCode.OutsideProject, `${target} is daemon-owned state under .frameshell/, not an asset.`, { path: target });
  }
  if (!(await isFile(real))) throw new RpcError(ErrorCode.AssetNotFound, `Asset ${target} is not a file.`, { path: target });
  return { real, rel: relPosix };
}

/**
 * Previous transcript for id and edit reuse. Throws `InvalidProjectFile` when
 * it exists but is broken: overwriting it would silently lose human edits.
 */
async function readPrevious(path: string): Promise<Transcript | null> {
  if (!(await exists(path))) return null;
  const invalid = (details: string) =>
    new RpcError(
      ErrorCode.InvalidProjectFile,
      `Invalid ${path}:\n${details}\nFix it or delete it; re-transcribing would lose its edits.`,
      { path, details },
    );
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  const parsed = parseTranscript(raw);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}

/** SPEC §5.3: times with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
