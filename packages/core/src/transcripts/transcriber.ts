import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { TranscriptionProvider, TranscriptionResult } from "@frameshell/plugin-api";
import { ErrorCode, type Progress, RpcError, type TranscribeResult } from "@frameshell/protocol";
import { SCHEMA_VERSION, TRANSCRIPT_SCHEMA_URL, type Transcript, parseTranscript } from "@frameshell/schema";
import { exists, readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import { type AudioExtractor, extractAudioWithFfmpeg } from "./audio.js";
import { assignWordIds } from "./ids.js";

/** Native tools a transcription may need, with progress for first-run installs. */
export interface TranscriberTools {
  /** See `BinaryManager.ensure`; project overrides already applied. */
  ensureBinary(name: string, onProgress: (progress: Progress) => void): Promise<string>;
  /** See `BinaryManager.ensureModel`. */
  ensureModel(id: string, onProgress: (progress: Progress) => void): Promise<string>;
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
  /** Defaults to ffmpeg via `tools`. */
  extractAudio?: AudioExtractor | undefined;
  progress?: ((progress: Progress) => void) | undefined;
}

/**
 * Transcribe one asset and write `transcripts/<asset>.words.json` (SPEC §5.4).
 *
 * Audio: the CFR proxy (`.frameshell/proxies/<asset path minus extension>.mp4`)
 * when present, else the asset, extracted once to 16 kHz mono WAV under
 * `.frameshell/cache/audio/`. Word ids survive re-transcription where the
 * same word is found again, and so do their human edits.
 *
 * Throws `AssetNotFound`, `OutsideProject`, `TranscriptionFailed` (provider
 * or extraction error), or the binary manager's errors unchanged.
 */
export async function transcribeAsset(options: TranscribeAssetOptions): Promise<TranscribeResult> {
  const started = performance.now();
  const { projectDir, providerId, tools } = options;
  const progress = options.progress ?? (() => {});
  const extractAudio = options.extractAudio ?? extractAudioWithFfmpeg;
  const { real: assetPath, rel: assetRel } = await resolveAsset(projectDir, options.asset);
  const transcriptRel = transcriptPathFor(assetRel);
  const transcriptPath = join(projectDir, ...transcriptRel.split("/"));
  // Fail before minutes of work when the old transcript is broken.
  await readPrevious(transcriptPath);
  const provider = typeof options.provider === "function" ? await options.provider() : options.provider;

  progress({ message: `Hashing ${assetRel}` });
  const hash = await sha256File(assetPath);
  const proxyRel = posix.join(".frameshell", "proxies", `${stripExtension(assetRel)}.mp4`);
  const proxy = join(projectDir, ...proxyRel.split("/"));
  const useProxy = await isFile(proxy);
  const audioSource = useProxy ? proxyRel : assetRel;
  const audio = join(projectDir, ".frameshell", "cache", "audio", `${hash.slice(0, 16)}-${useProxy ? "proxy" : "asset"}.wav`);

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
      await extractAudio(join(projectDir, ...audioSource.split("/")), temp, () => tools.ensureBinary("ffmpeg", progress));
      await rename(temp, audio);
    } catch (error) {
      await rm(temp, { force: true });
      failed(error);
    }
  }

  let result: TranscriptionResult;
  try {
    result = await provider.transcribe(
      audio,
      { ...(options.model ? { model: options.model } : {}), ...(options.language ? { language: options.language } : {}) },
      {
        ensureBinary: (name) => tools.ensureBinary(name, progress),
        ensureModel: (id) => tools.ensureModel(id, progress),
        progress: (update) => progress({ ...update }),
      },
    );
  } catch (error) {
    return failed(error);
  }

  // Re-read: the user may have edited it while the engine ran.
  const assigned = assignWordIds(result.words, await readPrevious(transcriptPath));
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
    seconds: Math.round(performance.now() - started) / 1000,
  };
}

/**
 * `transcripts/<path under assets/ minus extension>.words.json`; assets
 * outside `assets/` keep their full project-relative path.
 */
export function transcriptPathFor(assetRel: string): string {
  const inner = assetRel.startsWith("assets/") ? assetRel.slice("assets/".length) : assetRel;
  return `transcripts/${stripExtension(inner)}.words.json`;
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
